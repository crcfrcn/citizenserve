import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMlsChallenge, createSession } from '../src/auth/service';
import { cleanupExpiredSessionIndexes } from '../src/auth/session_index';
import { mlsAuthenticationMessage, MLS_PROOF_HEADER } from '../src/auth/mls_authentication';
import { createUserFromFinalizedRegistration } from '../src/account/user_repository';
import { guardRequest } from '../src/security/request_guard';
import { requireSession } from '../src/shared/http';
import { sha256Hex } from '../src/shared/hash';
import { bytesToHex } from '../src/shared/signing_message';
import type { Env, MlsAuthenticationProof, SessionState } from '../src/types';
import { createTestMiniflare } from './miniflare';

const CID = 'CN220-CTZN2-198805201-2026';
const ACCOUNT = '0x' + '11'.repeat(32);
let miniflare: Miniflare;
let env: Env;
let keyPair: CryptoKeyPair;
let publicKey: string;
let cache: TestCache;

/** KV故障替身只隔离持久化失败；挑战消费与索引条件使用实际D1。 */
class TestCache {
  readonly values = new Map<string, string>();
  failPut = false;
  async get<T>(key: string): Promise<T | null> { const value = this.values.get(key); return value ? JSON.parse(value) as T : null; }
  async put(key: string, value: string): Promise<void> {
    if (this.failPut) { this.failPut = false; throw new Error('kv_write_failed'); }
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

function request(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Request('https://worker.test' + path, {
    method: text === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(text).length) }) },
    body: text,
  });
}

