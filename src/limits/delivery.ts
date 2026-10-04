import type { Env } from '../types';
import { HttpError, parsePositiveInt } from '../shared/http';
import { resourceLimit, type ResourceKey } from './catalog';

export function deliveryTtl(env: Env): number {
  return Math.min(parsePositiveInt(env.MEDIA_TTL_SECONDS, 300), 300);
}

/** 推送、内部 RPC 等出站载荷在 fetch 前也必须经过统一字节上限。 */
export function assertDeliverySize(resourceKey: ResourceKey, value: string): void {
  if (new TextEncoder().encode(value).byteLength > resourceLimit(resourceKey).max_bytes) {
    throw new HttpError(413, 'delivery_too_large', '出站数据超过服务端上限');
  }
}

