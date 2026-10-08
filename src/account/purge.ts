import type { Env, MediaAssetRow } from '../types';
import { manifestObjectKey } from '../r2_keys';
import { deleteR2MediaAssets } from '../media';
import { clearIdentitySessions } from '../auth/session_index';
import { HttpError } from '../shared/http';

export interface PurgeIdentityResult {
  deleted_media_assets: number;
  deleted_r2_objects: number;
  deleted_rows: number;
}

interface PurgeUploadRow {
  upload_id: string;
  post_id: string;
  cid_number: string;
  manifest_byte_size: number;
}

/// 按唯一身份主键 CID 硬删除其在 Cloudflare 中可清除的身份、社交、鉴权、会话和媒体数据。
/// 边界：
/// - 普通应用推送端点随当前身份删除。
/// - 身份内容、设备、会话和 off-chain 关系全部按 cid_number 删除。
/// - finalized 交易最小证明与充值订单都带 CID 归属并随身份完整删除；链上原始交易事实
///   仍由公链保存，不以 D1 台账残留为审计前提。
/// - 会员与创作者订阅投影由 users 外键级联删除；注销不代签链上退订。
/// - 媒体提供商失败必须让注销失败关闭，禁止丢失后续清理所需的对象索引。
export async function purgeIdentity(
  env: Env,
  cidNumber: string
): Promise<PurgeIdentityResult> {
  // 1. 先完整读取并校验该 CID 的上传对象索引；清单损坏或已发布帖缺上传索引时 fail-closed，
  //    禁止先删 R2/D1 后丢失继续清理所需的唯一对象事实。
  const uploads = (
    await env.DB.prepare(
      `SELECT upload_id, post_id, cid_number, manifest_byte_size
        FROM square_uploads WHERE cid_number = ?`
    )
      .bind(cidNumber)
      .all<PurgeUploadRow>()
  ).results ?? [];
  const postWithoutUpload = await env.DB.prepare(
    `SELECT p.post_id
      FROM square_posts p
      LEFT JOIN square_uploads u ON u.post_id = p.post_id AND u.cid_number = p.cid_number
      WHERE p.cid_number = ? AND u.upload_id IS NULL
      LIMIT 1`
  )
    .bind(cidNumber)
    .first<{ post_id: string }>();
  if (postWithoutUpload) {
    throw new HttpError(409, 'identity_upload_index_missing', '身份内容缺少上传对象索引');
  }
  const postObjectKeys = [...new Set(uploads.map((upload) => manifestObjectKey(upload)))];

  // 2. R2 媒体：注销=删身份，按 cid_number 取该身份全部主媒体及衍生图并硬删除。
  const mediaRows = (
    await env.DB.prepare(
      `SELECT upload_id, post_id, cid_number, account_id, media_index, media_kind, object_key,
        upload_method, resource_key, content_type, byte_size, sha256,
        derivative_kind, derivative_object_key, derivative_content_type, derivative_byte_size,
        derivative_sha256, asset_state, duration_seconds, width, height, error_code,
        created_at, updated_at, ready_at
        FROM square_media_assets WHERE cid_number = ?`
    )
      .bind(cidNumber)
      .all<MediaAssetRow>()
  ).results ?? [];
  await deleteR2MediaAssets(env, mediaRows);

  // 3. R2：资料按 CID 前缀；帖子只按上方已严格验证的 D1 对象清单精确删除，覆盖历次换绑
  //    账户的发布路径。禁止按当前账户前缀猜测，也不保留生产期迁移工具兜底。
  for (let index = 0; index < postObjectKeys.length; index += 1000) {
    await env.SQUARE_PRIVATE.delete(postObjectKeys.slice(index, index + 1000));
  }
  const deletedProfileObjects = await deleteR2Prefix(env, `profile/${cidNumber}/`);
  const deletedR2 = postObjectKeys.length + mediaRows.length * 2 + deletedProfileObjects;

  // 4. KV：注销按 CID 失效历次换绑账户签发的全部会话；用户身份不再使用 KV 缓存。
  await clearIdentitySessions(env, cidNumber);

  // 5. D1 原子批删。存储总量回收必须和媒体/内容行删除同批提交：任一语句失败时
  //    D1 整批回滚，重试仍能从媒体行重建同一释放量；成功后媒体行已删除，后续重试
  //    不会再次扣减全局 resource_totals。
  //    所有有 CID 归属的身份、内容、关系、设备与用量数据均按 CID 删除。登录挑战
  //    记录 CID 归属，必须覆盖历次换绑账户，不能只删当前授权账户。
  const statements = [
    env.DB.prepare(`DELETE FROM mls_devices WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM push_endpoints WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM square_sessions WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM mls_authentication_challenges WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM square_uploads WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM square_posts WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM square_media_assets WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare('DELETE FROM contact_mls_messages WHERE cid_number = ?').bind(cidNumber),
    env.DB.prepare('DELETE FROM contact_mls_operations WHERE cid_number = ?').bind(cidNumber),
    env.DB.prepare('DELETE FROM contact_mls_packages WHERE cid_number = ?').bind(cidNumber),
    env.DB.prepare('DELETE FROM contact_mls_groups WHERE cid_number = ?').bind(cidNumber),
    env.DB.prepare(`DELETE FROM chain_transaction_confirmations WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM topup_orders WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM resource_reservations WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM resource_usage WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(
      `DELETE FROM square_follows WHERE follower_cid_number = ? OR followed_cid_number = ?`
    ).bind(cidNumber, cidNumber),
    env.DB.prepare(`DELETE FROM square_browse_days WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM square_notify_reads WHERE cid_number = ?`).bind(cidNumber),
    env.DB.prepare(`DELETE FROM rate_windows WHERE rate_key = ?`).bind(
      `upload:cid_number:${cidNumber}`,
    ),
    // users 最后删除并由外键级联资料、平台会员、创作者档位和双向订阅关系；
    // 只有 finalized CidRegistry::Revoked 可到达本入口。
    env.DB.prepare(`DELETE FROM users WHERE cid_number = ?`).bind(cidNumber)
  ];
  const results = await env.DB.batch(statements);
  const deletedRows = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);

  return {
    deleted_media_assets: mediaRows.length,
    deleted_r2_objects: deletedR2,
    deleted_rows: deletedRows
  };
}

/// 翻页硬删除某 R2 前缀下全部对象。
async function deleteR2Prefix(
  env: Env,
  prefix: string
): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.SQUARE_PRIVATE.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) {
      await env.SQUARE_PRIVATE.delete(keys);
      deleted += keys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}
