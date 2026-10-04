import { scaleString, scaleCompact, bytesToHex, hexToBytes } from '../shared/signing_message';
import type { PostCategory, PostType } from '../types';

// 与统一协议 P-CHAIN-SQUARE-001 固定索引一致；发布确认只接受该 pallet 事件。
const squarePostPalletIndex = 34;
const squarePostPublishedEventIndex = 0;
export interface SquarePostPublishedEvent {
  post_id: string;
  account_id: string;
  cid_number: string;
  post_type: PostType;
  post_category: PostCategory;
  content_hash: string;
  storage_receipt_id: string;
  storage_until: number;
  created_block: number;
  extrinsic_index: number | null;
}

export function decodeSquarePostPublishedEvents(eventsHex: string): SquarePostPublishedEvent[] {
  const data = hexToBytes(eventsHex);
  if (data.length === 0) return [];
  const [, countSize] = readCompactU32(data, 0);
  const events: SquarePostPublishedEvent[] = [];

  for (let scanOffset = countSize; scanOffset < data.length; scanOffset += 1) {
    try {
      let offset = scanOffset;
      const phase = data[offset];
      offset += 1;
      let extrinsicIndex: number | null = null;
      if (phase === 0x00) {
        if (offset + 4 > data.length) continue;
        extrinsicIndex = readU32Le(data, offset);
        offset += 4;
      } else if (phase !== 0x01 && phase !== 0x02) {
        continue;
      }

      if (offset + 2 > data.length) continue;
      const palletIndex = data[offset];
      const eventIndex = data[offset + 1];
      offset += 2;
      if (palletIndex !== squarePostPalletIndex || eventIndex !== squarePostPublishedEventIndex) {
        continue;
      }

      const decoded = decodeSquarePostPublishedEventPayload(data, offset);
      if (decoded) {
        events.push({ ...decoded, extrinsic_index: extrinsicIndex });
      }
    } catch {
      // System.Events 中混有大量其它 pallet 事件，扫描失败继续尝试下一个 offset。
    }
  }

  return dedupeByPostId(events);
}

export function decodeSquarePostPublishedEventPayload(
  data: Uint8Array,
  offset: number
): Omit<SquarePostPublishedEvent, 'extrinsic_index'> | null {
  let cursor = offset;
  const postId = readCompactBytes(data, cursor);
  cursor = postId.nextOffset;

  const cid = readCompactBytes(data, cursor);
  cursor = cid.nextOffset;
  const cidNumber = utf8(cid.value);
  if (cidNumber.length === 0) return null;

  if (cursor + 32 > data.length) return null;
  const accountIdBytes = data.slice(cursor, cursor + 32);
  cursor += 32;

  if (cursor + 2 + 32 > data.length) return null;
  const postTypeByte = data[cursor];
  cursor += 1;
  if (postTypeByte > 2) return null;
  const postType: PostType = postTypeByte === 0 ? 'document' : postTypeByte === 1 ? 'article' : 'video';
  const categoryByte = data[cursor];
  cursor += 1;
  if (categoryByte !== 0 && categoryByte !== 1) return null;
  const postCategory: PostCategory = categoryByte === 0 ? 'normal' : 'campaign';

  const contentHash = `0x${bytesToHex(data.slice(cursor, cursor + 32))}`;
  cursor += 32;
  const receipt = readCompactBytes(data, cursor);
  cursor = receipt.nextOffset;
  if (cursor + 8 + 4 > data.length) return null;
  const storageUntil = readU64Le(data, cursor);
  cursor += 8;
  const createdBlock = readU32Le(data, cursor);

  return {
    post_id: utf8(postId.value),
    account_id: `0x${bytesToHex(accountIdBytes)}`,
    cid_number: cidNumber,
    post_type: postType,
    post_category: postCategory,
    content_hash: contentHash,
    storage_receipt_id: utf8(receipt.value),
    storage_until: storageUntil,
    created_block: createdBlock
  };
}

export function u32Le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function u64Le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function dedupeByPostId(events: SquarePostPublishedEvent[]): SquarePostPublishedEvent[] {
  const seen = new Set<string>();
  const deduped: SquarePostPublishedEvent[] = [];
  for (const event of events) {
    if (seen.has(event.post_id)) continue;
    seen.add(event.post_id);
    deduped.push(event);
  }
  return deduped;
}

function readCompactBytes(data: Uint8Array, offset: number): { value: Uint8Array; nextOffset: number } {
  const [length, lengthSize] = readCompactU32(data, offset);
  const start = offset + lengthSize;
  const end = start + length;
  if (end > data.length) {
    throw new Error('compact bytes out of range');
  }
  return {
    value: data.slice(start, end),
    nextOffset: end
  };
}

function readCompactU32(data: Uint8Array, offset: number): [number, number] {
  if (offset >= data.length) throw new Error('compact offset out of range');
  const first = data[offset];
  const mode = first & 0x03;
  if (mode === 0) return [first >> 2, 1];
  if (mode === 1) {
    if (offset + 1 >= data.length) throw new Error('compact mode1 out of range');
    return [(first >> 2) | (data[offset + 1] << 6), 2];
  }
  if (mode === 2) {
    if (offset + 3 >= data.length) throw new Error('compact mode2 out of range');
    return [
      (first >> 2) |
        (data[offset + 1] << 6) |
        (data[offset + 2] << 14) |
        (data[offset + 3] << 22),
      4
    ];
  }
  throw new Error('compact big integer mode is not supported');
}

function readU32Le(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function readU64Le(data: Uint8Array, offset: number): number {
  const value = new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('u64 exceeds safe integer range');
  }
  return Number(value);
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
