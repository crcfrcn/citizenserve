import type { Env, MediaAssetRow, MembershipRow } from '../types';
import type { MembershipLevel } from '../membership/plans';
import { HttpError } from '../shared/http';
import { nowMs } from '../shared/time';
import { usageLimits } from './catalog';

export async function reserveUploadUsage(input: {
  env: Env;
  upload_id: string;
  cid_number: string;
  membership_level: MembershipLevel;
  membership: MembershipRow;
  byte_size: number;
  image_count: number;
  video_seconds: number;
  expires_at: number;
}): Promise<void> {
  const limit = usageLimits[input.membership_level];
  const { periodStart, periodEnd } = membershipUsagePeriod(input.membership);
  const createdAt = nowMs();
  // 用量预留归属键 = 身份主键 cid_number(活动预留数、周期用量额度均按 cid 累计)。
  const result = await input.env.DB.prepare(
    `INSERT INTO resource_reservations
      (reservation_id, cid_number, resource_key, period_start, period_end, byte_size,
       image_count, video_seconds, expires_at, reservation_state, created_at, used_at)
      SELECT ?, ?, 'square_upload', ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL
      WHERE
        (SELECT COUNT(*) FROM resource_reservations
          WHERE cid_number = ? AND resource_key = 'square_upload'
            AND reservation_state = 'reserved' AND expires_at > ?) < ?
        AND COALESCE((SELECT image_count FROM resource_usage
          WHERE cid_number = ? AND resource_key = 'square_upload' AND period_start = ?), 0)
          + COALESCE((SELECT SUM(image_count) FROM resource_reservations
            WHERE cid_number = ? AND resource_key = 'square_upload'
              AND reservation_state = 'reserved' AND expires_at > ?), 0) + ? <= ?
        AND COALESCE((SELECT video_seconds FROM resource_usage
          WHERE cid_number = ? AND resource_key = 'square_upload' AND period_start = ?), 0)
          + COALESCE((SELECT SUM(video_seconds) FROM resource_reservations
            WHERE cid_number = ? AND resource_key = 'square_upload'
              AND reservation_state = 'reserved' AND expires_at > ?), 0) + ? <= ?
        AND COALESCE((SELECT byte_size FROM resource_totals
          WHERE cid_number = ? AND resource_key = 'square_storage'), 0)
          + COALESCE((SELECT SUM(byte_size) FROM resource_reservations
            WHERE cid_number = ? AND resource_key = 'square_upload'
              AND reservation_state = 'reserved' AND expires_at > ?), 0) + ? <= ?`
  ).bind(
    input.upload_id, input.cid_number, periodStart, periodEnd, input.byte_size,
    input.image_count, input.video_seconds, input.expires_at, createdAt,
    input.cid_number, createdAt, limit.active_uploads,
    input.cid_number, periodStart, input.cid_number, createdAt,
    input.image_count, limit.monthly_images,
    input.cid_number, periodStart, input.cid_number, createdAt,
    input.video_seconds, limit.monthly_video_seconds,
    input.cid_number, input.cid_number, createdAt, input.byte_size, limit.storage_bytes,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new HttpError(429, 'upload_usage_exceeded', '活动上传数或订阅周期媒体额度已达到上限');
  }
}

export interface MembershipUsageState {
  period_start: number;
  period_end: number;
  image_count: number;
  video_seconds: number;
  active_uploads: number;
}

/**
 * 返回当前已用量与尚未过期预留的合计，供手机端在上传前执行同一会员额度预检。
 * 服务端 reserve 仍以条件 INSERT 原子复核，客户端结果不构成授权真源。
 */
export async function readMembershipUsageState(
  env: Env,
  cidNumber: string,
  membership: Pick<MembershipRow, 'last_charged_at' | 'paid_until'>,
): Promise<MembershipUsageState> {
  const { periodStart, periodEnd } = membershipUsagePeriod(membership);
  const observedAt = nowMs();
  const row = await env.DB.prepare(
    `SELECT
      COALESCE((SELECT image_count FROM resource_usage
        WHERE cid_number = ? AND resource_key = 'square_upload' AND period_start = ?), 0)
      + COALESCE((SELECT SUM(image_count) FROM resource_reservations
        WHERE cid_number = ? AND resource_key = 'square_upload'
          AND reservation_state = 'reserved' AND expires_at > ?), 0) AS image_count,
      COALESCE((SELECT video_seconds FROM resource_usage
        WHERE cid_number = ? AND resource_key = 'square_upload' AND period_start = ?), 0)
      + COALESCE((SELECT SUM(video_seconds) FROM resource_reservations
        WHERE cid_number = ? AND resource_key = 'square_upload'
          AND reservation_state = 'reserved' AND expires_at > ?), 0) AS video_seconds,
      COALESCE((SELECT COUNT(*) FROM resource_reservations
        WHERE cid_number = ? AND resource_key = 'square_upload'
          AND reservation_state = 'reserved' AND expires_at > ?), 0) AS active_uploads`
  ).bind(
    cidNumber, periodStart, cidNumber, observedAt,
    cidNumber, periodStart, cidNumber, observedAt,
    cidNumber, observedAt,
  ).first<{ image_count: number; video_seconds: number; active_uploads: number }>();
  return {
    period_start: periodStart,
    period_end: periodEnd,
    image_count: row?.image_count ?? 0,
    video_seconds: row?.video_seconds ?? 0,
    active_uploads: row?.active_uploads ?? 0,
  };
}

/**
 * 计费周期镜像给出周期起点；缺失或越界时按固定周期终点反推，保证同一周期
 * 的每次请求都命中同一个 D1 主键，不能用请求时间制造新周期绕过累计额度。
 */
