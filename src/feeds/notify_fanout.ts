import type { Env, SquareNotifyJob } from '../types';
import { nowMs } from '../shared/time';
import { createPushAuth, sendSquarePostAlert, type PushDevice } from '../shared/push';

/// 每页粉丝数：满页则 keyset 续跑下一页（不是丢弃上限，队列消费者跨调用推完全部）。
// 单 CID 最多 8 个推送端点；每页 5 人确保 D1、OAuth/APNs 与最多 40 次推送不超过
// Free Worker 单次 50 个 subrequest 的上限，满页由 Queue 游标续跑。
const FANOUT_PAGE = 5;

interface FollowerRow {
  cid_number: string;
  created_at: number;
}

/// 扇出一页：拉一页「未静音粉丝」(身份主键 cid)，取其未过期推送设备，逐台发可见推送；
/// 满页则续跑入队。分页按 (created_at, follower_cid_number) keyset，避免多设备粉丝跨页错位
/// （先分页粉丝，再取端点）。推送端点按 cid_number 归属，直接按粉丝 CID 查询。
export async function fanOutPage(
  env: Env,
  job: SquareNotifyJob,
  pageSize: number = FANOUT_PAGE,
): Promise<void> {
  const cursorAt = job.cursor?.created_at ?? 0;
  const cursorCidNumber = job.cursor?.cid_number ?? '';

  const followers = await env.DB.prepare(
    `SELECT follower_cid_number AS cid_number, created_at
       FROM square_follows
      WHERE followed_cid_number = ?
        AND notify_enabled = 1
        AND (created_at, follower_cid_number) > (?, ?)
      ORDER BY created_at ASC, follower_cid_number ASC
      LIMIT ?`,
  )
    .bind(job.author_cid_number, cursorAt, cursorCidNumber, pageSize)
    .all<FollowerRow>();
  const rows = followers.results ?? [];
  if (rows.length === 0) return;

  const cidNumbers = rows.map((row) => row.cid_number);
  const placeholders = cidNumbers.map(() => '?').join(',');
  const devices = await env.DB.prepare(
    `SELECT DISTINCT e.push_provider, e.push_token, e.apns_environment
       FROM push_endpoints e
       JOIN users u ON u.cid_number = e.cid_number
        AND u.binding_revision = e.binding_revision
        AND u.account_id = e.account_id
      WHERE e.cid_number IN (${placeholders})
        AND e.expires_at > ?`,
  )
    .bind(...cidNumbers, nowMs())
    .all<PushDevice>();

  const alert = buildAlert(job);
  const auth = createPushAuth();
  await Promise.all(
    (devices.results ?? []).map((device) =>
      sendSquarePostAlert(env, device, alert, auth).catch(() => false),
    ),
  );

  // 满页 → 续跑下一页（游标 = 本页末个粉丝 cid）。不满页说明已到末尾，结束。
  if (rows.length >= pageSize) {
    const last = rows[rows.length - 1];
    await env.NOTIFY?.send({
      ...job,
      cursor: { created_at: last.created_at, cid_number: last.cid_number },
    });
  }
}

function buildAlert(job: SquareNotifyJob): {
  title: string;
  body: string;
  post_id: string;
} {
  const kind = job.post_type === 'article' ? '文章' : job.post_type === 'video' ? '视频' : '公文';
  const name = job.author_name.trim().length > 0 ? job.author_name.trim() : '你关注的人';
  return { title: name, body: `发布了新${kind}`, post_id: job.post_id };
}
