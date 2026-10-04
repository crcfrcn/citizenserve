import { describe, expect, it } from 'vitest';
import { membershipPlans } from '../src/membership/plans';
import {
  assertDeclaredContentQuota,
  assertIdentityCanPublishCategory,
  assertManifestQuota
} from '../src/uploads/quota';
import type { MediaAssetRow, UploadItemInput } from '../src/types';
import { decodeSquarePostManifestText } from '../src/posts/manifest';

describe('membership upload quotas', () => {
  it('rejects a document whose text exceeds the member quota', () => {
    expect(() =>
      assertDeclaredContentQuota({
        membershipLevel: 'freedom',
        plan: membershipPlans.freedom,
        postType: 'document',
        titleLength: 0,
        textLength: 301,
        mediaItems: [image()]
      })
    ).toThrow(expect.objectContaining({ code: 'document_text_too_long' }));
  });

  it('allows a document with 9 images under the member quota', () => {
    expect(() =>
      assertDeclaredContentQuota({
        membershipLevel: 'spark',
        plan: membershipPlans.spark,
        postType: 'document',
        titleLength: 0,
        textLength: 300,
        mediaItems: Array.from({ length: 9 }, image)
      })
    ).not.toThrow();
  });

  it('gates campaign category by identity, not membership (ADR-037 + 用户 2026-07-16)', () => {
    // 用量额度按会员校验，不再把关分类权限：民主会员发竞选帖过额度校验（分类由身份另管）。
    expect(() =>
      assertDeclaredContentQuota({
        membershipLevel: 'democracy',
        plan: membershipPlans.democracy,
        postType: 'document',
        titleLength: 0,
        textLength: 120,
        mediaItems: [image()]
      })
    ).not.toThrow();
    // 分类权限按身份：非竞选身份发竞选帖被拒；竞选身份放行；普通帖任意身份放行。
    expect(() => assertIdentityCanPublishCategory('visitor', 'campaign')).toThrow(
      expect.objectContaining({ code: 'post_category_identity_mismatch' })
    );
    expect(() => assertIdentityCanPublishCategory('voting', 'campaign')).toThrow(
      expect.objectContaining({ code: 'post_category_identity_mismatch' })
    );
    expect(() => assertIdentityCanPublishCategory('candidate', 'campaign')).not.toThrow();
    expect(() => assertIdentityCanPublishCategory('visitor', 'normal')).not.toThrow();
  });

  it('rejects freedom article body images over its quota', () => {
    expect(() =>
      assertDeclaredContentQuota({
        membershipLevel: 'freedom',
        plan: membershipPlans.freedom,
        postType: 'article',
        titleLength: 12,
        textLength: 200,
        mediaItems: Array.from({ length: 51 }, image)
      })
    ).toThrow(expect.objectContaining({ code: 'article_image_count_exceeded' }));
  });

  it('rejects an article without its mandatory first cover image', () => {
    expect(() =>
      assertDeclaredContentQuota({
        membershipLevel: 'freedom',
        plan: membershipPlans.freedom,
        postType: 'article',
        titleLength: 12,
        textLength: 200,
        mediaItems: []
      })
    ).toThrow(expect.objectContaining({ code: 'article_cover_required' }));
    expect(() =>
      assertDeclaredContentQuota({
        membershipLevel: 'freedom',
        plan: membershipPlans.freedom,
        postType: 'article',
        titleLength: 12,
        textLength: 200,
        mediaItems: [video()]
      })
    ).toThrow(expect.objectContaining({ code: 'article_cover_required' }));
  });

  it('allows a campaign article within the article quota (category not membership-gated)', () => {
    expect(() =>
      assertDeclaredContentQuota({
        membershipLevel: 'spark',
        plan: membershipPlans.spark,
        postType: 'article',
        titleLength: 12,
        textLength: 30_000,
        mediaItems: Array.from({ length: 100 }, image)
      })
    ).not.toThrow();
  });

  it('enforces article video count as freedom 1, democracy 3 and spark 10', () => {
    expect(() => articleQuota('freedom', 2)).toThrow(
      expect.objectContaining({ code: 'article_video_count_exceeded' })
    );
    expect(() => articleQuota('democracy', 3)).not.toThrow();
    expect(() => articleQuota('democracy', 4)).toThrow(
      expect.objectContaining({ code: 'article_video_count_exceeded' })
    );
    expect(() => articleQuota('spark', 10)).not.toThrow();
    expect(() => articleQuota('spark', 11)).toThrow(
      expect.objectContaining({ code: 'article_video_count_exceeded' })
    );
  });

  it('checks the uploaded R2 manifest against actual media assets', async () => {
    const manifestText = JSON.stringify({
      schema: 'citizenapp.square.post',
      cid_number: 'CN220-CTZN2-198805200-2026',
      post_type: 'article',
      title: '标题标题标题标题标题',
      text: '正文内容正文内容正文',
      content_sections: [
        { text_delta: [{ insert: '正文内容正文内容正文' }, { insert: '\n' }] }
      ],
      media_items: [
        {
          media_kind: 'image',
          content_type: 'image/webp',
          byte_size: 1024,
          sha256: '11'.repeat(32),
          width: 320,
          height: 240
        }
      ]
    });

    await expect(
      assertManifestQuota({
        membershipLevel: 'freedom',
        plan: membershipPlans.freedom,
        upload: {
          cid_number: 'CN220-CTZN2-198805200-2026',
          post_type: 'article'
        },
        manifestText,
        mediaAssets: [mediaAsset()]
      })
    ).resolves.toMatchObject({ post_type: 'article' });
  });

  it('accepts one gallery group and multiple referenced videos', async () => {
    const manifestText = JSON.stringify({
      schema: 'citizenapp.square.post',
      cid_number: 'CN220-CTZN2-198805200-2026',
      post_type: 'article',
      title: '标题标题标题标题标题',
      text: '正文内容正文内容正文',
      content_sections: [
        {
          text_delta: [{ insert: '图集前面的正文内容满足十字' }, { insert: '\n' }],
          gallery_media_indices: [1, 2]
        },
        {
          text_delta: [{ insert: '第一个视频正文内容满足十字' }, { insert: '\n' }],
          video_media_index: 3
        },
        {
          text_delta: [{ insert: '第二个视频正文内容满足十字' }, { insert: '\n' }],
          video_media_index: 4
        }
      ],
      media_items: [
        manifestImage('11'),
        manifestImage('22'),
        manifestImage('33'),
        manifestVideo('44'),
        manifestVideo('55')
      ]
    });

    await expect(assertManifestQuota({
      membershipLevel: 'democracy',
      plan: membershipPlans.democracy,
      upload: {
        cid_number: 'CN220-CTZN2-198805200-2026',
        post_type: 'article'
      },
      manifestText,
      mediaAssets: [
        mediaAsset(0, 'image', '11'),
        mediaAsset(1, 'image', '22'),
        mediaAsset(2, 'image', '33'),
        mediaAsset(3, 'video', '44'),
        mediaAsset(4, 'video', '55')
      ]
    })).resolves.toMatchObject({ post_type: 'article' });
  });

  it('rejects unknown rich-text attributes and sections shorter than 10 characters', async () => {
    const base = {
      schema: 'citizenapp.square.post',
      cid_number: 'CN220-CTZN2-198805200-2026',
      post_type: 'article',
      title: '标题标题标题标题标题',
      text: '正文内容正文内容正文',
      media_items: [{
        media_kind: 'image',
        content_type: 'image/webp',
        byte_size: 1024,
        sha256: '11'.repeat(32),
        width: 320,
        height: 240
      }]
    };
    expect(() => decodeSquarePostManifestText(JSON.stringify({
      ...base,
      content_sections: [{ text_delta: [{ insert: '正文内容正文内容正文', attributes: { link: 'x' } }, { insert: '\n' }] }]
    }))).toThrow(expect.objectContaining({ code: 'manifest_content_sections_invalid' }));
    await expect(assertManifestQuota({
      membershipLevel: 'freedom',
      plan: membershipPlans.freedom,
      upload: { cid_number: base.cid_number, post_type: 'article' },
      manifestText: JSON.stringify({ ...base, content_sections: [{ text_delta: [{ insert: '不足十字' }, { insert: '\n' }] }] }),
      mediaAssets: [mediaAsset()]
    })).rejects.toMatchObject({ code: 'article_section_text_too_short' });
  });

  it('rejects a manifest whose media does not match the signed upload assets', async () => {
    const manifestText = JSON.stringify({
      schema: 'citizenapp.square.post',
      cid_number: 'CN220-CTZN2-198805200-2026',
      post_type: 'document',
      text: '正文',
      media_items: [
        {
          media_kind: 'image',
          content_type: 'image/webp',
          byte_size: 1024,
          sha256: '22'.repeat(32),
          width: 320,
          height: 240
        }
      ]
    });

    await expect(
      assertManifestQuota({
        membershipLevel: 'freedom',
        plan: membershipPlans.freedom,
        upload: {
          cid_number: 'CN220-CTZN2-198805200-2026',
          post_type: 'document'
        },
        manifestText,
        mediaAssets: [mediaAsset()]
      })
    ).rejects.toMatchObject({ code: 'manifest_media_mismatch' });
  });
});

