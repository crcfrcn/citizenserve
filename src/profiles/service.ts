import type {
  AuthorPostType,
  AuthorPostCategory,
  CitizenProfileDoc,
  Env,
  UserProfileResponse
} from '../types';
import {
  HttpError,
  jsonResponse,
  parsePositiveInt,
  readJson,
  requireSession
} from '../shared/http';
import { assertCidNumber } from '../shared/ids';
import { isSha256Hex } from '../shared/hash';
import { nowMs } from '../shared/time';
import { readUserByCidNumber } from '../account/user_repository';
import {
  getMembership,
  subscriptionIsActive
} from '../membership/service';
import type { MembershipLevel } from '../membership/plans';
import { addBrowseCount, assertBrowseAvailable, getBrowseState } from '../feeds/browse';
import { profileAssetPrefix } from '../r2_keys';
import {
  countUserStats,
  defaultProfileDoc,
  isFollowedBy,
  isFollowing,
  isNotifying,
  listAuthorPosts,
  listFollows,
  readProfileDoc,
  writeProfileDoc
} from './repository';

const DISPLAY_NAME_MAX = 40;
const BIO_MAX = 160;
const DEFAULT_AUTHOR_POST_LIMIT = 20;

interface ProfileUpdateRequest {
  display_name?: unknown;
  bio?: unknown;
  avatar_object_key?: unknown;
  avatar_content_hash?: unknown;
  banner_object_key?: unknown;
  banner_content_hash?: unknown;
}

/// GET /square/users/:cid —— 仅钱包用户可读，并附带当前身份的关注状态。
/// 路由参数 = 目标用户身份主键 cid_number(D1a 收敛:社交面统一按 cid 寻址)。
export async function getUserProfileRoute(
  request: Request,
  env: Env,
  cidRaw: string
): Promise<Response> {
  const targetCidNumber = parseCidNumber(cidRaw);
  const viewer = await requireSession(request, env);
  const profile = await buildProfileResponse(env, targetCidNumber, viewer.cid_number);
  return jsonResponse({ ok: true, profile });
}

/// GET 与 PUT 共用同一份主页响应装配：D1 资料 + 计数 + 认证 + is_following。
/// 身份主键 = 目标 cid_number；资料、身份档位、当前绑定账户、计数、关注和会员均读 D1。
async function buildProfileResponse(
  env: Env,
  targetCidNumber: string,
  viewerCidNumber: string | null
): Promise<UserProfileResponse> {
  // 用户与身份档位来自 finalized D1 投影；普通主页请求不得读取链。
  const [identity, doc, counts, membership, following, followedBy, notifying] =
    await Promise.all([
      readUserByCidNumber(env, targetCidNumber),
      readProfileDoc(env, targetCidNumber),
      countUserStats(env, targetCidNumber),
      getMembership(env, targetCidNumber),
      isFollowing(env, viewerCidNumber, targetCidNumber),
      isFollowedBy(env, viewerCidNumber, targetCidNumber),
      isNotifying(env, viewerCidNumber, targetCidNumber)
    ]);
  if (!identity) {
    throw new HttpError(404, 'user_not_found', '公民用户不存在');
  }

  const profile = doc ?? defaultProfileDoc(targetCidNumber);
  const membershipLevel = (membership?.membership_level ?? null) as MembershipLevel | null;
  return {
    account_id: identity.account_id,
    display_name: profile.display_name,
    bio: profile.bio,
    avatar_object_key: profile.avatar_object_key,
    banner_object_key: profile.banner_object_key,
    cid_number: targetCidNumber,
    is_certified: identity.identity_level !== 'visitor',
    identity_level: identity.identity_level,
    membership_level: membershipLevel,
    membership_active: membership ? subscriptionIsActive(membership) : false,
    counts,
    is_following: following,
    is_followed_by: followedBy,
    is_notifying: notifying,
    updated_at: profile.updated_at
  };
}

/// GET /square/users/:cid/posts?category=&post_type=&limit=&cursor=
/// —— 按作者身份和发布类型分页。
export async function getUserPostsRoute(
  request: Request,
  env: Env,
  cidRaw: string
): Promise<Response> {
  const targetCidNumber = parseCidNumber(cidRaw);
  const viewer = await requireSession(request, env);
  const before = await getBrowseState(env, viewer.cid_number);
  const url = new URL(request.url);
  const category = parseCategory(url.searchParams.get('category'));
  const postType = parsePostType(url.searchParams.get('post_type'));
  const limit = Math.min(parsePositiveInt(
    url.searchParams.get('limit') ?? undefined,
    DEFAULT_AUTHOR_POST_LIMIT
  ), assertBrowseAvailable(before));
  const cursor = parseCursor(url.searchParams.get('cursor'));

  const posts = await listAuthorPosts(
    env,
    targetCidNumber,
    category,
    postType,
    limit,
    cursor
  );
  const nextCursor =
    posts.length >= limit ? posts[posts.length - 1]?.created_at ?? null : null;
  const browse = await addBrowseCount(env, viewer.cid_number, before, posts.length);

  return jsonResponse({
    ok: true,
    cid_number: targetCidNumber,
    category,
    post_type: postType,
    posts,
    next_cursor: nextCursor,
    ...browse
  });
}

