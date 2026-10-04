import {
  decodeCitizenIdentityEvents,
  type CitizenIdentityEvent,
} from '../chain/citizen_identity_event';
import {
  fetchChainCidProjectionStatesAtBlock,
  type ChainCidProjectionState,
} from '../chain/identity';
import {
  fetchBlockHeader,
  fetchCanonicalBlockHash,
  fetchFinalizedHead,
  fetchSystemEventsAtBlock,
  isChainRpcConfigured,
} from '../chain/rpc';
import { readChainTimestampAtBlock } from '../chain/subscription';
import { HttpError, jsonResponse, readJson } from '../shared/http';
import { nowMs } from '../shared/time';
import type { Env, UserProjectionCursorRow } from '../types';
import { purgeIdentity } from './purge';
import {
  createUserFromFinalizedRegistration,
  readUserByCidNumber,
  updateUserFromFinalizedBinding,
  updateUserFromFinalizedIdentity,
  UserRepositoryError,
} from './user_repository';

const BLOCK_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const USER_PROJECTION_BLOCK_BATCH = 10;
const USER_PROJECTION_HEALTH_CACHE_KEY = 'health:user_projection';
const USER_PROJECTION_HEALTH_CACHE_SECONDS = 60;

export interface UserProjectionDeps {
  fetchFinalizedHead: typeof fetchFinalizedHead;
  fetchBlockHeader: typeof fetchBlockHeader;
  fetchCanonicalBlockHash: typeof fetchCanonicalBlockHash;
  fetchSystemEventsAtBlock: typeof fetchSystemEventsAtBlock;
  readChainTimestampAtBlock: typeof readChainTimestampAtBlock;
  fetchChainCidProjectionStatesAtBlock: typeof fetchChainCidProjectionStatesAtBlock;
  purgeIdentity: typeof purgeIdentity;
}

const defaultDeps: UserProjectionDeps = {
  fetchFinalizedHead,
  fetchBlockHeader,
  fetchCanonicalBlockHash,
  fetchSystemEventsAtBlock,
  readChainTimestampAtBlock,
  fetchChainCidProjectionStatesAtBlock,
  purgeIdentity,
};

export interface UserBlockProjectionResult {
  finalized_block_number: number;
  finalized_block_hash: string;
  identity_event_count: number;
  projected_user_count: number;
  revoked_user_count: number;
}

export interface UserProjectionReconcileResult {
  enabled: boolean;
  processed_block_count: number;
  projected_user_count: number;
  revoked_user_count: number;
  finalized_block_number: number | null;
  cursor_block_number: number | null;
}

/// 对外只暴露投影是否已经追到当前 finalized 头；它复用现有游标表，不创建新表或迁移数据。
export interface UserProjectionHealth {
  identity_projection_status: 'ready' | 'pending' | 'unavailable';
  finalized_block_number: number | null;
  cursor_block_number: number | null;
}

interface FinalizedBlockPoint {
  block_number: number;
  block_hash: string;
  chain_timestamp: number;
}

interface UserConfirmRequest {
  block_hash?: unknown;
}

/// POST /square/users/confirm：只接收 finalized 区块定位，用户关系全部从该区块事件和 storage 读取。
export async function confirmFinalizedUsersRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson<UserConfirmRequest>(request);
  const blockHash = requireBlockHash(body.block_hash);
  try {
    const result = await projectFinalizedUserBlock(env, blockHash);
    return jsonResponse({ ok: true, projection: result });
  } catch (error) {
    if (error instanceof UserRepositoryError) {
      throw new HttpError(409, error.error_code, error.message);
    }
    throw error;
  }
}

