import type { Env, SessionState } from '../types';
import { assertAccountId, assertCidNumber } from './ids';
import { readLimitedJson } from '../limits/request';
import { sessionCacheKey } from '../auth/session_index';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');

  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      {
        ok: false,
        error_code: error.code,
        message: error.message
      },
      { status: error.status }
    );
  }

  return jsonResponse(
    {
      ok: false,
      error_code: 'internal_error',
      message: '广场服务暂时不可用'
    },
    { status: 500 }
  );
}

export async function readJson<T>(request: Request<unknown, unknown>): Promise<T> {
  // JSON读取只依赖请求正文，保留实际请求的通用Cloudflare元数据类型。
  return readLimitedJson<T, unknown, unknown>(request);
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function requireSession(request: Request<unknown, unknown>, env: Env): Promise<SessionState> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'missing_session', '请先建立MLS设备会话');
  }

  const sessionToken = authorization.slice('Bearer '.length).trim();
  if (!sessionToken) {
    throw new HttpError(401, 'missing_session', '请先建立MLS设备会话');
  }

  const session = await env.SQUARE_CACHE.get<SessionState>(
    await sessionCacheKey(sessionToken),
    'json'
  );
  // 只接受唯一MLS会话结构，旧缓存或缺失字段不得被当成有效会话。
  let valid = false;
  if (session && typeof session === 'object' && !Array.isArray(session)) {
    try {
      assertCidNumber(session.cid_number); assertAccountId(session.account_id);
      valid = Object.keys(session).sort().join(',') === 'account_id,binding_revision,cid_number,created_at,device_id,expires_at'
        && typeof session.device_id === 'string' && /^[0-9a-f]{64}$/.test(session.device_id)
        && Number.isSafeInteger(session.binding_revision) && session.binding_revision > 0
        && Number.isSafeInteger(session.created_at) && session.created_at >= 0
        && Number.isSafeInteger(session.expires_at) && session.expires_at > session.created_at;
    } catch { valid = false; }
  }
  if (!valid || !session || session.expires_at <= Date.now()) {
    throw new HttpError(401, 'expired_session', '设备会话已过期');
  }

  return session;
}

/// 可选登录态：带合法 Bearer 时返回 session，否则返回 null（用于公开可读、登录可增强的接口）。
export async function maybeSession(request: Request<unknown, unknown>, env: Env): Promise<SessionState | null> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }
  try {
    return await requireSession(request, env);
  } catch {
    return null;
  }
}

export function optionsResponse(): Response {
  return new Response(null, { status: 204 });
}
