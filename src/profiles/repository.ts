import type {
  AuthorPostType,
  AuthorPostCategory,
  CitizenProfileDoc,
  Env,
  SquarePostFeedItem,
  SquarePostRow,
  UserProfileCounts
} from '../types';
import { hydrateFeedMediaItems } from '../posts/confirm';
import { resolveAuthorSignals } from '../author_signals';
import { readUserProfile } from '../account/user_repository';
import { HttpError } from '../shared/http';
import { assertCidNumber } from '../shared/ids';

const PROFILE_SCHEMA = 'citizenapp.square.profile' as const;

/// 空资料包默认值。首次访问、从未编辑的身份返回此结构，展示名/签名交由客户端兜底。
export function defaultProfileDoc(cidNumber: string): CitizenProfileDoc {
  return {
    schema: PROFILE_SCHEMA,
    cid_number: cidNumber,
    display_name: '',
    bio: '',
    avatar_object_key: null,
    avatar_content_hash: null,
    banner_object_key: null,
    banner_content_hash: null,
    updated_at: 0
  };
}

/// 公开资料只从 D1 `user_profiles` 读取；R2 仅保存头像和背景媒体字节。
export async function readProfileDoc(
  env: Env,
  cidNumber: string
): Promise<CitizenProfileDoc | null> {
  const row = await readUserProfile(env, assertCidNumber(cidNumber));
  return row ? {
    schema: PROFILE_SCHEMA,
    cid_number: row.cid_number,
    display_name: row.display_name,
    bio: row.bio,
    avatar_object_key: row.avatar_object_key,
    avatar_content_hash: row.avatar_content_hash,
    banner_object_key: row.banner_object_key,
    banner_content_hash: row.banner_content_hash,
    updated_at: row.updated_at,
  } : null;
}

/// 资料写入只更新 finalized 用户投影附属的 D1 行；没有用户行时失败关闭，不得凭资料创建用户。
export async function writeProfileDoc(env: Env, doc: CitizenProfileDoc): Promise<void> {
  const cid = assertCidNumber(doc.cid_number);
  const result = await env.DB.prepare(
    `UPDATE user_profiles
        SET display_name = ?, bio = ?,
            avatar_object_key = ?, avatar_content_hash = ?,
            banner_object_key = ?, banner_content_hash = ?, updated_at = ?
      WHERE cid_number = ?`,
  ).bind(
    doc.display_name,
    doc.bio,
    doc.avatar_object_key,
    doc.avatar_content_hash,
    doc.banner_object_key,
    doc.banner_content_hash,
    doc.updated_at,
    cid,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, 'user_profile_not_found', 'finalized 用户投影尚未建立');
  }
}

/// 主页关系与内容分类计数，全部走 D1 实时聚合（按身份主键 cid_number）。
///
/// `mutual_following` 只计算双向关系交集；四类内容按竞选、文章、视频、公文的顺序
/// 互斥归类，保证分类标签总数与对应列表使用同一口径。
export async function countUserStats(
  env: Env,
  cidNumber: string
): Promise<UserProfileCounts> {
  const [following, followers, mutualFollowing, contentCounts] = await Promise.all([
    countScalar(
      env,
      'SELECT COUNT(*) AS n FROM square_follows WHERE follower_cid_number = ?',
      cidNumber
    ),
    countScalar(
      env,
      'SELECT COUNT(*) AS n FROM square_follows WHERE followed_cid_number = ?',
      cidNumber
    ),
    countScalar(
      env,
      `SELECT COUNT(*) AS n
         FROM square_follows outbound
         INNER JOIN square_follows inbound
           ON inbound.follower_cid_number = outbound.followed_cid_number
          AND inbound.followed_cid_number = outbound.follower_cid_number
        WHERE outbound.follower_cid_number = ?`,
      cidNumber
    ),
    countProfileContent(env, cidNumber)
  ]);
  return {
    following,
    followers,
    mutual_following: mutualFollowing,
    ...contentCounts
  };
}

