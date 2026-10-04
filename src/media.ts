import { AwsClient } from 'aws4fetch';

import type { Env, MediaAssetRow, MediaUploadMethod } from './types';
import { HttpError } from './shared/http';
import { putKvJson } from './limits/storage';
import { hexToBytes } from './shared/signing_message';

const MEDIA_PREFIX = '/square/media/';
const PRESIGNED_UPLOAD_TTL_SECONDS = 15 * 60;
const PUBLIC_MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const R2_AUDIT_CURSOR_KEY = 'square_r2_audit_cursor';
const R2_DELETE_BATCH = 1000;
const CACHE_PURGE_URL_BATCH = 100;

export interface R2ObjectUploadPlan {
  object_key: string;
  upload_method: MediaUploadMethod;
  upload_url: string;
  upload_headers: Record<string, string>;
}

interface R2ObjectDeclaration {
  object_key: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  upload_id: string;
  media_index: number;
  object_role: 'source' | 'thumbnail' | 'cover';
}

/** 所有媒体都用带 SHA-256 的单次直传，正文不经过 Worker，R2 校验完整对象。 */
export async function createR2ObjectUpload(
  env: Env,
  declaration: R2ObjectDeclaration,
): Promise<R2ObjectUploadPlan> {
  const headers = {
    'content-type': declaration.content_type,
    'content-length': String(declaration.byte_size),
    'cache-control': PUBLIC_MEDIA_CACHE_CONTROL,
    'x-amz-checksum-sha256': checksumBase64(declaration.sha256),
    'x-amz-meta-sha256': declaration.sha256,
    'x-amz-meta-upload-id': declaration.upload_id,
    'x-amz-meta-media-index': String(declaration.media_index),
    'x-amz-meta-object-role': declaration.object_role,
  };
  return {
    object_key: declaration.object_key,
    upload_method: 'r2_put',
    upload_url: await presignedR2Url(env, declaration.object_key, 'PUT', headers),
    upload_headers: headers,
  };
}

/** 主媒体及衍生图是一个生命周期单元，删除时必须一起处理。 */
export async function deleteR2MediaAsset(
  env: Env,
  row: Pick<MediaAssetRow, 'object_key' | 'derivative_object_key'>,
): Promise<void> {
  await deleteR2MediaAssets(env, [row]);
}

/** 主媒体与衍生图按官方上限批量删除，禁止逐媒体放大 R2 与 Cache Purge 请求。 */
export async function deleteR2MediaAssets(
  env: Env,
  rows: ReadonlyArray<Pick<MediaAssetRow, 'object_key' | 'derivative_object_key'>>,
): Promise<void> {
  const objectKeys = [...new Set(rows.flatMap((row) => [
    row.object_key,
    row.derivative_object_key,
  ]))];
  for (let index = 0; index < objectKeys.length; index += R2_DELETE_BATCH) {
    await env.SQUARE_PUBLIC_MEDIA.delete(objectKeys.slice(index, index + R2_DELETE_BATCH));
  }
  await purgePublicMediaCache(env, objectKeys);
}

/**
 * 私有资料媒体读取入口。帖子媒体由独立公开 R2 bucket 的自定义域名直接交付，禁止再经过
 * Worker 或 D1；这样既保留资料会话门禁，也让图片/视频命中 CDN 后不产生 Worker 请求。
 */
export async function mediaRoute(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const objectKey = decodeObjectKey(path);
  const isProfile = /^profile\/[^/]+\/(avatar|banner)$/.test(objectKey);
  if (!isProfile) {
    throw new HttpError(400, 'invalid_media_key', '媒体对象路径不合法');
  }

  const options: R2GetOptions = {};
  if (request.headers.has('range')) options.range = request.headers;
  if (request.headers.has('if-none-match') || request.headers.has('if-match')) {
    options.onlyIf = request.headers;
  }
  const object = await env.SQUARE_PRIVATE.get(objectKey, options);
  if (!object) throw new HttpError(404, 'media_not_found', '媒体对象不存在');
  if (!('body' in object)) {
    return new Response(null, { status: request.headers.has('if-none-match') ? 304 : 412 });
  }

  const headers = new Headers();
  headers.set('content-type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  if (object.httpMetadata?.contentDisposition) {
    headers.set('content-disposition', object.httpMetadata.contentDisposition);
  }
  headers.set('accept-ranges', 'bytes');
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, no-store');
  let status = 200;
  const range = object.range;
  if (request.headers.has('range') && range && 'offset' in range && 'length' in range &&
      typeof range.offset === 'number' && typeof range.length === 'number') {
    status = 206;
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set('content-length', String(range.length));
  } else {
    headers.set('content-length', String(object.size));
  }
  return new Response(object.body, { status, headers });
}