function image(): UploadItemInput {
  return {
    media_kind: 'image',
    content_type: 'image/webp',
    byte_size: 1024,
    sha256: '11'.repeat(32),
    width: 320,
    height: 240,
    derivative_kind: 'thumbnail',
    derivative_content_type: 'image/webp',
    derivative_byte_size: 256,
    derivative_sha256: 'aa'.repeat(32),
  };
}

function video(): UploadItemInput {
  return {
    media_kind: 'video',
    content_type: 'video/mp4',
    byte_size: 2048,
    sha256: '22'.repeat(32),
    width: 854,
    height: 480,
    duration_seconds: 30,
    derivative_kind: 'cover',
    derivative_content_type: 'image/webp',
    derivative_byte_size: 256,
    derivative_sha256: 'bb'.repeat(32),
  };
}

function articleQuota(level: 'freedom' | 'democracy' | 'spark', videoCount: number): void {
  assertDeclaredContentQuota({
    membershipLevel: level,
    plan: membershipPlans[level],
    postType: 'article',
    titleLength: 12,
    textLength: 200,
    mediaItems: [image(), ...Array.from({ length: videoCount }, video)]
  });
}

function manifestImage(hashByte: string) {
  return {
    media_kind: 'image',
    content_type: 'image/webp',
    byte_size: 1024,
    sha256: hashByte.repeat(32),
    width: 320,
    height: 240
  };
}

