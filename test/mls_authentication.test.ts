import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign } from '@polkadot/util-crypto';
import {
  assertMlsOrigin, buildMlsDeviceBindingSigningMessage, consumeMlsAuthentication,
  mlsAuthenticationMessage, MLS_PROOF_HEADER, readMlsProof, validateMlsProof, verifyMlsSignature,
} from '../src/auth/mls_authentication';
import { createMlsChallenge, registerMlsDevice } from '../src/auth/service';
import { createUserFromFinalizedRegistration } from '../src/account/user_repository';
import { verifyTurnstile } from '../src/security/turnstile';
import { sha256Hex } from '../src/shared/hash';
import { bytesToHex, concatBytes, hexToBytes, signingMessage, scaleString, u64Le } from '../src/shared/signing_message';
import { cleanupSecurityState } from '../src/security/request_guard';
import type { Env, MlsAuthenticationProof, MlsAuthenticationPurpose, SessionState } from '../src/types';
import { createTestMiniflare } from './miniflare';

// Turnstile只隔离外部验证；钱包授权、Ed25519验签与D1事务均执行实际实现。
vi.mock('../src/security/turnstile', () => ({ verifyTurnstile: vi.fn(async () => undefined) }));
const CID = 'CN220-CTZN2-198805201-2026';
let miniflare: Miniflare;
let env: Env;
let keys: CryptoKeyPair;
let publicKey: string;
let wallet: ReturnType<typeof sr25519PairFromSeed>;
let accountId: string;
let session: SessionState;

function request(target: string, method: string, body = '', proof?: MlsAuthenticationProof, token?: string): Request {
  const headers: Record<string, string> = {};
  if (body || ['POST', 'PUT', 'PATCH'].includes(method)) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(new TextEncoder().encode(body).length);
  }
  if (proof) headers[MLS_PROOF_HEADER] = encodeProof(proof);
  if (token) headers.authorization = 'Bearer ' + token;
  return new Request('https://worker.test' + target, { method, headers, body: body || (method === 'POST' ? '' : undefined) });
}
function encodeProof(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sign(proof: MlsAuthenticationProof): Promise<MlsAuthenticationProof> {
  return { ...proof, signature: '0x' + bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, mlsAuthenticationMessage(proof)))) };
}
async function issue(purpose: MlsAuthenticationPurpose, method: string, target: string, body: string, token?: string): Promise<MlsAuthenticationProof> {
  const response = await createMlsChallenge(request('/api/square/auth/challenge', 'POST', JSON.stringify({
    account_id: accountId, public_key: publicKey, purpose, method, request_target: target,
    body_sha256: '0x' + await sha256Hex(body),
  }), undefined, token), env);
  const { ok: _ok, ...fields } = await response.json() as Record<string, unknown>;
  return sign({ ...fields, signature: '0x' + '00'.repeat(64) } as unknown as MlsAuthenticationProof);
}
async function registrationBody(issuedAt = Date.now(), validWallet = true): Promise<string> {
  const message = buildMlsDeviceBindingSigningMessage({
    cid_number: CID, binding_revision: 1, account_id: accountId, public_key: publicKey, issued_at: issuedAt,
  });
  return JSON.stringify({
    account_id: accountId, public_key: publicKey, issued_at: issuedAt,
    binding_signature: '0x' + bytesToHex(validWallet ? sr25519Sign(message, wallet) : new Uint8Array(64)),
    turnstile_token: 'synthetic-turnstile',
  });
}