export function membershipUsagePeriod(
  membership: Pick<MembershipRow, 'last_charged_at' | 'paid_until'>,
): { periodStart: number; periodEnd: number } {
  if (membership.last_charged_at < 0 || membership.last_charged_at >= membership.paid_until) {
    throw new HttpError(503, 'subscription_period_invalid', 'finalized 订阅用量周期不合法');
  }
  return { periodStart: membership.last_charged_at, periodEnd: membership.paid_until };
}

/** 完成上传时一次性把预留转为周期用量，重复 complete 不会重复计数。 */
export async function consumeUploadUsage(
  env: Env,
  uploadId: string,
  assets: MediaAssetRow[],
  manifestByteSize: number,
  contentHash: string,
  completedAt: number,
): Promise<void> {
  const usedAt = nowMs();
  const reservation = await env.DB.prepare(
    `UPDATE resource_reservations SET reservation_state = 'used', used_at = ?
      WHERE reservation_id = ? AND reservation_state = 'reserved'
      RETURNING cid_number, period_start, period_end, byte_size, image_count, video_seconds`
  ).bind(usedAt, uploadId).first<{
    cid_number: string;
    period_start: number;
    period_end: number;
    byte_size: number;
    image_count: number;
    video_seconds: number;
  }>();
  if (!reservation) throw new HttpError(409, 'upload_reservation_missing', '上传额度预留不存在或已核销');

  try {
    await env.DB.batch([
      env.DB.prepare(
      `INSERT INTO resource_usage
        (cid_number, resource_key, period_start, period_end, byte_size, image_count, video_seconds, updated_at)
        VALUES (?, 'square_upload', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cid_number, resource_key, period_start) DO UPDATE SET
          byte_size = resource_usage.byte_size + excluded.byte_size,
          image_count = resource_usage.image_count + excluded.image_count,
          video_seconds = resource_usage.video_seconds + excluded.video_seconds,
          updated_at = excluded.updated_at`
      ).bind(
      reservation.cid_number, reservation.period_start, reservation.period_end,
      reservation.byte_size, reservation.image_count, reservation.video_seconds, usedAt,
      ),
      totalStatement(env, reservation.cid_number, assets, manifestByteSize),
      env.DB.prepare(
        `UPDATE square_uploads SET content_hash = ?, status = 'completed', completed_at = ?
          WHERE upload_id = ? AND status = 'prepared'`
      ).bind(contentHash, completedAt, uploadId),
    ]);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE resource_reservations SET reservation_state = 'reserved', used_at = NULL
        WHERE reservation_id = ? AND reservation_state = 'used' AND used_at = ?`
    ).bind(uploadId, usedAt).run();
    throw error;
  }
}

export async function releaseUploadReservation(env: Env, uploadId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM resource_reservations WHERE reservation_id = ? AND reservation_state = 'reserved'`
  ).bind(uploadId).run();
}

/**
 * 构造存储总量回收语句。只回收当前存储总量，不返还已消耗的订阅周期上传额度。
 *
 * 调用方必须把返回语句与对应媒体/内容行删除放进同一个 D1 原子 batch；禁止提供或恢复
 * 单独执行的释放入口，否则跨存储清理中途失败后重试会重复扣减全局总量。
 */
export function storedMediaReleaseStatements(
  env: Env,
  cidNumber: string,
  assets: MediaAssetRow[],
  manifestByteSize: number,
  updatedAt: number = nowMs(),
): D1PreparedStatement[] {
  return [
    releaseTotalStatement(env, cidNumber, assets, manifestByteSize, updatedAt),
  ];
}

export async function cleanupExpiredReservations(env: Env): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM resource_reservations WHERE reservation_state = 'reserved' AND expires_at <= ?`
  ).bind(nowMs()).run();
}

function totalStatement(
  env: Env,
  cidNumber: string,
  assets: MediaAssetRow[],
  manifestByteSize: number,
): D1PreparedStatement {
  const byteSize = manifestByteSize + assets.reduce(
    (sum, asset) => sum + asset.byte_size + asset.derivative_byte_size,
    0,
  );
  const videoSeconds = assets
    .filter((asset) => asset.media_kind === 'video')
    .reduce((sum, asset) => sum + Math.ceil(asset.duration_seconds ?? 0), 0);
  return env.DB.prepare(
    `INSERT INTO resource_totals (cid_number, resource_key, byte_size, object_count, video_seconds, updated_at)
      VALUES (?, 'square_storage', ?, ?, ?, ?)
      ON CONFLICT(cid_number, resource_key) DO UPDATE SET
        byte_size = resource_totals.byte_size + excluded.byte_size,
        object_count = resource_totals.object_count + excluded.object_count,
        video_seconds = resource_totals.video_seconds + excluded.video_seconds,
        updated_at = excluded.updated_at`
  ).bind(cidNumber, byteSize, 1 + assets.length * 2, videoSeconds, nowMs());
}

function releaseTotalStatement(
  env: Env,
  cidNumber: string,
  assets: MediaAssetRow[],
  manifestByteSize: number,
  updatedAt: number,
): D1PreparedStatement {
  const byteSize = manifestByteSize + assets.reduce(
    (sum, asset) => sum + asset.byte_size + asset.derivative_byte_size,
    0,
  );
  const videoSeconds = assets
    .filter((asset) => asset.media_kind === 'video')
    .reduce((sum, asset) => sum + Math.ceil(asset.duration_seconds ?? 0), 0);
  return env.DB.prepare(
    `UPDATE resource_totals SET
      byte_size = MAX(0, byte_size - ?), object_count = MAX(0, object_count - ?),
      video_seconds = MAX(0, video_seconds - ?), updated_at = ?
      WHERE cid_number = ? AND resource_key = 'square_storage'`
  ).bind(byteSize, 1 + assets.length * 2, videoSeconds, updatedAt, cidNumber);
}
