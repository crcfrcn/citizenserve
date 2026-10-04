import type { Env } from '../types';
import { HttpError } from '../shared/http';
import { getMembership, subscriptionIsActive } from '../membership/service';
import { nowMs } from '../shared/time';

export const GUEST_DAILY_BROWSE_LIMIT = 100;

export interface BrowseState {
  browse_day: string;
  browse_count: number;
  browse_limit: number | null;
  browse_left: number | null;
}

/**
 * 读取当前身份的产品浏览额度(按 cid_number 计量)。有效会员不设产品额度；技术安全限速归第 2 步。
 * membership 与 browse_days 归属键均为身份主键 cid_number。
 */
export async function getBrowseState(
  env: Env,
  cidNumber: string,
): Promise<BrowseState> {
  const browseDay = new Date().toISOString().slice(0, 10);
  const membership = await getMembership(env, cidNumber);
  // ADR-037 统一口径：浏览额度只看订阅是否有效，不再经身份冻结判定。
  if (membership && subscriptionIsActive(membership)) {
    return { browse_day: browseDay, browse_count: 0, browse_limit: null, browse_left: null };
  }
  const row = await env.DB.prepare(
    `SELECT browse_count FROM square_browse_days WHERE cid_number = ? AND browse_day = ?`,
  ).bind(cidNumber, browseDay).first<{ browse_count: number }>();
  const count = Math.min(Math.max(row?.browse_count ?? 0, 0), GUEST_DAILY_BROWSE_LIMIT);
  return {
    browse_day: browseDay,
    browse_count: count,
    browse_limit: GUEST_DAILY_BROWSE_LIMIT,
    browse_left: Math.max(GUEST_DAILY_BROWSE_LIMIT - count, 0),
  };
}

/** 按服务端实际返回条数累计浏览量（归属键 cid_number），客户端声明值不能成为计费真源。 */
export async function addBrowseCount(
  env: Env,
  cidNumber: string,
  state: BrowseState,
  returnedCount: number,
): Promise<BrowseState> {
  if (state.browse_limit === null || returnedCount <= 0) return state;
  const allowed = Math.min(returnedCount, state.browse_left ?? 0);
  if (allowed <= 0) throw browseLimitReached();
  const updatedAt = nowMs();
  const write = await env.DB.prepare(
    `INSERT INTO square_browse_days (cid_number, browse_day, browse_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cid_number, browse_day) DO UPDATE SET
        browse_count = square_browse_days.browse_count + excluded.browse_count,
        updated_at = excluded.updated_at
      WHERE square_browse_days.browse_count + excluded.browse_count <= ?`,
  ).bind(cidNumber, state.browse_day, allowed, updatedAt, GUEST_DAILY_BROWSE_LIMIT).run();
  // 并发请求只能有一个原子扣量成功；失败请求不返回已经读取的内容。
  if ((write.meta?.changes ?? 0) !== 1) throw browseLimitReached();
  return getBrowseState(env, cidNumber);
}

export function assertBrowseAvailable(state: BrowseState): number {
  if (state.browse_limit === null) return 50;
  const left = state.browse_left ?? 0;
  if (left <= 0) throw browseLimitReached();
  return left;
}

function browseLimitReached(): HttpError {
  return new HttpError(429, 'browse_limit_reached', '今日广场浏览额度已用完');
}
