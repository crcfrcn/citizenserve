import { assertAccountId, assertCidNumber } from '../shared/ids';
import type { Env, IdentityLevel, UserProfileRow, UserRow } from '../types';

const BLOCK_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const IDENTITY_LEVELS = new Set<IdentityLevel>(['visitor', 'voting', 'candidate']);

export type UserRepositoryErrorCode =
  | 'invalid_finalized_user'
  | 'user_not_found'
  | 'user_registration_conflict'
  | 'user_binding_conflict'
  | 'user_binding_revision_rollback'
  | 'user_binding_block_rollback'
  | 'user_identity_conflict'
  | 'user_identity_block_rollback';

/// 用户投影只接受经过 finalized 证明的数据；错误码供后续投影与对账任务失败关闭。
export class UserRepositoryError extends Error {
  constructor(
    public readonly error_code: UserRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UserRepositoryError';
  }
}

export type FinalizedUserRegistration = UserRow;

export interface FinalizedUserBinding {
  cid_number: string;
  account_id: string;
  binding_revision: number;
  binding_finalized_block_number: number;
  binding_finalized_block_hash: string;
  binding_updated_at: number;
}

export interface FinalizedUserIdentity {
  cid_number: string;
  identity_level: IdentityLevel;
  identity_finalized_block_number: number;
  identity_finalized_block_hash: string;
  identity_updated_at: number;
}

export async function readUserByCidNumber(
  env: Env,
  cidNumber: string,
): Promise<UserRow | null> {
  const cid = assertCidNumber(cidNumber);
  return env.DB.prepare(
    `SELECT cid_number, account_id, binding_revision, identity_level,
            registration_finalized_block_number, registration_finalized_block_hash,
            binding_finalized_block_number, binding_finalized_block_hash,
            identity_finalized_block_number, identity_finalized_block_hash,
            registered_at, binding_updated_at, identity_updated_at
       FROM users
      WHERE cid_number = ?`,
  ).bind(cid).first<UserRow>();
}

export async function readUserByAccountId(
  env: Env,
  accountId: string,
): Promise<UserRow | null> {
  // 创世基线未经投影核验前不得作为登录身份返回；普通用户继续采用既有事件投影。
  const account = assertAccountId(accountId);
  return env.DB.prepare(
    `SELECT cid_number, account_id, binding_revision, identity_level,
            registration_finalized_block_number, registration_finalized_block_hash,
            binding_finalized_block_number, binding_finalized_block_hash,
            identity_finalized_block_number, identity_finalized_block_hash,
            registered_at, binding_updated_at, identity_updated_at
       FROM users
      WHERE account_id = ?
        AND (registration_finalized_block_number <> 0 OR (
          identity_finalized_block_number > 0 AND identity_finalized_block_number >= (
            SELECT finalized_block_number FROM user_projection_cursor WHERE cursor_id = 1
          )))`,
  ).bind(account).first<UserRow>();
}

