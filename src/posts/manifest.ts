import { resourceLimit } from '../limits/catalog';
import { HttpError } from '../shared/http';
import { isSha256Hex, sha256Hex } from '../shared/hash';
import type { ArticleContentSection, Env, PostType, PreparedUploadRow } from '../types';
import { manifestObjectKey } from '../r2_keys';

export interface SquareManifestMediaItem {
  media_kind: 'image' | 'video';
  file_name?: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  width: number;
  height: number;
  duration_seconds?: number;
}

export interface SquarePostManifest {
  schema: 'citizenapp.square.post';
  cid_number: string;
  post_type: PostType;
  title?: string;
  text: string;
  content_sections?: ArticleContentSection[];
  media_items: SquareManifestMediaItem[];
}

export interface ManifestAnchors {
  cid_number: string;
  post_type: PostType;
  content_hashes?: readonly string[];
}

export interface VerifiedSquarePostManifest {
  manifest: SquarePostManifest;
  bytes: Uint8Array;
  content_hash: string;
}

/// R2 manifest 路径只由永久 CID + post_id 派生，钱包换绑不改变对象归属。
export function manifestObjectKeyFromUpload(
  upload: Pick<PreparedUploadRow, 'cid_number' | 'post_id'>
): string {
  return manifestObjectKey(upload);
}

/// 读取 R2 原始字节并同时校验 CID、类型与所有内容哈希锚点。
export async function readVerifiedSquarePostManifest(
  env: Env,
  objectKey: string,
  anchors: ManifestAnchors,
): Promise<VerifiedSquarePostManifest> {
  const object = await env.SQUARE_PRIVATE.get(objectKey);
  if (!object) throw new HttpError(409, 'manifest_not_found', 'R2 manifest 不存在');
  const maxBytes = resourceLimit('square_manifest').max_bytes;
  if (object.size <= 0 || object.size > maxBytes) {
    await object.body.cancel();
    throw new HttpError(409, 'manifest_bytes_invalid', 'R2 manifest 字节长度不合法');
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentHash = await sha256Hex(bytes);
  for (const expected of anchors.content_hashes ?? []) {
    if (normalizeSha256(expected) !== contentHash) {
      throw new HttpError(409, 'manifest_hash_mismatch', 'R2 manifest 与发布哈希不一致');
    }
  }
  const manifest = decodeSquarePostManifestBytes(bytes);
  if (manifest.cid_number !== anchors.cid_number) {
    throw new HttpError(409, 'manifest_cid_mismatch', 'manifest CID 与上传任务不一致');
  }
  if (manifest.post_type !== anchors.post_type) {
    throw new HttpError(409, 'manifest_post_type_mismatch', 'manifest post_type 与上传任务不一致');
  }
  return { manifest, bytes, content_hash: contentHash };
}

export function decodeSquarePostManifestBytes(bytes: Uint8Array): SquarePostManifest {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(409, 'manifest_utf8_invalid', 'R2 manifest 不是合法 UTF-8');
  }
  return decodeSquarePostManifestText(text);
}

export function decodeSquarePostManifestText(text: string): SquarePostManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(409, 'manifest_json_invalid', 'R2 manifest 不是合法 JSON');
  }
  if (!isRecord(value)) throw new HttpError(409, 'manifest_json_invalid', 'manifest 必须是 JSON 对象');
  if ('account_id' in value || 'post_category' in value || 'content_format' in value || 'content_blocks' in value) {
    throw new HttpError(409, 'manifest_legacy_field', 'manifest 包含已删除的旧字段');
  }
  if (value.schema !== 'citizenapp.square.post') {
    throw new HttpError(409, 'invalid_manifest_schema', 'manifest schema 不合法');
  }
  if (typeof value.cid_number !== 'string' || value.cid_number.length === 0) {
    throw new HttpError(409, 'invalid_manifest_cid', 'manifest cid_number 不合法');
  }
  if (!isPostType(value.post_type)) {
    throw new HttpError(409, 'invalid_manifest_post_type', 'manifest post_type 不合法');
  }
  if (typeof value.text !== 'string' || !Array.isArray(value.media_items)) {
    throw new HttpError(409, 'manifest_content_incomplete', 'manifest 正文或媒体声明不完整');
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new HttpError(409, 'manifest_title_invalid', 'manifest 标题不合法');
  }
  if (!value.media_items.every(isMediaItem)) {
    throw new HttpError(409, 'manifest_media_invalid', 'manifest 媒体声明不合法');
  }
  if (
    value.content_sections !== undefined &&
    (!Array.isArray(value.content_sections) || !value.content_sections.every(isContentSection))
  ) {
    throw new HttpError(409, 'manifest_content_sections_invalid', 'manifest 文章段落不合法');
  }
  return {
    schema: 'citizenapp.square.post',
    cid_number: value.cid_number,
    post_type: value.post_type,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    text: value.text,
    ...(Array.isArray(value.content_sections)
      ? { content_sections: value.content_sections.filter(isContentSection) }
      : {}),
    media_items: value.media_items.filter(isMediaItem),
  };
}

