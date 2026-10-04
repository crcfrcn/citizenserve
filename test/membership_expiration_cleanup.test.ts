import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deletePostCloudflareDataByCid, sendStorageCleanupAlert } = vi.hoisted(() => ({
  deletePostCloudflareDataByCid: vi.fn(),
  sendStorageCleanupAlert: vi.fn(),
}));
vi.mock('../src/posts/confirm', () => ({
  deletePostCloudflareDataByCid,
}));
vi.mock('../src/shared/push', () => ({
  sendStorageCleanupAlert,
}));

import type { Env } from '../src/types';
import {
  MEMBERSHIP_STORAGE_GRACE_MS,
  STORAGE_CLEANUP_NOTICE_MS,
  runExpiredMembershipContentCleanup,
} from '../src/membership/expiration_cleanup';

const CID_EXPIRED = 'CN220-CTZN2-198805200-2026';
const CID_PAID = 'CN220-CTZN2-199001010-2026';

interface Membership {
  cid_number: string;
  subscription_status: string;
  paid_until: number;
  storage_cleanup_notified_at?: number | null;
}

class FakeDb {
  readonly memberships: Membership[] = [];
  readonly posts = new Map<string, string>();
  readonly uploads = new Map<string, string>();
  readonly storageBytes = new Map<string, number>();

  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStmt {
    this.args = args;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM square_memberships m')) {
      const finalizedChainTimestamp = this.args[0] as number;
      const storageLimit = this.args[1] as number;
      const limit = this.args[2] as number;
      const rows = this.db.memberships
        .filter((membership) =>
          (membership.subscription_status === 'cancelled' ||
            membership.subscription_status === 'terminated') &&
          membership.paid_until <= finalizedChainTimestamp &&
          (this.db.storageBytes.get(membership.cid_number) ?? 0) > storageLimit &&
          ([...this.db.posts.values()].includes(membership.cid_number) ||
            [...this.db.uploads.values()].includes(membership.cid_number)))
        .sort((a, b) =>
          a.paid_until - b.paid_until ||
          a.cid_number.localeCompare(b.cid_number))
        .slice(0, limit)
        .map((membership) => ({
          cid_number: membership.cid_number,
          storage_cleanup_notified_at:
            membership.storage_cleanup_notified_at ?? null,
        }));
      return { results: rows as T[] };
    }
    if (this.sql.includes('SELECT post_id') && this.sql.includes('UNION')) {
      const cidNumber = this.args[0] as string;
      const limit = this.args[2] as number;
      const postIds = new Set<string>();
      for (const [postId, owner] of this.db.posts) {
        if (owner === cidNumber) postIds.add(postId);
      }
      for (const [postId, owner] of this.db.uploads) {
        if (owner === cidNumber) postIds.add(postId);
      }
      const rows = [...postIds]
        .sort()
        .slice(0, limit)
        .map((post_id) => ({ post_id }));
      return { results: rows as T[] };
    }
    return { results: [] };
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM resource_totals')) {
      const byteSize = this.db.storageBytes.get(this.args[0] as string);
      return (byteSize == null ? null : { byte_size: byteSize }) as T | null;
    }
    return null;
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.sql.includes('SET storage_cleanup_notified_at = ?')) {
      const [notifiedAt, cidNumber] = this.args as [number, string];
      const membership = this.db.memberships.find(
        (item) => item.cid_number === cidNumber,
      );
      if (membership && membership.storage_cleanup_notified_at == null) {
        membership.storage_cleanup_notified_at = notifiedAt;
      }
    }
    return { success: true } as D1Result<unknown>;
  }
}

function env(db: FakeDb): Env {
  return { DB: db as unknown as D1Database } as Env;
}