/// 一页公开内容的作者身份用单条 D1 查询批量读取，禁止按作者逐条访问 D1 或回退读链。
export async function readUsersByCidNumbers(
  env: Env,
  cidNumbers: string[],
): Promise<Map<string, UserRow>> {
  const cids = [...new Set(cidNumbers.map((cidNumber) => assertCidNumber(cidNumber)))];
  if (cids.length === 0) return new Map();
  const placeholders = cids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT cid_number, account_id, binding_revision, identity_level,
            registration_finalized_block_number, registration_finalized_block_hash,
            binding_finalized_block_number, binding_finalized_block_hash,
            identity_finalized_block_number, identity_finalized_block_hash,
            registered_at, binding_updated_at, identity_updated_at
       FROM users
      WHERE cid_number IN (${placeholders})`,
  ).bind(...cids).all<UserRow>();
  return new Map((result.results ?? []).map((row) => [row.cid_number, row]));
}

export async function readUserProfile(
  env: Env,
  cidNumber: string,
): Promise<UserProfileRow | null> {
  const cid = assertCidNumber(cidNumber);
  return env.DB.prepare(
    `SELECT cid_number, display_name, bio, avatar_object_key, avatar_content_hash,
            banner_object_key, banner_content_hash, updated_at
       FROM user_profiles
      WHERE cid_number = ?`,
  ).bind(cid).first<UserProfileRow>();
}

/// finalized 注册幂等落库，并在同一 D1 batch 原子创建默认资料。
export async function createUserFromFinalizedRegistration(
  env: Env,
  registration: FinalizedUserRegistration,
): Promise<{ user: UserRow; profile: UserProfileRow }> {
  const expected = validateRegistration(registration);
  const currentByCid = await readUserByCidNumber(env, expected.cid_number);
  if (currentByCid) {
    if (!sameUser(currentByCid, expected)) {
      throw repositoryError(
        'user_registration_conflict',
        'cid_number already has a different finalized registration',
      );
    }
    await ensureDefaultProfile(env, expected.cid_number);
    return readUserAndProfile(env, expected.cid_number);
  }

  const currentByAccount = await readUserByAccountId(env, expected.account_id);
  if (currentByAccount) {
    throw repositoryError(
      'user_registration_conflict',
      'account_id is already bound to another cid_number',
    );
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (
           cid_number, account_id, binding_revision, identity_level,
           registration_finalized_block_number, registration_finalized_block_hash,
           binding_finalized_block_number, binding_finalized_block_hash,
           identity_finalized_block_number, identity_finalized_block_hash,
           registered_at, binding_updated_at, identity_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        expected.cid_number,
        expected.account_id,
        expected.binding_revision,
        expected.identity_level,
        expected.registration_finalized_block_number,
        expected.registration_finalized_block_hash,
        expected.binding_finalized_block_number,
        expected.binding_finalized_block_hash,
        expected.identity_finalized_block_number,
        expected.identity_finalized_block_hash,
        expected.registered_at,
        expected.binding_updated_at,
        expected.identity_updated_at,
      ),
      env.DB.prepare(
        'INSERT INTO user_profiles (cid_number) VALUES (?)',
      ).bind(expected.cid_number),
    ]);
  } catch {
    const concurrent = await readUserByCidNumber(env, expected.cid_number);
    if (!concurrent || !sameUser(concurrent, expected)) {
      throw repositoryError(
        'user_registration_conflict',
        'finalized registration conflicts with the current user projection',
      );
    }
    await ensureDefaultProfile(env, expected.cid_number);
  }

  return readUserAndProfile(env, expected.cid_number);
}

/// finalized 换绑只允许单调推进 revision、区块和链时间；同 revision 仅允许完全幂等重放。
export async function updateUserFromFinalizedBinding(
  env: Env,
  binding: FinalizedUserBinding,
): Promise<UserRow> {
  const expected = validateBinding(binding);
  const current = await readUserByCidNumber(env, expected.cid_number);
  if (!current) {
    throw repositoryError('user_not_found', 'cid_number has no user projection');
  }

  if (expected.binding_revision < current.binding_revision) {
    throw repositoryError(
      'user_binding_revision_rollback',
      'binding_revision cannot move backwards',
    );
  }
  if (expected.binding_revision === current.binding_revision) {
    if (!sameBinding(current, expected)) {
      throw repositoryError(
        'user_binding_conflict',
        'the same binding_revision contains different finalized data',
      );
    }
    return current;
  }
  if (
    expected.binding_finalized_block_number < current.binding_finalized_block_number
    || expected.binding_updated_at < current.binding_updated_at
  ) {
    throw repositoryError(
      'user_binding_block_rollback',
      'finalized binding block or timestamp cannot move backwards',
    );
  }

  let changes = 0;
  try {
    const result = await env.DB.prepare(
      `UPDATE users
          SET account_id = ?, binding_revision = ?,
              binding_finalized_block_number = ?, binding_finalized_block_hash = ?,
              binding_updated_at = ?
        WHERE cid_number = ?
          AND binding_revision = ?
          AND binding_finalized_block_number = ?`,
    ).bind(
      expected.account_id,
      expected.binding_revision,
      expected.binding_finalized_block_number,
      expected.binding_finalized_block_hash,
      expected.binding_updated_at,
      expected.cid_number,
      current.binding_revision,
      current.binding_finalized_block_number,
    ).run();
    changes = result.meta.changes ?? 0;
  } catch {
    throw repositoryError(
      'user_binding_conflict',
      'target account_id is already bound or the projection changed concurrently',
    );
  }

  const updated = await readUserByCidNumber(env, expected.cid_number);
  if (changes !== 1 || !updated || !sameBinding(updated, expected)) {
    throw repositoryError(
      'user_binding_conflict',
      'the user projection changed while applying the finalized binding',
    );
  }
  return updated;
}

/// 身份档位是独立 finalized 投影轴；不得借身份更新改写 CID 绑定或会员档位。
export async function updateUserFromFinalizedIdentity(
  env: Env,
  identity: FinalizedUserIdentity,
): Promise<UserRow> {
  const expected = validateIdentity(identity);
  const current = await readUserByCidNumber(env, expected.cid_number);
  if (!current) {
    throw repositoryError('user_not_found', 'cid_number has no user projection');
  }
  if (
    expected.identity_finalized_block_number < current.identity_finalized_block_number
    || expected.identity_updated_at < current.identity_updated_at
  ) {
    throw repositoryError(
      'user_identity_block_rollback',
      'finalized identity block or timestamp cannot move backwards',
    );
  }
  if (expected.identity_finalized_block_number === current.identity_finalized_block_number) {
    if (!sameIdentity(current, expected)) {
      throw repositoryError(
        'user_identity_conflict',
        'the same finalized identity block contains different data',
      );
    }
    return current;
  }

  const result = await env.DB.prepare(
    `UPDATE users
        SET identity_level = ?, identity_finalized_block_number = ?,
            identity_finalized_block_hash = ?, identity_updated_at = ?
      WHERE cid_number = ?
        AND identity_finalized_block_number = ?`,
  ).bind(
    expected.identity_level,
    expected.identity_finalized_block_number,
    expected.identity_finalized_block_hash,
    expected.identity_updated_at,
    expected.cid_number,
    current.identity_finalized_block_number,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw repositoryError(
      'user_identity_conflict',
      'the user identity projection changed concurrently',
    );
  }
  const updated = await readUserByCidNumber(env, expected.cid_number);
  if (!updated || !sameIdentity(updated, expected)) {
    throw repositoryError(
      'user_identity_conflict',
      'the finalized identity projection was not persisted',
    );
  }
  return updated;
}

async function ensureDefaultProfile(env: Env, cidNumber: string): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO user_profiles (cid_number) VALUES (?)',
  ).bind(cidNumber).run();
}

async function readUserAndProfile(
  env: Env,
  cidNumber: string,
): Promise<{ user: UserRow; profile: UserProfileRow }> {
  const [user, profile] = await Promise.all([
    readUserByCidNumber(env, cidNumber),
    readUserProfile(env, cidNumber),
  ]);
  if (!user || !profile) {
    throw repositoryError(
      'user_registration_conflict',
      'user and default profile were not created atomically',
    );
  }
  return { user, profile };
}

function validateRegistration(input: FinalizedUserRegistration): UserRow {
  const user: UserRow = {
    cid_number: validateCid(input.cid_number),
    account_id: validateAccount(input.account_id),
    binding_revision: positiveInteger(input.binding_revision, 'binding_revision'),
    identity_level: validateIdentityLevel(input.identity_level),
    registration_finalized_block_number: nonNegativeInteger(
      input.registration_finalized_block_number,
      'registration_finalized_block_number',
    ),
    registration_finalized_block_hash: blockHash(
      input.registration_finalized_block_hash,
      'registration_finalized_block_hash',
    ),
    binding_finalized_block_number: nonNegativeInteger(
      input.binding_finalized_block_number,
      'binding_finalized_block_number',
    ),
    binding_finalized_block_hash: blockHash(
      input.binding_finalized_block_hash,
      'binding_finalized_block_hash',
    ),
    identity_finalized_block_number: nonNegativeInteger(
      input.identity_finalized_block_number,
      'identity_finalized_block_number',
    ),
    identity_finalized_block_hash: blockHash(
      input.identity_finalized_block_hash,
      'identity_finalized_block_hash',
    ),
    registered_at: nonNegativeInteger(input.registered_at, 'registered_at'),
    binding_updated_at: nonNegativeInteger(input.binding_updated_at, 'binding_updated_at'),
    identity_updated_at: nonNegativeInteger(input.identity_updated_at, 'identity_updated_at'),
  };
  if (
    user.binding_finalized_block_number < user.registration_finalized_block_number
    || user.identity_finalized_block_number < user.registration_finalized_block_number
    || user.binding_updated_at < user.registered_at
    || user.identity_updated_at < user.registered_at
  ) {
    throw repositoryError(
      'invalid_finalized_user',
      'binding or identity finalized position cannot precede registration',
    );
  }
  return user;
}

function validateIdentity(input: FinalizedUserIdentity): FinalizedUserIdentity {
  return {
    cid_number: validateCid(input.cid_number),
    identity_level: validateIdentityLevel(input.identity_level),
    identity_finalized_block_number: nonNegativeInteger(
      input.identity_finalized_block_number,
      'identity_finalized_block_number',
    ),
    identity_finalized_block_hash: blockHash(
      input.identity_finalized_block_hash,
      'identity_finalized_block_hash',
    ),
    identity_updated_at: nonNegativeInteger(
      input.identity_updated_at,
      'identity_updated_at',
    ),
  };
}

function validateBinding(input: FinalizedUserBinding): FinalizedUserBinding {
  return {
    cid_number: validateCid(input.cid_number),
    account_id: validateAccount(input.account_id),
    binding_revision: positiveInteger(input.binding_revision, 'binding_revision'),
    binding_finalized_block_number: nonNegativeInteger(
      input.binding_finalized_block_number,
      'binding_finalized_block_number',
    ),
    binding_finalized_block_hash: blockHash(
      input.binding_finalized_block_hash,
      'binding_finalized_block_hash',
    ),
    binding_updated_at: nonNegativeInteger(input.binding_updated_at, 'binding_updated_at'),
  };
}

function validateCid(value: unknown): string {
  try {
    return assertCidNumber(value);
  } catch {
    throw repositoryError('invalid_finalized_user', 'invalid cid_number');
  }
}

function validateAccount(value: unknown): string {
  try {
    return assertAccountId(value);
  } catch {
    throw repositoryError('invalid_finalized_user', 'invalid account_id');
  }
}

function validateIdentityLevel(value: unknown): IdentityLevel {
  if (typeof value !== 'string' || !IDENTITY_LEVELS.has(value as IdentityLevel)) {
    throw repositoryError('invalid_finalized_user', 'invalid identity_level');
  }
  return value as IdentityLevel;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) {
    throw repositoryError('invalid_finalized_user', `${field} must be positive`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw repositoryError(
      'invalid_finalized_user',
      `${field} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function blockHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !BLOCK_HASH_PATTERN.test(value)) {
    throw repositoryError(
      'invalid_finalized_user',
      `${field} must be lowercase 0x followed by 64 hexadecimal characters`,
    );
  }
  return value;
}

