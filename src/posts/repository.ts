import type { Env, FeedKind, SquarePostFeedItem, SquarePostRow } from '../types';
import { hydrateFeedMediaItems } from './confirm';
import { resolveAuthorSignals } from '../author_signals';

export async function listFeedPosts(
  env: Env,
  feedKind: FeedKind,
  viewerCidNumber: string | null,
  limit: number
): Promise<SquarePostFeedItem[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 50);

  if (feedKind === 'campaign') {
    const result = await env.DB.prepare(
      `SELECT post_id, cid_number, account_id, post_category, post_type, title, excerpt,
          content_hash, storage_receipt_id, chain_block, chain_block_hash, tx_hash, created_at, post_state
        FROM square_posts
        WHERE post_state = 'published' AND post_category = 'campaign'
        ORDER BY created_at DESC
        LIMIT ?`
    )
      .bind(boundedLimit)
      .all<SquarePostRow>();
    return hydrateFeedItems(env, result.results ?? []);
  }

  if (feedKind === 'following' && !viewerCidNumber) {
    return [];
  }
  if (feedKind === 'following' && viewerCidNumber) {
    // 关注流:按观看者身份主键 cid 取其关注对象(follows 双端 cid)的已发布帖。
    const result = await env.DB.prepare(
      `SELECT p.post_id, p.cid_number, p.account_id, p.post_category, p.post_type,
          p.title, p.excerpt, p.content_hash, p.storage_receipt_id, p.chain_block,
          p.chain_block_hash, p.tx_hash,
          p.created_at, p.post_state
        FROM square_posts p
        INNER JOIN square_follows f
          ON f.followed_cid_number = p.cid_number
        WHERE f.follower_cid_number = ? AND p.post_state = 'published'
        ORDER BY p.created_at DESC
        LIMIT ?`
    )
      .bind(viewerCidNumber, boundedLimit)
      .all<SquarePostRow>();
    return hydrateFeedItems(env, result.results ?? []);
  }

  const result = await env.DB.prepare(
    `SELECT post_id, cid_number, account_id, post_category, post_type, title, excerpt,
        content_hash, storage_receipt_id, chain_block, chain_block_hash, tx_hash, created_at, post_state
      FROM square_posts
      WHERE post_state = 'published'
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(boundedLimit)
    .all<SquarePostRow>();

  return hydrateFeedItems(env, result.results ?? []);
}

async function hydrateFeedItems(
  env: Env,
  rows: SquarePostRow[]
): Promise<SquarePostFeedItem[]> {
  // 本页去重作者后只读 D1 用户、会员与资料投影；Feed 不读链、不读 R2。
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
