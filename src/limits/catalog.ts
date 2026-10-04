import type { MembershipLevel } from '../membership/plans';

export type ResourceKey =
  | 'profile_avatar'
  | 'profile_banner'
  | 'square_manifest'
  | 'square_image_freedom'
  | 'square_image_democracy'
  | 'square_image_spark'
  | 'square_image_thumbnail'
  | 'square_video_cover'
  | 'square_video_freedom'
  | 'square_video_democracy'
  | 'square_video_spark'
  | 'chat_server_access'
  | 'push_endpoint'
  | 'push_notification'
  | 'chain_extrinsic'
  | 'chain_extrinsic_json'
  | 'chain_rpc_response'
  | 'session_cache'
  | 'session_index'
  | 'contact_ciphertext'
  | 'api_json_small'
  | 'api_json';

export interface ResourceLimit {
  max_bytes: number;
  content_types?: readonly string[];
  max_width?: number;
  max_height?: number;
  max_seconds?: number;
  max_count?: number;
  max_items?: number;
  ttl_seconds?: number;
  max_total_bytes?: number;
}

const kib = 1024;
const mib = 1024 * kib;

/**
 * Cloudflare 资源硬上限唯一真源。
 *
 * 环境变量不得放宽这些值；产品权益、路由、存储和第三方上传都必须引用本表。
 */
export const resourceLimits: Readonly<Record<ResourceKey, ResourceLimit>> = {
  profile_avatar: {
    max_bytes: 512 * kib,
    content_types: ['image/jpeg', 'image/png', 'image/webp'],
    max_width: 1024,
    max_height: 1024,
    max_count: 1,
  },
  profile_banner: {
    max_bytes: 1536 * kib,
    content_types: ['image/jpeg', 'image/png', 'image/webp'],
    max_width: 1920,
    max_height: 720,
    max_count: 1,
  },
  square_manifest: {
    max_bytes: 256 * kib,
    content_types: ['application/json'],
    max_count: 1,
    // 薪火文章单篇最多 100 张图片（含首图）+ 10 个视频。
    max_items: 110,
  },
  square_image_freedom: {
    max_bytes: 1_000_000,
    content_types: ['image/webp'],
    max_width: 1280,
    max_height: 1280,
  },
  square_image_democracy: {
    max_bytes: 2_000_000,
    content_types: ['image/webp'],
    max_width: 1920,
    max_height: 1920,
  },
  square_image_spark: {
    max_bytes: 4_000_000,
    content_types: ['image/webp'],
    max_width: 2560,
    max_height: 2560,
  },
  square_image_thumbnail: {
    max_bytes: 256_000,
    content_types: ['image/webp'],
    max_width: 480,
    max_height: 480,
  },
  square_video_cover: {
    max_bytes: 512_000,
    content_types: ['image/webp'],
    max_width: 720,
    max_height: 720,
  },
  square_video_freedom: {
    max_bytes: 16_000_000,
    content_types: ['video/mp4'],
    max_seconds: 3 * 60,
    max_width: 854,
    max_height: 854,
    max_count: 1,
  },
  square_video_democracy: {
    max_bytes: 300_000_000,
    content_types: ['video/mp4'],
    max_seconds: 30 * 60,
    max_width: 1280,
    max_height: 1280,
    max_count: 1,
  },
  square_video_spark: {
    // 低于 R2 单次 PUT 约 5GiB 的上限，完整对象由 R2 校验 SHA-256。
    max_bytes: 3_000_000_000,
    content_types: ['video/mp4'],
    max_seconds: 3 * 60 * 60,
    max_width: 1920,
    max_height: 1920,
    max_count: 1,
  },
  chat_server_access: { max_bytes: 4 * kib },
  push_endpoint: { max_bytes: 16 * kib, max_count: 8, ttl_seconds: 90 * 24 * 60 * 60 },
  push_notification: { max_bytes: 4 * kib },
  chain_extrinsic: { max_bytes: 64 * kib },
  chain_extrinsic_json: { max_bytes: 132 * kib },
  chain_rpc_response: { max_bytes: 4 * mib },
  session_cache: { max_bytes: 4 * kib, max_count: 1 },
  session_index: { max_bytes: 4 * kib, max_count: 8 },
  // 单条联系人只包含小型端到端密文；限制整个 JSON 请求，防止借同步接口写入大对象。
  contact_ciphertext: { max_bytes: 16 * kib, max_items: 100 },
  api_json_small: { max_bytes: 16 * kib },
  api_json: { max_bytes: 128 * kib },
};

export interface UsageLimit {
  monthly_images: number;
  monthly_video_seconds: number;
  active_uploads: number;
  storage_bytes: number;
}

export const usageLimits: Readonly<Record<MembershipLevel, UsageLimit>> = {
  freedom: {
    monthly_images: 300,
    monthly_video_seconds: 300 * 60,
    active_uploads: 1,
    storage_bytes: 100_000_000_000,
  },
  democracy: {
    monthly_images: 1500,
    monthly_video_seconds: 1000 * 60,
    active_uploads: 2,
    storage_bytes: 1_000_000_000_000,
  },
  spark: {
    monthly_images: 5000,
    monthly_video_seconds: 10_000 * 60,
    active_uploads: 3,
    storage_bytes: 10_000_000_000_000,
  },
};

