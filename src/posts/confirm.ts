import { blake2AsU8a } from '@polkadot/util-crypto';

import type {
  Env,
  MediaAssetRow,
  PreparedUploadRow,
  SessionState,
  SquareFeedMediaItem,
  SquarePostDetail,
  SquarePostFeedItem,
} from '../types';
import {
  fetchBlockHeader,
  fetchCanonicalBlockHash,
  fetchFinalizedHead,
  fetchSignedBlock,
  fetchSystemEventsAtBlock,
} from '../chain/rpc';
import { fetchChainCidProjectionStateAtBlock } from '../chain/identity';
import {
  readChainTimestampAtBlock,
  readSubscriptionAtBlock,
} from '../chain/subscription';
import {
  decodeSquarePostPublishedEvents,
  type SquarePostPublishedEvent,
} from '../chain/square_event';
import { deleteR2MediaAssets, publicMediaUrl } from '../media';
import { storedMediaReleaseStatements } from '../limits/usage';
import { HttpError, jsonResponse, readJson, requireSession } from '../shared/http';
import { bytesToHex, hexToBytes } from '../shared/signing_message';
import { nowMs } from '../shared/time';
import { loadMediaAssets } from '../uploads/service';
import { assertMembershipLevel, membershipPlan } from '../membership/plans';
import {
  assertIdentityCanPublishCategory,
  assertManifestQuota,
  postCategoryForIdentity,
} from '../uploads/quota';
import { manifestObjectKey } from '../r2_keys';
import { readProfileDoc } from '../profiles/repository';
import {
  manifestObjectKeyFromUpload,
  normalizeSha256,
  readVerifiedSquarePostManifest,
  type SquarePostManifest,
} from './manifest';

interface ConfirmRequest {
  post_id?: unknown;
  block_hash?: unknown;
  tx_hash?: unknown;
}

export async function confirmPostRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<ConfirmRequest>(request);
  return jsonResponse({ ok: true, post: await confirmPublishedPost(env, session, body) });
}

/// 公开内容详情从 D1 确认可见状态，再读 R2 规范 manifest；Feed 不走此路径。
export async function getPostDetailRoute(
  request: Request,
  env: Env,
  rawPostId: string,
): Promise<Response> {
  await requireSession(request, env);
  const postId = decodePostId(rawPostId);
  const post = await loadPublishedPost(env, postId);
  const upload = await loadUploadForPost(env, postId);
  if (!upload || upload.status !== 'completed') {
    throw new HttpError(409, 'post_upload_index_missing', '已发布内容缺少上传索引');
  }
  const verified = await readVerifiedSquarePostManifest(
    env,
    manifestObjectKeyFromUpload(upload),
    {
      cid_number: post.cid_number,
      post_type: post.post_type,
      content_hashes: upload.content_hash
        ? [post.content_hash, upload.manifest_hash, upload.content_hash]
        : [post.content_hash, upload.manifest_hash],
    },
  );
  const mediaAssets = await loadMediaAssets(env, upload.upload_id);
  const detail: SquarePostDetail = {
    ...post,
    text: verified.manifest.text,
    content_sections: verified.manifest.content_sections ?? null,
    media_items: await mediaItemsFromAssets(env, mediaAssets),
  };
  return jsonResponse({ ok: true, post: detail });
}

export async function deletePostRoute(request: Request, env: Env, rawPostId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const postId = decodePostId(rawPostId);
  const result = await deletePostCloudflareData(env, session, postId);
  return jsonResponse({ ok: true, post_id: postId, post_state: 'deleted', cleanup: result });
}

export async function deletePostCloudflareData(
  env: Env,
  session: SessionState,
  postId: string,
): Promise<{ deleted_media_assets: number; deleted_r2_objects: number }> {
  const post = await loadPublishedPost(env, postId);
  if (post.cid_number !== session.cid_number) {
    throw new HttpError(403, 'post_owner_mismatch', '登录身份与内容作者不一致');
  }
  return deletePostCloudflareDataByCid(env, session.cid_number, postId, nowMs());
}

