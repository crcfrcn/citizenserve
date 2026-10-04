import { describe, expect, it, vi } from 'vitest';
import { assertAllowedOrigin, normalizeApiPath } from '../src/security/request_guard';
import { assertKnownRoute, assertRequestBodyLimit } from '../src/limits/request';
import { HttpError } from '../src/shared/http';
import type { Env, PreparedUploadRow } from '../src/types';
import {
  cleanupExpiredUploads,
  createStorageReceiptId,
  estimateUploadBytes,
  validateUploadItems
} from '../src/uploads/service';

const uploadAccountId =
  '0x8888888888888888888888888888888888888888888888888888888888888888';
const uploadPostId = 'sqp_expired';
const uploadCidNumber = 'CN220-CTZN2-198805200-2026';
const uploadManifestKey =
  `square/${uploadCidNumber}/posts/${uploadPostId}/manifest.json`;

describe('upload validation', () => {
  it('accepts supported image and video content types', () => {
    const items = validateUploadItems([
      mediaDeclaration('image'),
      mediaDeclaration('video')
    ]);

    expect(items).toHaveLength(2);
    expect(estimateUploadBytes(items)).toBe(3584);
  });

  it('rejects unsupported media content types', () => {
    expect(() =>
      validateUploadItems([{ ...mediaDeclaration('video'), content_type: 'application/octet-stream' }])
    ).toThrow(HttpError);
  });

  it('pre-generates stable storage receipt before external media upload', async () => {
    const input = {
      uploadId: 'squ_test',
      postId: 'sqp_test',
      cidNumber: uploadCidNumber,
      manifestHash: '11'.repeat(32)
    };

    const first = await createStorageReceiptId(input);
    const second = await createStorageReceiptId(input);

    expect(first).toBe(second);
    expect(first).toMatch(/^sqr_[a-f0-9]{64}$/);
  });

  it('只剥离唯一生产前缀 /api，不兼容已废弃的版本路径', () => {
    expect(normalizeApiPath('/api/square/feed')).toBe('/square/feed');
    expect(normalizeApiPath('/square/feed')).toBe('/square/feed');
    expect(normalizeApiPath('/api/legacy/square/feed')).toBe('/legacy/square/feed');
    expect(() => assertKnownRoute('GET', '/legacy/square/feed')).toThrowError(HttpError);
  });

  it('accepts the exact website origin and rejects lookalike origins', () => {
    const env = { WEB_ORIGIN: 'https://www.crcfrcn.com' } as Env;
    expect(() => assertAllowedOrigin(new Request('https://worker.test', {
      headers: { origin: 'https://www.crcfrcn.com' }
    }), env)).not.toThrow();
    expect(() => assertAllowedOrigin(new Request('https://worker.test', {
      headers: { origin: 'https://www.crcfrcn.com.evil.example' }
    }), env)).toThrowError(HttpError);
  });

  it('rejects oversized API JSON before parsing', () => {
    const request = new Request('https://worker.test/api/square/uploads/prepare', {
      method: 'POST',
      headers: { 'content-length': String(256 * 1024 + 1) }
    });
    expect(() => assertRequestBodyLimit(request, '/square/uploads/prepare')).toThrowError(HttpError);
  });

  it('到期上传按 CID 固定路径删除唯一 manifest 并原子提交 D1 清理', async () => {
    const harness = expiredCleanupEnv(expiredUpload());

    const result = await cleanupExpiredUploads(harness.env);

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(harness.mediaQueryCount()).toBe(1);
    expect(harness.r2Delete).toHaveBeenCalledWith(uploadManifestKey);
    expect(harness.batch).toHaveBeenCalledTimes(1);
  });
});

function expiredUpload(): PreparedUploadRow {
  return {
    upload_id: 'squ_expired',
    post_id: uploadPostId,
    cid_number: uploadCidNumber,
    account_id: uploadAccountId,
    post_type: 'document',
    manifest_hash: '11'.repeat(32),
    manifest_byte_size: 512,
    content_hash: null,
    storage_receipt_id: 'sqr_expired',
    estimated_bytes: 1024,
    status: 'prepared',
    expires_at: 1,
    created_at: 1,
    completed_at: null
  };
}

function mediaDeclaration(mediaKind: 'image' | 'video') {
  return {
    media_kind: mediaKind,
    content_type: mediaKind === 'image' ? 'image/webp' : 'video/mp4',
    byte_size: mediaKind === 'image' ? 1024 : 2048,
    sha256: '11'.repeat(32),
    width: mediaKind === 'image' ? 320 : 854,
    height: mediaKind === 'image' ? 240 : 480,
    ...(mediaKind === 'video' ? { duration_seconds: 30 } : {}),
    derivative_kind: mediaKind === 'image' ? 'thumbnail' : 'cover',
    derivative_content_type: 'image/webp',
    derivative_byte_size: 256,
    derivative_sha256: '22'.repeat(32),
  };
}

function expiredCleanupEnv(upload: PreparedUploadRow): {
  env: Env;
  r2Delete: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  mediaQueryCount: () => number;
} {
  const r2Delete = vi.fn(async () => undefined);
  const batch = vi.fn(async (statements: unknown[]) =>
    statements.map(() => ({ meta: { changes: 1 } }))
  );
  let mediaQueries = 0;
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          if (sql.includes('FROM square_uploads')) {
            return { results: [upload] };
          }
          if (sql.includes('FROM square_media_assets')) {
            mediaQueries += 1;
            return { results: [] };
          }
          return { results: [] };
        }
      };
      return statement;
    },
    batch
  };
  return {
    env: {
      DB: db,
      SQUARE_PRIVATE: { delete: r2Delete }
    } as unknown as Env,
    r2Delete,
    batch,
    mediaQueryCount: () => mediaQueries
  };
}
