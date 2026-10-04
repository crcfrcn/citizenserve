import type { Env, SessionState } from '../types';
import { resourceLimit } from '../limits/catalog';
import { sha256Hex } from '../shared/hash';
import { nowMs } from '../shared/time';

interface SessionIndexRow {
  session_token_hash: string;
}

/// 明文 Bearer token 永远不进入 D1 或 KV 键；两处只使用统一 SHA-256 标识。
export async function sessionCacheKey(sessionToken: string): Promise<string> {
  return `square_session:${await sha256Hex(sessionToken)}`;
}

/// KV 会话写入成功后登记 D1 强一致索引。调用方负责在本函数失败时回滚 KV。
export async function indexIdentitySession(
  env: Env,
  sessionToken: string,
  session: SessionState
): Promise<void> {
  const sessionTokenHash = await sha256Hex(sessionToken);
  await env.DB.prepare(
    `INSERT INTO square_sessions
      (session_token_hash, cid_number, binding_revision, account_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionTokenHash,
      session.cid_number,
      session.binding_revision,
      session.account_id,
      session.created_at,
      session.expires_at
    )
    .run();
  await trimIdentitySessions(env, session.cid_number, sessionTokenHash);
}

/**
 * 每个 CID 只保留资源目录允许的最新 Session。新签发的 token 始终优先保留，
 * 被汰汰项先删 KV 再删 D1 强一致索引；KV 失败时索引保留，下次重试仍可收敛。
 */
async function trimIdentitySessions(
  env: Env,
  cidNumber: string,
  currentHash: string,
): Promise<void> {
  const maxCount = resourceLimit('session_index').max_count ?? 1;
  const rows = await env.DB.prepare(
    `SELECT session_token_hash FROM square_sessions
      WHERE cid_number = ?
      ORDER BY CASE WHEN session_token_hash = ? THEN 0 ELSE 1 END,
        created_at DESC, session_token_hash DESC`,
  )
    .bind(cidNumber, currentHash)
    .all<SessionIndexRow>();
  for (const row of (rows.results ?? []).slice(maxCount)) {
    await env.SQUARE_CACHE.delete(`square_session:${row.session_token_hash}`);
    await env.DB.prepare(
      `DELETE FROM square_sessions WHERE session_token_hash = ?`,
    )
      .bind(row.session_token_hash)
      .run();
  }
}

/// Session 签发失败时同时清除可能已落下的 KV 与 D1 半成品。
export async function rollbackIdentitySession(
  env: Env,
  sessionToken: string
): Promise<void> {
  const sessionTokenHash = await sha256Hex(sessionToken);
  await Promise.all([
    env.SQUARE_CACHE.delete(`square_session:${sessionTokenHash}`),
    env.DB.prepare(
      `DELETE FROM square_sessions WHERE session_token_hash = ?`
    )
      .bind(sessionTokenHash)
      .run()
  ]);
}

/// 注销身份时先用 D1 强一致索引定位并删除该 CID 跨换绑账户的全部 KV 会话。
///
/// D1 索引行由 purge 最终原子 batch 删除；任一 KV 删除失败时索引仍完整保留，重试可收敛。
export async function clearIdentitySessions(
  env: Env,
  cidNumber: string
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT session_token_hash FROM square_sessions WHERE cid_number = ?`
  )
    .bind(cidNumber)
    .all<SessionIndexRow>();
  for (const row of rows.results ?? []) {
    await env.SQUARE_CACHE.delete(`square_session:${row.session_token_hash}`);
  }
}

/// 换绑吊销只失效同一 CID 下由此前账户签发的会话，新账户会话必须保留。
export async function clearIdentityAccountSessions(
  env: Env,
  cidNumber: string,
  accountId: string
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT session_token_hash
      FROM square_sessions WHERE cid_number = ? AND account_id = ?`
  )
    .bind(cidNumber, accountId)
    .all<SessionIndexRow>();
  for (const row of rows.results ?? []) {
    await env.SQUARE_CACHE.delete(`square_session:${row.session_token_hash}`);
  }
  await env.DB.prepare(
    `DELETE FROM square_sessions WHERE cid_number = ? AND account_id = ?`
  )
    .bind(cidNumber, accountId)
    .run();
}

/// CID 换绑后只保留 finalized 当前三元组签发的会话。
///
/// 明文 token 不落 D1，因此先用强一致哈希索引删除对应 KV，再删除索引行；任一步失败
/// 都允许接管流程按同一 finalized 真值幂等重试。
export async function clearStaleIdentitySessions(
  env: Env,
  cidNumber: string,
  bindingRevision: number,
  accountId: string,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT session_token_hash
      FROM square_sessions
      WHERE cid_number = ?
        AND (binding_revision <> ? OR account_id <> ?)`,
  )
    .bind(cidNumber, bindingRevision, accountId)
    .all<SessionIndexRow>();
  for (const row of rows.results ?? []) {
    await env.SQUARE_CACHE.delete(`square_session:${row.session_token_hash}`);
  }
  await env.DB.prepare(
    `DELETE FROM square_sessions
      WHERE cid_number = ?
        AND (binding_revision <> ? OR account_id <> ?)`,
  )
    .bind(cidNumber, bindingRevision, accountId)
    .run();
}

/// KV 会按 TTL 自动淘汰会话正文；D1 只保存不可逆 token 哈希，因此由定时任务清理过期索引。
/// 此处使用 Worker 服务端时间，只处理登录态生命周期，不参与任何会员权益到期判定。
export async function cleanupExpiredSessionIndexes(
  env: Env,
  currentTime = nowMs()
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM square_sessions WHERE expires_at <= ?`
  )
    .bind(currentTime)
    .run();
}
