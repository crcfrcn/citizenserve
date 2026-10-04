import type { IdentityLevel, MediaAssetRow, PostCategory, PostType, UploadItemInput } from '../types';
import { HttpError } from '../shared/http';
import type { MembershipLevel, MembershipPlan } from '../membership/plans';
import {
  decodeSquarePostManifestText,
  type SquareManifestMediaItem,
  type SquarePostManifest,
} from '../posts/manifest';

interface DeclaredQuotaInput {
  membershipLevel: MembershipLevel;
  plan: MembershipPlan;
  postType: PostType;
  titleLength: number;
  textLength: number;
  mediaItems: UploadItemInput[];
}

interface ManifestQuotaInput {
  membershipLevel: MembershipLevel;
  plan: MembershipPlan;
  upload: { cid_number: string; post_type: PostType };
  manifestText: string;
  mediaAssets: MediaAssetRow[];
}

export function assertDeclaredLength(value: unknown, fieldName: 'title_length' | 'text_length'): number {
  if (Number.isInteger(value) && typeof value === 'number' && value >= 0) return value;
  throw new HttpError(400, `invalid_${fieldName}`, `${fieldName} 必须是非负整数`);
}

export function assertDeclaredContentQuota(input: DeclaredQuotaInput): void {
  switch (input.postType) {
    case 'document':
      assertDocumentQuota(input);
      return;
    case 'article':
      assertArticleQuota(input);
      return;
    case 'video':
      assertVideoQuota(input);
  }
}

/// 发布分类只由 finalized 区块的身份派生，客户端永远不提供该值。
export function postCategoryForIdentity(identityLevel: IdentityLevel): PostCategory {
  return identityLevel === 'candidate' ? 'campaign' : 'normal';
}

export function assertIdentityCanPublishCategory(
  identityLevel: IdentityLevel,
  postCategory: PostCategory,
): void {
  if (postCategoryForIdentity(identityLevel) !== postCategory) {
    throw new HttpError(409, 'post_category_identity_mismatch', '发布分类与 finalized 身份不一致');
  }
}

export async function assertManifestQuota(input: ManifestQuotaInput): Promise<SquarePostManifest> {
  const manifest = decodeSquarePostManifestText(input.manifestText);
  if (manifest.cid_number !== input.upload.cid_number) {
    throw new HttpError(409, 'manifest_cid_mismatch', 'manifest CID 与上传任务不一致');
  }
  if (manifest.post_type !== input.upload.post_type) {
    throw new HttpError(409, 'manifest_post_type_mismatch', 'manifest post_type 与上传任务不一致');
  }
  const mediaItems: UploadItemInput[] = manifest.media_items.map((item, index) => ({
    media_kind: item.media_kind,
    content_type: item.content_type,
    byte_size: item.byte_size,
    sha256: item.sha256,
    width: item.width ?? 0,
    height: item.height ?? 0,
    duration_seconds: item.duration_seconds,
    derivative_kind: item.media_kind === 'video' ? 'cover' : 'thumbnail',
    derivative_content_type: 'image/webp',
    derivative_byte_size: input.mediaAssets[index]?.derivative_byte_size ?? 0,
    derivative_sha256: input.mediaAssets[index]?.derivative_sha256 ?? '',
  }));
  assertManifestMatchesAssets(manifest.media_items, input.mediaAssets);
  assertDeclaredContentQuota({
    membershipLevel: input.membershipLevel,
    plan: input.plan,
    postType: manifest.post_type,
    titleLength: scalarLength(manifest.title?.trim() ?? ''),
    textLength: scalarLength(manifest.text.trim()),
    mediaItems,
  });
  assertManifestShape(manifest);
  return manifest;
}

function assertDocumentQuota(input: DeclaredQuotaInput): void {
  if (input.titleLength !== 0) throw new HttpError(400, 'document_title_forbidden', '公文不允许标题');
  if (input.textLength > input.plan.document.text_max_chars) {
    throw new HttpError(400, 'document_text_too_long', `公文文字不能超过 ${input.plan.document.text_max_chars} 字`);
  }
  if (input.mediaItems.some((item) => item.media_kind !== 'image')) {
    throw new HttpError(400, 'document_video_forbidden', '公文只允许图片');
  }
  if (input.mediaItems.length > input.plan.document.max_images) {
    throw new HttpError(400, 'document_image_count_exceeded', `公文图片不能超过 ${input.plan.document.max_images} 张`);
  }
  if (input.textLength === 0 && input.mediaItems.length === 0) {
    throw new HttpError(400, 'document_content_required', '公文内容不能为空');
  }
}

function assertVideoQuota(input: DeclaredQuotaInput): void {
  if (input.titleLength !== 0) throw new HttpError(400, 'video_title_forbidden', '视频不允许标题');
  if (input.textLength > input.plan.video.text_max_chars) {
    throw new HttpError(400, 'video_text_too_long', `视频配文不能超过 ${input.plan.video.text_max_chars} 字`);
  }
  if (input.mediaItems.length !== 1 || input.mediaItems[0]?.media_kind !== 'video') {
    throw new HttpError(400, 'video_media_invalid', '视频发布必须且只能包含1个视频');
  }
  assertVideoItem(input.mediaItems[0], input.plan);
}

