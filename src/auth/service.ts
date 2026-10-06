import type { Env, MlsAuthenticationPurpose, MlsDeviceRow, SessionState } from '../types';
import { HttpError, jsonResponse, parsePositiveInt, readJson, requireSession } from '../shared/http';
import { assertAccountId, createId } from '../shared/ids';
import { nowMs, secondsFromNow } from '../shared/time';
import { putKvJson } from '../limits/storage';
import { resourceLimit, routeResource } from '../limits/catalog';
import { verifyTurnstile } from '../security/turnstile';
import { verifyWalletSignature } from './wallet_signature';
import { clearStaleIdentitySessions, indexIdentitySession, rollbackIdentitySession, sessionCacheKey } from './session_index';
import { readUserByAccountId } from '../account/user_repository';
import { inspectUserProjectionHealth } from '../account/user_projection';
import {
  assertExactFields, assertMlsOrigin, assertMlsPublicKey, assertMlsTarget,
  buildMlsDeviceBindingSigningMessage, consumeMlsAuthentication, randomMlsChallenge,
  readMlsDevice, readMlsProof, requestSessionHash,
} from './mls_authentication';

interface ChallengeRequest {
  account_id: unknown; public_key: unknown; purpose: unknown;
  method: unknown; request_target: unknown; body_sha256: unknown;
}

interface DeviceRegisterRequest {
  account_id: unknown; public_key: unknown; issued_at: unknown;
  binding_signature: unknown; turnstile_token: unknown;
}

/** 唯一挑战入口：身份来自finalized投影，客户端只能声明待认证请求。 */
export async function createMlsChallenge(request: Request<unknown, unknown>, env: Env): Promise<Response> {
  const body = await readJson<ChallengeRequest>(request);
  assertExactFields(body, ['account_id', 'public_key', 'purpose', 'method', 'request_target', 'body_sha256']);
  const accountId = accountIdFrom(body.account_id);
  const publicKey = assertMlsPublicKey(body.public_key);
  const bodyHash = assertMlsPublicKey(body.body_sha256);
  assertMlsTarget(body.method, body.request_target);
  if (!['session', 'request', 'registration'].includes(body.purpose as string)) {
    throw new HttpError(400, 'invalid_mls_purpose', '认证挑战用途不合法');
  }
  const purpose = body.purpose as MlsAuthenticationPurpose;
  const method = body.method as string;
  const target = body.request_target as string;
  const origin = assertMlsOrigin(new URL(request.url).origin);
  const targetUrl = new URL(target, origin);
  const path = targetUrl.pathname.startsWith('/api/') ? targetUrl.pathname.slice(4) : targetUrl.pathname;
  // 标准URL解释必须保留声明的路径；禁止点段规范化、未知路由或把挑战端点作为认证目标。
  if (targetUrl.pathname + targetUrl.search !== target || !routeResource(method, path)
      || (purpose === 'session' && (method !== 'POST' || path !== '/square/auth/session' || targetUrl.search))
      || (purpose === 'registration' && (method !== 'POST' || path !== '/square/auth/device/register' || targetUrl.search))
      || (purpose === 'request' && path.startsWith('/square/auth/'))) {
    throw new HttpError(400, 'invalid_mls_target', '认证目标不合法');
  }
  const identity = await readUserByAccountId(env, accountId);
  if (!identity) return throwMissingIdentity(env, '当前账户未绑定CID');
  const deviceId = publicKey.slice(2);
  let sessionHash: string | null = null;
  if (purpose === 'request') {
    const session = await requireSession(request, env);
    if (session.cid_number !== identity.cid_number || session.account_id !== accountId
        || session.binding_revision !== identity.binding_revision || session.device_id !== deviceId) {
      throw new HttpError(401, 'cid_binding_changed', '当前会话与MLS身份不一致');
    }
    sessionHash = await requestSessionHash(request);
  }
  if (purpose !== 'registration') {
    const device = await readMlsDevice(env, identity.cid_number, deviceId);
    if (!device || device.public_key !== publicKey || device.account_id !== accountId
        || device.binding_revision !== identity.binding_revision) {
      throw new HttpError(401, 'device_not_registered', '当前MLS设备尚未登记');
    }
  }
  const challenge = randomMlsChallenge();
  const now = nowMs();
  const limit = resourceLimit('mls_authentication_challenge');
  const expiresAt = now + limit.ttl_seconds! * 1000;
  // 条件INSERT在同一D1语句内计数，避免并发签发突破未消费挑战上限。
  const inserted = await env.DB.prepare(
    'INSERT INTO mls_authentication_challenges'
    + ' (challenge, purpose, cid_number, device_id, binding_revision, account_id, service_origin,'
    + ' method, request_target, body_sha256, session_token_hash, created_at, expires_at_millis)'
    + ' SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?'
    + ' WHERE (SELECT COUNT(*) FROM mls_authentication_challenges WHERE cid_number = ? AND purpose = ? AND expires_at_millis > ?) < ?'
    + ' AND EXISTS (SELECT 1 FROM users WHERE cid_number = ? AND binding_revision = ? AND account_id = ?)',
  ).bind(challenge, purpose, identity.cid_number, deviceId, identity.binding_revision, accountId, origin,
    method, target, bodyHash, sessionHash, now, expiresAt, identity.cid_number, purpose, now, limit.max_count!,
    identity.cid_number, identity.binding_revision, accountId).run();
  if (inserted.meta.changes !== 1) throw new HttpError(429, 'mls_challenge_limit_reached', '认证挑战已达上限或身份发生变化');
  return jsonResponse({
    ok: true, user_id: identity.cid_number, device_id: deviceId, public_key: publicKey,
    account_id: accountId, binding_revision: identity.binding_revision, service_origin: origin,
    challenge, expires_at_millis: expiresAt, method, request_target: target, body_sha256: bodyHash,
  });
}