/// 确认入口必须证明目标区块已 finalized 且属于 canonical 主链，然后才能读取事件并投影。
export async function projectFinalizedUserBlock(
  env: Env,
  blockHash: string,
  deps: UserProjectionDeps = defaultDeps,
): Promise<UserBlockProjectionResult> {
  const normalizedHash = requireBlockHash(blockHash);
  const finalizedHash = await deps.fetchFinalizedHead(env);
  const [targetHeader, finalizedHeader] = await Promise.all([
    deps.fetchBlockHeader(env, normalizedHash),
    deps.fetchBlockHeader(env, finalizedHash),
  ]);
  const targetNumber = parseBlockNumber(targetHeader.number);
  const finalizedNumber = parseBlockNumber(finalizedHeader.number);
  if (targetNumber > finalizedNumber) {
    throw new HttpError(409, 'user_projection_block_not_finalized', '身份事件区块尚未 finalized');
  }
  const canonicalHash = await deps.fetchCanonicalBlockHash(env, targetNumber);
  if (canonicalHash !== normalizedHash) {
    throw new HttpError(409, 'user_projection_block_not_canonical', '身份事件区块不属于 canonical 主链');
  }
  const chainTimestamp = await deps.readChainTimestampAtBlock(env, normalizedHash);
  return projectCanonicalBlock(env, {
    block_number: targetNumber,
    block_hash: normalizedHash,
    chain_timestamp: chainTimestamp,
  }, deps);
}

/// Cron 从强一致 D1 游标继续扫描；普通 Chat、主页、动态请求绝不调用本函数。
export async function reconcileFinalizedUserProjection(
  env: Env,
  deps: UserProjectionDeps = defaultDeps,
): Promise<UserProjectionReconcileResult> {
  if (!isChainRpcConfigured(env)) {
    return {
      enabled: false,
      processed_block_count: 0,
      projected_user_count: 0,
      revoked_user_count: 0,
      finalized_block_number: null,
      cursor_block_number: null,
    };
  }

  const finalizedHash = await deps.fetchFinalizedHead(env);
  const finalizedHeader = await deps.fetchBlockHeader(env, finalizedHash);
  const finalizedNumber = parseBlockNumber(finalizedHeader.number);
  let cursor = await ensureProjectionCursor(env, deps);
  const canonicalCursorHash = await deps.fetchCanonicalBlockHash(
    env,
    cursor.finalized_block_number,
  );
  if (canonicalCursorHash !== cursor.finalized_block_hash) {
    throw new HttpError(
      409,
      'user_projection_cursor_not_canonical',
      '用户投影游标不属于 canonical 主链',
    );
  }

  // 创世没有注册事件；已有游标也必须核验基线身份，不能只在首次初始化扫描。
  await reconcileGenesisUsers(env, {
    block_number: finalizedNumber,
    block_hash: finalizedHash,
    chain_timestamp: await deps.readChainTimestampAtBlock(env, finalizedHash),
  }, deps);

  const lastBlock = Math.min(
    finalizedNumber,
    cursor.finalized_block_number + USER_PROJECTION_BLOCK_BATCH,
  );
  let processedBlocks = 0;
  let projectedUsers = 0;
  let revokedUsers = 0;
  for (
    let blockNumber = cursor.finalized_block_number + 1;
    blockNumber <= lastBlock;
    blockNumber += 1
  ) {
    const blockHash = await deps.fetchCanonicalBlockHash(env, blockNumber);
    const chainTimestamp = await deps.readChainTimestampAtBlock(env, blockHash);
    const result = await projectCanonicalBlock(env, {
      block_number: blockNumber,
      block_hash: blockHash,
      chain_timestamp: chainTimestamp,
    }, deps);
    cursor = await advanceProjectionCursor(env, cursor, blockNumber, blockHash);
    processedBlocks += 1;
    projectedUsers += result.projected_user_count;
    revokedUsers += result.revoked_user_count;
  }

  return {
    enabled: true,
    processed_block_count: processedBlocks,
    projected_user_count: projectedUsers,
    revoked_user_count: revokedUsers,
    finalized_block_number: finalizedNumber,
    cursor_block_number: cursor.finalized_block_number,
  };
}

