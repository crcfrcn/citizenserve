import type { Env, FeedKind } from '../types';
import { jsonResponse, requireSession } from '../shared/http';
import { listFeedPosts } from '../posts/repository';
import { addBrowseCount, assertBrowseAvailable, getBrowseState } from './browse';

function parseLimit(url: URL): number {
  const value = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
  return Number.isFinite(value) ? value : 20;
}

export async function feedRoute(
  request: Request,
  env: Env,
  feedKind: FeedKind
): Promise<Response> {
  const url = new URL(request.url);
  const session = await requireSession(request, env);
  const before = await getBrowseState(env, session.cid_number);
  const limit = Math.min(parseLimit(url), assertBrowseAvailable(before));
  // 关注流按观看者身份主键 cid 取关注对象的帖;浏览计量归属键 = cid。
  const posts = await listFeedPosts(env, feedKind, session.cid_number, limit);
  const browse = await addBrowseCount(env, session.cid_number, before, posts.length);

  return jsonResponse({
    ok: true,
    feed_kind: feedKind,
    posts,
    ...browse,
  });
}