/** 已登记MLS身份消费登录挑战后建立会话，不请求钱包签名或派生其他密钥。 */
export async function createSession(request: Request<unknown, unknown>, env: Env): Promise<Response> {
  const body = await readJson<{ account_id: unknown }>(request.clone());
  assertExactFields(body, ['account_id']);
  const accountId = accountIdFrom(body.account_id);
  if (readMlsProof(request).account_id !== accountId) throw new HttpError(401, 'invalid_mls_proof', '登录账户与证明不一致');
  const proof = await consumeMlsAuthentication(request, env, 'session');
  const sessionTtlSeconds = parsePositiveInt(env.SESSION_TTL_SECONDS, 86_400);
  const sessionToken = createId('sqs');
  const session: SessionState = {
    cid_number: proof.user_id, binding_revision: proof.binding_revision, account_id: accountId,
    device_id: proof.device_id, created_at: nowMs(), expires_at: secondsFromNow(sessionTtlSeconds),
  };
  try {
    await putKvJson(env, await sessionCacheKey(sessionToken), session, 'session_cache', { expirationTtl: sessionTtlSeconds });
    await indexIdentitySession(env, sessionToken, session);
  } catch (error) {
    // 任一持久化失败烧毁挑战并清除半成品，重试须取得新挑战。
    await rollbackIdentitySession(env, sessionToken).catch(() => undefined);
    throw error;
  }
  return jsonResponse({
    ok: true, session_token: sessionToken, cid_number: proof.user_id, device_id: proof.device_id,
    binding_revision: proof.binding_revision, account_id: accountId, expires_at: session.expires_at,
  });
}