/** 由服务端 object key 生成唯一公开 CDN URL；禁止客户端提供主机名或任意路径。 */
export function publicMediaUrl(env: Env, objectKey: string): string {
  if (!isSquarePublicMediaKey(objectKey)) {
    throw new HttpError(500, 'invalid_public_media_key', '公开媒体对象键不合法');
  }
  const baseUrl = env.SQUARE_PUBLIC_MEDIA_BASE_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl || !isHttpsOrigin(baseUrl)) {
    throw new HttpError(503, 'public_media_domain_not_configured', '公开媒体 CDN 域名未配置');
  }
  return `${baseUrl}/${encodeObjectKey(objectKey)}`;
}

/**
 * 删除公开对象后按精确 URL 清理所有边缘节点缓存。失败必须向上抛出，让 D1 索引保留并由
 * 生命周期任务重试；R2 delete 与单 URL purge 都可安全幂等重放。
 */
export async function purgePublicMediaCache(env: Env, objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  const zoneId = env.ZONE_ID?.trim();
  const token = env.PURGE?.trim();
  if (!zoneId || !/^[a-f0-9]{32}$/.test(zoneId) || !token) {
    throw new HttpError(503, 'cache_purge_not_configured', '公开媒体缓存清理配置不完整');
  }
  const files = [...new Set(objectKeys)].map((objectKey) => publicMediaUrl(env, objectKey));
  for (let index = 0; index < files.length; index += CACHE_PURGE_URL_BATCH) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files: files.slice(index, index + CACHE_PURGE_URL_BATCH) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result: { success?: boolean } = await response
      .json<{ success?: boolean }>()
      .catch(() => ({}));
    if (!response.ok || result.success !== true) {
      throw new HttpError(502, 'cache_purge_failed', '公开媒体 CDN 缓存清理失败');
    }
  }
}

export interface SquareR2ConsistencyResult {
  checked_media_assets: number;
  checked_manifests: number;
  missing_public_objects: number;
  missing_private_objects: number;
}

interface R2AuditCursor {
  media?: { updated_at: number; upload_id: string; media_index: number };
  manifest?: { completed_at: number; upload_id: string };
}

interface ManifestAuditRow {
  upload_id: string;
  post_id: string;
  cid_number: string;
  manifest_byte_size: number;
  completed_at: number;
}

/**
 * 每日按 KV 单例游标轮转抽查 D1 指向的 R2 对象，不扫描 bucket，也不永久重复最旧记录。
 * 缺失项保留 D1 真源并输出结构化日志，禁止因一次存储故障自动删除已发布内容。
 */
export async function auditSquareR2Consistency(
  env: Env,
  limit = 10,
): Promise<SquareR2ConsistencyResult> {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const cursor = await readR2AuditCursor(env);
  const assets = await readMediaAuditPage(env, cursor.media, boundedLimit);
  const uploads = await readManifestAuditPage(env, cursor.manifest, boundedLimit);

  let missingPublic = 0;
  for (const asset of assets) {
    const [source, derivative] = await Promise.all([
      env.SQUARE_PUBLIC_MEDIA.head(asset.object_key),
      env.SQUARE_PUBLIC_MEDIA.head(asset.derivative_object_key),
    ]);
    if (!source || !derivative) {
      missingPublic += Number(!source) + Number(!derivative);
      console.error(JSON.stringify({
        event: 'square_r2_consistency_missing_public_media',
        upload_id: asset.upload_id,
        post_id: asset.post_id,
        media_index: asset.media_index,
        source_missing: !source,
        derivative_missing: !derivative,
      }));
    }
  }
  let missingPrivate = 0;
  for (const upload of uploads) {
    if (!await env.SQUARE_PRIVATE.head(
      `square/${upload.cid_number}/posts/${upload.post_id}/manifest.json`,
    )) {
      missingPrivate += 1;
      console.error(JSON.stringify({
        event: 'square_r2_consistency_missing_manifest',
        upload_id: upload.upload_id,
        post_id: upload.post_id,
      }));
    }
  }
  const lastAsset = assets.at(-1);
  const lastUpload = uploads.at(-1);
  if (lastAsset || lastUpload) {
    await putKvJson(env, R2_AUDIT_CURSOR_KEY, {
      media: lastAsset ? {
        updated_at: lastAsset.updated_at,
        upload_id: lastAsset.upload_id,
        media_index: lastAsset.media_index,
      } : cursor.media,
      manifest: lastUpload ? {
        completed_at: lastUpload.completed_at,
        upload_id: lastUpload.upload_id,
      } : cursor.manifest,
    } satisfies R2AuditCursor, 'api_json_small');
  }
  return {
    checked_media_assets: assets.length,
    checked_manifests: uploads.length,
    missing_public_objects: missingPublic,
    missing_private_objects: missingPrivate,
  };
}

