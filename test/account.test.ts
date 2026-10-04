import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';

import { purgeIdentity } from '../src/account/purge';
import { createUserFromFinalizedRegistration } from '../src/account/user_repository';
import { routeRequest } from '../src/routes';
import type { Env } from '../src/types';
import { createTestMiniflare } from './miniflare';

const ACCOUNT_ID = `0x${'11'.repeat(32)}`;
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const CID_NUMBER = 'CN220-CTZN2-198805202-2026';
const SCHEMA_SQL = readFileSync(
  resolve(process.cwd(), 'schema/citizenserve.sql'),
  'utf8',
);

let miniflare: Miniflare;
let env: Env;

describe('finalized CID 注销清理', () => {
  beforeEach(async () => {
    miniflare = createTestMiniflare({
      d1Bindings: ['DB'],
      r2Bindings: ['SQUARE_PRIVATE', 'SQUARE_PUBLIC_MEDIA'],
      kvBindings: ['SQUARE_CACHE'],
    });
    env = await miniflare.getBindings<Env>();
    await applySchema(env);
    await seedUser(env);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('按 CID 删除用户、D1 资料、R2 资料媒体和会话', async () => {
    await env.SQUARE_PRIVATE.put(`profile/${CID_NUMBER}/avatar`, 'image');
    await env.SQUARE_PRIVATE.put(`profile/${CID_NUMBER}/banner`, 'image');

    const result = await purgeIdentity(env, CID_NUMBER);

    expect(result.deleted_r2_objects).toBe(2);
    expect(await rowCount(env, 'users')).toBe(1);
    expect(await rowCount(env, 'user_profiles')).toBe(1);
    expect(await env.SQUARE_PRIVATE.get(`profile/${CID_NUMBER}/avatar`)).toBeNull();
    expect(await env.SQUARE_PRIVATE.get(`profile/${CID_NUMBER}/banner`)).toBeNull();
  });

  it('按 CID 固定路径清理上传 manifest，不依赖可损坏的对象键清单', async () => {
    const manifestKey = `square/${CID_NUMBER}/posts/post-fixed/manifest.json`;
    await env.SQUARE_PRIVATE.put(manifestKey, '{}');
    await env.DB.prepare(
      `INSERT INTO square_uploads
        (upload_id, post_id, cid_number, account_id, post_type, manifest_hash,
         manifest_byte_size, content_hash, storage_receipt_id, estimated_bytes, status,
         expires_at, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'document', ?, 2, NULL, NULL, 2, 'prepared', 10, 1, NULL)`,
    ).bind('upload-fixed', 'post-fixed', CID_NUMBER, ACCOUNT_ID, 'aa'.repeat(32)).run();

    const result = await purgeIdentity(env, CID_NUMBER);

    expect(result.deleted_r2_objects).toBe(1);
    expect(await env.SQUARE_PRIVATE.get(manifestKey)).toBeNull();
    expect(await rowCount(env, 'users')).toBe(1);
  });
});

describe('旧链下签名注销入口已删除', () => {
  it.each([
    '/square/account/delete/challenge',
    '/square/account/delete',
  ])('%s 在路由白名单阶段返回 route_not_found', async (path) => {
    await expect(routeRequest(
      new Request(`https://worker.test${path}`, {
        method: 'POST',
        headers: { 'content-length': '0' },
      }),
      {} as Env,
    )).rejects.toMatchObject({ code: 'route_not_found' });
  });
});

async function seedUser(bindings: Env): Promise<void> {
  await createUserFromFinalizedRegistration(bindings, {
    cid_number: CID_NUMBER,
    account_id: ACCOUNT_ID,
    binding_revision: 1,
    identity_level: 'visitor',
    registration_finalized_block_number: 1,
    registration_finalized_block_hash: BLOCK_HASH,
    binding_finalized_block_number: 1,
    binding_finalized_block_hash: BLOCK_HASH,
    identity_finalized_block_number: 1,
    identity_finalized_block_hash: BLOCK_HASH,
    registered_at: 1_000,
    binding_updated_at: 1_000,
    identity_updated_at: 1_000,
  });
}

async function applySchema(bindings: Env): Promise<void> {
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

async function rowCount(bindings: Env, table: 'users' | 'user_profiles'): Promise<number> {
  const row = await bindings.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