/// 判断用户投影是否足以证明一个账户“确实未绑定”。游标落后时只能判同步中，
/// 链配置或 RPC 不可用时只能判服务不可用，禁止把这两种情况降级成 cid_not_bound。
export async function inspectUserProjectionHealth(
  env: Env,
  deps: Pick<UserProjectionDeps, 'fetchFinalizedHead' | 'fetchBlockHeader'> = defaultDeps,
): Promise<UserProjectionHealth> {
  if (!isChainRpcConfigured(env)) {
    return {
      identity_projection_status: 'unavailable',
      finalized_block_number: null,
      cursor_block_number: null,
    };
  }

  let cursor: UserProjectionCursorRow | null;
  try {
    cursor = await readProjectionCursor(env);
  } catch {
    return {
      identity_projection_status: 'unavailable',
      finalized_block_number: null,
      cursor_block_number: null,
    };
  }
  if (!cursor) {
    return {
      identity_projection_status: 'pending',
      finalized_block_number: null,
      cursor_block_number: null,
    };
  }

  try {
    const finalizedHash = await deps.fetchFinalizedHead(env);
    const finalizedHeader = await deps.fetchBlockHeader(env, finalizedHash);
    const finalizedNumber = parseBlockNumber(finalizedHeader.number);
    const cursorNumber = cursor.finalized_block_number;
    if (cursorNumber < finalizedNumber) {
      return {
        identity_projection_status: 'pending',
        finalized_block_number: finalizedNumber,
        cursor_block_number: cursorNumber,
      };
    }
    if (cursorNumber === finalizedNumber && cursor.finalized_block_hash === finalizedHash) {
      const unverifiedGenesis = await env.DB.prepare(
        `SELECT cid_number FROM users WHERE registration_finalized_block_number = 0
          AND (identity_finalized_block_number = 0 OR identity_finalized_block_number < ?) LIMIT 1`,
      ).bind(finalizedNumber).first();
      return {
        identity_projection_status: unverifiedGenesis ? 'pending' : 'ready',
        finalized_block_number: finalizedNumber,
        cursor_block_number: cursorNumber,
      };
    }
    // 游标超前或同高度哈希不一致都不是“未绑定”证据，按投影不可用失败关闭。
    return {
      identity_projection_status: 'unavailable',
      finalized_block_number: finalizedNumber,
      cursor_block_number: cursorNumber,
    };
  } catch {
    return {
      identity_projection_status: 'unavailable',
      finalized_block_number: null,
      cursor_block_number: cursor.finalized_block_number,
    };
  }
}

/// 公共健康接口复用短时 KV 结果，避免匿名探活请求按次数放大内部链 RPC；登录缺失账户的
/// 安全判定仍直接调用上面的实时检查，不读取此缓存。
export async function inspectCachedUserProjectionHealth(
  env: Env,
  deps: Pick<UserProjectionDeps, 'fetchFinalizedHead' | 'fetchBlockHeader'> = defaultDeps,
): Promise<UserProjectionHealth> {
  try {
    const cached = await env.SQUARE_CACHE.get<UserProjectionHealth>(
      USER_PROJECTION_HEALTH_CACHE_KEY,
      'json',
    );
    if (isUserProjectionHealth(cached)) return cached;
  } catch {
    // KV 探活缓存损坏或暂时不可读时回退实时检查，不能把缓存故障伪装成投影故障。
  }
  const health = await inspectUserProjectionHealth(env, deps);
  try {
    await env.SQUARE_CACHE.put(
      USER_PROJECTION_HEALTH_CACHE_KEY,
      JSON.stringify(health),
      { expirationTtl: USER_PROJECTION_HEALTH_CACHE_SECONDS },
    );
  } catch {
    // 缓存写失败只影响探活成本，不改变本次真实投影结论。
  }
  return health;
}

function isUserProjectionHealth(value: unknown): value is UserProjectionHealth {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UserProjectionHealth>;
  return (
    candidate.identity_projection_status === 'ready'
    || candidate.identity_projection_status === 'pending'
    || candidate.identity_projection_status === 'unavailable'
  ) && (
    candidate.finalized_block_number === null
    || Number.isSafeInteger(candidate.finalized_block_number)
  ) && (
    candidate.cursor_block_number === null
    || Number.isSafeInteger(candidate.cursor_block_number)
  );
}