export function normalizeSha256(value: string): string {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!isSha256Hex(normalized)) {
    throw new HttpError(409, 'invalid_content_hash', '发布哈希不是合法 SHA-256');
  }
  return normalized.toLowerCase();
}

function isPostType(value: unknown): value is PostType {
  return value === 'document' || value === 'article' || value === 'video';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMediaItem(value: unknown): value is SquareManifestMediaItem {
  if (!isRecord(value) || (value.media_kind !== 'image' && value.media_kind !== 'video')) return false;
  return optionalString(value.file_name) &&
    typeof value.content_type === 'string' &&
    Number.isSafeInteger(value.byte_size) && (value.byte_size as number) > 0 &&
    typeof value.sha256 === 'string' && isSha256Hex(value.sha256) &&
    Number.isSafeInteger(value.width) && (value.width as number) > 0 &&
    Number.isSafeInteger(value.height) && (value.height as number) > 0 &&
    (value.duration_seconds === undefined ||
      (Number.isSafeInteger(value.duration_seconds) && (value.duration_seconds as number) > 0));
}

function isContentSection(value: unknown): value is ArticleContentSection {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) =>
    key !== 'text_delta' && key !== 'gallery_media_indices' && key !== 'video_media_index')) return false;
  if (!Array.isArray(value.text_delta) || value.text_delta.length === 0 ||
      !value.text_delta.every(isDeltaOperation)) return false;
  const gallery = value.gallery_media_indices;
  const video = value.video_media_index;
  if (gallery !== undefined && video !== undefined) return false;
  if (gallery !== undefined && (!Array.isArray(gallery) || gallery.length < 1 ||
      gallery.length > 9 || !gallery.every((index) => Number.isSafeInteger(index) && index >= 0))) {
    return false;
  }
  return video === undefined || (Number.isSafeInteger(video) && (video as number) >= 0);
}

const inlineBooleanAttributes = new Set(['bold', 'italic', 'underline', 'strike']);
const fonts = new Set(['heiti', 'songti', 'kaiti', 'monospace', 'jinglei']);
const sizes = new Set(['small', 'body', 'large', 'subtitle', 'title']);
const colors = new Set(['default', 'secondary', 'primary', 'info', 'success', 'warning', 'danger']);
const backgrounds = new Set(['neutral_soft', 'primary_soft', 'info_soft', 'success_soft', 'warning_soft', 'danger_soft']);

function isDeltaOperation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.insert !== 'string' || value.insert.length === 0) return false;
  if (Object.keys(value).some((key) => key !== 'insert' && key !== 'attributes')) return false;
  if (value.attributes === undefined) return true;
  if (!isRecord(value.attributes)) return false;
  return Object.entries(value.attributes).every(([key, attribute]) => {
    if (inlineBooleanAttributes.has(key)) return attribute === true;
    if (key === 'font') return fonts.has(attribute as string);
    if (key === 'size') return sizes.has(attribute as string);
    if (key === 'color') return colors.has(attribute as string);
    if (key === 'background') return backgrounds.has(attribute as string);
    if (key === 'align') return value.insert === '\n' && (attribute === 'center' || attribute === 'right');
    if (key === 'list') return value.insert === '\n' && (attribute === 'ordered' || attribute === 'bullet');
    return false;
  });
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}