function sameUser(left: UserRow, right: UserRow): boolean {
  return left.cid_number === right.cid_number
    && left.account_id === right.account_id
    && left.binding_revision === right.binding_revision
    && left.identity_level === right.identity_level
    && left.registration_finalized_block_number === right.registration_finalized_block_number
    && left.registration_finalized_block_hash === right.registration_finalized_block_hash
    && left.binding_finalized_block_number === right.binding_finalized_block_number
    && left.binding_finalized_block_hash === right.binding_finalized_block_hash
    && left.identity_finalized_block_number === right.identity_finalized_block_number
    && left.identity_finalized_block_hash === right.identity_finalized_block_hash
    && left.registered_at === right.registered_at
    && left.binding_updated_at === right.binding_updated_at
    && left.identity_updated_at === right.identity_updated_at;
}

function sameIdentity(left: UserRow, right: FinalizedUserIdentity): boolean {
  return left.cid_number === right.cid_number
    && left.identity_level === right.identity_level
    && left.identity_finalized_block_number === right.identity_finalized_block_number
    && left.identity_finalized_block_hash === right.identity_finalized_block_hash
    && left.identity_updated_at === right.identity_updated_at;
}

function sameBinding(left: UserRow, right: FinalizedUserBinding): boolean {
  return left.cid_number === right.cid_number
    && left.account_id === right.account_id
    && left.binding_revision === right.binding_revision
    && left.binding_finalized_block_number === right.binding_finalized_block_number
    && left.binding_finalized_block_hash === right.binding_finalized_block_hash
    && left.binding_updated_at === right.binding_updated_at;
}

function repositoryError(
  errorCode: UserRepositoryErrorCode,
  message: string,
): UserRepositoryError {
  return new UserRepositoryError(errorCode, message);
}
