import { describe, expect, it } from 'vitest';
import { resourceLimit, videoResource } from '../src/limits/catalog';
import {
  assertKnownRoute,
  assertRequestBodyLimit,
  readLimitedBytes,
} from '../src/limits/request';
import { assertDeclaredResource, validateUploadBytes } from '../src/limits/upload';
import { membershipUsagePeriod } from '../src/limits/usage';
import { HttpError } from '../src/shared/http';
import { routeRequest } from '../src/routes';
import { afterEach, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare 统一资源限制', () => {
  it('固定压缩后的图片、视频和普通推送硬上限', () => {
    expect(resourceLimit('profile_avatar').max_bytes).toBe(512 * 1024);
    expect(resourceLimit('square_image_freedom').max_bytes).toBe(1_000_000);
    expect(resourceLimit('square_image_spark').max_bytes).toBe(4_000_000);
    expect(resourceLimit(videoResource('freedom')).max_bytes).toBe(16_000_000);
    expect(resourceLimit(videoResource('spark')).max_seconds).toBe(3 * 60 * 60);
    expect(resourceLimit('push_endpoint').max_bytes).toBe(16 * 1024);
    expect(resourceLimit('contact_ciphertext').max_bytes).toBe(16 * 1024);
  });

  it('在进入风控和 D1 前拒绝未登记路由', () => {
    expect(() => assertKnownRoute('GET', '/unknown')).toThrowError(HttpError);
    // finalized 换绑不再由客户端携此前账户签名二次清理；已删除 endpoint 必须彻底下线。
    expect(() => assertKnownRoute('POST', '/square/rebind/revoke')).toThrowError(
      HttpError
    );
    expect(() => assertKnownRoute('PUT', '/square/uploads/media')).toThrowError(HttpError);
    expect(assertKnownRoute('GET', '/square/contacts')).toBe('api_json_small');
    expect(assertKnownRoute('PUT', '/square/push-endpoint')).toBe('push_endpoint');
    expect(assertKnownRoute('PUT', `/square/contacts/${'ab'.repeat(32)}`)).toBe('contact_ciphertext');
    expect(assertKnownRoute('GET', '/download/citizenapp/android')).toBe('api_json_small');
    for (const path of [
      '/download/citizenchain/macOS',
      '/download/citizenchain/macOS/updater',
      '/download/citizenchain/Windows',
      '/download/citizenchain/LinuxARM',
      '/download/citizenchain/LinuxAMD',
    ]) expect(assertKnownRoute('GET', path)).toBe('api_json_small');
    for (const path of [
      '/download/citizenchain/macos' + '-arm64',
      '/download/citizenchain/macos' + '-arm64-updater',
      '/download/citizenchain/windows-x86_64',
      '/download/citizenchain/linux-arm64',
      '/download/citizenchain/linux-amd64',
      '/download/citizenchain/linux-arm',
      '/download/citizenchain/linux-amd',
    ]) expect(() => assertKnownRoute('GET', path)).toThrowError(HttpError);
    expect(assertKnownRoute('GET', '/chain/citizensdk/bootstrap')).toBe('api_json_small');
    expect(assertKnownRoute(
      'PUT', '/operations/citizenchain/download-publications/linux-arm',
    )).toBe('api_json_small');
    expect(() => assertKnownRoute('GET', '/download/citizenapp/ios')).toThrowError(HttpError);
  });

  it('Turnstile 页面禁止被嵌入且不使用通配 postMessage 或 unsafe-inline', async () => {
    const response = await routeRequest(
      new Request('https://worker.test/api/security/turnstile'),
      { TURNSTILE_SITEKEY: 'test-site-key' } as never,
    );
    const html = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(response.status).toBe(200);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(html).not.toContain("postMessage({type:'turnstile'");
    const nonce = html.match(/<style nonce="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  it('拒绝没有 Content-Length 或声明超限的写请求', () => {
    expect(() => assertRequestBodyLimit(new Request('https://worker.test/square/push-endpoint', {
      method: 'PUT',
      body: '{}',
    }), '/square/push-endpoint')).toThrow(expect.objectContaining({ code: 'content_length_required' }));

    expect(() => assertRequestBodyLimit(new Request('https://worker.test/square/push-endpoint', {
      method: 'PUT',
      headers: { 'content-length': String(16 * 1024 + 1) },
    }), '/square/push-endpoint')).toThrow(expect.objectContaining({ code: 'request_too_large' }));
  });

  it('没有可信声明长度时仍在流读取阶段截断', async () => {
    const bytes = new Uint8Array(512 * 1024 + 1);
    const request = new Request('https://worker.test/square/profile/assets', {
      method: 'PUT',
      body: bytes,
    });
    await expect(readLimitedBytes(request, 'profile_avatar')).rejects.toMatchObject({
      code: 'request_too_large',
    });
  });

  it('校验图片文件头、真实尺寸、字节和哈希后才签发限制凭证', async () => {
    const png = pngHeader(100, 80);
    const ticket = await validateUploadBytes({
      resource_key: 'profile_avatar',
      bytes: png,
      content_type: 'image/png',
      expected_bytes: png.length,
    });
    expect(ticket.width).toBe(100);
    expect(ticket.height).toBe(80);
    expect(ticket.content_hash).toMatch(/^[a-f0-9]{64}$/);

    await expect(validateUploadBytes({
      resource_key: 'profile_avatar',
      bytes: pngHeader(2000, 80),
      content_type: 'image/png',
    })).rejects.toMatchObject({ code: 'image_dimensions_exceeded' });
  });

  it('环境外声明不能突破最高档视频硬上限', () => {
    expect(() => assertDeclaredResource({
      resource_key: 'square_video_spark',
      byte_size: resourceLimit('square_video_spark').max_bytes + 1,
      content_type: 'video/mp4',
      duration_seconds: 1,
    })).toThrow(expect.objectContaining({ code: 'resource_size_invalid' }));
  });

  it('用量周期严格复用链上最近扣款与 paid_until，不推算固定天数', () => {
    expect(membershipUsagePeriod({
      last_charged_at: 1_700_000_000_000,
      paid_until: 1_702_678_400_000,
    })).toEqual({
      periodStart: 1_700_000_000_000,
      periodEnd: 1_702_678_400_000,
    });
    expect(() => membershipUsagePeriod({
      last_charged_at: 1000,
      paid_until: 1000,
    })).toThrow(expect.objectContaining({ code: 'subscription_period_invalid' }));
  });
});

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