function manifestVideo(hashByte: string) {
  return {
    media_kind: 'video',
    content_type: 'video/mp4',
    byte_size: 2048,
    sha256: hashByte.repeat(32),
    width: 854,
    height: 480,
    duration_seconds: 30
  };
}

function mediaAsset(
  mediaIndex = 0,
  mediaKind: 'image' | 'video' = 'image',
  hashByte = '11'
): MediaAssetRow {
  return {
    upload_id: 'squ_test',
    post_id: 'sqp_test',
    cid_number: 'CN220-CTZN2-198805200-2026',
    account_id: '0x3333333333333333333333333333333333333333333333333333333333333333',
    media_index: mediaIndex,
    media_kind: mediaKind,
    object_key: `square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/${mediaIndex}/source.${mediaKind === 'image' ? 'webp' : 'mp4'}`,
    upload_method: 'r2_put',
    resource_key: mediaKind === 'image' ? 'square_image_freedom' : 'square_video_freedom',
    content_type: mediaKind === 'image' ? 'image/webp' : 'video/mp4',
    byte_size: mediaKind === 'image' ? 1024 : 2048,
    sha256: hashByte.repeat(32),
    derivative_kind: mediaKind === 'image' ? 'thumbnail' : 'cover',
    derivative_object_key: `square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/${mediaIndex}/${mediaKind === 'image' ? 'thumbnail' : 'cover'}.webp`,
    derivative_content_type: 'image/webp',
    derivative_byte_size: 256,
    derivative_sha256: 'aa'.repeat(32),
    asset_state: 'ready',
    duration_seconds: mediaKind === 'video' ? 30 : null,
    width: mediaKind === 'image' ? 320 : 854,
    height: mediaKind === 'image' ? 240 : 480,
    error_code: null,
    created_at: 1,
    updated_at: 1,
    ready_at: 1
  };
}