async function projectCanonicalBlock(
  env: Env,
  point: FinalizedBlockPoint,
  deps: UserProjectionDeps,
): Promise<UserBlockProjectionResult> {
  const eventsHex = await deps.fetchSystemEventsAtBlock(env, point.block_hash);
  const events = decodeCitizenIdentityEvents(eventsHex);
  const grouped = groupEventsByCid(events);
  const states = await deps.fetchChainCidProjectionStatesAtBlock(
    env,
    [...grouped.keys()],
    point.block_hash,
    point.chain_timestamp,
  );
  let projectedUsers = 0;
  let revokedUsers = 0;

  for (const [cidNumber, cidEvents] of grouped) {
    const state = states.get(cidNumber) ?? null;
    if (!state) {
      throw new HttpError(
        409,
        'user_projection_state_missing',
        '身份事件缺少同区块 CidRegistry 状态',
      );
    }
    validateEventState(cidEvents, state);

    const current = await readUserByCidNumber(env, cidNumber);
    if (state.cid_record_status === 'Revoked') {
      if (current) {
        await deps.purgeIdentity(env, cidNumber);
        revokedUsers += 1;
      }
      continue;
    }

    if (!state.account_id) {
      throw new HttpError(
        409,
        'user_projection_binding_missing',
        'Active CID 缺少 AccountIdByCid',
      );
    }
    if (!current) {
      const registration = await registrationAnchor(env, state, point, deps);
      await createUserFromFinalizedRegistration(env, {
        cid_number: cidNumber,
        account_id: state.account_id,
        binding_revision: state.binding_revision,
        identity_level: state.identity_level,
        registration_finalized_block_number: registration.block_number,
        registration_finalized_block_hash: registration.block_hash,
        binding_finalized_block_number: point.block_number,
        binding_finalized_block_hash: point.block_hash,
        identity_finalized_block_number: point.block_number,
        identity_finalized_block_hash: point.block_hash,
        registered_at: registration.chain_timestamp,
        binding_updated_at: point.chain_timestamp,
        identity_updated_at: point.chain_timestamp,
      });
      projectedUsers += 1;
      continue;
    }

    if (point.block_number >= current.binding_finalized_block_number) {
      if (state.binding_revision < current.binding_revision) {
        throw new HttpError(
          409,
          'user_projection_binding_revision_rollback',
          'finalized 身份事件试图回退 binding_revision',
        );
      }
      if (state.binding_revision === current.binding_revision) {
        if (state.account_id !== current.account_id) {
          throw new HttpError(
            409,
            'user_projection_binding_conflict',
            '同一 binding_revision 对应不同 AccountId',
          );
        }
      } else {
        await updateUserFromFinalizedBinding(env, {
          cid_number: cidNumber,
          account_id: state.account_id,
          binding_revision: state.binding_revision,
          binding_finalized_block_number: point.block_number,
          binding_finalized_block_hash: point.block_hash,
          binding_updated_at: point.chain_timestamp,
        });
      }
    }

    if (point.block_number >= current.identity_finalized_block_number) {
      await updateUserFromFinalizedIdentity(env, {
        cid_number: cidNumber,
        identity_level: state.identity_level,
        identity_finalized_block_number: point.block_number,
        identity_finalized_block_hash: point.block_hash,
        identity_updated_at: point.chain_timestamp,
      });
    }
    projectedUsers += 1;
  }

  return {
    finalized_block_number: point.block_number,
    finalized_block_hash: point.block_hash,
    identity_event_count: events.length,
    projected_user_count: projectedUsers,
    revoked_user_count: revokedUsers,
  };
}