export function resourceLimit(key: ResourceKey): ResourceLimit {
  return resourceLimits[key];
}

export function imageResource(level: MembershipLevel): ResourceKey {
  if (level === 'spark') return 'square_image_spark';
  return level === 'democracy' ? 'square_image_democracy' : 'square_image_freedom';
}

export function videoResource(level: MembershipLevel): ResourceKey {
  if (level === 'spark') return 'square_video_spark';
  return level === 'freedom' ? 'square_video_freedom' : 'square_video_democracy';
}

interface RouteLimit {
  method: string;
  path: RegExp;
  resource_key: ResourceKey;
}

const route = (method: string, path: RegExp, resource_key: ResourceKey = 'api_json_small'): RouteLimit => ({
  method,
  path,
  resource_key,
});

/** 已登记路由是 Worker 进入风控和 D1 前的白名单。 */
const routeLimits: readonly RouteLimit[] = [
  route('GET', /^\/health$/),
  route('GET', /^\/download\/(?:citizenapp\/android|citizenwallet\/android|citizenchain\/(?:macOS(?:\/updater)?|Windows|LinuxARM|LinuxAMD))$/),
  route('GET', /^\/operations\/citizenchain\/download-publications\/(?:linux-arm|linux-amd|macos|windows)$/),
  route('PUT', /^\/operations\/citizenchain\/download-publications\/(?:linux-arm|linux-amd|macos|windows)$/),
  route('GET', /^\/chain\/bootstrap$/),
  route('GET', /^\/chain\/citizensdk\/bootstrap$/),
  route('GET', /^\/constitution$/),
  route('GET', /^\/security\/(turnstile|config)$/),
  route('POST', /^\/chain\/extrinsics\/relay$/, 'chain_extrinsic_json'),
  route('POST', /^\/square\/auth\/(challenge|session)$/),
  route('POST', /^\/square\/auth\/device\/register$/),
  route('POST', /^\/auth\/chatserver\/access$/, 'chat_server_access'),
  route('GET', /^\/square\/membership$/),
  route('POST', /^\/square\/membership\/confirm$/),
  route('POST', /^\/square\/users\/confirm$/),
  route('GET', /^\/square\/topup\/config$/),
  route('POST', /^\/square\/topup\/intent$/),
  route('POST', /^\/square\/topup\/confirm$/),
  route('POST', /^\/square\/topup\/status$/),
  route('GET', /^\/square\/topup\/settlement\/pending$/),
  route('GET', /^\/square\/topup\/settlement\/history$/),
  route('POST', /^\/square\/topup\/settlement\/[^/]+\/(claim|settled|exception)$/),
  route('GET', /^\/square\/creator\/(plan|overview)$/),
  route('GET', /^\/square\/creator\/plan\/[^/]+$/),
  route('POST', /^\/square\/creator\/plan$/, 'api_json'),
  route('POST', /^\/square\/creator\/subscription\/confirm$/),
  route('GET', /^\/square\/contacts$/),
  route('PUT', /^\/square\/contacts\/[^/]+$/, 'contact_ciphertext'),
  route('DELETE', /^\/square\/contacts\/[^/]+$/),
  route('POST', /^\/square\/uploads\/prepare$/, 'api_json'),
  route('PUT', /^\/square\/uploads\/manifest$/, 'square_manifest'),
  route('POST', /^\/square\/uploads\/complete$/),
  route('DELETE', /^\/square\/uploads\/[^/]+$/),
  route('POST', /^\/square\/posts\/confirm$/),
  route('GET', /^\/square\/posts\/self$/),
  route('GET', /^\/square\/posts\/[^/]+$/),
  route('DELETE', /^\/square\/posts\/[^/]+$/),
  route('GET', /^\/square\/media\/.+$/),
  route('GET', /^\/square\/feed\/(recommended|following|campaign)$/),
  route('PUT', /^\/square\/profile$/),
  route('POST', /^\/square\/profile\/assets\/prepare$/),
  route('PUT', /^\/square\/profile\/assets$/, 'profile_banner'),
  route('GET', /^\/square\/users\/[^/]+(?:\/(posts|follows))?$/),
  route('POST', /^\/square\/follows$/),
  route('PUT', /^\/square\/follows\/[^/]+\/notify$/),
  route('DELETE', /^\/square\/follows\/[^/]+$/),
  route('GET', /^\/square\/notify\/unread$/),
  route('POST', /^\/square\/notify\/read$/),
  route('PUT', /^\/square\/push-endpoint$/, 'push_endpoint'),
];

export function routeResource(method: string, path: string): ResourceKey | null {
  const normalizedMethod = method.toUpperCase();
  const match = routeLimits.find((item) =>
    (normalizedMethod === 'OPTIONS' || item.method === normalizedMethod) && item.path.test(path));
  return match?.resource_key ?? null;
}