function proofHeader(proof: MlsAuthenticationProof): string {
  return btoa(JSON.stringify(proof)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function loginRequest(): Promise<{ request: Request; proof: MlsAuthenticationProof }> {
  const body = { account_id: ACCOUNT };
  const target = '/api/square/auth/session';
  const challengeResponse = await createMlsChallenge(request('/api/square/auth/challenge', {
    account_id: ACCOUNT, public_key: publicKey, purpose: 'session', method: 'POST',
    request_target: target, body_sha256: '0x' + await sha256Hex(JSON.stringify(body)),
  }), env);
  const { ok: _ok, ...fields } = await challengeResponse.json() as Record<string, unknown>;
  const proof = { ...fields, signature: '0x' + '00'.repeat(64) } as unknown as MlsAuthenticationProof;
  proof.signature = '0x' + bytesToHex(new Uint8Array(await crypto.subtle.sign(
    'Ed25519', keyPair.privateKey, mlsAuthenticationMessage(proof),
  )));
  return { request: request(target, body, { [MLS_PROOF_HEADER]: proofHeader(proof) }), proof };
}

beforeEach(async () => {
  miniflare = createTestMiniflare({ d1Bindings: ['DB'] });
  env = await miniflare.getBindings<Env>();
  const sql = readFileSync(resolve(process.cwd(), 'schema/citizenserve.sql'), 'utf8')
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  cache = new TestCache();
  env.SQUARE_CACHE = cache as unknown as KVNamespace;
  const allowRate = { limit: async () => ({ success: true }) } as RateLimit;
  env.RATE_AUTH = allowRate; env.RATE_READ = allowRate; env.RATE_WRITE = allowRate;
  env.HASH_KEY = 'synthetic-auth-rate-value';
  keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  publicKey = '0x' + bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
  await createUserFromFinalizedRegistration(env, {
    cid_number: CID, account_id: ACCOUNT, binding_revision: 1, identity_level: 'visitor',
    registration_finalized_block_number: 1, registration_finalized_block_hash: '0x' + '1'.repeat(64),
    binding_finalized_block_number: 1, binding_finalized_block_hash: '0x' + '1'.repeat(64),
    identity_finalized_block_number: 1, identity_finalized_block_hash: '0x' + '1'.repeat(64),
    registered_at: 1, binding_updated_at: 1, identity_updated_at: 1,
  });
  await env.DB.prepare('INSERT INTO mls_devices VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(CID, publicKey.slice(2), 1, ACCOUNT, publicKey, 1, 1, 1).run();
});
afterEach(async () => { await miniflare?.dispose(); });

describe('同一MLS身份建立设备会话', () => {
  it('只用D1投影和已登记MLS公钥登录，索引保存设备且不保存明文token', async () => {
    const input = await loginRequest();
    const response = await createSession(input.request, env);
    const result = await response.json() as Record<string, unknown>;
    expect(result.cid_number).toBe(CID);
    expect(result.device_id).toBe(publicKey.slice(2));
    const token = result.session_token as string;
    const hash = await sha256Hex(token);
    expect(cache.values.has('square_session:' + hash)).toBe(true);
    expect([...cache.values.keys()].join()).not.toContain(token);
    expect(await env.DB.prepare('SELECT * FROM square_sessions WHERE session_token_hash = ?').bind(hash).first())
      .toMatchObject({ cid_number: CID, device_id: publicKey.slice(2), account_id: ACCOUNT });
  });

  it('实际D1并发条件消费只签发一个会话', async () => {
    const input = await loginRequest();
    const results = await Promise.allSettled([createSession(input.request.clone(), env), createSession(input.request.clone(), env)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'invalid_mls_challenge' } });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM square_sessions').first<{ n: number }>())?.n).toBe(1);
  });

  it('KV失败仍烧毁挑战并清除两侧半成品', async () => {
    const input = await loginRequest();
    cache.failPut = true;
    await expect(createSession(input.request.clone(), env)).rejects.toThrow('kv_write_failed');
    expect(cache.values.size).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM square_sessions').first<{ n: number }>())?.n).toBe(0);
    await expect(createSession(input.request.clone(), env)).rejects.toMatchObject({ code: 'invalid_mls_challenge' });
  });

  it('D1索引失败回滚KV且挑战不可再次使用', async () => {
    const input = await loginRequest();
    await env.DB.prepare('DROP TABLE square_sessions').run();
    await expect(createSession(input.request.clone(), env)).rejects.toThrow();
    expect(cache.values.size).toBe(0);
    await expect(createSession(input.request.clone(), env)).rejects.toMatchObject({ code: 'invalid_mls_challenge' });
  });

  it('挑战后换绑拒绝旧账户和代次', async () => {
    const input = await loginRequest();
    await env.DB.prepare('UPDATE users SET binding_revision = 2, account_id = ? WHERE cid_number = ?')
      .bind('0x' + '22'.repeat(32), CID).run();
    await expect(createSession(input.request, env)).rejects.toMatchObject({ code: 'cid_binding_changed' });
  });

  it('未登记的MLS公钥不能申请普通登录挑战', async () => {
    await expect(createMlsChallenge(request('/square/auth/challenge', {
      account_id: ACCOUNT, public_key: '0x' + 'aa'.repeat(32), purpose: 'session', method: 'POST',
      request_target: '/square/auth/session', body_sha256: '0x' + await sha256Hex('{}'),
    }), env)).rejects.toMatchObject({ code: 'device_not_registered' });
  });

  it('缺失身份投影且无链配置时返回服务不可用，不能误报未绑定', async () => {
    await expect(createMlsChallenge(request('/square/auth/challenge', {
      account_id: '0x' + '33'.repeat(32), public_key: publicKey, purpose: 'session', method: 'POST',
      request_target: '/square/auth/session', body_sha256: '0x' + await sha256Hex('{}'),
    }), env)).rejects.toMatchObject({ code: 'identity_projection_unavailable' });
  });

  it('已有八个会话时新会话淘汰最早索引与KV', async () => {
    for (let i = 0; i < 8; i++) {
      const hash = String(i).padStart(64, '0');
      await env.DB.prepare('INSERT INTO square_sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(hash, CID, 1, ACCOUNT, publicKey.slice(2), i + 1, Date.now() + 60_000).run();
      cache.values.set('square_session:' + hash, '{}');
    }
    await createSession((await loginRequest()).request, env);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM square_sessions').first<{ n: number }>())?.n).toBe(8);
    expect(cache.values.has('square_session:' + '0'.repeat(64))).toBe(false);
  });

  it('到期清理只删除过期索引', async () => {
    for (const [hash, expiry] of [['a'.repeat(64), 999], ['b'.repeat(64), 1001]] as const) {
      await env.DB.prepare('INSERT INTO square_sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(hash, CID, 1, ACCOUNT, publicKey.slice(2), 1, expiry).run();
    }
    await cleanupExpiredSessionIndexes(env, 1000);
    expect((await env.DB.prepare('SELECT session_token_hash FROM square_sessions').all()).results)
      .toEqual([{ session_token_hash: 'b'.repeat(64) }]);
  });

  it('受保护路由在请求证明前拒绝换绑残留会话', async () => {
    const response = await createSession((await loginRequest()).request, env);
    const result = await response.json() as { session_token: string };
    await env.DB.prepare('UPDATE users SET binding_revision = 2 WHERE cid_number = ?').bind(CID).run();
    await expect(guardRequest(request('/square/feed/recommended', undefined, { authorization: 'Bearer ' + result.session_token }), env, '/square/feed/recommended'))
      .rejects.toMatchObject({ code: 'cid_binding_changed' });
  });

  it('严格会话拒绝缺失设备、额外字段和到期缓存', async () => {
    const key = 'square_session:' + await sha256Hex('test');
    const session: SessionState = { cid_number: CID, account_id: ACCOUNT, binding_revision: 1, device_id: publicKey.slice(2), created_at: 0, expires_at: Date.now() + 1000 };
    for (const invalid of [{ ...session, device_id: undefined }, { ...session, extra: true }, { ...session, expires_at: 1 }]) {
      cache.values.set(key, JSON.stringify(invalid));
      await expect(requireSession(request('/square/media/a', undefined, { authorization: 'Bearer test' }), env))
        .rejects.toMatchObject({ code: 'expired_session' });
    }
  });
});
