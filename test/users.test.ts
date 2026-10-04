import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';

import {
  createUserFromFinalizedRegistration,
  readUserByAccountId,
  readUserByCidNumber,
  readUserProfile,
  readUsersByCidNumbers,
  updateUserFromFinalizedBinding,
  updateUserFromFinalizedIdentity,
} from '../src/account/user_repository';
import { readProfileDoc, writeProfileDoc } from '../src/profiles/repository';
import type {
  Env,
  IdentityLevel,
  UserRow,
} from '../src/types';
import { createTestMiniflare } from './miniflare';

const ACCOUNT_A = `0x${'11'.repeat(32)}`;
const ACCOUNT_B = `0x${'22'.repeat(32)}`;
const ACCOUNT_C = `0x${'33'.repeat(32)}`;
const BLOCK_A = `0x${'aa'.repeat(32)}`;
const BLOCK_B = `0x${'bb'.repeat(32)}`;
const CID_A = 'CN220-CTZN2-100000001-2026';
const CID_B = 'CN220-CTZN2-100000002-2026';
const SCHEMA_SQL = readFileSync(
  resolve(process.cwd(), 'schema/citizenserve.sql'),
  'utf8',
);

let miniflare: Miniflare;
let env: Env;

describe('finalized 用户账户 D1 投影', () => {
  beforeEach(async () => {
    miniflare = createTestMiniflare({
      d1Bindings: ['DB'],
    });
    env = await miniflare.getBindings<Env>();
    await applySchema(env);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('创世 schema 建立用户表、资料表和级联外键', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('users', 'user_profiles')
        ORDER BY name`,
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(['user_profiles', 'users']);

    const foreignKeys = await env.DB.prepare(
      'PRAGMA foreign_key_list(user_profiles)',
    ).all<{ table: string; from: string; to: string; on_delete: string }>();
    expect(foreignKeys.results).toContainEqual(expect.objectContaining({
      table: 'users',
      from: 'cid_number',
      to: 'cid_number',
      on_delete: 'CASCADE',
    }));
  });

  it('finalized 注册原子创建用户和默认资料', async () => {
    const created = await createUserFromFinalizedRegistration(env, registration());
    expect(created.user).toEqual(registration());
    expect(created.profile).toEqual({
      cid_number: CID_A,
      display_name: '',
      bio: '',
      avatar_object_key: null,
      avatar_content_hash: null,
      banner_object_key: null,
      banner_content_hash: null,
      updated_at: 0,
    });
    expect(await readUserByCidNumber(env, CID_A)).toEqual(created.user);
    expect(await readUserByAccountId(env, ACCOUNT_A)).toEqual(created.user);
  });

  it('一页作者身份使用单条 D1 查询批量读取并去重 CID', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    await createUserFromFinalizedRegistration(env, registration({
      cid_number: CID_B,
      account_id: ACCOUNT_B,
    }));

    const users = await readUsersByCidNumbers(env, [CID_B, CID_A, CID_B]);

    expect(users.size).toBe(2);
    expect(users.get(CID_A)?.account_id).toBe(ACCOUNT_A);
    expect(users.get(CID_B)?.account_id).toBe(ACCOUNT_B);
  });

  it('公开资料只读写 D1，并由 schema 固定媒体对象键与 SHA-256', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    const contentHash = 'ab'.repeat(32);
    await writeProfileDoc(env, {
      schema: 'citizenapp.square.profile',
      cid_number: CID_A,
      display_name: '公民',
      bio: '个性签名',
      avatar_object_key: `profile/${CID_A}/avatar`,
      avatar_content_hash: contentHash,
      banner_object_key: null,
      banner_content_hash: null,
      updated_at: 2_000,
    });
    expect(await readProfileDoc(env, CID_A)).toEqual({
      schema: 'citizenapp.square.profile',
      cid_number: CID_A,
      display_name: '公民',
      bio: '个性签名',
      avatar_object_key: `profile/${CID_A}/avatar`,
      avatar_content_hash: contentHash,
      banner_object_key: null,
      banner_content_hash: null,
      updated_at: 2_000,
    });

    await expect(
      env.DB.prepare(
        'UPDATE user_profiles SET avatar_object_key = ?, avatar_content_hash = ? WHERE cid_number = ?',
      ).bind(`profile/${CID_A}/other`, contentHash, CID_A).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        'UPDATE user_profiles SET avatar_object_key = ?, avatar_content_hash = NULL WHERE cid_number = ?',
      ).bind(`profile/${CID_A}/avatar`, CID_A).run(),
    ).rejects.toThrow();
  });

  it('完全相同的 finalized 注册可安全幂等重放', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    await createUserFromFinalizedRegistration(env, registration());

    const users = await countRows('users');
    const profiles = await countRows('user_profiles');
    expect(users).toBe(2);
    expect(profiles).toBe(2);
  });

  it('同一 CID 的不同注册事实失败关闭', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    await expectErrorCode(
      createUserFromFinalizedRegistration(env, registration({ account_id: ACCOUNT_B })),
      'user_registration_conflict',
    );
    expect((await readUserByCidNumber(env, CID_A))?.account_id).toBe(ACCOUNT_A);
  });

  it('同一当前账户不能同时控制两个 CID', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    await expectErrorCode(
      createUserFromFinalizedRegistration(env, registration({ cid_number: CID_B })),
      'user_registration_conflict',
    );
    expect(await readUserByCidNumber(env, CID_B)).toBeNull();
  });

  it('finalized 换绑更新当前账户并保留永久 CID 和资料', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    const binding = {
      cid_number: CID_A,
      account_id: ACCOUNT_B,
      binding_revision: 2,
      binding_finalized_block_number: 101,
      binding_finalized_block_hash: BLOCK_B,
      binding_updated_at: 2_000,
    };
    const updated = await updateUserFromFinalizedBinding(env, binding);
    const replayed = await updateUserFromFinalizedBinding(env, binding);

    expect(updated).toMatchObject({
      cid_number: CID_A,
      account_id: ACCOUNT_B,
      binding_revision: 2,
      registration_finalized_block_number: 100,
    });
    expect(await readUserByAccountId(env, ACCOUNT_A)).toBeNull();
    expect((await readUserByAccountId(env, ACCOUNT_B))?.cid_number).toBe(CID_A);
    expect(await readUserProfile(env, CID_A)).not.toBeNull();
    expect(replayed).toEqual(updated);
  });

  it('finalized 身份档位独立推进且不能回退区块', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    const updated = await updateUserFromFinalizedIdentity(env, {
      cid_number: CID_A,
      identity_level: 'voting',
      identity_finalized_block_number: 102,
      identity_finalized_block_hash: BLOCK_B,
      identity_updated_at: 2_000,
    });
    expect(updated).toMatchObject({
      identity_level: 'voting',
      account_id: ACCOUNT_A,
      binding_revision: 1,
    });
    await expectErrorCode(
      updateUserFromFinalizedIdentity(env, {
        cid_number: CID_A,
        identity_level: 'visitor',
        identity_finalized_block_number: 101,
        identity_finalized_block_hash: BLOCK_A,
        identity_updated_at: 1_500,
      }),
      'user_identity_block_rollback',
    );
  });

  it('拒绝 revision 回退、finalized 区块回退和链时间回退', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    await updateUserFromFinalizedBinding(env, {
      cid_number: CID_A,
      account_id: ACCOUNT_B,
      binding_revision: 2,
      binding_finalized_block_number: 101,
      binding_finalized_block_hash: BLOCK_B,
      binding_updated_at: 2_000,
    });
    await expectErrorCode(
      updateUserFromFinalizedBinding(env, {
        cid_number: CID_A,
        account_id: ACCOUNT_A,
        binding_revision: 1,
        binding_finalized_block_number: 100,
        binding_finalized_block_hash: BLOCK_A,
        binding_updated_at: 1_000,
      }),
      'user_binding_revision_rollback',
    );
    await expectErrorCode(
      updateUserFromFinalizedBinding(env, {
        cid_number: CID_A,
        account_id: ACCOUNT_C,
        binding_revision: 3,
        binding_finalized_block_number: 100,
        binding_finalized_block_hash: BLOCK_A,
        binding_updated_at: 3_000,
      }),
      'user_binding_block_rollback',
    );
    await expectErrorCode(
      updateUserFromFinalizedBinding(env, {
        cid_number: CID_A,
        account_id: ACCOUNT_C,
        binding_revision: 3,
        binding_finalized_block_number: 102,
        binding_finalized_block_hash: BLOCK_A,
        binding_updated_at: 1_999,
      }),
      'user_binding_block_rollback',
    );
  });

  it('同 revision 的不同 finalized 事实和已占用目标账户均冲突', async () => {
    await createUserFromFinalizedRegistration(env, registration());
    await expectErrorCode(
      updateUserFromFinalizedBinding(env, {
        cid_number: CID_A,
        account_id: ACCOUNT_B,
        binding_revision: 1,
        binding_finalized_block_number: 100,
        binding_finalized_block_hash: BLOCK_A,
        binding_updated_at: 1_000,
      }),
      'user_binding_conflict',
    );

    await createUserFromFinalizedRegistration(env, registration({
      cid_number: CID_B,
      account_id: ACCOUNT_C,
    }));
    await expectErrorCode(
      updateUserFromFinalizedBinding(env, {
        cid_number: CID_A,
        account_id: ACCOUNT_C,
        binding_revision: 2,
        binding_finalized_block_number: 101,
        binding_finalized_block_hash: BLOCK_B,
        binding_updated_at: 2_000,
      }),
      'user_binding_conflict',
    );
  });

  it('拒绝不规范 CID、AccountId、身份档位、区块哈希和数值', async () => {
    const invalidInputs: UserRow[] = [
      registration({ cid_number: 'A'.repeat(33) }),
      registration({ account_id: `0x${'AA'.repeat(32)}` }),
      registration({ identity_level: 'administrator' as IdentityLevel }),
      registration({ registration_finalized_block_hash: '0xabc' }),
      registration({ binding_revision: -1 }),
      registration({ registered_at: Number.MAX_SAFE_INTEGER + 1 }),
    ];
    for (const input of invalidInputs) {
      await expectErrorCode(
        createUserFromFinalizedRegistration(env, input),
        'invalid_finalized_user',
      );
    }
    expect(await countRows('users')).toBe(1);
  });

  it('资料不能脱离用户存在，删除用户会级联删除资料', async () => {
    await expect(
      env.DB.prepare(
        'INSERT INTO user_profiles (cid_number) VALUES (?)',
      ).bind(CID_A).run(),
    ).rejects.toThrow();

    await createUserFromFinalizedRegistration(env, registration());
    await env.DB.prepare('DELETE FROM users WHERE cid_number = ?').bind(CID_A).run();
    expect(await readUserProfile(env, CID_A)).toBeNull();
  });
});

function registration(overrides: Partial<UserRow> = {}): UserRow {
  return {
    cid_number: CID_A,
    account_id: ACCOUNT_A,
    binding_revision: 1,
    identity_level: 'visitor',
    registration_finalized_block_number: 100,
    registration_finalized_block_hash: BLOCK_A,
    binding_finalized_block_number: 100,
    binding_finalized_block_hash: BLOCK_A,
    identity_finalized_block_number: 100,
    identity_finalized_block_hash: BLOCK_A,
    registered_at: 1_000,
    binding_updated_at: 1_000,
    identity_updated_at: 1_000,
    ...overrides,
  };
}

async function applySchema(bindings: Env): Promise<void> {
  // 与 Worker 其它真实 D1 测试相同：逐条执行唯一创世基线，不维护测试专用 schema。
  const statements = SCHEMA_SQL
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await bindings.DB.prepare(statement).run();
  }
}

async function countRows(table: 'users' | 'user_profiles'): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function expectErrorCode(
  promise: Promise<unknown>,
  errorCode: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ error_code: errorCode });
}
