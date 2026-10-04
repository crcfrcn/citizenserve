import type { Env } from '../types';
import { readUserByCidNumber } from '../account/user_repository';
import { assertDeliverySize } from '../limits/delivery';
import { nowMs } from './time';

type PushProvider = 'apns' | 'fcm';
export type ApnsEnvironment = 'sandbox' | 'production';
const PUSH_TIMEOUT_MS = 10_000;

interface PushDeviceRow {
  push_provider: PushProvider;
  push_token: string;
  apns_environment: ApnsEnvironment | null;
}

/** 同一次 Worker/Queue 调用内复用推送凭据，禁止每台设备重复签名或请求 OAuth。 */
export interface PushAuth {
  apns_jwt?: Promise<string>;
  fcm_access_token?: Promise<string>;
}

export function createPushAuth(): PushAuth {
  return {};
}

/// 单台设备的推送目标（provider + token）；广场扇出按批查出后逐台发送。
export interface PushDevice {
  push_provider: PushProvider;
  push_token: string;
  apns_environment: ApnsEnvironment | null;
}

interface SquarePostAlert {
  title: string;
  body: string;
  post_id: string;
}

interface StorageCleanupAlert {
  title: string;
  body: string;
  cleanup_after: number;
  target_storage_bytes: number;
}

/**
 * 会员权益过期后的存储清理预告。只向当前 finalized 绑定仍有效的设备发送，载荷不含
 * 帖子正文或对象键；调用方必须在通知后另留等待期，禁止同一轮直接删除。
 */
export async function sendStorageCleanupAlert(
  env: Env,
  cidNumber: string,
  targetStorageBytes: number,
  cleanupAfter: number,
): Promise<number> {
  const identity = await readUserByCidNumber(env, cidNumber);
  if (!identity || !identity.account_id || identity.binding_revision <= 0) return 0;
  const devices = await env.DB.prepare(
    `SELECT push_provider, push_token, apns_environment
       FROM push_endpoints
      WHERE cid_number = ? AND binding_revision = ? AND account_id = ? AND expires_at > ?`,
  ).bind(
    cidNumber,
    identity.binding_revision,
    identity.account_id,
    nowMs(),
  ).all<PushDeviceRow>();
  const targetGb = Math.floor(targetStorageBytes / 1_000_000_000);
  const alert: StorageCleanupAlert = {
    title: '存储空间清理提醒',
    body: `会员权益已过期，24 小时后将按最旧内容清理至 ${targetGb}GB`,
    cleanup_after: cleanupAfter,
    target_storage_bytes: targetStorageBytes,
  };
  assertDeliverySize('push_notification', JSON.stringify(alert));
  const auth = createPushAuth();
  const outcomes = await Promise.all(
    (devices.results ?? []).map((device) =>
      sendDeviceStorageCleanupAlert(env, device, alert, auth).catch(() => false),
    ),
  );
  return outcomes.filter(Boolean).length;
}

async function sendDeviceStorageCleanupAlert(
  env: Env,
  device: PushDeviceRow,
  alert: StorageCleanupAlert,
  auth: PushAuth,
): Promise<boolean> {
  if (device.push_provider === 'apns') {
    if (device.apns_environment === null) return false;
    if (!env.APNS_KEY || !env.APNS_KID || !env.APNS_TEAM || !env.APNS_TOPIC) return false;
    const jwt = await apnsJwt(env, auth);
    const response = await fetch(
      `https://${apnsHost(device.apns_environment)}/3/device/${encodeURIComponent(device.push_token)}`,
      {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-topic': env.APNS_TOPIC,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' },
          kind: 'storage_cleanup',
          cleanup_after: alert.cleanup_after,
          target_storage_bytes: alert.target_storage_bytes,
        }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      },
    );
    return response.ok;
  }
  if (!env.FCM_PROJECT || !env.FCM_EMAIL || !env.FCM_KEY) return false;
  const accessToken = await fcmAccessToken(env, auth);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: device.push_token,
          notification: { title: alert.title, body: alert.body },
          data: {
            kind: 'storage_cleanup',
            cleanup_after: String(alert.cleanup_after),
            target_storage_bytes: String(alert.target_storage_bytes),
          },
          android: {
            priority: 'high',
            notification: { sound: 'default', channel_id: 'square_posts' },
          },
        },
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    },
  );
  return response.ok;
}

/// 广场发帖可见通知只携带公开作者标题与 post_id；不承载聊天状态或聊天唤醒。
export async function sendSquarePostAlert(
  env: Env,
  device: PushDevice,
  alert: SquarePostAlert,
  auth: PushAuth = createPushAuth(),
): Promise<boolean> {
  if (device.push_provider === 'apns') {
    if (device.apns_environment === null) return false;
    return sendApnsAlert(env, device.push_token, device.apns_environment, alert, auth);
  }
  return sendFcmAlert(env, device.push_token, alert, auth);
}

async function sendApnsAlert(
  env: Env,
  token: string,
  environment: ApnsEnvironment,
  alert: SquarePostAlert,
  auth: PushAuth,
): Promise<boolean> {
  if (!env.APNS_KEY || !env.APNS_KID || !env.APNS_TEAM || !env.APNS_TOPIC) {
    return false;
  }
  const jwt = await apnsJwt(env, auth);
  const host = apnsHost(environment);
  const response = await fetch(`https://${host}/3/device/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-topic': env.APNS_TOPIC,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' },
      kind: 'square_post',
      post_id: alert.post_id,
    }),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  return response.ok;
}

async function sendFcmAlert(
  env: Env,
  token: string,
  alert: SquarePostAlert,
  auth: PushAuth,
): Promise<boolean> {
  if (!env.FCM_PROJECT || !env.FCM_EMAIL || !env.FCM_KEY) {
    return false;
  }
  const accessToken = await fcmAccessToken(env, auth);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: alert.title, body: alert.body },
          data: { kind: 'square_post', post_id: alert.post_id },
          // Android 8+ 用 App 侧预建的高优先级渠道 'square_posts' 保证横幅+声音；
          // channel_id 必须与 MainActivity 创建的渠道一致，否则声音由系统默认渠道决定。
          android: {
            priority: 'high',
            notification: { sound: 'default', channel_id: 'square_posts' },
          },
        },
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    },
  );
  return response.ok;
}

/// APNs Token 的签发环境属于设备记录，不能由 Worker 环境全局决定。
export function apnsHost(environment: ApnsEnvironment): string {
  return environment === 'sandbox'
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com';
}

async function createApnsJwt(env: Env): Promise<string> {
  const header = encodeJson({ alg: 'ES256', kid: env.APNS_KID });
  const claims = encodeJson({ iss: env.APNS_TEAM, iat: Math.floor(Date.now() / 1000) });
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(env.APNS_KEY!),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function createFcmAccessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertionHeader = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const assertionClaims = encodeJson({
    iss: env.FCM_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${assertionHeader}.${assertionClaims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(env.FCM_KEY!),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error('FCM OAuth token request failed');
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('FCM OAuth response missing access token');
  }
  return json.access_token;
}

function apnsJwt(env: Env, auth: PushAuth): Promise<string> {
  auth.apns_jwt ??= createApnsJwt(env);
  return auth.apns_jwt;
}

function fcmAccessToken(env: Env, auth: PushAuth): Promise<string> {
  auth.fcm_access_token ??= createFcmAccessToken(env);
  return auth.fcm_access_token;
}

function pemBytes(value: string): ArrayBuffer {
  const body = value
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
