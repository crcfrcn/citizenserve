import type { PostType, UploadItemInput } from '../types';
import { HttpError } from '../shared/http';
import { isSha256Hex } from '../shared/hash';
import { resourceLimit } from '../limits/catalog';

export function assertPostType(value: unknown): PostType {
  if (value === 'document' || value === 'article' || value === 'video') {
    return value;
  }
  throw new HttpError(400, 'invalid_post_type', 'post_type 必须是 document、article 或 video');
}

export function assertManifestHash(value: unknown): string {
  if (isSha256Hex(value)) {
    return value.toLowerCase();
  }
  throw new HttpError(400, 'invalid_manifest_hash', 'manifest_hash 必须是 sha256 hex');
}

export function validateUploadItems(value: unknown): UploadItemInput[] {
  const maxMediaItems = resourceLimit('square_manifest').max_items ?? 0;
  if (!Array.isArray(value) || value.length > maxMediaItems) {
    throw new HttpError(400, 'invalid_media_items', `媒体数量不能超过 ${maxMediaItems} 个`);
  }

  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new HttpError(400, 'invalid_media_item', `第 ${index + 1} 个媒体不合法`);
    }

    const item = raw as Partial<UploadItemInput>;
    if (item.media_kind !== 'image' && item.media_kind !== 'video') {
      throw new HttpError(400, 'invalid_media_kind', `第 ${index + 1} 个媒体类型不合法`);
    }
    if (typeof item.content_type !== 'string') {
      throw new HttpError(400, 'invalid_content_type', `第 ${index + 1} 个媒体 content_type 不合法`);
    }
    const byteSize = item.byte_size;
    if (!Number.isInteger(byteSize) || byteSize === undefined || byteSize <= 0) {
      throw new HttpError(400, 'invalid_byte_size', `第 ${index + 1} 个媒体大小不合法`);
    }

    if (!isSha256Hex(item.sha256) || !isSha256Hex(item.derivative_sha256)) {
      throw new HttpError(400, 'invalid_media_hash', `第 ${index + 1} 个媒体哈希不合法`);
    }
    if (!Number.isInteger(item.width) || !Number.isInteger(item.height) ||
        (item.width ?? 0) <= 0 || (item.height ?? 0) <= 0) {
      throw new HttpError(400, 'invalid_media_dimensions', `第 ${index + 1} 个媒体尺寸不合法`);
    }
    if (item.derivative_content_type !== 'image/webp' ||
        !Number.isInteger(item.derivative_byte_size) ||
        (item.derivative_byte_size ?? 0) <= 0) {
      throw new HttpError(400, 'invalid_media_derivative', `第 ${index + 1} 个媒体衍生图不合法`);
    }

    if (item.media_kind === 'video') {
      if (item.content_type !== 'video/mp4') {
        throw new HttpError(400, 'invalid_video_type', '视频只允许 HEVC MP4');
      }
      if (byteSize > resourceLimit('square_video_spark').max_bytes) {
        throw new HttpError(400, 'video_too_large', '单个视频体积超出上限');
      }
      if (
        !Number.isInteger(item.duration_seconds) ||
        item.duration_seconds === undefined ||
        item.duration_seconds <= 0
      ) {
        throw new HttpError(400, 'invalid_video_duration', '视频必须提供真实 duration_seconds');
      }
      if (item.derivative_kind !== 'cover' ||
          item.derivative_byte_size! > resourceLimit('square_video_cover').max_bytes) {
        throw new HttpError(400, 'invalid_video_cover', '视频必须提供符合上限的 WebP 封面');
      }
    } else {
      if (item.content_type !== 'image/webp') {
        throw new HttpError(400, 'invalid_image_type', '广场图片只允许本地处理后的 WebP');
      }
      if (byteSize > resourceLimit('square_image_spark').max_bytes) {
        throw new HttpError(400, 'image_too_large', '单张图片超过统一资源上限');
      }
      if (item.derivative_kind !== 'thumbnail' ||
          item.derivative_byte_size! > resourceLimit('square_image_thumbnail').max_bytes) {
        throw new HttpError(400, 'invalid_image_thumbnail', '图片必须提供符合上限的 WebP 缩略图');
      }
    }

    return {
      media_kind: item.media_kind,
      content_type: item.content_type,
      byte_size: byteSize,
      sha256: item.sha256.toLowerCase(),
      width: item.width!,
      height: item.height!,
      duration_seconds: item.media_kind === 'video' ? item.duration_seconds : undefined,
      derivative_kind: item.derivative_kind!,
      derivative_content_type: 'image/webp' as const,
      derivative_byte_size: item.derivative_byte_size!,
      derivative_sha256: item.derivative_sha256!.toLowerCase(),
    };
  });
}

export function estimateUploadBytes(mediaItems: UploadItemInput[]): number {
  return mediaItems.reduce(
    (sum, item) => sum + item.byte_size + item.derivative_byte_size,
    0,
  );
}
