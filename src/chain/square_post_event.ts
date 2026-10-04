import { assertCidNumber } from '../shared/ids';
import { hexToBytes } from '../shared/signing_message';

// SquarePost 是 runtime 官方 pallet index 34；事件索引严格按当前 Event 声明顺序。
const SQUARE_POST_PALLET_INDEX = 34;

export type SquarePostSubscriptionEventName =
  | 'SubscriptionCharged'
  | 'SubscriptionResumed'
  | 'SubscriptionSuspended'
  | 'SubscriptionReconsented'
  | 'SubscriptionIssuerPaused'
  | 'SubscriptionRenewalStopped'
  | 'SubscriptionCancelled'
  | 'SubscriptionPlanChanged'
  | 'CreatorPlansSet'
  | 'CreatorTierNameUpdated';

export interface SquarePostSubscriptionEvent {
  event_name: SquarePostSubscriptionEventName;
  subscriber_cid_number: string | null;
  issuer_kind: 'platform' | 'creator' | null;
  creator_cid_number: string | null;
  extrinsic_index: number | null;
  record_offset: number;
}

interface DecodedPayload
  extends Omit<SquarePostSubscriptionEvent, 'extrinsic_index' | 'record_offset'> {
  next_offset: number;
}

/**
 * 从 System.Events 发现订阅关系候选。事件载荷只用于定位关系；投影器必须在同一
 * finalized 区块重新读取 subscription/creator-plan storage，禁止把事件载荷当状态真源。
 */
export function decodeSquarePostSubscriptionEvents(
  eventsHex: string,
): SquarePostSubscriptionEvent[] {
  const data = hexToBytes(eventsHex);
  if (data.length === 0) return [];
  const [eventCount, countSize] = readCompactU32(data, 0);
  if (eventCount === 0) return [];
  const events: SquarePostSubscriptionEvent[] = [];

  for (let recordOffset = countSize; recordOffset < data.length; recordOffset += 1) {
    try {
      let offset = recordOffset;
      const phase = data[offset++];
      let extrinsicIndex: number | null = null;
      if (phase === 0) {
        extrinsicIndex = readU32Le(data, offset);
        offset += 4;
      } else if (phase !== 1 && phase !== 2) {
        continue;
      }
      if (offset + 2 > data.length || data[offset] !== SQUARE_POST_PALLET_INDEX) {
        continue;
      }
      const eventIndex = data[offset + 1];
      const payload = decodePayload(data, offset + 2, eventIndex);
      if (!payload) continue;
      const recordEnd = readTopicsEnd(data, payload.next_offset);
      if (recordEnd === null) continue;
      const { next_offset: _nextOffset, ...event } = payload;
      events.push({ ...event, extrinsic_index: extrinsicIndex, record_offset: recordOffset });
      // 已确认的 EventRecord 载荷内部可能出现类似 phase/pallet/event 的字节；整条跳过。
      recordOffset = recordEnd - 1;
    } catch {
      // System.Events 混有其它 pallet 的可变长度载荷；候选失败后继续逐字节扫描。
    }
  }
  return dedupe(events).sort((left, right) => left.record_offset - right.record_offset);
}