async function readR2AuditCursor(env: Env): Promise<R2AuditCursor> {
  const value = await env.SQUARE_CACHE.get<unknown>(R2_AUDIT_CURSOR_KEY, 'json');
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  return {
    media: parseMediaAuditCursor(raw.media),
    manifest: parseManifestAuditCursor(raw.manifest),
  };
}

async function readMediaAuditPage(
  env: Env,
  cursor: R2AuditCursor['media'],
  limit: number,
): Promise<MediaAssetRow[]> {
  const select = `SELECT upload_id, post_id, cid_number, account_id, media_index, media_kind,
    object_key, upload_method, resource_key, content_type, byte_size, sha256,
    derivative_kind, derivative_object_key, derivative_content_type, derivative_byte_size,
    derivative_sha256, asset_state, duration_seconds, width, height, error_code,
    created_at, updated_at, ready_at FROM square_media_assets`;
  if (cursor) {
    const page = (await env.DB.prepare(
      `${select} WHERE asset_state = 'ready'
        AND (updated_at, upload_id, media_index) > (?, ?, ?)
        ORDER BY updated_at ASC, upload_id ASC, media_index ASC LIMIT ?`,
    )
      .bind(cursor.updated_at, cursor.upload_id, cursor.media_index, limit)
      .all<MediaAssetRow>()).results ?? [];
    if (page.length > 0) return page;
  }
  return (await env.DB.prepare(
    `${select} WHERE asset_state = 'ready'
      ORDER BY updated_at ASC, upload_id ASC, media_index ASC LIMIT ?`,
  ).bind(limit).all<MediaAssetRow>()).results ?? [];
}

async function readManifestAuditPage(
  env: Env,
  cursor: R2AuditCursor['manifest'],
  limit: number,
): Promise<ManifestAuditRow[]> {
  const select = `SELECT upload_id, post_id, cid_number, manifest_byte_size, completed_at
    FROM square_uploads`;
  if (cursor) {
    const page = (await env.DB.prepare(
      `${select} WHERE status = 'completed' AND completed_at IS NOT NULL
        AND (completed_at, upload_id) > (?, ?)
        ORDER BY completed_at ASC, upload_id ASC LIMIT ?`,
    )
      .bind(cursor.completed_at, cursor.upload_id, limit)
      .all<ManifestAuditRow>()).results ?? [];
    if (page.length > 0) return page;
  }
  return (await env.DB.prepare(
    `${select} WHERE status = 'completed' AND completed_at IS NOT NULL
      ORDER BY completed_at ASC, upload_id ASC LIMIT ?`,
  ).bind(limit).all<ManifestAuditRow>()).results ?? [];
}

function parseMediaAuditCursor(value: unknown): R2AuditCursor['media'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.updated_at !== 'number'
    || typeof raw.upload_id !== 'string'
    || typeof raw.media_index !== 'number'
  ) return undefined;
  return {
    updated_at: raw.updated_at,
    upload_id: raw.upload_id,
    media_index: raw.media_index,
  };
}

function parseManifestAuditCursor(value: unknown): R2AuditCursor['manifest'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.completed_at !== 'number' || typeof raw.upload_id !== 'string') {
    return undefined;
  }
  return { completed_at: raw.completed_at, upload_id: raw.upload_id };
}

function decodeObjectKey(path: string): string {
  try {
    return path
      .slice(MEDIA_PREFIX.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    throw new HttpError(400, 'invalid_media_key', '媒体对象路径编码不合法');
  }
}

/** S3 checksum 请求头使用标准 Base64，D1 与业务协议继续保存小写 hex。 */
function checksumBase64(sha256: string): string {
  const bytes = hexToBytes(sha256);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isSquarePublicMediaKey(objectKey: string): boolean {
  return /^square\/[^/]+\/posts\/[a-zA-Z0-9_-]+\/media\/\d+\/(source\.(?:webp|mp4)|thumbnail\.webp|cover\.webp)$/.test(objectKey);
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split('/').map(encodeURIComponent).join('/');
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

async function presignedR2Url(
  env: Env,
  objectKey: string,
  method: 'PUT',
  headers: Record<string, string>,
  query: URLSearchParams = new URLSearchParams(),
): Promise<string> {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_KEY?.trim();
  const secretAccessKey = env.R2_SECRET?.trim();
  const bucket = env.SQUARE_PUBLIC_MEDIA_BUCKET_NAME?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new HttpError(503, 'r2_upload_signing_not_configured', 'R2 直传签名配置不完整');
  }
  const encodedKey = encodeObjectKey(objectKey);
  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`);
  for (const [key, value] of query) url.searchParams.set(key, value);
  url.searchParams.set('X-Amz-Expires', String(PRESIGNED_UPLOAD_TTL_SECONDS));
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const signed = await client.sign(new Request(url, { method, headers }), {
    aws: { signQuery: true },
  });
  return signed.url;
}
