import type { Env } from '../types';
import {
  HttpError,
  jsonResponse,
  readJson,
  requireSession
} from '../shared/http';
import { isSha256Hex } from '../shared/hash';
import { profileAssetPrefix } from '../r2_keys';
import { resourceLimit, type ResourceKey } from '../limits/catalog';
import { apiRouteUrl, readLimitedBytes } from '../limits/request';
import { assertDeclaredResource, validateUploadBytes } from '../limits/upload';
import { putR2Object } from '../limits/storage';

interface PrepareAssetRequest {
  kind?: unknown;
  content_type?: unknown;
  byte_size?: unknown;
  sha256?: unknown;
}

/// 头像/背景准备只固定本人对象 key；实际字节必须再经 Worker 有界校验后写 R2。
export async function prepareProfileAsset(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<PrepareAssetRequest>(request);

  const kind =
    body.kind === 'banner' ? 'banner' : body.kind === 'avatar' ? 'avatar' : null;
  if (kind === null) {
    throw new HttpError(400, 'invalid_asset_kind', '资源类型必须是 avatar 或 banner');
  }
  const resourceKey: ResourceKey = kind === 'avatar' ? 'profile_avatar' : 'profile_banner';
  if (typeof body.content_type !== 'string' || typeof body.byte_size !== 'number') {
    throw new HttpError(400, 'invalid_asset_declaration', '资源文件声明不完整');
  }
  assertDeclaredResource({
    resource_key: resourceKey,
    byte_size: body.byte_size,
    content_type: body.content_type,
  });
  if (!isSha256Hex(body.sha256)) {
    throw new HttpError(400, 'invalid_sha256', 'sha256 必须是 64 位 hex');
  }

  const sha = (body.sha256 as string).toLowerCase();
  // 固定对象键让并发上传也只能覆盖同一对象，物理上不可能留下第二个头像或背景。
  const objectKey = `${profileAssetPrefix(session.cid_number)}${kind}`;
  const uploadUrl = apiRouteUrl(request, '/square/profile/assets', {
    object_key: objectKey,
    byte_size: String(body.byte_size),
    sha256: sha,
  });

  return jsonResponse({
    ok: true,
    object_key: objectKey,
    content_hash: sha,
    upload_url: uploadUrl
  });
}

/// 头像/背景实际上传入口：校验真实字节、文件头、尺寸和哈希，并只保留同类最新对象。
export async function putProfileAsset(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const objectKey = url.searchParams.get('object_key');
  if (!objectKey || !objectKey.startsWith(profileAssetPrefix(session.cid_number))) {
    throw new HttpError(403, 'asset_object_forbidden', '无权写入该资源对象');
  }
  const fileName = objectKey.slice(profileAssetPrefix(session.cid_number).length);
  const match = /^(avatar|banner)$/.exec(fileName);
  if (!match) throw new HttpError(400, 'asset_object_invalid', '资源对象 key 不合法');
  const kind = match[1]!;
  const resourceKey: ResourceKey = kind === 'avatar' ? 'profile_avatar' : 'profile_banner';
  const expectedHash = url.searchParams.get('sha256');
  if (!isSha256Hex(expectedHash)) {
    throw new HttpError(400, 'invalid_sha256', '上传地址缺少合法 sha256');
  }
  const expectedBytes = Number.parseInt(url.searchParams.get('byte_size') ?? '', 10);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 ||
      expectedBytes > resourceLimit(resourceKey).max_bytes) {
    throw new HttpError(400, 'invalid_byte_size', '资源申报大小不合法');
  }
  const bytes = await readLimitedBytes(request, resourceKey, true);
  const ticket = await validateUploadBytes({
    resource_key: resourceKey,
    bytes,
    content_type: request.headers.get('content-type') ?? '',
    expected_bytes: expectedBytes,
    expected_hash: expectedHash,
  });
  await putR2Object(env, objectKey, bytes, ticket);
  return jsonResponse({
    ok: true,
    object_key: objectKey,
    content_hash: ticket.content_hash,
    byte_size: ticket.byte_size,
    width: ticket.width,
    height: ticket.height,
  });
}
