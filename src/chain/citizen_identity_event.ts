import { assertAccountId, assertCidNumber } from '../shared/ids';
import { bytesToHex, hexToBytes } from '../shared/signing_message';

// CitizenIdentity 是 runtime 官方 pallet index 10；事件索引严格按当前 Event 声明顺序。
const CITIZEN_IDENTITY_PALLET_INDEX = 10;

export type CitizenIdentityEventName =
  | 'VotingIdentityRegistered'
  | 'VotingIdentityUpdated'
  | 'CandidateIdentityUpgraded'
  | 'CandidateIdentityUpdated'
  | 'CitizenIdentityRevoked'
  | 'CidOccupied'
  | 'CidSelfOccupied'
  | 'CidAccountIdRebound'
  | 'CidRevoked';

export interface CitizenIdentityEvent {
  event_name: CitizenIdentityEventName;
  cid_number: string;
  binding_revision: number | null;
  account_id: string | null;
  previous_account_id: string | null;
  new_account_id: string | null;
  registrar_cid_number: string | null;
  extrinsic_index: number | null;
  record_offset: number;
}

interface DecodedPayload extends Omit<CitizenIdentityEvent, 'extrinsic_index' | 'record_offset'> {
  next_offset: number;
}

/// 从 System.Events 中发现 CitizenIdentity 生命周期事件。
/// 事件只负责发现候选 CID；投影器随后必须在同一区块复核全部 storage，不能直接信任载荷。
export function decodeCitizenIdentityEvents(eventsHex: string): CitizenIdentityEvent[] {
  const data = hexToBytes(eventsHex);
  if (data.length === 0) return [];
  const [eventCount, countSize] = readCompactU32(data, 0);
  if (eventCount === 0) return [];
  const events: CitizenIdentityEvent[] = [];

  for (let recordOffset = countSize; recordOffset < data.length; recordOffset += 1) {
    try {
      let offset = recordOffset;
      const phase = data[offset];
      offset += 1;
      let extrinsicIndex: number | null = null;
      if (phase === 0) {
        extrinsicIndex = readU32Le(data, offset);
        offset += 4;
      } else if (phase !== 1 && phase !== 2) {
        continue;
      }
      if (offset + 2 > data.length || data[offset] !== CITIZEN_IDENTITY_PALLET_INDEX) {
        continue;
      }
      const eventIndex = data[offset + 1];
      offset += 2;
      const payload = decodePayload(data, offset, eventIndex);
      if (!payload || !hasValidTopics(data, payload.next_offset)) continue;
      const { next_offset: _nextOffset, ...event } = payload;
      events.push({
        ...event,
        extrinsic_index: extrinsicIndex,
        record_offset: recordOffset,
      });
    } catch {
      // System.Events 混有其它 pallet 的不同长度载荷；候选失败后继续扫描。
    }
  }
  return dedupe(events).sort((left, right) => left.record_offset - right.record_offset);
}

function decodePayload(
  data: Uint8Array,
  offset: number,
  eventIndex: number,
): DecodedPayload | null {
  switch (eventIndex) {
    case 0:
      return identityAccountEvent(data, offset, 'VotingIdentityRegistered');
    case 1:
      return identityAccountEvent(data, offset, 'VotingIdentityUpdated');
    case 2:
      return identityAccountEvent(data, offset, 'CandidateIdentityUpgraded');
    case 3:
      return identityAccountEvent(data, offset, 'CandidateIdentityUpdated');
    case 4:
      return identityAccountEvent(data, offset, 'CitizenIdentityRevoked', true);
    case 5:
      return cidOccupiedEvent(data, offset);
    case 6:
      return cidSelfOccupiedEvent(data, offset);
    case 7:
      return cidAccountIdReboundEvent(data, offset);
    case 8:
      return cidRevokedEvent(data, offset);
    default:
      return null;
  }
}

function identityAccountEvent(
  data: Uint8Array,
  offset: number,
  eventName: CitizenIdentityEventName,
  hasRevision = false,
): DecodedPayload {
  const account = readAccountId(data, offset);
  const cid = readCidNumber(data, account.next_offset);
  const revision = hasRevision ? readU64Le(data, cid.next_offset) : null;
  return basePayload({
    eventName,
    cidNumber: cid.value,
    accountId: account.value,
    bindingRevision: revision,
    nextOffset: cid.next_offset + (hasRevision ? 8 : 0),
  });
}

