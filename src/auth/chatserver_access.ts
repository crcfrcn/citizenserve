import type { Env } from '../types';
import { getMembership, subscriptionIsActive } from '../membership/service';
import { membershipPlan } from '../membership/plans';
import { HttpError, jsonResponse, readJson, requireSession } from '../shared/http';
import { nowMs } from '../shared/time';

const CITIZENCHATSERVER_AUDIENCE = 'citizenchatserver';
const CHAT_SERVER_ACCESS_TTL_MILLIS = 15 * 60 * 1000;

interface ChatServerAccessRequest {
  device_id?: unknown;
}

interface ChatServerClaims {
  sub: string;
  device_id: string;
  chat_enabled: true;
  max_attachment_bytes: number;
  iss: string;
  aud: typeof CITIZENCHATSERVER_AUDIENCE;
  nbf: number;
  exp: number;
}

/**
 * CitizenServe 只把已经验证的公民身份、设备会话和会员权益签成 CitizenChatServer 短期授权。
 * 该控制面不承载聊天数据；CitizenChatServer 只验签，不读取公民产品表或 CitizenServe 会话。
 */
export async function issueChatServerAccess(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<ChatServerAccessRequest>(request);
  const deviceId = requireDeviceId(body.device_id);
  const membership = await getMembership(env, session.cid_number);
  if (!membership || !subscriptionIsActive(membership)) {
    throw new HttpError(403, 'chat_membership_required', '需要有效会员才能使用聊天');
  }

  const chatServerUrl = requireHttpsOrigin(env.CHAT_SERVER_URL, 'chat_server_not_configured');
  const issuer = requireHttpsOrigin(env.WEB_ORIGIN, 'chat_issuer_not_configured');
  const issuedAtMillis = nowMs();
  const expiresAtMillis = issuedAtMillis + CHAT_SERVER_ACCESS_TTL_MILLIS;
  const claims: ChatServerClaims = {
    sub: session.cid_number,
    device_id: deviceId,
    chat_enabled: true,
    max_attachment_bytes: membershipPlan(membership.membership_level).chat_file_max_bytes,
    iss: issuer,
    aud: CITIZENCHATSERVER_AUDIENCE,
    nbf: Math.floor(issuedAtMillis / 1000),
    exp: Math.floor(expiresAtMillis / 1000),
  };
  const privateKey = env.CHAT_AUTH_ED25519_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new HttpError(503, 'chat_signing_key_not_configured', '聊天授权签名尚未配置');
  }

  return jsonResponse({
    ok: true,
    chat_server_url: chatServerUrl,
    chat_server_token: await signChatServerToken(claims, privateKey),
    expires_at_millis: expiresAtMillis,
  });
}

export async function signChatServerToken(
  claims: ChatServerClaims,
  privateKeyPem: string,
): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemBody(privateKeyPem, 'PRIVATE KEY'),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
  } catch {
    throw new HttpError(503, 'chat_signing_key_invalid', '聊天授权签名配置无效');
  }
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function requireDeviceId(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || value.includes(':')
    || [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new HttpError(400, 'invalid_device_id', '聊天设备标识不合法');
  }
  return value;
}

function requireHttpsOrigin(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new HttpError(503, code, '聊天服务配置不完整');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(503, code, '聊天服务配置不完整');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new HttpError(503, code, '聊天服务配置不完整');
  }
  return url.origin;
}

function pemBody(pem: string, label: string): ArrayBuffer {
  const normalized = pem.replace(/\r/g, '').trim();
  const prefix = `-----BEGIN ${label}-----`;
  const suffix = `-----END ${label}-----`;
  if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) {
    throw new Error('invalid PEM');
  }
  const encoded = normalized.slice(prefix.length, -suffix.length).replace(/\s/g, '');
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
