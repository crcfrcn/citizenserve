import {
  manifestObjectKeyFromUpload,
  normalizeSha256,
  readVerifiedSquarePostManifest,
} from './manifest';
import { HttpError, jsonResponse, requireSession } from '../shared/http';
import type { Env } from '../types';

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 5;

interface SelfPostCopyRow {
  post_id: string;
  cid_number: string;
  account_id: string;
  post_category: 'normal' | 'campaign';
  post_type: 'document' | 'article' | 'video';
  content_hash: string;
  storage_receipt_id: string;
  chain_block: number | null;
  created_at: number;
  post_state: string;
  upload_cid_number: string;
  upload_account_id: string;
  upload_post_type: string;
  manifest_hash: string;
  upload_content_hash: string | null;
  upload_storage_receipt_id: string | null;
  upload_status: string;
}

interface SelfPostCursor {
  created_at: number;
  post_id: string;
}

/** GET /square/posts/self：按会话 CID 回灌本人已发布 manifest 原始字节。 */
export async function selfPostCopiesRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = parseCursor(url.searchParams.get('cursor'));

  const binds: Array<string | number> = [session.cid_number];
  let cursorClause = '';
  if (cursor) {
    cursorClause = `
        AND (p.created_at < ? OR (p.created_at = ? AND p.post_id < ?))`;
    binds.push(cursor.created_at, cursor.created_at, cursor.post_id);
  }
  binds.push(limit + 1);

  const result = await env.DB.prepare(
    `SELECT p.post_id, p.cid_number, p.account_id, p.post_category, p.post_type,
        p.content_hash, p.storage_receipt_id, p.chain_block, p.created_at, p.post_state,
        u.cid_number AS upload_cid_number, u.account_id AS upload_account_id,
        u.post_type AS upload_post_type, u.manifest_hash,
        u.content_hash AS upload_content_hash,
        u.storage_receipt_id AS upload_storage_receipt_id, u.status AS upload_status
      FROM square_posts p
      INNER JOIN square_uploads u ON u.post_id = p.post_id
      WHERE p.cid_number = ? AND p.post_state = 'published'${cursorClause}
      ORDER BY p.created_at DESC, p.post_id DESC
      LIMIT ?`,
  ).bind(...binds).all<SelfPostCopyRow>();

  const rows = result.results ?? [];
  const pageRows = rows.slice(0, limit);
  // 一页任一对象不完整即整页失败，客户端不得把部分结果误当作完整回灌。
  const items = await Promise.all(
    pageRows.map((row) => buildSelfPostCopy(env, session.cid_number, row)),
  );
  const last = pageRows.at(-1);
  return jsonResponse({
    ok: true,
    items,
    next_cursor:
      rows.length > limit && last
        ? encodeCursor({ created_at: last.created_at, post_id: last.post_id })
        : null,
  });
}

async function buildSelfPostCopy(
  env: Env,
  sessionCidNumber: string,
  row: SelfPostCopyRow,
): Promise<{
  post_id: string;
  cid_number: string;
  account_id: string;
  post_category: 'normal' | 'campaign';
  post_type: 'document' | 'article' | 'video';
  manifest_bytes_base64: string;
  content_hash: string;
  storage_receipt_id: string;
  chain_block: number | null;
  created_at: number;
  post_state: 'published';
}> {
  const contentHash = validateRow(sessionCidNumber, row);
  const objectKey = manifestObjectKeyFromUpload(row);
  const verified = await readVerifiedSquarePostManifest(env, objectKey, {
    cid_number: row.cid_number,
    post_type: row.post_type,
    content_hashes: [
      row.content_hash,
      row.manifest_hash,
      row.upload_content_hash!,
    ],
  });
  if (verified.content_hash !== contentHash) {
    throw new HttpError(409, 'post_manifest_hash_mismatch', '帖子与 manifest 发布哈希不一致');
  }

  return {
    post_id: row.post_id,
    cid_number: row.cid_number,
    account_id: row.account_id,
    post_category: row.post_category,
    post_type: row.post_type,
    manifest_bytes_base64: bytesToBase64(verified.bytes),
    // 客户端 Isar 契约固定使用 64 位小写 SHA-256，不下发 D1 中可能带 0x 的展示形态。
    content_hash: contentHash,
    storage_receipt_id: row.storage_receipt_id,
    chain_block: row.chain_block,
    created_at: row.created_at,
    post_state: 'published',
  };
}

function validateRow(sessionCidNumber: string, row: SelfPostCopyRow): string {
  if (row.cid_number !== sessionCidNumber || row.upload_cid_number !== sessionCidNumber) {
    throw new HttpError(409, 'post_owner_mismatch', '帖子、上传记录与当前身份归属不一致');
  }
  if (
    !/^0x[0-9a-f]{64}$/.test(row.account_id) ||
    row.upload_account_id !== row.account_id
  ) {
    throw new HttpError(409, 'post_account_mismatch', '帖子与上传签名账户不一致');
  }
  if (row.post_category !== 'normal' && row.post_category !== 'campaign') {
    throw new HttpError(409, 'post_category_invalid', '内容分类不合法');
  }
  if (!['document', 'article', 'video'].includes(row.post_type) || row.upload_post_type !== row.post_type) {
    throw new HttpError(409, 'post_type_mismatch', '内容与上传 post_type 不一致');
  }
  if (row.post_state !== 'published' || row.upload_status !== 'completed') {
    throw new HttpError(409, 'post_not_recoverable', '帖子尚未完成发布确认');
  }
  if (
    row.post_id.trim().length === 0 ||
    row.storage_receipt_id.trim().length === 0 ||
    row.upload_storage_receipt_id !== row.storage_receipt_id
  ) {
    throw new HttpError(409, 'post_receipt_mismatch', '帖子与上传存储回执不一致');
  }
  if (!Number.isSafeInteger(row.created_at) || row.created_at <= 0) {
    throw new HttpError(409, 'post_created_at_invalid', '帖子服务端时间不合法');
  }
  if (
    row.chain_block !== null &&
    (!Number.isSafeInteger(row.chain_block) || row.chain_block < 0)
  ) {
    throw new HttpError(409, 'post_chain_block_invalid', '帖子链上区块号不合法');
  }
  if (row.upload_content_hash === null) {
    throw new HttpError(409, 'upload_content_hash_missing', '上传记录缺少发布哈希');
  }

  const postHash = normalizeSha256(row.content_hash);
  if (
    normalizeSha256(row.manifest_hash) !== postHash ||
    normalizeSha256(row.upload_content_hash) !== postHash
  ) {
    throw new HttpError(409, 'post_upload_hash_mismatch', '帖子与上传哈希不一致');
  }
  return postHash;
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(400, 'invalid_limit', 'limit 必须是正整数');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_PAGE_SIZE) {
    throw new HttpError(400, 'invalid_limit', `limit 不能超过 ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function parseCursor(raw: string | null): SelfPostCursor | null {
  if (raw === null) return null;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(raw));
    const value = JSON.parse(json) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !Number.isSafeInteger((value as { created_at?: unknown }).created_at) ||
      ((value as { created_at: number }).created_at <= 0) ||
      typeof (value as { post_id?: unknown }).post_id !== 'string' ||
      (value as { post_id: string }).post_id.trim().length === 0
    ) {
      throw new Error('invalid cursor');
    }
    return {
      created_at: (value as { created_at: number }).created_at,
      post_id: (value as { post_id: string }).post_id,
    };
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor 不合法');
  }
}

function encodeCursor(cursor: SelfPostCursor): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(cursor)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