beforeEach(async () => {
  await cryptoWaitReady();
  // 固定合成种子只用于测试，绝不读取真实钱包材料。
  wallet = sr25519PairFromSeed(new Uint8Array(32).fill(23));
  accountId = '0x' + bytesToHex(wallet.publicKey);
  keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  publicKey = '0x' + bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  miniflare = createTestMiniflare({ d1Bindings: ['DB'], kvBindings: ['SQUARE_CACHE'] });
  env = await miniflare.getBindings<Env>();
  const sql = readFileSync(resolve(process.cwd(), 'schema/citizenserve.sql'), 'utf8')
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  await createUserFromFinalizedRegistration(env, {
    cid_number: CID, account_id: accountId, binding_revision: 1, identity_level: 'visitor',
    registration_finalized_block_number: 1, registration_finalized_block_hash: '0x' + '1'.repeat(64),
    binding_finalized_block_number: 1, binding_finalized_block_hash: '0x' + '1'.repeat(64),
    identity_finalized_block_number: 1, identity_finalized_block_hash: '0x' + '1'.repeat(64),
    registered_at: 1, binding_updated_at: 1, identity_updated_at: 1,
  });
  session = { cid_number: CID, device_id: publicKey.slice(2), account_id: accountId, binding_revision: 1, created_at: Date.now(), expires_at: Date.now() + 60_000 };
  await env.DB.prepare('INSERT INTO mls_devices VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(CID, publicKey.slice(2), 1, accountId, publicKey, 1, 1, 1).run();
  for (const token of ['token-a', 'token-b']) await env.SQUARE_CACHE.put('square_session:' + await sha256Hex(token), JSON.stringify(session));
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await miniflare?.dispose(); });

describe('MLS固定证明格式与实际验签', () => {
  it('固定SignWithLabel标签和独立TLS编码结果逐字一致', async () => {
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    // 独立以固定字段类型构造期望值，不调用生产变长编码器。
    const text = (value: string) => {
      const bytes = new TextEncoder().encode(value);
      return concatBytes(new Uint8Array([bytes.length]), bytes);
    };
    const u64 = (value: number) => {
      const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value)); return bytes;
    };
    const content = concatBytes(text(CID), hexToBytes(proof.device_id), hexToBytes(accountId),
      u64(1), text('https://worker.test'), hexToBytes(proof.challenge), u64(proof.expires_at_millis),
      text('POST'), text('/square/auth/session'), hexToBytes(proof.body_sha256));
    expect(content.length).toBeGreaterThanOrEqual(64);
    expect(content.length).toBeLessThan(16384);
    const expected = concatBytes(text('MLS 1.0 TataChatAuthentication'),
      new Uint8Array([0x40 | (content.length >>> 8), content.length & 255]), content);
    expect(mlsAuthenticationMessage(proof)).toEqual(expected);
    expect(await verifyMlsSignature(proof)).toBe(true);
    const otherDomain = new Uint8Array(expected); otherDomain[9] ^= 1;
    expect(await crypto.subtle.verify('Ed25519', keys.publicKey, hexToBytes(proof.signature), otherDomain)).toBe(false);
  });

  it('每个认证字段篡改均不能通过原签名', async () => {
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    const changes: Partial<MlsAuthenticationProof>[] = [
      { user_id: 'CN220-CTZN2-198805202-2026' }, { device_id: 'aa'.repeat(32) },
      { public_key: '0x' + 'aa'.repeat(32) }, { account_id: '0x' + 'bb'.repeat(32) },
      { binding_revision: 2 }, { service_origin: 'https://other.test' }, { challenge: '0x' + 'cc'.repeat(32) },
      { expires_at_millis: proof.expires_at_millis - 1 }, { method: 'PUT' },
      { request_target: '/square/auth/session?x=1' }, { body_sha256: '0x' + 'dd'.repeat(32) },
      { signature: '0x' + '00'.repeat(64) },
    ];
    for (const change of changes) expect(await verifyMlsSignature({ ...proof, ...change })).toBe(false);
  });

  it('严格拒绝缺项、多余字段、错误公钥和非规范证明编码', async () => {
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    const { signature: _signature, ...missing } = proof;
    for (const value of [missing, { ...proof, extra: 1 }, { ...proof, public_key: publicKey.toUpperCase() }, { ...proof, binding_revision: 1.5 }]) {
      expect(() => validateMlsProof(value)).toThrow();
    }
    const req = request('/square/auth/session', 'POST', '{}', proof);
    req.headers.set(MLS_PROOF_HEADER, encodeProof(proof) + '=');
    expect(() => readMlsProof(req)).toThrow();
    const duplicate = JSON.stringify(proof).slice(0, -1) + ',"method":"POST"}';
    req.headers.set(MLS_PROOF_HEADER, btoa(duplicate).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
    expect(() => readMlsProof(req)).toThrow();
  });

  it('只接受规范HTTPS源，拒绝明文与非规范源', () => {
    const insecure = new URL('https://worker.test'); insecure.protocol = 'http:';
    for (const value of [insecure.origin, 'https://worker.test/', 'https://WORKER.test', 'https://worker.test:443', 'https://user@worker.test']) {
      expect(() => assertMlsOrigin(value)).toThrow();
    }
    expect(assertMlsOrigin('https://worker.test')).toBe('https://worker.test');
  });
});