describe('会员权益到期云端内容清理', () => {
  beforeEach(() => {
    deletePostCloudflareDataByCid.mockReset();
    deletePostCloudflareDataByCid.mockResolvedValue({
      deleted_media_assets: 0,
      deleted_r2_objects: 0,
    });
    sendStorageCleanupAlert.mockReset();
    sendStorageCleanupAlert.mockResolvedValue(1);
  });

  it('只用传入的 Cloudflare 定时事件时间判断 paid_until，不使用设备时间', async () => {
    const db = new FakeDb();
    db.memberships.push(
      {
        cid_number: CID_EXPIRED,
        subscription_status: 'cancelled',
        paid_until: 9_000,
        storage_cleanup_notified_at: 0,
      },
      { cid_number: CID_PAID, subscription_status: 'cancelled', paid_until: 11_000 },
    );
    db.posts.set('post-expired', CID_EXPIRED);
    db.posts.set('post-paid', CID_PAID);
    db.storageBytes.set(CID_EXPIRED, 100_000_000_001);
    db.storageBytes.set(CID_PAID, 100_000_000_001);

    const result = await runExpiredMembershipContentCleanup(
      env(db),
      MEMBERSHIP_STORAGE_GRACE_MS + 10_000,
    );

    expect(result).toEqual({
      identity_count: 1,
      deleted_content_items: 1,
      failed_content_items: 0,
    });
    expect(deletePostCloudflareDataByCid).toHaveBeenCalledWith(
      expect.anything(),
      CID_EXPIRED,
      'post-expired',
      MEMBERSHIP_STORAGE_GRACE_MS + 10_000,
    );
    expect(deletePostCloudflareDataByCid).not.toHaveBeenCalledWith(
      expect.anything(),
      CID_PAID,
      expect.anything(),
      expect.anything(),
    );
  });

  it('同一 post 的帖子行和上传行只清理一次，并覆盖只有上传未发布的内容', async () => {
    const db = new FakeDb();
    db.memberships.push({
      cid_number: CID_EXPIRED,
      subscription_status: 'terminated',
      paid_until: 9_000,
      storage_cleanup_notified_at: 0,
    });
    db.posts.set('post-published', CID_EXPIRED);
    db.uploads.set('post-published', CID_EXPIRED);
    db.uploads.set('post-upload-only', CID_EXPIRED);
    db.storageBytes.set(CID_EXPIRED, 100_000_000_001);

    const result = await runExpiredMembershipContentCleanup(
      env(db),
      MEMBERSHIP_STORAGE_GRACE_MS + 9_000,
    );

    expect(result.deleted_content_items).toBe(2);
    expect(deletePostCloudflareDataByCid).toHaveBeenCalledTimes(2);
  });

  it('单项失败保留为失败结果并继续同批其它内容，供下一轮重试', async () => {
    const db = new FakeDb();
    db.memberships.push({
      cid_number: CID_EXPIRED,
      subscription_status: 'cancelled',
      paid_until: 9_000,
      storage_cleanup_notified_at: 0,
    });
    db.posts.set('post-a', CID_EXPIRED);
    db.posts.set('post-b', CID_EXPIRED);
    db.storageBytes.set(CID_EXPIRED, 100_000_000_001);
    deletePostCloudflareDataByCid
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({
        deleted_media_assets: 0,
        deleted_r2_objects: 0,
      });

    const result = await runExpiredMembershipContentCleanup(
      env(db),
      MEMBERSHIP_STORAGE_GRACE_MS + 9_000,
    );

    expect(result).toEqual({
      identity_count: 1,
      deleted_content_items: 1,
      failed_content_items: 1,
    });
    expect(deletePostCloudflareDataByCid).toHaveBeenCalledTimes(2);
  });

  it('单轮最多清理四项，给订阅 batch 和设备通知保留 subrequest 余量', async () => {
    const db = new FakeDb();
    db.memberships.push({
      cid_number: CID_EXPIRED,
      subscription_status: 'terminated',
      paid_until: 9_000,
      storage_cleanup_notified_at: 0,
    });
    for (let index = 0; index < 10; index += 1) {
      db.posts.set(`post-${index}`, CID_EXPIRED);
    }
    db.storageBytes.set(CID_EXPIRED, 100_000_000_001);

    const result = await runExpiredMembershipContentCleanup(
      env(db),
      MEMBERSHIP_STORAGE_GRACE_MS + 9_000,
    );

    expect(result.deleted_content_items).toBe(4);
    expect(deletePostCloudflareDataByCid).toHaveBeenCalledTimes(4);
  });

  it('拒绝非法定时事件时间戳', async () => {
    await expect(
      runExpiredMembershipContentCleanup(env(new FakeDb()), -1),
    ).rejects.toThrow('scheduled timestamp is invalid');
  });

  it('宽限期结束后先通知并再等待 24 小时，禁止同一轮直接删除', async () => {
    const db = new FakeDb();
    db.memberships.push({
      cid_number: CID_EXPIRED,
      subscription_status: 'terminated',
      paid_until: 9_000,
      storage_cleanup_notified_at: null,
    });
    db.posts.set('post-notified', CID_EXPIRED);
    db.storageBytes.set(CID_EXPIRED, 100_000_000_001);
    const finalizedAt = MEMBERSHIP_STORAGE_GRACE_MS + 9_000;

    const result = await runExpiredMembershipContentCleanup(env(db), finalizedAt);

    expect(result.deleted_content_items).toBe(0);
    expect(deletePostCloudflareDataByCid).not.toHaveBeenCalled();
    expect(sendStorageCleanupAlert).toHaveBeenCalledWith(
      expect.anything(),
      CID_EXPIRED,
      100_000_000_000,
      finalizedAt + STORAGE_CLEANUP_NOTICE_MS,
    );
    expect(db.memberships[0].storage_cleanup_notified_at).toBe(finalizedAt);
  });

  it('30 天宽限期内或当前存储不超过自由会员上限时不删除内容', async () => {
    const db = new FakeDb();
    db.memberships.push({
      cid_number: CID_EXPIRED,
      subscription_status: 'cancelled',
      paid_until: 9_000,
    });
    db.posts.set('post-kept', CID_EXPIRED);
    db.storageBytes.set(CID_EXPIRED, 100_000_000_000);

    const result = await runExpiredMembershipContentCleanup(
      env(db),
      MEMBERSHIP_STORAGE_GRACE_MS + 8_999,
    );

    expect(result.deleted_content_items).toBe(0);
    expect(deletePostCloudflareDataByCid).not.toHaveBeenCalled();
  });
});
