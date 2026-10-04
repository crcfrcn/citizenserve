import type { Env } from '../types';
import { HttpError } from '../shared/http';
import { LimitTicket } from './upload';
import { validateUploadBytes } from './upload';
import type { ResourceKey } from './catalog';

/** 所有 Worker 主动写 R2 的用户资源都必须持有统一校验签发的限制凭证。 */
export async function putR2Object(
  env: Env,
  objectKey: string,
  bytes: Uint8Array,
  ticket: LimitTicket,
): Promise<void> {
  ticket.assertValid();
  if (bytes.byteLength !== ticket.byte_size) {
    throw new HttpError(500, 'limit_ticket_size_mismatch', '资源写入大小与限制凭证不一致');
  }
  await env.SQUARE_PRIVATE.put(objectKey, bytes, {
    httpMetadata: { contentType: ticket.content_type },
    customMetadata: {
      content_hash: ticket.content_hash,
      resource_key: ticket.resource_key,
    },
  });
}

export async function putKvJson(
  env: Env,
  key: string,
  value: unknown,
  resourceKey: ResourceKey,
  options?: KVNamespacePutOptions,
): Promise<void> {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  await validateUploadBytes({
    resource_key: resourceKey,
    bytes,
    content_type: 'application/json',
  });
  await env.SQUARE_CACHE.put(key, text, options);
}
