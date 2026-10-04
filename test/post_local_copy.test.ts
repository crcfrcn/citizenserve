import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Miniflare } from 'miniflare';

import worker from '../src/index';
import { createUserFromFinalizedRegistration } from '../src/account/user_repository';
import { sha256Hex } from '../src/shared/hash';
import {
  OP_SIGN_SQUARE_LOGIN,
  scaleString,
  signingMessage,
} from '../src/shared/signing_message';
import type { Env, SessionState } from '../src/types';
import { createTestMiniflare } from './miniflare';

const ACCOUNT_A = `0x${'11'.repeat(32)}`;
const ACCOUNT_B = `0x${'22'.repeat(32)}`;
const CID_A = 'CN220-CTZN2-100000001-2026';
const CID_B = 'CN220-CTZN2-100000002-2026';
vi.mock('../src/auth/wallet_signature', () => ({
  verifyWalletSignature: vi.fn(async () => true),
}));
const SCHEMA_SQL = readFileSync(
  resolve(process.cwd(), 'schema/citizenserve.sql'),
  'utf8',
);

interface TestAccount {
  account_id: string;
  cid_number: string;
  token: string;
  private_key: CryptoKey;
}

interface Harness {
  miniflare: Miniflare;
  env: Env;
  accountA: TestAccount;
  accountB: TestAccount;
  nonce: number;
}

let harness: Harness;

describe('本人发布内容本地副本回灌 API', () => {
  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    if (harness) await harness.miniflare.dispose();
  });

  it('通过完整 Worker HTTP 入口和真实 D1/R2/KV binding 按 Session CID 隔离回灌', async () => {
    const newest = await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_a_3',
      created_at: 3000,
      text: '本人第三条',
    });
    const middle = await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_a_2',
      created_at: 2000,
      text: '本人第二条',
      post_type: 'article',
    });
    await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_a_1',
      created_at: 1000,
      text: '本人第一条',
    });
    await seedPost(harness.env, harness.accountB, {
      post_id: 'sqp_b_1',
      created_at: 9000,
      text: '另一身份的内容',
    });

    const anonymous = await callWorker(harness, null, '/square/posts/self');
    expect(anonymous.status).toBe(401);
    expect((await responseJson(anonymous)).error_code).toBe('missing_session');

    const firstResponse = await callWorker(
      harness,
      harness.accountA,
      '/square/posts/self?limit=2',
    );
    expect(firstResponse.status).toBe(200);
    const first = await responseJson(firstResponse);
    expect((first.items as Array<{ post_id: string }>).map((item) => item.post_id))
      .toEqual(['sqp_a_3', 'sqp_a_2']);
    expect(first.next_cursor).toEqual(expect.any(String));

    const firstItem = (first.items as Array<Record<string, unknown>>)[0];
    expect(firstItem).toMatchObject({
      post_id: 'sqp_a_3',
      cid_number: CID_A,
      account_id: ACCOUNT_A,
      post_type: 'document',
      content_hash: newest.content_hash,
      created_at: 3000,
      post_state: 'published',
    });
    expect(decodeBase64(firstItem.manifest_bytes_base64 as string))
      .toEqual(newest.manifest_bytes);
    const secondItem = (first.items as Array<Record<string, unknown>>)[1];
    expect(decodeBase64(secondItem.manifest_bytes_base64 as string))
      .toEqual(middle.manifest_bytes);

    const secondResponse = await callWorker(
      harness,
      harness.accountA,
      `/square/posts/self?limit=2&cursor=${first.next_cursor as string}`,
    );
    expect(secondResponse.status).toBe(200);
    const second = await responseJson(secondResponse);
    expect((second.items as Array<{ post_id: string }>).map((item) => item.post_id))
      .toEqual(['sqp_a_1']);
    expect(second.next_cursor).toBeNull();

    const other = await responseJson(
      await callWorker(harness, harness.accountB, '/square/posts/self'),
    );
    expect((other.items as Array<{ post_id: string }>).map((item) => item.post_id))
      .toEqual(['sqp_b_1']);

    // 本人副本回灌不属于公共 feed 浏览，不写入浏览计数。
    const browseRows = await harness.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM square_browse_days',
    ).first<{ count: number }>();
    expect(browseRows?.count).toBe(0);
  });

  it('同毫秒按 post_id 稳定分页且拒绝非法 limit/cursor', async () => {
    await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_same_c',
      created_at: 5000,
      text: 'C',
    });
    await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_same_b',
      created_at: 5000,
      text: 'B',
    });
    await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_same_a',
      created_at: 5000,
      text: 'A',
    });

    const first = await responseJson(
      await callWorker(harness, harness.accountA, '/square/posts/self?limit=2'),
    );
    expect((first.items as Array<{ post_id: string }>).map((item) => item.post_id))
      .toEqual(['sqp_same_c', 'sqp_same_b']);
    const second = await responseJson(
      await callWorker(
        harness,
        harness.accountA,
        `/square/posts/self?limit=2&cursor=${first.next_cursor as string}`,
      ),
    );
    expect((second.items as Array<{ post_id: string }>).map((item) => item.post_id))
      .toEqual(['sqp_same_a']);

    const invalidLimit = await callWorker(
      harness,
      harness.accountA,
      '/square/posts/self?limit=6',
    );
    expect(invalidLimit.status).toBe(400);
    expect((await responseJson(invalidLimit)).error_code).toBe('invalid_limit');

    const invalidCursor = await callWorker(
      harness,
      harness.accountA,
      '/square/posts/self?cursor=not-a-valid-cursor',
    );
    expect(invalidCursor.status).toBe(400);
    expect((await responseJson(invalidCursor)).error_code).toBe('invalid_cursor');
  });

  it('任一 manifest 哈希损坏时整页 fail-closed，不返回部分正确内容', async () => {
    await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_good',
      created_at: 2000,
      text: '正确内容',
    });
    const corrupt = await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_corrupt',
      created_at: 1000,
      text: '将被篡改',
    });
    await harness.env.SQUARE_PRIVATE.put(
      corrupt.object_key,
      '{"schema":"citizenapp.square.post","text":"篡改"}',
      { httpMetadata: { contentType: 'application/json' } },
    );

    const response = await callWorker(
      harness,
      harness.accountA,
      '/square/posts/self',
    );
    expect(response.status).toBe(409);
    const body = await responseJson(response);
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe('manifest_hash_mismatch');
    expect(body.items).toBeUndefined();
  });

  it('CID 固定路径的 manifest 缺失时整页 fail-closed', async () => {
    const seeded = await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_no_key',
      created_at: 1000,
      text: '固定路径对象将被删除',
    });
    await harness.env.SQUARE_PRIVATE.delete(seeded.object_key);

    expect(await harness.env.SQUARE_PRIVATE.head(seeded.object_key)).toBeNull();
    const response = await callWorker(
      harness,
      harness.accountA,
      '/square/posts/self',
    );
    expect(response.status).toBe(409);
    expect((await responseJson(response)).error_code).toBe('manifest_not_found');
  });

  it('帖子与上传归属或链锚不一致时拒绝回灌', async () => {
    const seeded = await seedPost(harness.env, harness.accountA, {
      post_id: 'sqp_owner_conflict',
      created_at: 1000,
      text: '归属冲突',
    });
    await harness.env.DB.prepare(
      'UPDATE square_uploads SET cid_number = ? WHERE post_id = ?',
    ).bind(CID_B, seeded.post_id).run();

    const ownerConflict = await callWorker(
      harness,
      harness.accountA,
      '/square/posts/self',
    );
    expect(ownerConflict.status).toBe(409);
    expect((await responseJson(ownerConflict)).error_code).toBe('post_owner_mismatch');

    await harness.env.DB.prepare(
      'UPDATE square_uploads SET cid_number = ?, manifest_hash = ? WHERE post_id = ?',
    ).bind(CID_A, 'ff'.repeat(32), seeded.post_id).run();
    const hashConflict = await callWorker(
      harness,
      harness.accountA,
      '/square/posts/self',
    );
    expect(hashConflict.status).toBe(409);
    expect((await responseJson(hashConflict)).error_code).toBe('post_upload_hash_mismatch');
  });
});

