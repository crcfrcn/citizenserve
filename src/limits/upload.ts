import { HttpError } from '../shared/http';
import { sha256Hex } from '../shared/hash';
import { resourceLimit, type ResourceKey } from './catalog';

export class LimitTicket {
  private readonly marker = 'citizenapp_limit_ticket';

  private constructor(
    readonly resource_key: ResourceKey,
    readonly byte_size: number,
    readonly content_type: string,
    readonly content_hash: string,
    readonly width: number | null,
    readonly height: number | null,
  ) {}

  private static issue(input: {
    resource_key: ResourceKey;
    byte_size: number;
    content_type: string;
    content_hash: string;
    width?: number | null;
    height?: number | null;
  }): LimitTicket {
    const ticket = new LimitTicket(
      input.resource_key,
      input.byte_size,
      input.content_type,
      input.content_hash,
      input.width ?? null,
      input.height ?? null,
    );
    Object.freeze(ticket);
    return ticket;
  }

  static async validate(input: {
    resource_key: ResourceKey;
    bytes: Uint8Array;
    content_type: string;
    expected_bytes?: number;
    expected_hash?: string;
  }): Promise<LimitTicket> {
    const contentType = input.content_type.split(';', 1)[0]!.trim().toLowerCase();
    const limit = resourceLimit(input.resource_key);
    if (input.bytes.byteLength <= 0 || input.bytes.byteLength > limit.max_bytes) {
      throw new HttpError(413, 'resource_too_large', '资源文件超过服务端上限');
    }
    if (input.expected_bytes !== undefined && input.expected_bytes !== input.bytes.byteLength) {
      throw new HttpError(409, 'resource_size_mismatch', '资源实际大小与申报不一致');
    }
    if (limit.content_types && !limit.content_types.includes(contentType)) {
      throw new HttpError(415, 'resource_content_type_invalid', '资源文件类型不受支持');
    }

    const contentHash = await sha256Hex(input.bytes);
    if (input.expected_hash && contentHash !== input.expected_hash.toLowerCase()) {
      throw new HttpError(409, 'resource_hash_mismatch', '资源内容哈希与申报不一致');
    }

    let width: number | null = null;
    let height: number | null = null;
    if (contentType.startsWith('image/')) {
      const size = imageSize(input.bytes, contentType);
      width = size.width;
      height = size.height;
      if ((limit.max_width && width > limit.max_width) || (limit.max_height && height > limit.max_height)) {
        throw new HttpError(413, 'image_dimensions_exceeded', '图片尺寸超过服务端上限');
      }
    }

    return LimitTicket.issue({
      resource_key: input.resource_key,
      byte_size: input.bytes.byteLength,
      content_type: contentType,
      content_hash: contentHash,
      width,
      height,
    });
  }

  assertValid(): void {
    if (this.marker !== 'citizenapp_limit_ticket') {
      throw new HttpError(500, 'limit_ticket_invalid', '资源限制凭证不合法');
    }
  }
}

export async function validateUploadBytes(input: {
  resource_key: ResourceKey;
  bytes: Uint8Array;
  content_type: string;
  expected_bytes?: number;
  expected_hash?: string;
}): Promise<LimitTicket> {
  return LimitTicket.validate(input);
}

export function assertDeclaredResource(input: {
  resource_key: ResourceKey;
  byte_size: number;
  content_type: string;
  duration_seconds?: number;
}): void {
  const limit = resourceLimit(input.resource_key);
  const contentType = input.content_type.trim().toLowerCase();
  if (!Number.isSafeInteger(input.byte_size) || input.byte_size <= 0 || input.byte_size > limit.max_bytes) {
    throw new HttpError(400, 'resource_size_invalid', '资源申报大小超过服务端上限');
  }
  if (limit.content_types && !limit.content_types.includes(contentType)) {
    throw new HttpError(415, 'resource_content_type_invalid', '资源文件类型不受支持');
  }
  if (limit.max_seconds !== undefined &&
      (!Number.isFinite(input.duration_seconds) || input.duration_seconds! <= 0 || input.duration_seconds! > limit.max_seconds)) {
    throw new HttpError(400, 'resource_duration_invalid', '资源时长超过服务端上限');
  }
}

function imageSize(bytes: Uint8Array, contentType: string): { width: number; height: number } {
  const size = contentType === 'image/png'
    ? pngSize(bytes)
    : contentType === 'image/jpeg'
      ? jpegSize(bytes)
      : webpSize(bytes);
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new HttpError(415, 'image_header_invalid', '图片文件头与类型不匹配');
  }
  return size;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    return { width: readUint24(bytes, 24) + 1, height: readUint24(bytes, 27) + 1 };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: (bytes[26]! | bytes[27]! << 8) & 0x3fff, height: (bytes[28]! | bytes[29]! << 8) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes[21]! | bytes[22]! << 8 | bytes[23]! << 16 | bytes[24]! << 24;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
}
