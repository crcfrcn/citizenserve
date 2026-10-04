import type { Env } from '../types';
import { resourceLimit } from '../limits/catalog';
import { HttpError, jsonResponse, readJson, requireSession } from '../shared/http';
import { nowMs } from '../shared/time';

type PushProvider = 'apns' | 'fcm';
type ApnsEnvironment = 'sandbox' | 'production';

interface RegisterPushEndpointRequest {
  push_provider?: unknown;
  push_token?: unknown;
  apns_environment?: unknown;
  expires_at?: unknown;
}

/**
 * 幂等登记当前 CitizenServe 会话设备的普通应用通知端点。
 *
 * 设备身份只读取已验签 Session 的 device_key_hash；请求不得自报设备编号。该端点只服务
 * 广场公开通知和会员存储清理提醒，不承载聊天唤醒、消息、会话或附件信息。
 */
export async function registerPushEndpoint(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<RegisterPushEndpointRequest>(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_push_endpoint_fields', '应用推送端点字段不合法');
  }
  const fields = Object.keys(body).sort();
  const expected = ['apns_environment', 'expires_at', 'push_provider', 'push_token'];
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new HttpError(400, 'invalid_push_endpoint_fields', '应用推送端点字段不合法');
  }
  const pushProvider = assertPushProvider(body.push_provider);
  const pushToken = assertPushToken(body.push_token);
  const apnsEnvironment = assertApnsEnvironment(pushProvider, body.apns_environment);
  const expiresAt = assertPositiveMillis(body.expires_at);
  const current = nowMs();
  if (expiresAt <= current) {
    throw new HttpError(400, 'expired_push_endpoint', '应用推送端点已经过期');
  }
  const endpointLimit = resourceLimit('push_endpoint');
  const maxExpiresAt = current + (endpointLimit.ttl_seconds ?? 1) * 1000;
  if (expiresAt > maxExpiresAt) {
    throw new HttpError(400, 'push_endpoint_ttl_exceeded', '应用推送端点有效期超过上限');
  }

  const existing = await env.DB.prepare(
    `SELECT binding_revision, account_id, push_provider, push_token,
            apns_environment, expires_at
       FROM push_endpoints
      WHERE cid_number = ? AND device_key_hash = ?`,
  )
    .bind(session.cid_number, session.device_key_hash)
    .first<{
      binding_revision: number;
      account_id: string;
      push_provider: string;
      push_token: string;
      apns_environment: string | null;
      expires_at: number;
    }>();
  const refreshFloor = current + Math.floor((endpointLimit.ttl_seconds ?? 1) * 1000 / 3);
  if (
    existing?.binding_revision === session.binding_revision
    && existing.account_id === session.account_id
    && existing.push_provider === pushProvider
    && existing.push_token === pushToken
    && existing.apns_environment === apnsEnvironment
    && existing.expires_at > refreshFloor
  ) {
    return jsonResponse({ ok: true, expires_at: existing.expires_at });
  }

  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM push_endpoints
      WHERE cid_number = ? AND device_key_hash <> ? AND expires_at > ?`,
  )
    .bind(session.cid_number, session.device_key_hash, current)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= (endpointLimit.max_count ?? 1)) {
    throw new HttpError(409, 'push_endpoint_limit_reached', '应用推送设备数已达上限');
  }

  // 同一平台 Token 只能属于一个 finalized 当前会话；重装、换绑和 Token 轮换时直接清除旧归属。
  await env.DB.prepare(
    `DELETE FROM push_endpoints
      WHERE push_provider = ? AND push_token = ?
        AND (cid_number <> ? OR device_key_hash <> ?)`,
  )
    .bind(pushProvider, pushToken, session.cid_number, session.device_key_hash)
    .run();
  await env.DB.prepare(
    `INSERT INTO push_endpoints
      (cid_number, binding_revision, account_id, device_key_hash, push_provider,
       push_token, apns_environment, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cid_number, device_key_hash) DO UPDATE SET
        binding_revision = excluded.binding_revision,
        account_id = excluded.account_id,
        push_provider = excluded.push_provider,
        push_token = excluded.push_token,
        apns_environment = excluded.apns_environment,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
  )
    .bind(
      session.cid_number,
      session.binding_revision,
      session.account_id,
      session.device_key_hash,
      pushProvider,
      pushToken,
      apnsEnvironment,
      expiresAt,
      current,
    )
    .run();
  return jsonResponse({ ok: true, expires_at: expiresAt });
}

/** 定时删除过期普通应用通知端点。 */
export async function cleanupExpiredPushEndpoints(
  env: Env,
  current = nowMs(),
): Promise<void> {
  await env.DB.prepare('DELETE FROM push_endpoints WHERE expires_at <= ?')
    .bind(current)
    .run();
}

function assertPushProvider(value: unknown): PushProvider {
  if (value === 'apns' || value === 'fcm') return value;
  throw new HttpError(400, 'invalid_push_provider', '应用推送服务不合法');
}

function assertPushToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096) {
    throw new HttpError(400, 'invalid_push_token', '应用推送 Token 不合法');
  }
  return value;
}

function assertApnsEnvironment(
  pushProvider: PushProvider,
  value: unknown,
): ApnsEnvironment | null {
  if (pushProvider === 'apns') {
    if (value === 'sandbox' || value === 'production') return value;
    throw new HttpError(400, 'invalid_apns_environment', 'APNs 环境不合法');
  }
  if (value === null) return null;
  throw new HttpError(400, 'unexpected_apns_environment', 'FCM 端点不得携带 APNs 环境');
}

function assertPositiveMillis(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, 'invalid_push_endpoint_expires_at', '应用推送端点过期时间不合法');
  }
  return value;
}