/** 钱包授权和MLS持钥证明缺一不可；自报公钥无法取得CID授权。 */
export async function registerMlsDevice(request: Request, env: Env): Promise<Response> {
  const body = await readJson<DeviceRegisterRequest>(request.clone());
  assertExactFields(body, ['account_id', 'public_key', 'issued_at', 'binding_signature', 'turnstile_token']);
  const accountId = accountIdFrom(body.account_id);
  const publicKey = assertMlsPublicKey(body.public_key);
  const now = nowMs();
  if (typeof body.issued_at !== 'number' || !Number.isSafeInteger(body.issued_at)
      || body.issued_at <= 0 || body.issued_at > now + 300_000 || typeof body.binding_signature !== 'string') {
    throw new HttpError(400, 'invalid_device_binding', 'MLS登记授权格式不合法');
  }
  const identity = await readUserByAccountId(env, accountId);
  if (!identity) return throwMissingIdentity(env, '当前账户未绑定CID');
  const proof = readMlsProof(request);
  if (proof.user_id !== identity.cid_number || proof.public_key !== publicKey
      || proof.account_id !== accountId || proof.binding_revision !== identity.binding_revision) {
    throw new HttpError(401, 'invalid_mls_proof', 'MLS登记证明与钱包授权不一致');
  }
  const message = buildMlsDeviceBindingSigningMessage({
    cid_number: identity.cid_number, binding_revision: identity.binding_revision,
    account_id: accountId, public_key: publicKey, issued_at: body.issued_at,
  });
  if (!await verifyWalletSignature(message, body.binding_signature, accountId)) {
    throw new HttpError(401, 'invalid_binding_signature', 'MLS设备登记钱包授权无效');
  }
  const existing = await readMlsDevice(env, identity.cid_number, proof.device_id);
  const identical = sameRegistration(existing, identity.binding_revision, accountId, publicKey, body.issued_at);
  if (!identical) {
    if (existing && (existing.binding_revision > identity.binding_revision
        || (existing.binding_revision === identity.binding_revision && existing.issued_at >= body.issued_at))) {
      throw new HttpError(409, 'stale_device_binding', '登记证明不能覆盖更新记录');
    }
    await verifyTurnstile(request, env, body.turnstile_token);
  }
  // 原钱包授权可以持久复用；每次重试仍须证明控制同一MLS身份且只消费新挑战。
  await consumeMlsAuthentication(request, env, 'registration');
  const written = await env.DB.prepare(
    'INSERT INTO mls_devices (cid_number, device_id, binding_revision, account_id, public_key, issued_at, created_at, updated_at)'
    + ' SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE cid_number = ? AND binding_revision = ? AND account_id = ?)'
    + ' ON CONFLICT(cid_number, device_id) DO UPDATE SET binding_revision = excluded.binding_revision,'
    + ' account_id = excluded.account_id, public_key = excluded.public_key, issued_at = excluded.issued_at, updated_at = excluded.updated_at'
    + ' WHERE excluded.binding_revision > mls_devices.binding_revision OR'
    + ' (excluded.binding_revision = mls_devices.binding_revision AND excluded.issued_at > mls_devices.issued_at)',
  ).bind(identity.cid_number, proof.device_id, identity.binding_revision, accountId, publicKey, body.issued_at,
    now, now, identity.cid_number, identity.binding_revision, accountId).run();
  if (written.meta.changes !== 1) {
    const current = await readUserByAccountId(env, accountId);
    const registered = await readMlsDevice(env, identity.cid_number, proof.device_id);
    if (!current || current.cid_number !== identity.cid_number || current.binding_revision !== identity.binding_revision
        || !sameRegistration(registered, identity.binding_revision, accountId, publicKey, body.issued_at)) {
      throw new HttpError(409, 'stale_device_binding', '登记期间身份变化或已有更新记录');
    }
  }
  await revokeStaleBindingCredentials(env, identity.cid_number, identity.binding_revision, accountId);
  return jsonResponse({ ok: true, cid_number: identity.cid_number, binding_revision: identity.binding_revision, device_id: proof.device_id });
}

function sameRegistration(row: MlsDeviceRow | null, revision: number, accountId: string, publicKey: string, issuedAt: number): boolean {
  return !!row && row.binding_revision === revision && row.account_id === accountId && row.public_key === publicKey && row.issued_at === issuedAt;
}

function accountIdFrom(value: unknown): string {
  try { return assertAccountId(value); }
  catch { throw new HttpError(400, 'invalid_account_id', '账户标识格式不合法'); }
}

/** 缺失投影不等于未绑定，保留真实服务状态分类。 */
async function throwMissingIdentity(env: Env, unboundMessage: string): Promise<never> {
  const projection = await inspectUserProjectionHealth(env);
  if (projection.identity_projection_status === 'pending') throw new HttpError(409, 'identity_projection_pending', '当前身份仍在同步');
  if (projection.identity_projection_status === 'unavailable') throw new HttpError(503, 'identity_projection_unavailable', '身份投影服务暂时不可用');
  throw new HttpError(403, 'cid_not_bound', unboundMessage);
}

/** 只清除更早绑定的鉴权记录，不能删除并发产生的更高代次或CID业务数据。 */
async function revokeStaleBindingCredentials(env: Env, cidNumber: string, revision: number, accountId: string): Promise<void> {
  await clearStaleIdentitySessions(env, cidNumber, revision, accountId);
  await env.DB.batch(['mls_authentication_challenges', 'push_endpoints', 'mls_devices'].map((table) =>
    env.DB.prepare('DELETE FROM ' + table + ' WHERE cid_number = ? AND (binding_revision < ? OR (binding_revision = ? AND account_id <> ?))')
      .bind(cidNumber, revision, revision, accountId)));
}