/// 创世候选仅来自最终schema中的第0块登记；当前绑定与有效性仍以finalized链为真源。
async function reconcileGenesisUsers(
  env: Env, point: FinalizedBlockPoint, deps: UserProjectionDeps,
): Promise<void> {
  const rows = await env.DB.prepare(
    'SELECT cid_number, registration_finalized_block_hash FROM users WHERE registration_finalized_block_number = 0',
  ).all<{ cid_number: string; registration_finalized_block_hash: string }>();
  const seeds = rows.results ?? [];
  if (seeds.length === 0) return;
  const genesisHash = await deps.fetchCanonicalBlockHash(env, 0);
  if (seeds.some((row) => row.registration_finalized_block_hash !== genesisHash)) {
    throw new HttpError(409, 'user_projection_genesis_mismatch', '创世身份不属于当前链');
  }
  const states = await deps.fetchChainCidProjectionStatesAtBlock(
    env, seeds.map((row) => row.cid_number), point.block_hash, point.chain_timestamp,
  );
  for (const seed of seeds) {
    const state = states.get(seed.cid_number);
    if (!state || state.registered_block_number !== 0) {
      throw new HttpError(409, 'user_projection_state_missing', '创世身份缺少finalized登记状态');
    }
    if (state.cid_record_status === 'Revoked') {
      await deps.purgeIdentity(env, seed.cid_number);
      continue;
    }
    if (!state.account_id) {
      throw new HttpError(409, 'user_projection_binding_missing', '创世身份缺少有效绑定');
    }
    const current = await readUserByCidNumber(env, seed.cid_number);
    if (!current || state.binding_revision < current.binding_revision ||
        (state.binding_revision === current.binding_revision && state.account_id !== current.account_id)) {
      throw new HttpError(409, 'user_projection_binding_conflict', '创世身份绑定与finalized状态矛盾');
    }
    // 同版本保持原换绑锚点；只有真正的新绑定版本才推进绑定轴。
    if (state.binding_revision > current.binding_revision) {
      await updateUserFromFinalizedBinding(env, {
        cid_number: seed.cid_number, account_id: state.account_id,
        binding_revision: state.binding_revision,
        binding_finalized_block_number: point.block_number,
        binding_finalized_block_hash: point.block_hash,
        binding_updated_at: point.chain_timestamp,
      });
    }
    await updateUserFromFinalizedIdentity(env, {
      cid_number: seed.cid_number, identity_level: state.identity_level,
      identity_finalized_block_number: point.block_number,
      identity_finalized_block_hash: point.block_hash,
      identity_updated_at: point.chain_timestamp,
    });
  }
}

async function registrationAnchor(
  env: Env,
  state: ChainCidProjectionState,
  current: FinalizedBlockPoint,
  deps: UserProjectionDeps,
): Promise<FinalizedBlockPoint> {
  if (state.registered_block_number > current.block_number) {
    throw new HttpError(
      409,
      'user_projection_registration_block_invalid',
      'CidRegistry 注册区块晚于当前事件区块',
    );
  }
  if (state.registered_block_number === current.block_number) return current;
  const blockHash = await deps.fetchCanonicalBlockHash(env, state.registered_block_number);
  const chainTimestamp = state.registered_block_number === 0
    ? 0
    : await deps.readChainTimestampAtBlock(env, blockHash);
  return {
    block_number: state.registered_block_number,
    block_hash: blockHash,
    chain_timestamp: chainTimestamp,
  };
}