interface ProfileContentCounts {
  posts: number;
  campaigns: number;
  videos: number;
  articles: number;
}

/// 四类内容一次聚合完成；发布类型直接来自 `post_type`，不从媒体反推。
async function countProfileContent(
  env: Env,
  cidNumber: string
): Promise<ProfileContentCounts> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE
         WHEN post.post_category = 'normal'
          AND post.post_type = 'document' THEN 1 ELSE 0 END), 0) AS posts,
       COALESCE(SUM(CASE
         WHEN post.post_category = 'campaign' THEN 1 ELSE 0 END), 0) AS campaigns,
       COALESCE(SUM(CASE
         WHEN post.post_category = 'normal'
          AND post.post_type = 'video' THEN 1 ELSE 0 END), 0) AS videos,
       COALESCE(SUM(CASE
         WHEN post.post_category = 'normal'
          AND post.post_type = 'article' THEN 1 ELSE 0 END), 0) AS articles
     FROM square_posts post
     WHERE post.cid_number = ? AND post.post_state = 'published'`
  )
    .bind(cidNumber)
    .first<ProfileContentCounts>();
  return {
    posts: Number(row?.posts ?? 0),
    campaigns: Number(row?.campaigns ?? 0),
    videos: Number(row?.videos ?? 0),
    articles: Number(row?.articles ?? 0)
  };
}


/// 当前登录者是否已关注目标身份。未登录 viewer 传 null，直接返回 false。
export async function isFollowing(
  env: Env,
  viewerCidNumber: string | null,
  targetCidNumber: string
): Promise<boolean> {
  if (!viewerCidNumber || viewerCidNumber === targetCidNumber) {
    return false;
  }
  const row = await env.DB.prepare(
    'SELECT 1 AS n FROM square_follows WHERE follower_cid_number = ? AND followed_cid_number = ? LIMIT 1'
  )
    .bind(viewerCidNumber, targetCidNumber)
    .first<{ n: number }>();
  return row !== null;
}

/// 目标身份是否关注当前查看者。未登录或本人视角直接返回 false。
export async function isFollowedBy(
  env: Env,
  viewerCidNumber: string | null,
  targetCidNumber: string
): Promise<boolean> {
  if (!viewerCidNumber || viewerCidNumber === targetCidNumber) {
    return false;
  }
  return isFollowing(env, targetCidNumber, viewerCidNumber);
}

/// 当前登录者是否对目标身份开启发帖通知（= 已关注且未静音）。未登录/自看返回 false。
export async function isNotifying(
  env: Env,
  viewerCidNumber: string | null,
  targetCidNumber: string
): Promise<boolean> {
  if (!viewerCidNumber || viewerCidNumber === targetCidNumber) {
    return false;
  }
  const row = await env.DB.prepare(
    'SELECT notify_enabled FROM square_follows WHERE follower_cid_number = ? AND followed_cid_number = ? LIMIT 1'
  )
    .bind(viewerCidNumber, targetCidNumber)
    .first<{ notify_enabled: number }>();
  return row?.notify_enabled === 1;
}

/// 设置对某关注的发帖通知开关；仅对已存在的关注生效，返回是否命中一条关注记录。
/// 未关注（0 命中）时上层据此提示「先关注」，通知归属永远挂在关注关系上。
export async function setFollowNotify(
  env: Env,
  followerCidNumber: string,
  followedCidNumber: string,
  enabled: boolean
): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE square_follows SET notify_enabled = ? WHERE follower_cid_number = ? AND followed_cid_number = ?'
  )
    .bind(enabled ? 1 : 0, followerCidNumber, followedCidNumber)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/// 按作者分页拉取已发布内容；category 与 postType 均在 D1 分页前过滤，
/// cursor 为上一页最后一条 created_at（keyset 游标）。
export async function listAuthorPosts(
  env: Env,
  cidNumber: string,
  category: AuthorPostCategory,
  postType: AuthorPostType,
  limit: number,
  cursor: number | null
): Promise<SquarePostFeedItem[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 50);
  const conditions = ["cid_number = ?", "post_state = 'published'"];
  const binds: Array<string | number> = [cidNumber];
  if (category !== 'all') {
    conditions.push('post_category = ?');
    binds.push(category);
  }
  if (postType !== 'all') {
    conditions.push('post_type = ?');
    binds.push(postType);
  }
  if (cursor !== null) {
    conditions.push('created_at < ?');
    binds.push(cursor);
  }
  binds.push(boundedLimit);

  const result = await env.DB.prepare(
    `SELECT post_id, cid_number, account_id, post_category, post_type, title, excerpt,
        content_hash, storage_receipt_id, chain_block, chain_block_hash, tx_hash, created_at, post_state
      FROM square_posts
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(...binds)
    .all<SquarePostRow>();

  const rows = result.results ?? [];
  // 作者主页所有帖子同一身份：去重后仅读一次链上身份+会员+资料，回填作者徽章信号。
  const [signals, items] = await Promise.all([
    resolveAuthorSignals(
      env,
      rows.map((row) => ({ cid_number: row.cid_number, account_id: row.account_id }))
    ),
    hydrateFeedMediaItems(env, rows)
  ]);
  return items.map((item) => {
    const signal = signals.get(item.cid_number);
    return {
      ...item,
      identity_level: signal?.identity_level ?? 'visitor',
      membership_level: signal?.membership_level ?? null,
      membership_active: signal?.membership_active ?? false,
      display_name: signal?.display_name ?? '',
      avatar_object_key: signal?.avatar_object_key ?? null
    };
  });
}