async function createHarness(): Promise<Harness> {
  const miniflare = createTestMiniflare({
    d1Bindings: ['DB'],
    r2Bindings: ['SQUARE_PRIVATE', 'SQUARE_PUBLIC_MEDIA'],
    kvBindings: ['SQUARE_CACHE'],
    textBindings: {
      HASH_KEY: 'post-local-copy-test-rate-key',
      CHAIN_GENESIS_HASH: `0x${'12'.repeat(32)}`,
    },
  });
  const env = await miniflare.getBindings<Env>();
  const allowRate = {
    limit: async () => ({ success: true }),
  } as RateLimit;
  env.RATE_AUTH = allowRate;
  env.RATE_WRITE = allowRate;
  env.RATE_READ = allowRate;
  // D1 exec 按换行拆语句，无法直接接受含独立注释行的创世 SQL；测试逐条执行同一基线。
  const statements = SCHEMA_SQL
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
  const accountA = await registerAccount(env, ACCOUNT_A, CID_A, 'token-a');
  const accountB = await registerAccount(env, ACCOUNT_B, CID_B, 'token-b');
  return {
    miniflare,
    env,
    accountA,
    accountB,
    nonce: 0,
  };
}

async function registerAccount(
  env: Env,
  accountId: string,
  cidNumber: string,
  token: string,
): Promise<TestAccount> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicKey = toHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const deviceId = await sha256Hex(publicKey);
  const now = Date.now();
  await createUserFromFinalizedRegistration(env, {
    cid_number: cidNumber,
    account_id: accountId,
    binding_revision: 1,
    identity_level: 'visitor',
    registration_finalized_block_number: 1,
    registration_finalized_block_hash: `0x${'1'.repeat(64)}`,
    binding_finalized_block_number: 1,
    binding_finalized_block_hash: `0x${'1'.repeat(64)}`,
    identity_finalized_block_number: 1,
    identity_finalized_block_hash: `0x${'1'.repeat(64)}`,
    registered_at: now,
    binding_updated_at: now,
    identity_updated_at: now,
  });
  const session: SessionState = {
    cid_number: cidNumber,
    binding_revision: 1,
    account_id: accountId,
    device_key_hash: deviceId,
    created_at: now,
    expires_at: now + 60_000,
  };
  await env.SQUARE_CACHE.put(
    `square_session:${await sha256Hex(token)}`,
    JSON.stringify(session)
  );
  await env.DB.prepare(
    `INSERT INTO square_device_subkeys
      (cid_number, device_id, binding_revision, account_id, p256_public_key,
        issued_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(cidNumber, deviceId, 1, accountId, publicKey, now, now, now).run();
  return {
    account_id: accountId,
    cid_number: cidNumber,
    token,
    private_key: keyPair.privateKey,
  };
}

async function seedPost(
  env: Env,
  account: TestAccount,
  input: {
    post_id: string;
    created_at: number;
    text: string;
    post_type?: 'document' | 'article' | 'video';
  },
): Promise<{
  post_id: string;
  object_key: string;
  manifest_bytes: Uint8Array;
  content_hash: string;
}> {
  const manifest: Record<string, unknown> = {
    schema: 'citizenapp.square.post',
    cid_number: account.cid_number,
    post_type: input.post_type ?? 'document',
    text: input.text,
    media_items: [],
  };
  if (input.post_type === 'article') {
    manifest.title = `${input.text}文章标题标题`;
    manifest.content_sections = [{
      text_delta: [{ insert: input.text }, { insert: '\n' }]
    }];
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const contentHash = await sha256Hex(manifestBytes);
  const objectKey =
    `square/${account.cid_number}/posts/${input.post_id}/manifest.json`;
  const uploadId = `squ_${input.post_id}`;
  const storageReceiptId = `sqr_${input.post_id}`;
  await env.SQUARE_PRIVATE.put(objectKey, manifestBytes, {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.DB.prepare(
    `INSERT INTO square_uploads
      (upload_id, post_id, cid_number, account_id, post_type, manifest_hash,
        manifest_byte_size, content_hash, storage_receipt_id, estimated_bytes,
        status, expires_at, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
  ).bind(
    uploadId,
    input.post_id,
    account.cid_number,
    account.account_id,
    input.post_type ?? 'document',
    contentHash,
    manifestBytes.byteLength,
    contentHash,
    storageReceiptId,
    manifestBytes.byteLength,
    9999999999999,
    input.created_at - 2,
    input.created_at - 1,
  ).run();
  await env.DB.prepare(
    `INSERT INTO square_posts
      (post_id, cid_number, account_id, post_category, post_type, title,
        excerpt, content_hash, storage_receipt_id, chain_block, chain_block_hash,
        tx_hash, created_at, post_state)
      VALUES (?, ?, ?, 'normal', ?, ?, ?, ?, ?, 88, ?, ?, ?, 'published')`,
  ).bind(
    input.post_id,
    account.cid_number,
    account.account_id,
    input.post_type ?? 'document',
    input.post_type === 'article' ? `${input.text}文章标题标题` : null,
    input.text,
    `0x${contentHash}`,
    storageReceiptId,
    `0x${'33'.repeat(32)}`,
    `0x${'44'.repeat(32)}`,
    input.created_at,
  ).run();
  return {
    post_id: input.post_id,
    object_key: objectKey,
    manifest_bytes: manifestBytes,
    content_hash: contentHash,
  };
}

async function callWorker(
  context: Harness,
  account: TestAccount | null,
  path: string,
): Promise<Response> {
  const headers = new Headers();
  if (account) {
    const requestTime = Date.now();
    const nonce = (++context.nonce).toString(16).padStart(32, '0');
    const canonical = [
      'square_request',
      'GET',
      path,
      await sha256Hex(''),
      String(requestTime),
      nonce,
      await sha256Hex(account.token),
    ].join('\n');
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      account.private_key,
      signingMessage(OP_SIGN_SQUARE_LOGIN, scaleString(canonical)),
    );
    headers.set('authorization', `Bearer ${account.token}`);
    headers.set('x-device-time', String(requestTime));
    headers.set('x-device-nonce', nonce);
    headers.set('x-device-signature', `0x${toHex(signature)}`);
  }
  return worker.fetch(new Request(`https://worker.test${path}`, { headers }), context.env);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}
