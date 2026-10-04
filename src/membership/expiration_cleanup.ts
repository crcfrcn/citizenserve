import type { Env } from '../types';
import { deletePostCloudflareDataByCid } from '../posts/confirm';
import { usageLimits } from '../limits/catalog';
import { sendStorageCleanupAlert } from '../shared/push';

// 权益到期清理使用 Cloudflare 定时事件时间；会员状态只由手机 finalized 交易同步，
// Worker 不再为清理任务扫描链状态，也不保留第二套会员时钟。
// 最坏情况：两名用户各 8 台设备通知 + 一名用户清理 4 篇、每篇最多 5 个外部请求；
// 连同同轮订阅 batch 仍低于 Free 的 50 subrequest。
const MAX_IDENTITIES_PER_SWEEP = 3;
const MAX_CONTENT_ITEMS_PER_SWEEP = 4;
export const MEMBERSHIP_STORAGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const STORAGE_CLEANUP_NOTICE_MS = 24 * 60 * 60 * 1000;

interface ExpiredIdentityRow {
  cid_number: string;
  storage_cleanup_notified_at: number | null;
}

interface ContentItemRow {
  post_id: string;
}

export interface ExpiredMembershipCleanupResult {
  identity_count: number;
  deleted_content_items: number;
  failed_content_items: number;
}

/**
 * 权益到期满 30 天后，仅把当前存储超过自由会员 100GB 的部分按最旧内容优先清理。
 *
 * 每个内容项先删除 R2 主文件、衍生图和 manifest，全部成功后才事务删除 D1 索引；
 * 失败项保留 D1 行供下一轮继续定位，R2 重复删除视为幂等成功。
 */
export async function runExpiredMembershipContentCleanup(
  env: Env,
  scheduledAt: number,
): Promise<ExpiredMembershipCleanupResult> {
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0) {
    throw new Error('scheduled timestamp is invalid');
  }

  const identities = await selectExpiredIdentities(
    env,
    scheduledAt - MEMBERSHIP_STORAGE_GRACE_MS,
    usageLimits.freedom.storage_bytes,
    MAX_IDENTITIES_PER_SWEEP,
  );
  let remaining = MAX_CONTENT_ITEMS_PER_SWEEP;
  let deleted = 0;
  let failed = 0;

  for (const identity of identities) {
    if (remaining <= 0) break;
    let storageBytes = await readStorageBytes(env, identity.cid_number);
    if (storageBytes <= usageLimits.freedom.storage_bytes) continue;
    if (identity.storage_cleanup_notified_at === null) {
      const cleanupAfter = scheduledAt + STORAGE_CLEANUP_NOTICE_MS;
      await sendStorageCleanupAlert(
        env,
        identity.cid_number,
        usageLimits.freedom.storage_bytes,
        cleanupAfter,
      );
      await env.DB.prepare(
        `UPDATE square_memberships
            SET storage_cleanup_notified_at = ?
          WHERE cid_number = ? AND storage_cleanup_notified_at IS NULL`,
      ).bind(scheduledAt, identity.cid_number).run();
      continue;
    }
    if (identity.storage_cleanup_notified_at + STORAGE_CLEANUP_NOTICE_MS > scheduledAt) {
      continue;
    }
    const items = await selectContentItems(env, identity.cid_number, remaining);
    for (const item of items) {
      if (remaining <= 0 || storageBytes <= usageLimits.freedom.storage_bytes) break;
      remaining -= 1;
      try {
        await deletePostCloudflareDataByCid(
          env,
          identity.cid_number,
          item.post_id,
          scheduledAt,
        );
        deleted += 1;
        storageBytes = await readStorageBytes(env, identity.cid_number);
      } catch (error) {
        failed += 1;
        console.error(JSON.stringify({
          event: 'expired_membership_content_cleanup_failed',
          cid_number: identity.cid_number,
          post_id: item.post_id,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  return {
    identity_count: identities.length,
    deleted_content_items: deleted,
    failed_content_items: failed,
  };
}

async function selectExpiredIdentities(
  env: Env,
  paidUntilCutoff: number,
  storageLimit: number,
  limit: number,
): Promise<ExpiredIdentityRow[]> {
  const rows = await env.DB.prepare(
    `SELECT m.cid_number, m.storage_cleanup_notified_at
       FROM square_memberships m
      WHERE m.paid_until <= ?
        AND COALESCE((SELECT byte_size FROM resource_totals
          WHERE cid_number = m.cid_number AND resource_key = 'square_storage'), 0) > ?
        AND (
          EXISTS (SELECT 1 FROM square_posts p WHERE p.cid_number = m.cid_number)
          OR EXISTS (SELECT 1 FROM square_uploads u WHERE u.cid_number = m.cid_number)
        )
      ORDER BY m.paid_until ASC, m.cid_number ASC
      LIMIT ?`,
  )
    .bind(paidUntilCutoff, storageLimit, limit)
    .all<ExpiredIdentityRow>();
  return rows.results ?? [];
}

async function selectContentItems(
  env: Env,
  cidNumber: string,
  limit: number,
): Promise<ContentItemRow[]> {
  const rows = await env.DB.prepare(
    `SELECT post_id FROM (
       SELECT p.post_id, p.created_at
         FROM square_posts p WHERE p.cid_number = ?
       UNION ALL
       SELECT u.post_id, u.created_at
         FROM square_uploads u
         LEFT JOIN square_posts p ON p.post_id = u.post_id
        WHERE u.cid_number = ? AND p.post_id IS NULL
     ) ORDER BY created_at ASC, post_id ASC
      LIMIT ?`,
  )
    .bind(cidNumber, cidNumber, limit)
    .all<ContentItemRow>();
  return rows.results ?? [];
}

async function readStorageBytes(env: Env, cidNumber: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT byte_size FROM resource_totals
      WHERE cid_number = ? AND resource_key = 'square_storage'`,
  ).bind(cidNumber).first<{ byte_size: number }>();
  return row?.byte_size ?? 0;
}