function decodePayload(data: Uint8Array, offset: number, eventIndex: number): DecodedPayload | null {
  if (eventIndex === 9 || eventIndex === 10) {
    const creator = readCidNumber(data, offset);
    let nextOffset = creator.next_offset + 32;
    if (eventIndex === 9) nextOffset += 4;
    else nextOffset = readCompactBytes(data, nextOffset, 32).next_offset;
    return {
      event_name: eventIndex === 9 ? 'CreatorPlansSet' : 'CreatorTierNameUpdated',
      subscriber_cid_number: null,
      issuer_kind: null,
      creator_cid_number: creator.value,
      next_offset: nextOffset,
    };
  }
  if (eventIndex < 1 || eventIndex > 8) return null;

  const subscriber = readCidNumber(data, offset);
  let nextOffset = subscriber.next_offset;
  if (eventIndex === 1 || eventIndex === 8) nextOffset += 32;
  const issuer = readIssuer(data, nextOffset);
  nextOffset = issuer.next_offset;
  switch (eventIndex) {
    case 1:
      nextOffset = skipPlan(data, nextOffset) + 16 + 8 + 8;
      break;
    case 2:
      nextOffset += 8;
      break;
    case 3:
      nextOffset += 1 + 8;
      break;
    case 4:
      nextOffset += 16;
      break;
    case 5:
    case 6:
    case 7:
      nextOffset += 8;
      break;
    case 8:
      nextOffset = skipPlan(data, nextOffset) + 16 + 8;
      break;
  }
  if (nextOffset > data.length) throw new RangeError('SquarePost event payload is truncated');
  const names: Record<number, SquarePostSubscriptionEventName> = {
    1: 'SubscriptionCharged',
    2: 'SubscriptionResumed',
    3: 'SubscriptionSuspended',
    4: 'SubscriptionReconsented',
    5: 'SubscriptionIssuerPaused',
    6: 'SubscriptionRenewalStopped',
    7: 'SubscriptionCancelled',
    8: 'SubscriptionPlanChanged',
  };
  return {
    event_name: names[eventIndex],
    subscriber_cid_number: subscriber.value,
    issuer_kind: issuer.kind,
    creator_cid_number: issuer.creator_cid_number,
    next_offset: nextOffset,
  };
}

function readIssuer(data: Uint8Array, offset: number): {
  kind: 'platform' | 'creator';
  creator_cid_number: string | null;
  next_offset: number;
} {
  const tag = data[offset++];
  if (tag === 0) return { kind: 'platform', creator_cid_number: null, next_offset: offset };
  if (tag !== 1) throw new RangeError('SquarePost issuer is invalid');
  const creator = readCidNumber(data, offset);
  return { kind: 'creator', creator_cid_number: creator.value, next_offset: creator.next_offset };
}

function skipPlan(data: Uint8Array, offset: number): number {
  const tag = data[offset++];
  if (tag === 0) {
    if (offset >= data.length) throw new RangeError('platform plan is truncated');
    return offset + 1;
  }
  if (tag !== 1) throw new RangeError('SquarePost plan is invalid');
  const tier = readCompactBytes(data, offset, 32);
  if (tier.next_offset >= data.length) throw new RangeError('creator plan is truncated');
  return tier.next_offset + 1;
}

function readCidNumber(data: Uint8Array, offset: number): { value: string; next_offset: number } {
  const bytes = readCompactBytes(data, offset, 32);
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value);
  return { value: assertCidNumber(value), next_offset: bytes.next_offset };
}

function readCompactBytes(data: Uint8Array, offset: number, maxLength: number): {
  value: Uint8Array;
  next_offset: number;
} {
  const [length, size] = readCompactU32(data, offset);
  const start = offset + size;
  const end = start + length;
  if (length === 0 || length > maxLength || end > data.length) {
    throw new RangeError('bounded event bytes are invalid');
  }
  return { value: data.slice(start, end), next_offset: end };
}

function readTopicsEnd(data: Uint8Array, offset: number): number | null {
  try {
    const [count, size] = readCompactU32(data, offset);
    const end = offset + size + count * 32;
    return end <= data.length ? end : null;
  } catch {
    return null;
  }
}

function readCompactU32(data: Uint8Array, offset: number): [number, number] {
  if (offset >= data.length) throw new RangeError('compact value is missing');
  const first = data[offset];
  const mode = first & 3;
  if (mode === 0) return [first >> 2, 1];
  if (mode === 1) {
    if (offset + 1 >= data.length) throw new RangeError('compact value is truncated');
    return [(first >> 2) | (data[offset + 1] << 6), 2];
  }
  if (mode === 2) {
    if (offset + 3 >= data.length) throw new RangeError('compact value is truncated');
    return [
      (first >> 2) | (data[offset + 1] << 6) | (data[offset + 2] << 14) | (data[offset + 3] << 22),
      4,
    ];
  }
  throw new RangeError('compact big integer mode is unsupported');
}

function readU32Le(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) throw new RangeError('u32 event field is truncated');
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function dedupe(events: SquarePostSubscriptionEvent[]): SquarePostSubscriptionEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.record_offset}:${event.event_name}:${event.subscriber_cid_number ?? ''}:${event.creator_cid_number ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