function cidOccupiedEvent(data: Uint8Array, offset: number): DecodedPayload {
  const cid = readCidNumber(data, offset);
  const registrar = readCidNumber(data, cid.next_offset);
  const revision = readU64Le(data, registrar.next_offset);
  return basePayload({
    eventName: 'CidOccupied',
    cidNumber: cid.value,
    registrarCidNumber: registrar.value,
    bindingRevision: revision,
    nextOffset: registrar.next_offset + 8,
  });
}

function cidSelfOccupiedEvent(data: Uint8Array, offset: number): DecodedPayload {
  const cid = readCidNumber(data, offset);
  const account = readAccountId(data, cid.next_offset);
  const revision = readU64Le(data, account.next_offset);
  return basePayload({
    eventName: 'CidSelfOccupied',
    cidNumber: cid.value,
    accountId: account.value,
    bindingRevision: revision,
    nextOffset: account.next_offset + 8,
  });
}

function cidAccountIdReboundEvent(data: Uint8Array, offset: number): DecodedPayload {
  const cid = readCidNumber(data, offset);
  const previous = readAccountId(data, cid.next_offset);
  const next = readAccountId(data, previous.next_offset);
  const revision = readU64Le(data, next.next_offset);
  return basePayload({
    eventName: 'CidAccountIdRebound',
    cidNumber: cid.value,
    previousAccountId: previous.value,
    newAccountId: next.value,
    bindingRevision: revision,
    nextOffset: next.next_offset + 8,
  });
}

function cidRevokedEvent(data: Uint8Array, offset: number): DecodedPayload {
  const cid = readCidNumber(data, offset);
  const revision = readU64Le(data, cid.next_offset);
  return basePayload({
    eventName: 'CidRevoked',
    cidNumber: cid.value,
    bindingRevision: revision,
    nextOffset: cid.next_offset + 8,
  });
}

function basePayload(input: {
  eventName: CitizenIdentityEventName;
  cidNumber: string;
  bindingRevision?: number | null;
  accountId?: string | null;
  previousAccountId?: string | null;
  newAccountId?: string | null;
  registrarCidNumber?: string | null;
  nextOffset: number;
}): DecodedPayload {
  return {
    event_name: input.eventName,
    cid_number: input.cidNumber,
    binding_revision: input.bindingRevision ?? null,
    account_id: input.accountId ?? null,
    previous_account_id: input.previousAccountId ?? null,
    new_account_id: input.newAccountId ?? null,
    registrar_cid_number: input.registrarCidNumber ?? null,
    next_offset: input.nextOffset,
  };
}

function readCidNumber(
  data: Uint8Array,
  offset: number,
): { value: string; next_offset: number } {
  const bytes = readCompactBytes(data, offset, 32);
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value);
  return { value: assertCidNumber(value), next_offset: bytes.next_offset };
}

function readAccountId(
  data: Uint8Array,
  offset: number,
): { value: string; next_offset: number } {
  if (offset + 32 > data.length) throw new RangeError('AccountId event payload is truncated');
  const value = assertAccountId(`0x${bytesToHex(data.slice(offset, offset + 32))}`);
  return { value, next_offset: offset + 32 };
}

function readCompactBytes(
  data: Uint8Array,
  offset: number,
  maxLength: number,
): { value: Uint8Array; next_offset: number } {
  const [length, size] = readCompactU32(data, offset);
  const start = offset + size;
  const end = start + length;
  if (length === 0 || length > maxLength || end > data.length) {
    throw new RangeError('bounded event bytes are invalid');
  }
  return { value: data.slice(start, end), next_offset: end };
}

function hasValidTopics(data: Uint8Array, offset: number): boolean {
  try {
    const [count, size] = readCompactU32(data, offset);
    return offset + size + count * 32 <= data.length;
  } catch {
    return false;
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
      (first >> 2)
        | (data[offset + 1] << 6)
        | (data[offset + 2] << 14)
        | (data[offset + 3] << 22),
      4,
    ];
  }
  throw new RangeError('compact big integer mode is unsupported');
}

function readU32Le(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) throw new RangeError('u32 event field is truncated');
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function readU64Le(data: Uint8Array, offset: number): number {
  if (offset + 8 > data.length) throw new RangeError('u64 event field is truncated');
  const value = new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
  if (value === 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('binding_revision event field is invalid');
  }
  return Number(value);
}

function dedupe(events: CitizenIdentityEvent[]): CitizenIdentityEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.record_offset}:${event.event_name}:${event.cid_number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
