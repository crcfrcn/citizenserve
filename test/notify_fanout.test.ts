import { describe, expect, it } from 'vitest';
import { fanOutPage } from '../src/feeds/notify_fanout';
import type { Env, SquareNotifyJob } from '../src/types';

/// 身份主键 = CID 号（R2 重构后 follows 双端皆为 cid）。作者与粉丝都以 cid 标识。
const author = 'CN220-CTZN2-198805200-2026';
const cidA = 'CN220-CTZN2-1000000AA-2026';
const cidB = 'CN220-CTZN2-1000000BB-2026';
const cidC = 'CN220-CTZN2-1000000CC-2026';
const FAR_FUTURE = 9999999999999;

interface FollowRow {
  follower_cid_number: string;
  followed_cid_number: string;
  notify_enabled: number;
  created_at: number;
}
/// 普通应用通知端点直接按cid_number归属，不参与业务内容存储。
interface DeviceRow {
  cid_number: string;
  push_provider: 'apns' | 'fcm';
  push_token: string;
  apns_environment: 'sandbox' | 'production' | null;
  expires_at: number;
}

describe('fanOutPage', () => {
  it('pushes only to notify-enabled followers with non-expired devices', async () => {
    const { env, db } = fakeEnv({
      follows: [follow(cidA, 1, 100), follow(cidB, 0, 110), follow(cidC, 1, 120)],
      devices: [device(cidA, FAR_FUTURE), device(cidC, 1)],
    });
    await fanOutPage(env, job(), 100);
    // 静音（notify_enabled=0）的 cidB 与设备过期的 cidC 都排除，仅 cidA 收到推送。
    expect(db.pushedCids).toEqual([cidA]);
  });

  it('does not re-enqueue when the page is not full', async () => {
    const { env, queue } = fakeEnv({
      follows: [follow(cidA, 1, 100), follow(cidB, 1, 110)],
      devices: [device(cidA, FAR_FUTURE), device(cidB, FAR_FUTURE)],
    });
    await fanOutPage(env, job(), 100);
    expect(queue.sent).toHaveLength(0);
  });

  it('re-enqueues a continuation cursor when the page is full', async () => {
    const { env, queue } = fakeEnv({
      follows: [follow(cidA, 1, 100), follow(cidB, 1, 110), follow(cidC, 1, 120)],
      devices: [
        device(cidA, FAR_FUTURE),
        device(cidB, FAR_FUTURE),
        device(cidC, FAR_FUTURE),
      ],
    });
    await fanOutPage(env, job(), 2); // 页大小 2、3 个合格粉丝 → 满页续跑

    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      author_cid_number: author,
      post_id: 'p1',
      cursor: { created_at: 110, cid_number: cidB }, // 本页末个粉丝 cid
    });
  });
});

function job(): SquareNotifyJob {
  return {
    author_cid_number: author,
    author_name: '林正华',
    post_type: 'document',
    post_id: 'p1',
  };
}

function follow(followerCid: string, notify: number, createdAt: number): FollowRow {
  return {
    follower_cid_number: followerCid,
    followed_cid_number: author,
    notify_enabled: notify,
    created_at: createdAt,
  };
}

function device(cid: string, expiresAt: number): DeviceRow {
  return {
    cid_number: cid,
    push_provider: 'fcm',
    push_token: `tok_${cid}`,
    apns_environment: null,
    expires_at: expiresAt,
  };
}

function fakeEnv(options: {
  follows: FollowRow[];
  devices: DeviceRow[];
}): {
  env: Env;
  queue: FakeQueue;
  db: FakeDb;
} {
  const queue = new FakeQueue();
  const db = new FakeDb(options.follows, options.devices);
  const env = {
    DB: db as unknown as D1Database,
    NOTIFY: queue as unknown as Queue<SquareNotifyJob>,
    // 无 APNS/FCM 密钥 → sendSquarePostAlert 早退 false，不触真推送。
  } as unknown as Env;
  return { env, queue, db };
}

class FakeQueue {
  sent: SquareNotifyJob[] = [];
  async send(message: SquareNotifyJob): Promise<void> {
    this.sent.push(message);
  }
}

class FakeDb {
  pushedCids: string[] = [];
  constructor(
    readonly follows: FollowRow[],
    readonly devices: DeviceRow[],
  ) {}
  prepare(sql: string): FakeStmt {
    return new FakeStmt(sql, this);
  }
}

class FakeStmt {
  private binds: unknown[] = [];
  constructor(
    private readonly sql: string,
    private readonly db: FakeDb,
  ) {}

  bind(...args: unknown[]): FakeStmt {
    this.binds = args;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM square_follows')) {
      const [followed, cursorAt, cursorCid, limit] = this.binds as [
        string,
        number,
        string,
        number,
      ];
      const rows = this.db.follows
        .filter(
          (f) =>
            f.followed_cid_number === followed &&
            f.notify_enabled === 1 &&
            (f.created_at > cursorAt ||
              (f.created_at === cursorAt && f.follower_cid_number > cursorCid)),
        )
        .sort(
          (a, b) =>
            a.created_at - b.created_at ||
            a.follower_cid_number.localeCompare(b.follower_cid_number),
        )
        .slice(0, limit)
        .map((f) => ({ cid_number: f.follower_cid_number, created_at: f.created_at }));
      return { results: rows as unknown as T[] };
    }

    // 按粉丝 CID 读取未过期普通应用通知端点。
    if (this.sql.includes('FROM push_endpoints')) {
      const cids = this.binds.slice(0, -1) as string[];
      const now = this.binds[this.binds.length - 1] as number;
      const matched = this.db.devices.filter(
        (d) => cids.includes(d.cid_number) && d.expires_at > now,
      );
      this.db.pushedCids.push(...matched.map((d) => d.cid_number));
      return {
        results: matched.map((d) => ({
          push_provider: d.push_provider,
          push_token: d.push_token,
          apns_environment: d.apns_environment,
        })) as unknown as T[],
      };
    }

    return { results: [] };
  }
}
