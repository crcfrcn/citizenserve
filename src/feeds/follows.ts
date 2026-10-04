import type { Env } from '../types';
import { HttpError, jsonResponse, readJson, requireSession } from '../shared/http';
import { setFollowNotify } from '../profiles/repository';
import { assertCidNumber } from '../shared/ids';
import { nowMs } from '../shared/time';

interface FollowRequest {
  followed_cid_number?: unknown;
}

interface NotifyRequest {
  enabled?: unknown;
}

/// 关注目标身份主键 cid_number(D1a 收敛:关注关系双端均为 cid,前端直接传目标 cid)。
function parseFollowedCidNumber(value: unknown): string {
  try {
    return assertCidNumber(value);
  } catch {
    throw new HttpError(400, 'invalid_followed_cid_number', '关注目标身份标识 cid_number 格式不合法');
  }
}

export async function followRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<FollowRequest>(request);
  const followedCidNumber = parseFollowedCidNumber(body.followed_cid_number);
  if (followedCidNumber === session.cid_number) {
    throw new HttpError(400, 'self_follow_forbidden', '不能关注自己');
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO square_follows
      (follower_cid_number, followed_cid_number, created_at)
      VALUES (?, ?, ?)`
  )
    .bind(session.cid_number, followedCidNumber, nowMs())
    .run();

  return jsonResponse({
    ok: true,
    followed_cid_number: followedCidNumber
  });
}

export async function unfollowRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const followedCidNumber = parseFollowedCidNumber(
    decodeURIComponent(url.pathname.split('/').pop() ?? '')
  );

  await env.DB.prepare(
    `DELETE FROM square_follows
      WHERE follower_cid_number = ? AND followed_cid_number = ?`
  )
    .bind(session.cid_number, followedCidNumber)
    .run();

  return jsonResponse({
    ok: true,
    followed_cid_number: followedCidNumber
  });
}

/// PUT /square/follows/:cid/notify —— 开/关对某关注的发帖通知。
/// 通知归属挂在关注关系上：只有已关注才能设置，未关注返回 409 让客户端提示先关注。
export async function setFollowNotifyRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  // 路径 .../follows/:cid/notify → 目标身份主键 cid_number 是 notify 的前一段。
  const followedCidNumber = parseFollowedCidNumber(
    decodeURIComponent(segments[segments.length - 2] ?? '')
  );

  const body = await readJson<NotifyRequest>(request);
  if (typeof body.enabled !== 'boolean') {
    throw new HttpError(400, 'invalid_enabled', 'enabled 必须是布尔值');
  }

  const hit = await setFollowNotify(
    env,
    session.cid_number,
    followedCidNumber,
    body.enabled
  );
  if (!hit) {
    throw new HttpError(409, 'not_following', '请先关注 TA 再设置通知');
  }

  return jsonResponse({
    ok: true,
    followed_cid_number: followedCidNumber,
    notify_enabled: body.enabled
  });
}
