import { HttpError } from '../shared/http';
import { resourceLimit, routeResource, type ResourceKey } from './catalog';

/** 未登记路由必须在 IP 哈希、限流和任何 D1 查询之前拒绝。 */
export function assertKnownRoute(method: string, path: string): ResourceKey {
  const resourceKey = routeResource(method, path);
  if (!resourceKey) throw new HttpError(404, 'route_not_found', '接口不存在');
  return resourceKey;
}

export function assertRequestBodyLimit<H, C>(request: Request<H, C>, path: string): void {
  const resourceKey = assertKnownRoute(request.method, path);
  const declared = contentLength(request);
  if (['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase()) && declared === null) {
    throw new HttpError(411, 'content_length_required', '请求必须提供 Content-Length');
  }
  if (declared !== null && declared > resourceLimit(resourceKey).max_bytes) {
    throw new HttpError(413, 'request_too_large', '请求体超过服务端上限');
  }
}

export async function readLimitedBytes<H, C>(
  request: Request<H, C>,
  resourceKey?: ResourceKey,
  requireLength = false,
): Promise<Uint8Array> {
  const key = resourceKey ?? requestResource(request);
  const maxBytes = resourceLimit(key).max_bytes;
  const declared = contentLength(request);
  if (requireLength && declared === null) {
    throw new HttpError(411, 'content_length_required', '上传必须提供 Content-Length');
  }
  if (declared !== null && declared > maxBytes) {
    throw new HttpError(413, 'request_too_large', '请求体超过服务端上限');
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'request_too_large', '请求体超过服务端上限');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== total) {
    throw new HttpError(400, 'content_length_mismatch', '请求体长度与 Content-Length 不一致');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readLimitedText<H, C>(request: Request<H, C>, resourceKey?: ResourceKey): Promise<string> {
  const bytes = await readLimitedBytes(request, resourceKey);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'invalid_utf8', '请求体不是合法 UTF-8');
  }
}

export async function readLimitedJson<T, H = unknown, C = CfProperties<H>>(request: Request<H, C>): Promise<T> {
  const text = await readLimitedText(request);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}

/** 同域部署前缀属于入口层，返回给 App 的 Worker 上传地址必须保留当前前缀。 */
export function apiRouteUrl<H, C>(request: Request<H, C>, path: string, query: Record<string, string>): string {
  const current = new URL(request.url);
  const prefix = current.pathname.startsWith('/api/') ? '/api' : '';
  const url = new URL(`${prefix}${path}`, current.origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function requestResource<H, C>(request: Request<H, C>): ResourceKey {
  return assertKnownRoute(request.method, normalizePath(new URL(request.url).pathname));
}

function contentLength<H, C>(request: Request<H, C>): number | null {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'content_length_invalid', 'Content-Length 不合法');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'content_length_invalid', 'Content-Length 不合法');
  }
  return value;
}

function normalizePath(pathname: string): string {
  const prefix = '/api';
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}