export async function deletePostCloudflareDataByCid(
  env: Env,
  cidNumber: string,
  postId: string,
  updatedAt: number,
): Promise<{ deleted_media_assets: number; deleted_r2_objects: number }> {
  const upload = await loadUploadForPost(env, postId);
  if (upload && upload.cid_number !== cidNumber) {
    throw new HttpError(409, 'content_owner_mismatch', '内容项与身份归属不一致');
  }
  const indexedPost = await loadPostOrNull(env, postId);
  if (indexedPost && indexedPost.cid_number !== cidNumber) {
    throw new HttpError(409, 'content_owner_mismatch', '内容项与身份归属不一致');
  }
  if (indexedPost && !upload) {
    throw new HttpError(409, 'post_upload_index_missing', '已发布内容缺少上传索引');
  }
  const mediaAssets = upload ? await loadMediaAssets(env, upload.upload_id) : [];
  await deleteR2MediaAssets(env, mediaAssets);
  if (upload) await env.SQUARE_PRIVATE.delete(manifestObjectKey(upload));

  const statements = [
    ...(upload
      ? storedMediaReleaseStatements(
          env,
          upload.cid_number,
          mediaAssets,
          upload.manifest_byte_size,
          updatedAt,
        )
      : []),
    env.DB.prepare('DELETE FROM square_posts WHERE post_id = ? AND cid_number = ?').bind(postId, cidNumber),
  ];
  if (upload) {
    statements.push(
      env.DB.prepare('DELETE FROM square_media_assets WHERE upload_id = ?').bind(upload.upload_id),
      env.DB.prepare('DELETE FROM square_uploads WHERE upload_id = ?').bind(upload.upload_id),
    );
  }
  await env.DB.batch(statements);
  return {
    deleted_media_assets: mediaAssets.length,
    deleted_r2_objects: upload ? 1 + mediaAssets.length * 2 : 0,
  };
}