describe('一次性挑战、实际请求和会话绑定', () => {
  it('请求挑战跨会话挪用失败，正确会话成功且不能重放', async () => {
    const target = '/api/square/membership?limit=1';
    const proof = await issue('request', 'GET', target, '', 'token-a');
    await expect(consumeMlsAuthentication(request(target, 'GET', '', proof, 'token-b'), env, 'request', session))
      .rejects.toMatchObject({ code: 'invalid_mls_challenge' });
    await consumeMlsAuthentication(request(target, 'GET', '', proof, 'token-a'), env, 'request', session);
    await expect(consumeMlsAuthentication(request(target, 'GET', '', proof, 'token-a'), env, 'request', session))
      .rejects.toMatchObject({ code: 'invalid_mls_challenge' });
  });

  it('路径前缀、查询、正文和DELETE正文逐字绑定', async () => {
    const target = '/api/square/follows/' + CID;
    const body = '{"a":1}';
    const proof = await issue('request', 'DELETE', target, body, 'token-a');
    await expect(consumeMlsAuthentication(request(target.slice(4), 'DELETE', body, proof, 'token-a'), env, 'request', session)).rejects.toThrow();
    await expect(consumeMlsAuthentication(request(target + '?q=1', 'DELETE', body, proof, 'token-a'), env, 'request', session)).rejects.toThrow();
    await expect(consumeMlsAuthentication(request(target, 'DELETE', '', proof, 'token-a'), env, 'request', session)).rejects.toThrow();
    await consumeMlsAuthentication(request(target, 'DELETE', body, proof, 'token-a'), env, 'request', session);
  });

  it('签名格式正确但用途不同的挑战不能兑换', async () => {
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    await expect(consumeMlsAuthentication(request('/square/auth/session', 'POST', '{}', proof), env, 'registration'))
      .rejects.toMatchObject({ code: 'invalid_mls_challenge' });
  });

  // 两个用例覆盖整批 64/65 次真实 D1 请求；独立给予 30 秒总预算，普通用例仍保持默认时限。
  it('实际D1每用途并发签发最多保留64条未消费记录', async () => {
    const body = JSON.stringify({ account_id: accountId, public_key: publicKey, purpose: 'session', method: 'POST',
      request_target: '/square/auth/session', body_sha256: '0x' + await sha256Hex('{}') });
    const results = await Promise.allSettled(Array.from({ length: 65 }, () => createMlsChallenge(request('/square/auth/challenge', 'POST', body), env)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(64);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'mls_challenge_limit_reached' } });
  }, 30_000);

  it('预登录用途占满配额不能挤占已认证请求用途', async () => {
    const challengeBody = JSON.stringify({ account_id: accountId, public_key: publicKey, purpose: 'session', method: 'POST',
      request_target: '/square/auth/session', body_sha256: '0x' + await sha256Hex('{}') });
    for (let i = 0; i < 64; i++) await createMlsChallenge(request('/square/auth/challenge', 'POST', challengeBody), env);
    const proof = await issue('request', 'GET', '/square/membership', '', 'token-a');
    await consumeMlsAuthentication(request('/square/membership', 'GET', '', proof, 'token-a'), env, 'request', session);
  }, 30_000);

  it('错误签名不消费合法挑战，正确证明随后仍可消费', async () => {
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    await expect(consumeMlsAuthentication(request('/square/auth/session', 'POST', '{}',
      { ...proof, signature: '0x' + '00'.repeat(64) }), env, 'session')).rejects.toMatchObject({ code: 'invalid_mls_signature' });
    await consumeMlsAuthentication(request('/square/auth/session', 'POST', '{}', proof), env, 'session');
  });

  it('未知用途、未知路由、点段规范化和非安全整数均拒绝', async () => {
    const body = { account_id: accountId, public_key: publicKey, purpose: 'session', method: 'POST',
      request_target: '/square/auth/session', body_sha256: '0x' + await sha256Hex('{}') };
    for (const change of [{ purpose: 'unknown' }, { request_target: '/unknown' }, { request_target: '/api/../square/auth/session' }]) {
      await expect(createMlsChallenge(request('/square/auth/challenge', 'POST', JSON.stringify({ ...body, ...change })), env)).rejects.toThrow();
    }
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    expect(() => validateMlsProof({ ...proof, expires_at_millis: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    const tooLarge = request('/square/auth/session', 'POST', '{}');
    tooLarge.headers.set(MLS_PROOF_HEADER, 'a'.repeat(22000));
    expect(() => readMlsProof(tooLarge)).toThrow();
  });

  it('过期挑战拒绝，定时清理后删除对应记录', async () => {
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    vi.spyOn(Date, 'now').mockReturnValue(proof.expires_at_millis + 1);
    await expect(consumeMlsAuthentication(request('/square/auth/session', 'POST', '{}', proof), env, 'session'))
      .rejects.toMatchObject({ code: 'invalid_mls_challenge' });
    await cleanupSecurityState(env);
    expect(await env.DB.prepare('SELECT * FROM mls_authentication_challenges WHERE challenge = ?').bind(proof.challenge).first()).toBeNull();
  });

  it('验签期间设备撤销仍由消费语句的登记条件拒绝', async () => {
    const proof = await issue('session', 'POST', '/square/auth/session', '{}');
    const original = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const valid = await original(...args);
      await env.DB.prepare('DELETE FROM mls_devices WHERE cid_number = ?').bind(CID).run();
      return valid;
    });
    await expect(consumeMlsAuthentication(request('/square/auth/session', 'POST', '{}', proof), env, 'session'))
      .rejects.toMatchObject({ code: 'invalid_mls_challenge' });
  });
});

