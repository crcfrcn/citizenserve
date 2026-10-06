import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteR2MediaAssets, mediaRoute } from '../src/media';
import type { Env } from '../src/types';

class FakeR2 {
  constructor(
    private readonly objects: Record<string, { body: string; contentType: string }>
  ) {}

  async get(key: string) {
    const object = this.objects[key];
    if (!object) return null;
    return {
      body: object.body,
      size: new TextEncoder().encode(object.body).byteLength,
      httpMetadata: { contentType: object.contentType },
      httpEtag: '"etag"'
    };
  }
}

function fakeEnv(
  objects: Record<string, { body: string; contentType: string }>
): Env {
  return {
    SQUARE_PRIVATE: new FakeR2(objects) as unknown as R2Bucket,
    SQUARE_CACHE: {
      get: async (key: string) => key ===
        'square_session:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' ? {
        account_id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        cid_number: 'CN220-CTZN2-198805200-2026',
        binding_revision: 1,
        device_id: 'a'.repeat(64),
        created_at: 0,
        expires_at: Date.now() + 60_000
      } : null
    } as unknown as KVNamespace
  } as unknown as Env;
}

function call(env: Env, path: string) {
  return mediaRoute(new Request(`https://worker${path}`, {
    headers: { authorization: 'Bearer test' }
  }), env, path);
}

describe('media read channel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams a stored object with its content type', async () => {
    const key = 'profile/acct/avatar';
    const env = fakeEnv({
      [key]: { body: 'IMG', contentType: 'image/webp' }
    });
    const response = await call(env, `/square/media/${key}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('IMG');
  });

  it('404s a missing object', async () => {
    const key = 'profile/a/avatar';
    await expect(
      call(fakeEnv({}), `/square/media/${key}`)
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects keys outside the profile prefix', async () => {
    await expect(
      call(fakeEnv({}), '/square/media/secret/keys.txt')
    ).rejects.toMatchObject({ code: 'invalid_media_key' });
  });

  it('110 个媒体项只产生一次 R2 批删和三次按 URL purge', async () => {
    const r2Delete = vi.fn(async (_keys: string | string[]) => undefined);
    const purge = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ success: true }));
    vi.stubGlobal('fetch', purge);
    const env = {
      SQUARE_PUBLIC_MEDIA: { delete: r2Delete },
      SQUARE_PUBLIC_MEDIA_BASE_URL: 'https://media.crcfrcn.com',
      ZONE_ID: 'a'.repeat(32),
      PURGE: 'purge-token',
    } as unknown as Env;
    const assets = Array.from({ length: 110 }, (_, index) => ({
      object_key: `square/cid/posts/post/media/${index}/source.webp`,
      derivative_object_key: `square/cid/posts/post/media/${index}/thumbnail.webp`,
    }));

    await deleteR2MediaAssets(env, assets);

    expect(r2Delete).toHaveBeenCalledTimes(1);
    expect(r2Delete.mock.calls[0][0]).toHaveLength(220);
    expect(purge).toHaveBeenCalledTimes(3);
    expect(purge.mock.calls.map((call) =>
      (JSON.parse(String(call[1]?.body)) as { files: string[] }).files.length,
    )).toEqual([100, 100, 20]);
  });
});