function validateEventState(
  events: CitizenIdentityEvent[],
  state: ChainCidProjectionState,
): void {
  const revisions = events
    .map((event) => event.binding_revision)
    .filter((revision): revision is number => revision !== null);
  if (revisions.some((revision) => revision > state.binding_revision)) {
    throw new HttpError(
      409,
      'user_projection_event_revision_invalid',
      '身份事件 revision 超过同区块 storage',
    );
  }
  if (state.cid_record_status === 'Revoked') {
    const revocationEvents = events
      .filter((event) => isRevocationEvent(event.event_name));
    if (revocationEvents.length === 0) {
      throw new HttpError(
        409,
        'user_projection_revocation_event_missing',
        'CidRegistry 已撤销但本区块没有对应撤销事件',
      );
    }
    const revocationRevisions = revocationEvents
      .map((event) => event.binding_revision)
      .filter((revision): revision is number => revision !== null);
    if (!revocationRevisions.includes(state.binding_revision)) {
      throw new HttpError(
        409,
        'user_projection_revocation_revision_invalid',
        '撤销事件 revision 与同区块 CidRegistry 不一致',
      );
    }
  } else if (hasRevocationEvent(events)) {
    throw new HttpError(
      409,
      'user_projection_revocation_state_invalid',
      '撤销事件与同区块 Active CidRegistry 冲突',
    );
  }
}

function groupEventsByCid(
  events: CitizenIdentityEvent[],
): Map<string, CitizenIdentityEvent[]> {
  const grouped = new Map<string, CitizenIdentityEvent[]>();
  for (const event of events) {
    const current = grouped.get(event.cid_number) ?? [];
    current.push(event);
    grouped.set(event.cid_number, current);
  }
  return grouped;
}

function hasRevocationEvent(events: CitizenIdentityEvent[]): boolean {
  return events.some((event) => isRevocationEvent(event.event_name));
}

function isRevocationEvent(eventName: CitizenIdentityEvent['event_name']): boolean {
  return eventName === 'CitizenIdentityRevoked' || eventName === 'CidRevoked';
}

async function ensureProjectionCursor(
  env: Env,
  deps: UserProjectionDeps,
): Promise<UserProjectionCursorRow> {
  const existing = await readProjectionCursor(env);
  if (existing) return existing;
  const genesisHash = await deps.fetchCanonicalBlockHash(env, 0);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_projection_cursor
      (cursor_id, finalized_block_number, finalized_block_hash, updated_at)
      VALUES (1, 0, ?, ?)`,
  ).bind(genesisHash, nowMs()).run();
  const created = await readProjectionCursor(env);
  if (!created) throw new Error('user projection cursor was not created');
  return created;
}

async function readProjectionCursor(env: Env): Promise<UserProjectionCursorRow | null> {
  return env.DB.prepare(
    `SELECT cursor_id, finalized_block_number, finalized_block_hash, updated_at
       FROM user_projection_cursor WHERE cursor_id = 1`,
  ).first<UserProjectionCursorRow>();
}

async function advanceProjectionCursor(
  env: Env,
  previous: UserProjectionCursorRow,
  blockNumber: number,
  blockHash: string,
): Promise<UserProjectionCursorRow> {
  const result = await env.DB.prepare(
    `UPDATE user_projection_cursor
        SET finalized_block_number = ?, finalized_block_hash = ?, updated_at = ?
      WHERE cursor_id = 1
        AND finalized_block_number = ?
        AND finalized_block_hash = ?`,
  ).bind(
    blockNumber,
    blockHash,
    nowMs(),
    previous.finalized_block_number,
    previous.finalized_block_hash,
  ).run();
  if ((result.meta.changes ?? 0) === 1) {
    const advanced = await readProjectionCursor(env);
    if (advanced) return advanced;
  }
  const concurrent = await readProjectionCursor(env);
  if (concurrent && concurrent.finalized_block_number >= blockNumber) return concurrent;
  throw new HttpError(
    409,
    'user_projection_cursor_conflict',
    '用户投影游标发生并发冲突',
  );
}

function requireBlockHash(value: unknown): string {
  if (typeof value !== 'string' || !BLOCK_HASH_PATTERN.test(value)) {
    throw new HttpError(
      400,
      'invalid_finalized_block_hash',
      'block_hash 必须是小写 0x 加 64 位十六进制',
    );
  }
  return value;
}

function parseBlockNumber(value: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new HttpError(502, 'chain_block_number_invalid', '链服务节点返回无效区块号');
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(502, 'chain_block_number_invalid', '链服务节点区块号超出安全范围');
  }
  return parsed;
}