export interface FollowEntry {
  cid_number: string;
  created_at: number;
}

/// 关注、关注者和互关列表分页（身份主键 cid_number）。互关以第二条关注建立的时间
/// 作为 `created_at`，因此列表顺序表达双向关系正式成立的先后。
export async function listFollows(
  env: Env,
  cidNumber: string,
  type: 'following' | 'followers' | 'mutual_following',
  limit: number,
  cursor: number | null
): Promise<FollowEntry[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 50);
  if (type === 'mutual_following') {
    const binds: Array<string | number> = [cidNumber];
    let cursorClause = '';
    if (cursor !== null) {
      cursorClause = ' AND MAX(outbound.created_at, inbound.created_at) < ?';
      binds.push(cursor);
    }
    binds.push(boundedLimit);
    const result = await env.DB.prepare(
      `SELECT outbound.followed_cid_number AS cid_number,
              MAX(outbound.created_at, inbound.created_at) AS created_at
         FROM square_follows outbound
         INNER JOIN square_follows inbound
           ON inbound.follower_cid_number = outbound.followed_cid_number
          AND inbound.followed_cid_number = outbound.follower_cid_number
        WHERE outbound.follower_cid_number = ?${cursorClause}
        ORDER BY created_at DESC
        LIMIT ?`
    )
      .bind(...binds)
      .all<FollowEntry>();
    return result.results ?? [];
  }
  const selectCol = type === 'following' ? 'followed_cid_number' : 'follower_cid_number';
  const whereCol = type === 'following' ? 'follower_cid_number' : 'followed_cid_number';
  const binds: Array<string | number> = [cidNumber];
  let cursorClause = '';
  if (cursor !== null) {
    cursorClause = ' AND created_at < ?';
    binds.push(cursor);
  }
  binds.push(boundedLimit);

  const result = await env.DB.prepare(
    `SELECT ${selectCol} AS cid_number, created_at
      FROM square_follows
      WHERE ${whereCol} = ?${cursorClause}
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(...binds)
    .all<FollowEntry>();
  return result.results ?? [];
}

async function countScalar(env: Env, sql: string, bind: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(bind).first<{ n: number }>();
  return typeof row?.n === 'number' ? row.n : 0;
}
