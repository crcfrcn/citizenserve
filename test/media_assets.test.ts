import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  auditSquareR2Consistency,
  createR2ObjectUpload,
  publicMediaUrl,
  purgePublicMediaCache,
} from '../src/media';
import type { Env } from '../src/types';

describe('R2 media assets', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs a bounded direct PUT for small media', async () => {
    const plan = await createR2ObjectUpload(signingEnv(), {
      object_key: 'square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/0/source.webp',
      content_type: 'image/webp',
      byte_size: 1024,
      sha256: '11'.repeat(32),
      upload_id: 'squ_test',
      media_index: 0,
      object_role: 'source',
    });

    expect(plan.upload_method).toBe('r2_put');
    expect(plan.upload_url).toContain('X-Amz-Signature=');
    expect(new URL(plan.upload_url).searchParams.get('X-Amz-SignedHeaders'))
      .toContain('x-amz-checksum-sha256');
    expect(plan.upload_headers).toMatchObject({
      'content-type': 'image/webp',
      'content-length': '1024',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-amz-checksum-sha256': 'ERERERERERERERERERERERERERERERERERERERERERE=',
      'x-amz-meta-sha256': '11'.repeat(32),
    });
  });

  it('signs the full SHA-256 checksum for the largest supported video', async () => {
    const plan = await createR2ObjectUpload(signingEnv(), {
      object_key: 'square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/0/source.mp4',
      content_type: 'video/mp4',
      byte_size: 3_000_000_000,
      sha256: '22'.repeat(32),
      upload_id: 'squ_test',
      media_index: 0,
      object_role: 'source',
    });

    expect(plan).toMatchObject({
      upload_method: 'r2_put',
      upload_headers: {
        'content-type': 'video/mp4',
        'content-length': '3000000000',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-amz-checksum-sha256': 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=',
        'x-amz-meta-sha256': '22'.repeat(32),
        'x-amz-meta-upload-id': 'squ_test',
        'x-amz-meta-media-index': '0',
        'x-amz-meta-object-role': 'source',
      },
    });
    expect(plan.upload_url).toContain('X-Amz-Signature=');
    expect(new URL(plan.upload_url).searchParams.get('X-Amz-SignedHeaders'))
      .toContain('x-amz-checksum-sha256');
  });

  it('returns the public R2 custom-domain URL without routing playback through Worker', () => {
    expect(publicMediaUrl(
      signingEnv(),
      'square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/0/source.mp4',
    )).toBe(
      'https://media.crcfrcn.com/square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/0/source.mp4',
    );
  });

  it('purges deleted public media by exact CDN URLs', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const objectKey =
      'square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/0/source.mp4';

    await purgePublicMediaCache(signingEnv(), [objectKey, objectKey]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/zones/0123456789abcdef0123456789abcdef/purge_cache',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      files: [`https://media.crcfrcn.com/${objectKey}`],
    });
  });

  it('audits D1 references against public media and private manifests without listing buckets', async () => {
    const publicHead = vi.fn(async (key: string) =>
      key.endsWith('source.webp') ? { key } : null);
    const privateHead = vi.fn(async () => null);
    const cache = new Map<string, string>();
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async all() {
            if (sql.includes('FROM square_media_assets')) {
              return { results: [{
                upload_id: 'squ_test',
                post_id: 'sqp_test',
                cid_number: 'CN220-CTZN2-198805200-2026',
                account_id: `0x${'11'.repeat(32)}`,
                media_index: 0,
                media_kind: 'image',
                object_key: 'square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/0/source.webp',
                upload_method: 'r2_put',
                resource_key: 'square_image_freedom',
                content_type: 'image/webp',
                byte_size: 10,
                sha256: '11'.repeat(32),
                derivative_kind: 'thumbnail',
                derivative_object_key: 'square/CN220-CTZN2-198805200-2026/posts/sqp_test/media/0/thumbnail.webp',
                derivative_content_type: 'image/webp',
                derivative_byte_size: 5,
                derivative_sha256: '22'.repeat(32),
                asset_state: 'ready',
                duration_seconds: null,
                width: 10,
                height: 10,
                error_code: null,
                created_at: 1,
                updated_at: 1,
                ready_at: 1,
              }] };
            }
            return { results: [{
              upload_id: 'squ_test',
              post_id: 'sqp_test',
              cid_number: 'CN220-CTZN2-198805200-2026',
              manifest_byte_size: 2,
              completed_at: 1,
            }] };
          },
        };
        return statement;
      },
    };

    const result = await auditSquareR2Consistency({
      DB: db,
      SQUARE_CACHE: {
        async get<T>(key: string, type?: 'json') {
          const value = cache.get(key);
          if (value === undefined) return null;
          return (type === 'json' ? JSON.parse(value) : value) as T;
        },
        async put(key: string, value: string) {
          cache.set(key, value);
        },
      },
      SQUARE_PUBLIC_MEDIA: { head: publicHead },
      SQUARE_PRIVATE: { head: privateHead },
    } as unknown as Env);

    expect(result).toEqual({
      checked_media_assets: 1,
      checked_manifests: 1,
      missing_public_objects: 1,
      missing_private_objects: 1,
    });
    expect(publicHead).toHaveBeenCalledTimes(2);
    expect(privateHead).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cache.get('square_r2_audit_cursor') ?? '{}')).toEqual({
      media: { updated_at: 1, upload_id: 'squ_test', media_index: 0 },
      manifest: { completed_at: 1, upload_id: 'squ_test' },
    });
  });
});

function signingEnv(): Env {
  return {
    CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_KEY: 'access-key',
    R2_SECRET: 'secret-key',
    SQUARE_PUBLIC_MEDIA_BUCKET_NAME: 'citizenserve-media',
    SQUARE_PUBLIC_MEDIA_BASE_URL: 'https://media.crcfrcn.com',
    ZONE_ID: '0123456789abcdef0123456789abcdef',
    PURGE: 'cache-purge-token',
  } as unknown as Env;
}