/// GET /square/users/:cid/follows?type=following|followers|mutual_following ——
/// 关注、关注者或互关列表分页。
export async function getUserFollowsRoute(
  request: Request,
  env: Env,
  cidRaw: string
): Promise<Response> {
  const targetCid = parseCidNumber(cidRaw);
  await requireSession(request, env);
  const url = new URL(request.url);
  const type = parseFollowType(url.searchParams.get('type'));
  const limit = parsePositiveInt(
    url.searchParams.get('limit') ?? undefined,
    DEFAULT_AUTHOR_POST_LIMIT
  );
  const cursor = parseCursor(url.searchParams.get('cursor'));

  // 列表项为身份主键 cid_number(FollowEntry.cid_number)。
  const entries = await listFollows(env, targetCid, type, limit, cursor);
  const nextCursor =
    entries.length >= limit ? entries[entries.length - 1]?.created_at ?? null : null;

  return jsonResponse({ ok: true, type, entries, next_cursor: nextCursor });
}

/// PUT /square/profile —— 仅本人可写；身份主键 cid_number 从 session 派生。
export async function putProfileRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<ProfileUpdateRequest>(request);
  const existing = (await readProfileDoc(env, session.cid_number)) ??
    defaultProfileDoc(session.cid_number);

  const assetPrefix = profileAssetPrefix(session.cid_number);
  const next: CitizenProfileDoc = {
    schema: 'citizenapp.square.profile',
    cid_number: session.cid_number,
    display_name: normalizeText(body.display_name, existing.display_name, DISPLAY_NAME_MAX),
    bio: normalizeText(body.bio, existing.bio, BIO_MAX),
    avatar_object_key: normalizeAssetKey(
      body.avatar_object_key,
      existing.avatar_object_key,
      `${assetPrefix}avatar`
    ),
    avatar_content_hash: normalizeContentHash(
      body.avatar_content_hash,
      existing.avatar_content_hash,
    ),
    banner_object_key: normalizeAssetKey(
      body.banner_object_key,
      existing.banner_object_key,
      `${assetPrefix}banner`
    ),
    banner_content_hash: normalizeContentHash(
      body.banner_content_hash,
      existing.banner_content_hash,
    ),
    updated_at: nowMs()
  };
  assertAssetPair(next.avatar_object_key, next.avatar_content_hash, 'avatar');
  assertAssetPair(next.banner_object_key, next.banner_content_hash, 'banner');

  await writeProfileDoc(env, next);
  // 返回与 GET 一致的完整主页响应（本人视角 is_following=false），让客户端单一解析。
  const profile = await buildProfileResponse(env, session.cid_number, session.cid_number);
  return jsonResponse({ ok: true, profile });
}

function parseCidNumber(cidRaw: string): string {
  try {
    return assertCidNumber(decodeURIComponent(cidRaw));
  } catch {
    throw new HttpError(400, 'invalid_cid_number', '身份标识 cid_number 格式不合法');
  }
}

function parseCategory(value: string | null): AuthorPostCategory {
  if (value === 'normal' || value === 'campaign') {
    return value;
  }
  return 'all';
}

function parsePostType(value: string | null): AuthorPostType {
  if (value === null) return 'all';
  if (value === 'document' || value === 'article' || value === 'video') {
    return value;
  }
  throw new HttpError(400, 'invalid_post_type', '发布类型不合法');
}

function parseFollowType(
  value: string | null
): 'following' | 'followers' | 'mutual_following' {
  if (value === 'following' || value === 'followers' || value === 'mutual_following') {
    return value;
  }
  throw new HttpError(400, 'invalid_follow_type', '关注列表类型不合法');
}

function parseCursor(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/// 文本字段：未提供沿用旧值；提供则 trim 并强制长度上限，超限直接拒绝而非静默截断。
function normalizeText(value: unknown, fallback: string, max: number): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_profile_field', '资料字段必须是文本');
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new HttpError(400, 'profile_field_too_long', `资料字段超过 ${max} 字上限`);
  }
  return trimmed;
}

/// 头像/背景对象 key：未提供沿用旧值；提供则必须落在本人 profile 前缀下，杜绝越权写他人对象。
function normalizeAssetKey(
  value: unknown,
  fallback: string | null,
  expectedKey: string
): string | null {
  if (value === undefined) {
    return fallback;
  }
  if (value === null || value === '') {
    return null;
  }
  if (value !== expectedKey) {
    throw new HttpError(400, 'invalid_asset_key', '资源对象不是本账户固定资料键');
  }
  return value;
}

function normalizeContentHash(value: unknown, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }
  if (value === null || value === '') {
    return null;
  }
  if (!isSha256Hex(value)) {
    throw new HttpError(400, 'invalid_profile_content_hash', '资料媒体哈希必须是 64 位十六进制');
  }
  return value.toLowerCase();
}

function assertAssetPair(
  objectKey: string | null,
  contentHash: string | null,
  kind: 'avatar' | 'banner',
): void {
  if ((objectKey === null) !== (contentHash === null)) {
    throw new HttpError(
      400,
      'invalid_profile_asset_pair',
      `${kind} 的对象键和内容哈希必须同时存在或同时清空`,
    );
  }
}
