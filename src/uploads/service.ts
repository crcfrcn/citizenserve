import type { Env, MediaAssetRow, PreparedUploadRow, SessionState, UploadItemInput } from '../types';
import { HttpError, jsonResponse, parsePositiveInt, readJson, requireSession } from '../shared/http';
import { isSha256Hex, sha256Hex } from '../shared/hash';
import { createId } from '../shared/ids';
import { nowMs, secondsFromNow } from '../shared/time';
import { requireActiveMembership } from '../membership/service';
import { membershipPlan, type MembershipLevel } from '../membership/plans';
import {
  createR2ObjectUpload,
  deleteR2MediaAssets,
} from '../media';
import { buildObjectKeyPlan, manifestObjectKey, squareMediaObjectKeys } from '../r2_keys';
import { assertManifestHash, assertPostType, estimateUploadBytes, validateUploadItems } from './validation';
import { assertDeclaredContentQuota, assertDeclaredLength, assertManifestQuota } from './quota';
import { imageResource, resourceLimit, videoResource, type ResourceKey } from '../limits/catalog';
import { apiRouteUrl, readLimitedBytes } from '../limits/request';
import { assertDeclaredResource, validateUploadBytes } from '../limits/upload';
import { putR2Object } from '../limits/storage';
import { fetchFinalizedChainStorage } from '../chain/rpc';
import { storageMapKey } from '../chain/storage_key';
import { bytesToHex, scaleString } from '../shared/signing_message';
import {
  consumeUploadUsage,
  releaseUploadReservation,
  reserveUploadUsage,
  storedMediaReleaseStatements,
} from '../limits/usage';

interface PrepareUploadRequest {
  post_type?: unknown;
  title_length?: unknown;
  text_length?: unknown;
  manifest_hash?: unknown;
  manifest_byte_size?: unknown;
  media_items?: unknown;
}

interface CompleteUploadRequest {
  upload_id?: unknown;
  manifest_hash?: unknown;
  content_hash?: unknown;
}

export async function createStorageReceiptId(input: {
  uploadId: string;
  postId: string;
  cidNumber: string;
  manifestHash: string;
}): Promise<string> {
  return `sqr_${await sha256Hex(
    `${input.uploadId}:${input.postId}:${input.cidNumber}:${input.manifestHash}`,
  )}`;
}

async function getPreparedUpload(env: Env, uploadId: string): Promise<PreparedUploadRow> {
  const upload = await env.DB.prepare(
    `SELECT upload_id, post_id, cid_number, account_id, post_type, manifest_hash,
        manifest_byte_size, content_hash, storage_receipt_id, estimated_bytes, status,
        expires_at, created_at, completed_at
      FROM square_uploads WHERE upload_id = ?`,
  ).bind(uploadId).first<PreparedUploadRow>();
  if (!upload) throw new HttpError(404, 'upload_not_found', '上传任务不存在');
  return upload;
}

