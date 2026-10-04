import { describe, expect, it } from 'vitest';
import { addBrowseCount, assertBrowseAvailable, getBrowseState } from '../src/feeds/browse';
import type { Env } from '../src/types';

// R3 身份主键重构：browse 计量与 membership 镜像归属键均为 cid_number（不再传绑定账户）。
const CID_NUMBER = 'CN220-CTZN2-198805200-2026';

class BrowseDb {
  count = 0;
  prepare(sql: string): BrowseStmt {
    return new BrowseStmt(this, sql);
  }
}

class BrowseStmt {
  private values: unknown[] = [];
  constructor(private readonly db: BrowseDb, private readonly sql: string) {}
  bind(...values: unknown[]): BrowseStmt {
    this.values = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM square_memberships')) return null;
    // 归属键改为 cid_number：读支路匹配 WHERE cid_number = ? AND browse_day = ?。
    if (this.sql.includes('FROM square_browse_days') && this.sql.includes('cid_number = ?')) {
      return (this.db.count > 0 ? { browse_count: this.db.count } : null) as T | null;
    }
    return null;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    // 原子扣量落在 (cid_number, browse_day) 唯一键上；browse_count 仍是绑定第 3 个占位符。
    if (
      this.sql.includes('INSERT INTO square_browse_days') &&
      this.sql.includes('ON CONFLICT(cid_number, browse_day)')
    ) {
      const next = this.db.count + Number(this.values[2]);
      if (next > 100) return { meta: { changes: 0 } };
      this.db.count = next;
    }
    return { meta: { changes: 1 } };
  }
}

describe('wallet browse allowance', () => {
  it('starts unsubscribed wallets at 100 returned items per UTC day', async () => {
    const db = new BrowseDb();
    const env = { DB: db } as unknown as Env;
    const state = await getBrowseState(env, CID_NUMBER);
    expect(state).toMatchObject({ browse_count: 0, browse_limit: 100, browse_left: 100 });
  });

  it('counts only server-returned items and blocks after the allowance is exhausted', async () => {
    const db = new BrowseDb();
    const env = { DB: db } as unknown as Env;
    let state = await getBrowseState(env, CID_NUMBER);
    state = await addBrowseCount(env, CID_NUMBER, state,40);
    expect(state.browse_left).toBe(60);
    state = await addBrowseCount(env, CID_NUMBER, state,60);
    expect(state.browse_left).toBe(0);
    expect(() => assertBrowseAvailable(state)).toThrow(
      expect.objectContaining({ code: 'browse_limit_reached', status: 429 }),
    );
  });

  it('rejects a stale concurrent deduction instead of returning over-limit content', async () => {
    const db = new BrowseDb();
    db.count = 90;
    const env = { DB: db } as unknown as Env;
    const stale = await getBrowseState(env, CID_NUMBER);
    await addBrowseCount(env, CID_NUMBER, stale,10);
    await expect(addBrowseCount(env, CID_NUMBER, stale,10)).rejects.toMatchObject({
      code: 'browse_limit_reached',
      status: 429,
    });
    expect(db.count).toBe(100);
  });
});