function assertArticleQuota(input: DeclaredQuotaInput): void {
  if (input.titleLength < input.plan.article.title_min_chars ||
      input.titleLength > input.plan.article.title_max_chars) {
    throw new HttpError(400, 'article_title_invalid',
      `文章标题必须是 ${input.plan.article.title_min_chars}-${input.plan.article.title_max_chars} 字`);
  }
  if (input.textLength === 0) throw new HttpError(400, 'article_body_required', '文章正文不能为空');
  if (input.textLength > input.plan.article.body_max_chars) {
    throw new HttpError(400, 'article_body_too_long', `文章正文不能超过 ${input.plan.article.body_max_chars} 字`);
  }
  if (input.mediaItems[0]?.media_kind !== 'image') {
    throw new HttpError(400, 'article_cover_required', '文章必须上传1张首图');
  }
  // 单篇图片额度包含首图，不能再额外放行一张封面。
  const images = input.mediaItems.filter((item) => item.media_kind === 'image');
  if (images.length > input.plan.article.max_images) {
    throw new HttpError(400, 'article_image_count_exceeded', `文章图片总数不能超过 ${input.plan.article.max_images} 张`);
  }
  const videos = input.mediaItems.filter((item) => item.media_kind === 'video');
  if (videos.length > input.plan.article.max_videos) {
    throw new HttpError(
      400,
      'article_video_count_exceeded',
      `当前会员每篇文章最多插入 ${input.plan.article.max_videos} 个视频`,
    );
  }
  for (const video of videos) assertVideoItem(video, input.plan);
}

function assertVideoItem(item: UploadItemInput, plan: MembershipPlan): void {
  if (item.byte_size > plan.video.max_video_bytes) {
    throw new HttpError(400, 'video_too_large', `单个视频不能超过 ${formatBytes(plan.video.max_video_bytes)}`);
  }
  if ((item.duration_seconds ?? 0) > plan.video.max_video_seconds) {
    throw new HttpError(400, 'video_too_long', `单个视频不能超过 ${plan.video.max_video_seconds} 秒`);
  }
}

function assertManifestShape(manifest: SquarePostManifest): void {
  if (manifest.post_type !== 'article' && manifest.content_sections !== undefined) {
    throw new HttpError(400, 'content_sections_forbidden', '只有文章允许 content_sections');
  }
  if (manifest.post_type !== 'article' && manifest.title !== undefined) {
    throw new HttpError(400, 'title_forbidden', '只有文章允许标题');
  }
  if (manifest.post_type !== 'article') return;
  const sections = manifest.content_sections ?? [];
  if (sections.length === 0) {
    throw new HttpError(400, 'article_content_sections_required', '文章必须包含规范正文段落');
  }
  const referenced = new Set<number>();
  for (const section of sections) {
    let text = '';
    for (const operation of section.text_delta) text += operation.insert;
    if (!text.endsWith('\n') || scalarLength(text.trim()) < 10) {
      throw new HttpError(400, 'article_section_text_too_short', '文章每个段落不少于 10 个字');
    }
    const isGallery = section.gallery_media_indices !== undefined;
    const indices = isGallery
      ? section.gallery_media_indices ?? []
      : section.video_media_index === undefined ? [] : [section.video_media_index];
    for (const index of indices) {
      const media = manifest.media_items[index];
      const expectedKind = isGallery ? 'image' : 'video';
      if (index === 0 || !media || media.media_kind !== expectedKind || referenced.has(index)) {
        throw new HttpError(400, 'article_content_section_mismatch', '文章段落与媒体顺序不一致');
      }
      referenced.add(index);
    }
  }
  for (let index = 1; index < manifest.media_items.length; index += 1) {
    if (!referenced.has(index)) {
      throw new HttpError(400, 'article_media_unreferenced', '文章存在未引用的正文媒体');
    }
  }
}

function assertManifestMatchesAssets(
  mediaItems: SquareManifestMediaItem[],
  mediaAssets: MediaAssetRow[],
): void {
  if (mediaItems.length !== mediaAssets.length) {
    throw new HttpError(409, 'manifest_media_count_mismatch', 'manifest 媒体数量与上传授权不一致');
  }
  for (const [index, item] of mediaItems.entries()) {
    const asset = mediaAssets[index];
    if (!asset || asset.media_index !== index || asset.media_kind !== item.media_kind ||
        asset.content_type !== item.content_type || asset.byte_size !== item.byte_size ||
        asset.sha256 !== item.sha256.toLowerCase() ||
        asset.width !== (item.width ?? null) || asset.height !== (item.height ?? null) ||
        (item.media_kind === 'video' && asset.duration_seconds !== item.duration_seconds)) {
      throw new HttpError(409, 'manifest_media_mismatch', `第 ${index + 1} 个媒体与上传授权不一致`);
    }
  }
}

function scalarLength(value: string): number { return [...value].length; }

function formatBytes(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  return bytes % gib === 0 ? `${bytes / gib}GB` : `${Math.round(bytes / mib)}MB`;
}