export async function prepareUpload(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<PrepareUploadRequest>(request);
  const postType = assertPostType(body.post_type);
  const titleLength = assertDeclaredLength(body.title_length, 'title_length');
  const textLength = assertDeclaredLength(body.text_length, 'text_length');
  const manifestHash = assertManifestHash(body.manifest_hash);
  const manifestByteSize = declaredManifestByteSize(body.manifest_byte_size);
  const mediaItems = validateUploadItems(body.media_items);
  const estimatedBytes = manifestByteSize + estimateUploadBytes(mediaItems);
  const membership = await requireActiveMembership(env, session.cid_number, session.account_id);
  const membershipLevel = normalizeMembershipLevel(membership.membership_level);
  const plan = membershipPlan(membershipLevel);
  assertDeclaredContentQuota({
    membershipLevel,
    plan,
    postType,
    titleLength,
    textLength,
    mediaItems,
  });
  const mediaResources = mediaItems.map((item) => mediaResource(membershipLevel, item));
  mediaItems.forEach((item, index) => {
    assertDeclaredResource({
      resource_key: mediaResources[index]!,
      byte_size: item.byte_size,
      content_type: item.content_type,
      duration_seconds: item.duration_seconds,
    });
    assertDeclaredResource({
      resource_key: item.derivative_kind === 'cover' ? 'square_video_cover' : 'square_image_thumbnail',
      byte_size: item.derivative_byte_size,
      content_type: item.derivative_content_type,
    });
    assertDimensions(item, resourceLimit(mediaResources[index]!));
  });

  const uploadId = createId('squ');
  const postId = createId('sqp');
  const expiresAt = secondsFromNow(
    mediaItems.some((item) => item.media_kind === 'video')
      ? 3600
      : parsePositiveInt(env.UPLOAD_TTL_SECONDS, 900),
  );
  const storageReceiptId = await createStorageReceiptId({
    uploadId,
    postId,
    cidNumber: session.cid_number,
    manifestHash,
  });
  await reserveUploadUsage({
    env,
    upload_id: uploadId,
    cid_number: session.cid_number,
    membership_level: membershipLevel,
    membership,
    byte_size: estimatedBytes,
    image_count: mediaItems.filter((item) => item.media_kind === 'image').length,
    video_seconds: mediaItems
      .filter((item) => item.media_kind === 'video')
      .reduce((sum, item) => sum + (item.duration_seconds ?? 0), 0),
    expires_at: expiresAt,
  });

  const plans: Array<{
    item: UploadItemInput;
    resourceKey: ResourceKey;
    keys: ReturnType<typeof squareMediaObjectKeys>;
    source: Awaited<ReturnType<typeof createR2ObjectUpload>>;
    derivative: Awaited<ReturnType<typeof createR2ObjectUpload>>;
  }> = [];
  try {
    for (const [index, item] of mediaItems.entries()) {
      const keys = squareMediaObjectKeys({
        cid_number: session.cid_number,
        post_id: postId,
        media_index: index,
        media_kind: item.media_kind,
      });
      const source = await createR2ObjectUpload(env, {
        object_key: keys.object_key,
        content_type: item.content_type,
        byte_size: item.byte_size,
        sha256: item.sha256,
        upload_id: uploadId,
        media_index: index,
        object_role: 'source',
      });
      // 此阶段只签发 URL，客户端还未上传对象；失败时不产生无效 R2 DELETE。
      const derivative = await createR2ObjectUpload(env, {
        object_key: keys.derivative_object_key,
        content_type: item.derivative_content_type,
        byte_size: item.derivative_byte_size,
        sha256: item.derivative_sha256,
        upload_id: uploadId,
        media_index: index,
        object_role: keys.derivative_kind,
      });
      plans.push({ item, resourceKey: mediaResources[index]!, keys, source, derivative });
    }
    const createdAt = nowMs();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO square_uploads
          (upload_id, post_id, cid_number, account_id, post_type, manifest_hash,
            manifest_byte_size, content_hash, storage_receipt_id, estimated_bytes, status,
            expires_at, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'prepared', ?, ?, NULL)`,
      ).bind(
        uploadId,
        postId,
        session.cid_number,
        session.account_id,
        postType,
        manifestHash,
        manifestByteSize,
        storageReceiptId,
        estimatedBytes,
        expiresAt,
        createdAt,
      ),
      ...plans.map((planItem, index) => env.DB.prepare(
        `INSERT INTO square_media_assets
          (upload_id, post_id, cid_number, account_id, media_index, media_kind, object_key,
            upload_method, resource_key, content_type, byte_size, sha256,
            derivative_kind, derivative_object_key, derivative_content_type,
            derivative_byte_size, derivative_sha256, asset_state, duration_seconds, width,
            height, error_code, created_at, updated_at, ready_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared',
            ?, ?, ?, NULL, ?, ?, NULL)`,
      ).bind(
        uploadId,
        postId,
        session.cid_number,
        session.account_id,
        index,
        planItem.item.media_kind,
        planItem.keys.object_key,
        planItem.source.upload_method,
        planItem.resourceKey,
        planItem.item.content_type,
        planItem.item.byte_size,
        planItem.item.sha256,
        planItem.keys.derivative_kind,
        planItem.keys.derivative_object_key,
        planItem.item.derivative_content_type,
        planItem.item.derivative_byte_size,
        planItem.item.derivative_sha256,
        planItem.item.duration_seconds ?? null,
        planItem.item.width,
        planItem.item.height,
        createdAt,
        createdAt,
      )),
    ]);
  } catch (error) {
    // prepare 响应还没有交给客户端，R2 不可能已有本轮对象，只释放 D1 预留。
    await releaseUploadReservation(env, uploadId);
    throw error;
  }

  const objectKeyPlan = buildObjectKeyPlan(session.cid_number, postId);
  return jsonResponse({
    ok: true,
    upload_id: uploadId,
    post_id: postId,
    storage_receipt_id: storageReceiptId,
    expires_at: expiresAt,
    estimated_bytes: estimatedBytes,
    manifest_object_key: objectKeyPlan.manifest_object_key,
    manifest_upload_url: apiRouteUrl(request, '/square/uploads/manifest', { upload_id: uploadId }),
    media_items: plans.map((planItem) => ({
      media_kind: planItem.item.media_kind,
      content_type: planItem.item.content_type,
      byte_size: planItem.item.byte_size,
      resource_key: planItem.resourceKey,
      asset_state: 'prepared',
      ...planItem.source,
      derivative_kind: planItem.keys.derivative_kind,
      derivative_content_type: planItem.item.derivative_content_type,
      derivative_byte_size: planItem.item.derivative_byte_size,
      derivative_object_key: planItem.keys.derivative_object_key,
      derivative_upload_method: planItem.derivative.upload_method,
      derivative_upload_url: planItem.derivative.upload_url,
      derivative_upload_headers: planItem.derivative.upload_headers,
    })),
  });
}

/** manifest 体积小且需要服务端字节级校验，唯一允许通过 Worker 写入 R2。 */
export async function putManifest(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const uploadId = new URL(request.url).searchParams.get('upload_id');
  if (!uploadId) throw new HttpError(400, 'invalid_upload_id', '上传任务编号不合法');
  const upload = await getPreparedUpload(env, uploadId);
  assertUploadOwner(upload, session);
  const bytes = await readLimitedBytes(request, 'square_manifest', true);
  const ticket = await validateUploadBytes({
    resource_key: 'square_manifest',
    bytes,
    content_type: request.headers.get('content-type') ?? '',
    expected_bytes: upload.manifest_byte_size,
    expected_hash: upload.manifest_hash,
  });
  const objectKey = manifestObjectKey(upload);
  await putR2Object(env, objectKey, bytes, ticket);
  return jsonResponse({ ok: true, object_key: objectKey, byte_size: ticket.byte_size });
}

export async function completeUpload(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<CompleteUploadRequest>(request);
  const uploadId = requiredUploadId(body.upload_id);
  const manifestHash = assertManifestHash(body.manifest_hash);
  if (!isSha256Hex(body.content_hash)) {
    throw new HttpError(400, 'invalid_content_hash', 'content_hash 必须是 sha256 hex');
  }
  const contentHash = body.content_hash.toLowerCase();
  const upload = await getPreparedUpload(env, uploadId);
  assertUploadOwner(upload, session);
  if (upload.status !== 'prepared') throw new HttpError(409, 'upload_already_completed', '上传任务已完成');
  if (upload.expires_at <= nowMs()) throw new HttpError(410, 'upload_expired', '上传任务已过期');
  if (upload.manifest_hash !== manifestHash || contentHash !== manifestHash) {
    throw new HttpError(409, 'manifest_hash_mismatch', 'manifest/content hash 与 prepare 不一致');
  }
  if (!upload.storage_receipt_id) throw new HttpError(409, 'storage_receipt_missing', '上传任务缺少存储回执');

  const manifestObject = await env.SQUARE_PRIVATE.get(manifestObjectKey(upload));
  if (!manifestObject) throw new HttpError(409, 'manifest_missing', 'manifest 对象未上传');
  if (manifestObject.size !== upload.manifest_byte_size) {
    await manifestObject.body.cancel();
    throw new HttpError(409, 'manifest_size_mismatch', 'manifest 实际体积与申报不一致');
  }
  const manifestText = await manifestObject.text();
  if (await sha256Hex(manifestText) !== manifestHash) {
    throw new HttpError(409, 'manifest_object_hash_mismatch', 'R2 manifest 内容与哈希不一致');
  }
  const mediaAssets = await loadMediaAssets(env, uploadId);
  for (const asset of mediaAssets) await verifyR2MediaAsset(env, asset);
  const membership = await requireActiveMembership(env, upload.cid_number, session.account_id);
  const membershipLevel = normalizeMembershipLevel(membership.membership_level);
  await assertManifestQuota({
    membershipLevel,
    plan: membershipPlan(membershipLevel),
    upload,
    manifestText,
    mediaAssets,
  });
  const completedAt = nowMs();
  await env.DB.batch(mediaAssets.map((asset) => env.DB.prepare(
    `UPDATE square_media_assets SET asset_state = 'ready', error_code = NULL,
      updated_at = ?, ready_at = ? WHERE upload_id = ? AND media_index = ?`,
  ).bind(completedAt, completedAt, asset.upload_id, asset.media_index)));
  await consumeUploadUsage(
    env,
    uploadId,
    mediaAssets,
    upload.manifest_byte_size,
    contentHash,
    completedAt,
  );
  return jsonResponse({
    ok: true,
    upload_id: uploadId,
    post_id: upload.post_id,
    content_hash: contentHash,
    storage_receipt_id: upload.storage_receipt_id,
    storage_state: 'completed',
  });
}

export async function abortUpload(request: Request, env: Env, rawUploadId: string): Promise<Response> {
  const session = await requireSession(request, env);
  let uploadId: string;
  try {
    uploadId = decodeURIComponent(rawUploadId).trim();
  } catch {
    throw new HttpError(400, 'invalid_upload_id', '上传任务编号不合法');
  }
  return jsonResponse(await abortUploadForSession(env, session, requiredUploadId(uploadId)));
}

export async function abortUploadForSession(
  env: Env,
  session: Pick<SessionState, 'cid_number'>,
  uploadId: string,
): Promise<{
  ok: true;
  upload_id: string;
  post_id: string;
  deleted_media_assets: number;
  deleted_r2_objects: number;
}> {
  const upload = await getPreparedUpload(env, uploadId);
  assertUploadOwner(upload, session);
  const projected = await env.DB.prepare(
    'SELECT post_id FROM square_posts WHERE post_id = ? LIMIT 1',
  ).bind(upload.post_id).first<{ post_id: string }>();
  if (projected) throw new HttpError(409, 'published_upload_cannot_abort', '已发布内容不能按孤儿上传清理');
  const storageKey = storageMapKey('SquarePost', 'SquarePosts', scaleString(upload.post_id));
  if (await fetchFinalizedChainStorage(env, `0x${bytesToHex(storageKey)}`)) {
    throw new HttpError(409, 'finalized_upload_cannot_abort', '上传对应内容已经 finalized，不能清理');
  }
  const assets = await loadMediaAssets(env, uploadId);
  await deleteR2MediaAssets(env, assets);
  await env.SQUARE_PRIVATE.delete(manifestObjectKey(upload));
  const statements = upload.status === 'completed'
    ? storedMediaReleaseStatements(env, upload.cid_number, assets, upload.manifest_byte_size)
    : [];
  statements.push(
    env.DB.prepare('DELETE FROM square_media_assets WHERE upload_id = ?').bind(uploadId),
    env.DB.prepare('DELETE FROM square_uploads WHERE upload_id = ?').bind(uploadId),
    env.DB.prepare('DELETE FROM resource_reservations WHERE reservation_id = ?').bind(uploadId),
  );
  await env.DB.batch(statements);
  return {
    ok: true,
    upload_id: uploadId,
    post_id: upload.post_id,
    deleted_media_assets: assets.length,
    deleted_r2_objects: 1 + assets.length * 2,
  };
}

export async function cleanupExpiredUploads(env: Env): Promise<{ deleted: number; failed: number }> {
  const result = await env.DB.prepare(
    `SELECT upload_id, post_id, cid_number, account_id, post_type, manifest_hash,
      manifest_byte_size, content_hash, storage_receipt_id, estimated_bytes, status,
      expires_at, created_at, completed_at
      FROM square_uploads WHERE status = 'prepared' AND expires_at <= ? LIMIT 8`,
  ).bind(nowMs()).all<PreparedUploadRow>();
  let deleted = 0;
  let failed = 0;
  for (const upload of result.results ?? []) {
    try {
      const assets = await loadMediaAssets(env, upload.upload_id);
      await deleteR2MediaAssets(env, assets);
      await env.SQUARE_PRIVATE.delete(manifestObjectKey(upload));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM square_media_assets WHERE upload_id = ?').bind(upload.upload_id),
        env.DB.prepare("DELETE FROM square_uploads WHERE upload_id = ? AND status = 'prepared'").bind(upload.upload_id),
        env.DB.prepare("DELETE FROM resource_reservations WHERE reservation_id = ? AND reservation_state = 'reserved'").bind(upload.upload_id),
      ]);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        event: 'expired_upload_cleanup_failed',
        cid_number: upload.cid_number,
        upload_id: upload.upload_id,
        post_id: upload.post_id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return { deleted, failed };
}

export async function loadMediaAssets(env: Env, uploadId: string): Promise<MediaAssetRow[]> {
  const result = await env.DB.prepare(`${mediaAssetSelect()} WHERE upload_id = ? ORDER BY media_index ASC`)
    .bind(uploadId).all<MediaAssetRow>();
  return result.results ?? [];
}

export { validateUploadItems, estimateUploadBytes };

async function loadMediaAsset(env: Env, uploadId: string, mediaIndex: number): Promise<MediaAssetRow> {
  const asset = await env.DB.prepare(`${mediaAssetSelect()} WHERE upload_id = ? AND media_index = ?`)
    .bind(uploadId, mediaIndex).first<MediaAssetRow>();
  if (!asset) throw new HttpError(404, 'media_asset_not_found', '媒体资产不存在');
  return asset;
}

function mediaAssetSelect(): string {
  return `SELECT upload_id, post_id, cid_number, account_id, media_index, media_kind,
    object_key, upload_method, resource_key, content_type, byte_size, sha256,
    derivative_kind, derivative_object_key, derivative_content_type, derivative_byte_size,
    derivative_sha256, asset_state, duration_seconds, width, height, error_code,
    created_at, updated_at, ready_at FROM square_media_assets`;
}

async function verifyR2MediaAsset(env: Env, asset: MediaAssetRow): Promise<void> {
  const source = await env.SQUARE_PUBLIC_MEDIA.head(asset.object_key);
  const derivative = await env.SQUARE_PUBLIC_MEDIA.head(asset.derivative_object_key);
  if (!source || !derivative) throw new HttpError(409, 'media_object_missing', 'R2 媒体或衍生图未上传');
  assertR2ObjectDeclaration(source, asset.byte_size, asset.content_type, asset.sha256, asset, 'source');
  assertR2ObjectDeclaration(
    derivative,
    asset.derivative_byte_size,
    asset.derivative_content_type,
    asset.derivative_sha256,
    asset,
    asset.derivative_kind,
  );
  if (asset.media_kind === 'image') {
    const object = await env.SQUARE_PUBLIC_MEDIA.get(asset.object_key);
    if (!object) throw new HttpError(409, 'media_object_missing', 'R2 图片不存在');
    const bytes = new Uint8Array(await object.arrayBuffer());
    const ticket = await validateUploadBytes({
      resource_key: asset.resource_key as ResourceKey,
      bytes,
      content_type: asset.content_type,
      expected_bytes: asset.byte_size,
      expected_hash: asset.sha256,
    });
    if (ticket.width !== asset.width || ticket.height !== asset.height) {
      throw new HttpError(409, 'media_dimensions_mismatch', '图片实际尺寸与申报不一致');
    }
  } else {
    await validateHevcMp4Prefix(env, asset);
  }
  const derivativeObject = await env.SQUARE_PUBLIC_MEDIA.get(asset.derivative_object_key);
  if (!derivativeObject) throw new HttpError(409, 'media_derivative_missing', 'R2 衍生图不存在');
  await validateUploadBytes({
    resource_key: asset.derivative_kind === 'cover' ? 'square_video_cover' : 'square_image_thumbnail',
    bytes: new Uint8Array(await derivativeObject.arrayBuffer()),
    content_type: asset.derivative_content_type,
    expected_bytes: asset.derivative_byte_size,
    expected_hash: asset.derivative_sha256,
  });
}

function assertR2ObjectDeclaration(
  object: R2Object,
  byteSize: number,
  contentType: string,
  sha256: string,
  asset: MediaAssetRow,
  role: 'source' | 'thumbnail' | 'cover',
): void {
  const objectSha256 = object.checksums.sha256
    ? bytesToHex(new Uint8Array(object.checksums.sha256))
    : null;
  if (object.size !== byteSize || object.httpMetadata?.contentType !== contentType ||
      objectSha256 !== sha256 ||
      object.customMetadata?.sha256 !== sha256 ||
      object.customMetadata?.upload_id !== asset.upload_id ||
      object.customMetadata?.media_index !== String(asset.media_index) ||
      object.customMetadata?.object_role !== role) {
    throw new HttpError(409, 'r2_object_declaration_mismatch', 'R2 对象与服务端授权不一致');
  }
}

async function validateHevcMp4Prefix(env: Env, asset: MediaAssetRow): Promise<void> {
  const object = await env.SQUARE_PUBLIC_MEDIA.get(asset.object_key, {
    range: { offset: 0, length: Math.min(asset.byte_size, 4 * 1024 * 1024) },
  });
  if (!object) throw new HttpError(409, 'video_object_missing', 'R2 视频不存在');
  const prefix = new Uint8Array(await object.arrayBuffer());
  const text = new TextDecoder('latin1').decode(prefix);
  const ftyp = text.indexOf('ftyp');
  const moov = text.indexOf('moov');
  const mdat = text.indexOf('mdat');
  if (ftyp < 0 || moov < 0 || (mdat >= 0 && moov > mdat) ||
      (!text.includes('hvc1') && !text.includes('hev1')) || text.includes('avc1')) {
    throw new HttpError(415, 'video_hevc_faststart_required', '视频必须是 HEVC MP4 且启用 faststart');
  }
}

function assertDimensions(item: UploadItemInput, limit: ReturnType<typeof resourceLimit>): void {
  if ((limit.max_width && item.width > limit.max_width) ||
      (limit.max_height && item.height > limit.max_height)) {
    throw new HttpError(400, 'media_dimensions_exceeded', '媒体尺寸超过会员清晰度上限');
  }
}

function assertUploadOwner(
  row: Pick<PreparedUploadRow, 'cid_number'> | Pick<MediaAssetRow, 'cid_number'>,
  session: Pick<SessionState, 'cid_number'>,
): void {
  if (row.cid_number !== session.cid_number) {
    throw new HttpError(403, 'upload_owner_mismatch', '登录身份与上传记录不一致');
  }
}

function declaredManifestByteSize(value: unknown): number {
  const byteSize = requiredPositiveInt(value, 'manifest_byte_size');
  assertDeclaredResource({
    resource_key: 'square_manifest',
    byte_size: byteSize,
    content_type: 'application/json',
  });
  return byteSize;
}

function requiredUploadId(value: unknown): string {
  if (typeof value === 'string' && /^squ_[a-zA-Z0-9_-]+$/.test(value)) return value;
  throw new HttpError(400, 'invalid_upload_id', '上传任务编号不合法');
}

function requiredPositiveInt(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new HttpError(400, `invalid_${name}`, `${name} 必须是正整数`);
}

function normalizeMembershipLevel(value: string): MembershipLevel {
  if (value === 'spark' || value === 'democracy') return value;
  return 'freedom';
}

function mediaResource(level: MembershipLevel, item: UploadItemInput): ResourceKey {
  return item.media_kind === 'video' ? videoResource(level) : imageResource(level);
}