export async function confirmPublishedPost(
  env: Env,
  session: SessionState,
  body: ConfirmRequest,
): Promise<SquarePostFeedItem> {
  const postId = requireString(body.post_id, 'invalid_post_id', '内容编号不合法');
  const blockHash = requireHash(body.block_hash, 'invalid_block_hash', '区块哈希不合法');
  const txHash = requireHash(body.tx_hash, 'invalid_tx_hash', '交易哈希不合法');
  const upload = await loadCompletedUpload(env, postId);
  if (upload.cid_number !== session.cid_number || upload.account_id !== session.account_id) {
    throw new HttpError(403, 'upload_owner_mismatch', '登录身份与上传记录不一致');
  }
  if (!upload.content_hash || !upload.storage_receipt_id) {
    throw new HttpError(409, 'upload_not_completed', '上传任务尚未完成');
  }

  // confirm 是唯一链上复核入口：确认交易位于 canonical finalized 区块。
  const transaction = await verifyFinalizedTransactionHash(env, blockHash, txHash);
  const eventsHex = await fetchSystemEventsAtBlock(env, blockHash);
  const event = findMatchingEvent(
    decodeSquarePostPublishedEvents(eventsHex),
    upload,
    transaction.extrinsicIndex,
  );
  if (!event) throw new HttpError(409, 'square_event_not_found', '指定交易没有匹配的发布事件');

  const chainTimestamp = await readChainTimestampAtBlock(env, blockHash);
  const identity = await fetchChainCidProjectionStateAtBlock(
    env,
    upload.cid_number,
    blockHash,
    chainTimestamp,
  );
  if (!identity || identity.cid_record_status !== 'Active' || identity.account_id !== upload.account_id) {
    throw new HttpError(409, 'publisher_identity_mismatch', '发布交易与同区块 CID 绑定不一致');
  }
  const postCategory = postCategoryForIdentity(identity.identity_level);
  assertIdentityCanPublishCategory(identity.identity_level, event.post_category);
  if (event.post_category !== postCategory) {
    throw new HttpError(409, 'post_category_event_mismatch', '链上事件分类与同区块身份不一致');
  }
  const subscription = await readSubscriptionAtBlock(
    env,
    upload.cid_number,
    { kind: 'platform' },
    blockHash,
  );
  if (!subscription || subscription.plan.kind !== 'platform' ||
      !['active', 'cancelled'].includes(subscription.status) ||
      chainTimestamp >= subscription.paidUntil) {
    throw new HttpError(409, 'platform_membership_not_effective', '发布交易所在区块没有有效平台会员权益');
  }
  if (event.storage_until !== subscription.paidUntil) {
    throw new HttpError(409, 'storage_until_event_mismatch', '链上事件存储有效期与同区块会员状态不一致');
  }

  const verified = await readVerifiedSquarePostManifest(
    env,
    manifestObjectKeyFromUpload(upload),
    {
      cid_number: upload.cid_number,
      post_type: upload.post_type,
      content_hashes: [upload.manifest_hash, upload.content_hash],
    },
  );
  const mediaAssets = await loadMediaAssets(env, upload.upload_id);
  if (mediaAssets.some((asset) => asset.asset_state !== 'ready' || !asset.sha256)) {
    throw new HttpError(409, 'media_asset_not_ready', '媒体资产尚未完成处理或缺少哈希');
  }
  // 最终授权和额度按交易所在 finalized 区块的链上会员真源复核；D1 只负责 prepare 早期反馈。
  const membershipLevel = assertMembershipLevel(subscription.plan.membershipLevel);
  await assertManifestQuota({
    membershipLevel,
    plan: membershipPlan(membershipLevel),
    upload,
    manifestText: new TextDecoder().decode(verified.bytes),
    mediaAssets,
  });

  const manifest = verified.manifest;
  const title = manifest.post_type === 'article' ? manifest.title?.trim() ?? null : null;
  const excerpt = [...manifest.text.trim()].slice(0, 300).join('');
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO square_posts
      (post_id, cid_number, account_id, post_category, post_type, title, excerpt,
       content_hash, storage_receipt_id, chain_block, chain_block_hash, tx_hash, created_at, post_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
  ).bind(
    upload.post_id,
    upload.cid_number,
    upload.account_id,
    postCategory,
    upload.post_type,
    title,
    excerpt,
    normalizeHash(upload.content_hash),
    upload.storage_receipt_id,
    transaction.blockNumber,
    blockHash,
    txHash,
    chainTimestamp,
  ).run();

  const post = await loadPublishedPost(env, upload.post_id);
  assertIdempotentPost(post, upload, postCategory, blockHash, txHash);
  if ((inserted.meta.changes ?? 0) === 1) {
    try {
      const authorDoc = await readProfileDoc(env, upload.cid_number);
      await env.NOTIFY?.send({
        author_cid_number: upload.cid_number,
        author_name: authorDoc?.display_name ?? '',
        post_type: upload.post_type,
        post_id: upload.post_id,
      });
    } catch (error) {
      console.error(`[square-notify] enqueue failed for ${upload.post_id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return buildFeedPostItem(env, post);
}

/// Feed 只读 D1 帖子投影与媒体索引，禁止逐帖读 R2 manifest。
export async function buildFeedPostItem(env: Env, row: SquarePostFeedItem): Promise<SquarePostFeedItem> {
  return (await hydrateFeedMediaItems(env, [row]))[0] ?? row;
}

/// 一页 Feed 用一次 D1 查询批量取得媒体投影；文章只下发首图，正文媒体留给详情接口。
export async function hydrateFeedMediaItems(
  env: Env,
  rows: SquarePostFeedItem[],
): Promise<SquarePostFeedItem[]> {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT upload_id, post_id, cid_number, account_id, media_index, media_kind, object_key,
      upload_method, resource_key, content_type, byte_size, sha256,
      derivative_kind, derivative_object_key, derivative_content_type, derivative_byte_size,
      derivative_sha256, asset_state, duration_seconds, width, height, error_code,
      created_at, updated_at, ready_at
     FROM square_media_assets
     WHERE post_id IN (${placeholders})
     ORDER BY post_id, media_index`,
  ).bind(...rows.map((row) => row.post_id)).all<MediaAssetRow>();
  const byPost = new Map<string, MediaAssetRow[]>();
  for (const asset of result.results ?? []) {
    const list = byPost.get(asset.post_id) ?? [];
    list.push(asset);
    byPost.set(asset.post_id, list);
  }
  return Promise.all(rows.map(async (row) => {
    const assets = byPost.get(row.post_id) ?? [];
    const feedAssets = row.post_type === 'article'
      ? assets.filter((asset) => asset.media_index === 0)
      : assets;
    return { ...row, media_items: await mediaItemsFromAssets(env, feedAssets) };
  }));
}

async function mediaItemsFromAssets(env: Env, assets: MediaAssetRow[]): Promise<SquareFeedMediaItem[]> {
  return assets.map((asset) => {
    if (asset.asset_state !== 'ready' || !asset.sha256) {
      throw new HttpError(409, 'media_asset_not_ready', '已发布内容的媒体索引不完整');
    }
    return {
      media_kind: asset.media_kind,
      object_key: asset.object_key,
      url: publicMediaUrl(env, asset.object_key),
      asset_state: asset.asset_state,
      derivative_kind: asset.derivative_kind,
      derivative_object_key: asset.derivative_object_key,
      thumbnail_url: publicMediaUrl(env, asset.derivative_object_key),
      content_type: asset.content_type,
      byte_size: asset.byte_size,
      sha256: asset.sha256,
      duration_seconds: asset.duration_seconds,
      width: asset.width,
      height: asset.height,
    };
  });
}

async function verifyFinalizedTransactionHash(
  env: Env,
  blockHash: string,
  txHash: string,
): Promise<{ blockNumber: number; extrinsicIndex: number }> {
  const [finalizedHead, signedBlock] = await Promise.all([
    fetchFinalizedHead(env),
    fetchSignedBlock(env, blockHash),
  ]);
  const blockNumber = parseBlockNumber(signedBlock.block.header.number);
  const [finalizedHeader, canonicalHash] = await Promise.all([
    fetchBlockHeader(env, finalizedHead),
    fetchCanonicalBlockHash(env, blockNumber),
  ]);
  if (blockNumber > parseBlockNumber(finalizedHeader.number) || canonicalHash !== blockHash) {
    throw new HttpError(409, 'post_block_not_finalized', '发布交易区块尚未成为 finalized 主链区块');
  }
  const extrinsicIndex = signedBlock.block.extrinsics.findIndex((hex) => {
    try {
      return `0x${bytesToHex(blake2AsU8a(hexToBytes(hex), 256))}` === txHash;
    } catch {
      return false;
    }
  });
  if (extrinsicIndex < 0) {
    throw new HttpError(409, 'post_tx_not_in_block', '指定 finalized 区块不包含该发布交易');
  }
  return { blockNumber, extrinsicIndex };
}

function findMatchingEvent(
  events: SquarePostPublishedEvent[],
  upload: PreparedUploadRow,
  extrinsicIndex: number,
): SquarePostPublishedEvent | null {
  return events.find((event) =>
    event.extrinsic_index === extrinsicIndex &&
    event.post_id === upload.post_id &&
    event.cid_number === upload.cid_number &&
    event.account_id === upload.account_id &&
    event.post_type === upload.post_type &&
    normalizeHash(event.content_hash) === normalizeHash(upload.content_hash ?? '') &&
    event.storage_receipt_id === upload.storage_receipt_id
  ) ?? null;
}

async function loadCompletedUpload(env: Env, postId: string): Promise<PreparedUploadRow> {
  const upload = await loadUploadForPost(env, postId);
  if (!upload) throw new HttpError(404, 'upload_not_found', '上传记录不存在');
  if (upload.status !== 'completed') throw new HttpError(409, 'upload_not_completed', '上传任务尚未完成');
  return upload;
}

async function loadUploadForPost(env: Env, postId: string): Promise<PreparedUploadRow | null> {
  return env.DB.prepare(
    `SELECT upload_id, post_id, cid_number, account_id, post_type, manifest_hash,
      manifest_byte_size, content_hash,
      storage_receipt_id, estimated_bytes, status, expires_at, created_at, completed_at
     FROM square_uploads WHERE post_id = ?`,
  ).bind(postId).first<PreparedUploadRow>();
}

async function loadPublishedPost(env: Env, postId: string): Promise<SquarePostFeedItem> {
  const post = await loadPostOrNull(env, postId);
  if (!post || post.post_state !== 'published') {
    throw new HttpError(404, 'post_not_found', '内容不存在');
  }
  return post;
}

async function loadPostOrNull(env: Env, postId: string): Promise<SquarePostFeedItem | null> {
  return env.DB.prepare(
    `SELECT post_id, cid_number, account_id, post_category, post_type, title, excerpt,
      content_hash, storage_receipt_id, chain_block, chain_block_hash, tx_hash, created_at, post_state
     FROM square_posts WHERE post_id = ?`,
  ).bind(postId).first<SquarePostFeedItem>();
}

function assertIdempotentPost(
  post: SquarePostFeedItem,
  upload: PreparedUploadRow,
  category: 'normal' | 'campaign',
  blockHash: string,
  txHash: string,
): void {
  if (post.cid_number !== upload.cid_number || post.account_id !== upload.account_id ||
      post.post_type !== upload.post_type || post.post_category !== category ||
      normalizeSha256(post.content_hash) !== normalizeSha256(upload.content_hash ?? '') ||
      post.storage_receipt_id !== upload.storage_receipt_id ||
      post.chain_block_hash !== blockHash || post.tx_hash !== txHash) {
    throw new HttpError(409, 'post_id_conflict', 'post_id 已绑定不同的 finalized 发布事实');
  }
}

function requireString(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HttpError(400, code, message);
  return value.trim();
}

function requireHash(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new HttpError(400, code, message);
  return value;
}

function decodePostId(value: string): string {
  try {
    const decoded = decodeURIComponent(value).trim();
    if (decoded.length === 0) throw new Error('empty');
    return decoded;
  } catch {
    throw new HttpError(400, 'invalid_post_id', '内容编号不合法');
  }
}

function parseBlockNumber(value: string): number {
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(502, 'chain_block_number_invalid', '链服务节点返回了无效区块高度');
  return parsed;
}

function normalizeHash(value: string): string {
  return value.startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`;
}