describe('可信MLS设备登记', () => {
  it('GMB登记仅授权同一MLS公钥，载荷字段与顺序固定', () => {
    const input = { cid_number: CID, binding_revision: 1, account_id: accountId, public_key: publicKey, issued_at: 1000 };
    expect(buildMlsDeviceBindingSigningMessage(input)).toEqual(signingMessage(0x1c, concatBytes(
      scaleString(CID), u64Le(1), scaleString(accountId), scaleString(publicKey), u64Le(1000),
    )));
  });

  it('实际钱包授权加MLS持钥证明登记，旧时间证明可重试回执且不重复Turnstile', async () => {
    await env.DB.prepare('DELETE FROM mls_devices WHERE cid_number = ?').bind(CID).run();
    const body = await registrationBody(Date.now() - 600_000);
    const target = '/api/square/auth/device/register';
    const first = await issue('registration', 'POST', target, body);
    expect((await registerMlsDevice(request(target, 'POST', body, first), env)).status).toBe(200);
    const second = await issue('registration', 'POST', target, body);
    expect((await registerMlsDevice(request(target, 'POST', body, second), env)).status).toBe(200);
    expect(verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT public_key, device_id FROM mls_devices WHERE cid_number = ?').bind(CID).first())
      .toEqual({ public_key: publicKey, device_id: publicKey.slice(2) });
  });

  it('MLS自签名不能替代钱包登记授权', async () => {
    await env.DB.prepare('DELETE FROM mls_devices WHERE cid_number = ?').bind(CID).run();
    const body = await registrationBody(Date.now(), false);
    const target = '/square/auth/device/register';
    const proof = await issue('registration', 'POST', target, body);
    await expect(registerMlsDevice(request(target, 'POST', body, proof), env)).rejects.toMatchObject({ code: 'invalid_binding_signature' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM mls_devices').first<{ n: number }>())?.n).toBe(0);
  });

  it('较旧授权不能覆盖更新登记', async () => {
    const now = Date.now();
    await env.DB.prepare('UPDATE mls_devices SET issued_at = ? WHERE cid_number = ?').bind(now, CID).run();
    const body = await registrationBody(now - 1);
    const target = '/square/auth/device/register';
    const proof = await issue('registration', 'POST', target, body);
    await expect(registerMlsDevice(request(target, 'POST', body, proof), env)).rejects.toMatchObject({ code: 'stale_device_binding' });
  });
});

