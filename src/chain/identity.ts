import { bytesToHex, hexToBytes } from "../shared/signing_message";
import type { Env, IdentityLevel } from "../types";
import { decodeAccountId, storageMapKey } from "./storage_key";
import { nowMs } from "../shared/time";
import { assertCidNumber } from "../shared/ids";
import { fetchChainStorage, fetchChainStorageBatch, fetchFinalizedHead } from "./rpc";

export interface ChainIdentityState {
  account_id: string;
  binding_revision: number;
  identity_level: IdentityLevel;
  has_voting_identity: boolean;
  has_candidate_identity: boolean;
  cid_number: string | null;
  checked_at: number;
}

interface VotingIdentity {
  passport_valid_from: number;
  passport_valid_until: number;
  citizen_status: "normal" | "revoked";
}

interface CandidateIdentity {
  birth_date: number;
}

export interface ChainCidProjectionState {
  cid_number: string;
  cid_record_status: "Active" | "Revoked";
  account_id: string | null;
  binding_revision: number;
  identity_level: IdentityLevel;
  registered_block_number: number;
  revoked_block_number: number | null;
}

function visitorIdentityState(accountId: string): ChainIdentityState {
  return {
    account_id: accountId,
    binding_revision: 0,
    identity_level: "visitor",
    has_voting_identity: false,
    has_candidate_identity: false,
    cid_number: null,
    checked_at: nowMs(),
  };
}

/// 未绑定/无有效身份的身份主键 cid_number 的默认态(account_id 空)。
function visitorIdentityStateByCid(cidNumber: string): ChainIdentityState {
  return {
    account_id: "",
    binding_revision: 0,
    identity_level: "visitor",
    has_voting_identity: false,
    has_candidate_identity: false,
    cid_number: cidNumber,
    checked_at: nowMs(),
  };
}

/// 按身份主键 cid_number 读取链上身份态(锚定同一 finalized 区块):
/// AccountIdByCid → 当前绑定钱包账户 account_id;CidRegistry active 校验;投票/竞选公开字段。
/// 未绑定或 CidRegistry 非 active → 返回 null(由调用方决定降级形态)。
async function readChainIdentityByCid(
  env: Env,
  cidNumber: string,
  finalizedHead: string,
): Promise<ChainIdentityState | null> {
  const cidScale = encodeBoundedBytes(new TextEncoder().encode(cidNumber));
  const walletByCidKey = storageMapKey("CitizenIdentity", "AccountIdByCid", cidScale);
  const cidRegistryKey = storageMapKey("CitizenIdentity", "CidRegistry", cidScale);
  const votingKey = storageMapKey("CitizenIdentity", "VotingIdentityByCid", cidScale);
  const candidateKey = storageMapKey("CitizenIdentity", "CandidateIdentityByCid", cidScale);
  const bindingRevisionKey = storageMapKey(
    "CitizenIdentity",
    "BindingRevisionByCid",
    cidScale,
  );
  const [walletHex, cidRecordHex, votingHex, candidateHex, bindingRevisionHex] = await Promise.all([
    fetchChainStorage(env, `0x${bytesToHex(walletByCidKey)}`, finalizedHead),
    fetchChainStorage(env, `0x${bytesToHex(cidRegistryKey)}`, finalizedHead),
    fetchChainStorage(env, `0x${bytesToHex(votingKey)}`, finalizedHead),
    fetchChainStorage(env, `0x${bytesToHex(candidateKey)}`, finalizedHead),
    fetchChainStorage(env, `0x${bytesToHex(bindingRevisionKey)}`, finalizedHead),
  ]);

  const walletBinding = walletHex ? hexToBytes(walletHex) : null;
  const cidRecord = cidRecordHex ? hexToBytes(cidRecordHex) : null;
  if (!walletBinding || !cidRecordIsActive(cidRecord)) {
    return null;
  }
  const boundAccountId = `0x${bytesToHex(walletBinding)}`;
  const bindingRevision = decodeU64(bindingRevisionHex);
  if (bindingRevision <= 0) {
    return null;
  }

  const votingIdentity = votingHex ? decodeVotingIdentity(hexToBytes(votingHex)) : null;
  const hasVotingIdentity = votingIdentity ? votingIdentityIsActive(votingIdentity) : false;
  const candidateIdentity = candidateHex ? decodeCandidateIdentity(hexToBytes(candidateHex)) : null;
  const hasCandidateIdentity = hasVotingIdentity && candidateIdentity !== null;
  const identityLevel: IdentityLevel = hasCandidateIdentity
    ? "candidate"
    : hasVotingIdentity
      ? "voting"
      : "visitor";

  // cid_number 是用户唯一身份主键:只要 CidRegistry active(占即绑)就返回,匿名/投票/竞选一视同仁。
  // 投票/竞选只是该 CID 链上多几个公开字段(姓/名/出生地…),由 identity_level / has_*_identity
  // 单独表达,不决定"有没有身份"。account_id = AccountIdByCid 即当前绑定钱包账户。
  return {
    account_id: boundAccountId,
    binding_revision: bindingRevision,
    identity_level: identityLevel,
    has_voting_identity: hasVotingIdentity,
    has_candidate_identity: hasCandidateIdentity,
    cid_number: cidNumber,
    checked_at: nowMs(),
  };
}

function decodeU64(value: string | null): number {
  if (!value) return 0;
  const bytes = hexToBytes(value);
  if (bytes.length !== 8) return 0;
  let decoded = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    decoded = (decoded << 8n) | BigInt(bytes[index]);
  }
  return decoded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decoded) : 0;
}

/// 按钱包账户 account_id 读取链上身份:CidByAccountId → cid,再经 readChainIdentityByCid
/// 复核 AccountIdByCid 双向绑定(必须回指本账户),防单向映射伪造。
export async function fetchChainIdentityState(
  env: Env,
  accountId: string,
): Promise<ChainIdentityState> {
  const accountIdBytes = decodeAccountId(accountId);
  // 同一次身份判断的所有 storage 必须锚定同一个 finalized 区块，禁止混读 best head。
  const finalizedHead = await fetchFinalizedHead(env);
  const cidByWalletKey = storageMapKey("CitizenIdentity", "CidByAccountId", accountIdBytes);
  const cidHex = await fetchChainStorage(env, `0x${bytesToHex(cidByWalletKey)}`, finalizedHead);
  const cidNumber = cidHex ? decodeCidNumber(hexToBytes(cidHex)) : null;
  if (!cidNumber) return visitorIdentityState(accountId);

  const state = await readChainIdentityByCid(env, cidNumber, finalizedHead);
  // 双向绑定校验:AccountIdByCid 必须回指本账户,否则视为无效(单向映射伪造)。
  if (!state || !sameBytes(decodeAccountId(state.account_id), accountIdBytes)) {
    return visitorIdentityState(accountId);
  }
  return state;
}

/// 按 CID 读取最新 finalized 的当前双向绑定；动权或审计落库路径使用，禁止 KV 缓存。
export async function fetchChainIdentityStateByCid(
  env: Env,
  cidNumber: string,
): Promise<ChainIdentityState> {
  const finalizedHead = await fetchFinalizedHead(env);
  return (await readChainIdentityByCid(env, cidNumber, finalizedHead))
    ?? visitorIdentityStateByCid(cidNumber);
}

/// 在调用方已经验证的精确 finalized 区块读取完整 CID 生命周期投影。
/// 与普通页面读取分离：这里只供注册、换绑、身份档位变化和吊销投影使用，不走 KV。
export async function fetchChainCidProjectionStateAtBlock(
  env: Env,
  cidNumber: string,
  blockHash: string,
  chainTimestamp: number,
): Promise<ChainCidProjectionState | null> {
  const cid = assertCidNumber(cidNumber);
  return (await fetchChainCidProjectionStatesAtBlock(
    env,
    [cid],
    blockHash,
    chainTimestamp,
  )).get(cid) ?? null;
}

/** 单区块全部相关 CID 共用一次 storage batch，事件数量不再线性放大 Worker subrequest。 */
export async function fetchChainCidProjectionStatesAtBlock(
  env: Env,
  cidNumbers: readonly string[],
  blockHash: string,
  chainTimestamp: number,
): Promise<Map<string, ChainCidProjectionState | null>> {
  const cids = [...new Set(cidNumbers.map(assertCidNumber))];
  if (!Number.isSafeInteger(chainTimestamp) || chainTimestamp < 0) {
    throw new Error("finalized chain timestamp is invalid");
  }
  const keySets = cids.map((cid) => {
    const cidScale = encodeBoundedBytes(new TextEncoder().encode(cid));
    return [
      storageMapKey("CitizenIdentity", "AccountIdByCid", cidScale),
      storageMapKey("CitizenIdentity", "CidRegistry", cidScale),
      storageMapKey("CitizenIdentity", "BindingRevisionByCid", cidScale),
      storageMapKey("CitizenIdentity", "VotingIdentityByCid", cidScale),
      storageMapKey("CitizenIdentity", "CandidateIdentityByCid", cidScale),
    ];
  });
  const values = await fetchChainStorageBatch(
    env,
    keySets.flatMap((keys) => keys.map((key) => ({
      storageKeyHex: `0x${bytesToHex(key)}`,
      blockHashHex: blockHash,
    }))),
  );
  const result = new Map<string, ChainCidProjectionState | null>();
  cids.forEach((cid, index) => {
    const offset = index * 5;
    result.set(cid, decodeCidProjectionState(
      cid,
      chainTimestamp,
      values[offset] ?? null,
      values[offset + 1] ?? null,
      values[offset + 2] ?? null,
      values[offset + 3] ?? null,
      values[offset + 4] ?? null,
    ));
  });
  return result;
}

/** 同一 finalized 区块批量读取当前 CID 与 AccountId 绑定；订阅投影不得依赖 D1 用户先存在。 */
export async function fetchChainAccountIdsByCidAtBlock(
  env: Env,
  cidNumbers: readonly string[],
  blockHash: string,
): Promise<Map<string, string | null>> {
  const cids = [...new Set(cidNumbers.map(assertCidNumber))];
  const keys = cids.flatMap((cid) => {
    const cidScale = encodeBoundedBytes(new TextEncoder().encode(cid));
    return [
      storageMapKey("CitizenIdentity", "AccountIdByCid", cidScale),
      storageMapKey("CitizenIdentity", "CidRegistry", cidScale),
    ];
  });
  const values = await fetchChainStorageBatch(
    env,
    keys.map((key) => ({
      storageKeyHex: `0x${bytesToHex(key)}`,
      blockHashHex: blockHash,
    })),
  );
  const result = new Map<string, string | null>();
  cids.forEach((cid, index) => {
    const accountHex = values[index * 2] ?? null;
    const recordHex = values[index * 2 + 1] ?? null;
    if (!accountHex || !recordHex || !cidRecordIsActive(hexToBytes(recordHex))) {
      result.set(cid, null);
      return;
    }
    const accountBytes = hexToBytes(accountHex);
    if (accountBytes.length !== 32) {
      throw new Error("finalized AccountIdByCid is invalid");
    }
    result.set(cid, `0x${bytesToHex(accountBytes)}`);
  });
  return result;
}

function decodeCidProjectionState(
  cid: string,
  chainTimestamp: number,
  accountHex: string | null,
  recordHex: string | null,
  revisionHex: string | null,
  votingHex: string | null,
  candidateHex: string | null,
): ChainCidProjectionState | null {
  if (!recordHex) return null;

  const record = decodeCidRecord(hexToBytes(recordHex));
  if (!record) throw new Error("finalized CidRegistry record is invalid");
  const accountBytes = accountHex ? hexToBytes(accountHex) : null;
  if (accountBytes && accountBytes.length !== 32) {
    throw new Error("finalized AccountIdByCid is invalid");
  }
  const bindingRevision = decodeU64(revisionHex);
  if (bindingRevision <= 0) {
    throw new Error("finalized BindingRevisionByCid is invalid");
  }

  const votingIdentity = votingHex ? decodeVotingIdentity(hexToBytes(votingHex)) : null;
  const hasVotingIdentity = record.cid_record_status === "Active"
    && votingIdentity !== null
    && votingIdentityIsActive(votingIdentity, new Date(chainTimestamp));
  const candidateIdentity = candidateHex ? decodeCandidateIdentity(hexToBytes(candidateHex)) : null;
  const identityLevel: IdentityLevel = hasVotingIdentity && candidateIdentity
    ? "candidate"
    : hasVotingIdentity
      ? "voting"
      : "visitor";

  return {
    cid_number: cid,
    cid_record_status: record.cid_record_status,
    account_id: accountBytes ? `0x${bytesToHex(accountBytes)}` : null,
    binding_revision: bindingRevision,
    identity_level: identityLevel,
    registered_block_number: record.registered_block_number,
    revoked_block_number: record.revoked_block_number,
  };
}

export function decodeVotingIdentity(data: Uint8Array): VotingIdentity | null {
  try {
    let offset = 0;
    if (offset + 4 + 4 + 1 > data.length) return null;
    const passportValidFrom = readU32Le(data, offset);
    offset += 4;
    const passportValidUntil = readU32Le(data, offset);
    offset += 4;
    const statusByte = data[offset];
    if (statusByte !== 0 && statusByte !== 1) return null;
    offset += 1;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    if (offset + 4 !== data.length) return null;
    if (
      !isValidDateInt(passportValidFrom) ||
      !isValidDateInt(passportValidUntil)
    ) {
      return null;
    }
    return {
      passport_valid_from: passportValidFrom,
      passport_valid_until: passportValidUntil,
      citizen_status: statusByte === 0 ? "normal" : "revoked",
    };
  } catch {
    return null;
  }
}

export function decodeCandidateIdentity(
  data: Uint8Array,
): CandidateIdentity | null {
  try {
    let offset = 0;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    const familyName = readCompactBytes(data, offset, 128);
    offset = familyName.nextOffset;
    const givenName = readCompactBytes(data, offset, 128);
    offset = givenName.nextOffset;
    if (familyName.value.length === 0 || givenName.value.length === 0)
      return null;
    if (offset + 1 + 4 + 4 !== data.length) return null;
    const citizenSex = data[offset];
    if (citizenSex !== 0 && citizenSex !== 1) return null;
    offset += 1;
    const birthDate = readU32Le(data, offset);
    if (!isValidDateInt(birthDate)) return null;
    return { birth_date: birthDate };
  } catch {
    return null;
  }
}

export function votingIdentityIsActive(
  identity: VotingIdentity,
  now = new Date(nowMs()),
): boolean {
  if (identity.citizen_status !== "normal") {
    return false;
  }
  const today = dateInt(new Date(now.getTime() + 8 * 60 * 60 * 1000));
  return (
    today >= identity.passport_valid_from &&
    today <= identity.passport_valid_until
  );
}

export function decodeCidNumber(data: Uint8Array): string | null {
  try {
    const cid = readCompactBytes(data, 0, 32);
    if (cid.nextOffset !== data.length) return null;
    const value = utf8(cid.value).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function cidRecordIsActive(data: Uint8Array | null): boolean {
  if (!data) return false;
  try {
    let offset = readCompactBytes(data, 0, 32).nextOffset;
    offset += 32;
    if (offset > data.length) return false;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    if (offset + 1 + 4 + 1 > data.length || data[offset] !== 0) return false;
    offset += 1 + 4;
    // Active 记录必须没有撤销块号；状态与 revoked_at 自相矛盾时 fail-closed。
    return data[offset] === 0 && offset + 1 === data.length;
  } catch {
    return false;
  }
}

interface DecodedCidRecord {
  cid_record_status: "Active" | "Revoked";
  registered_block_number: number;
  revoked_block_number: number | null;
}

function decodeCidRecord(data: Uint8Array): DecodedCidRecord | null {
  try {
    let offset = readCompactBytes(data, 0, 32).nextOffset;
    if (offset + 32 > data.length) return null;
    offset += 32;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    offset = readCompactBytes(data, offset, 16).nextOffset;
    if (offset + 1 + 4 + 1 > data.length) return null;
    const status = data[offset];
    offset += 1;
    const registeredBlockNumber = readU32Le(data, offset);
    offset += 4;
    const revokedOption = data[offset];
    offset += 1;
    if (status === 0 && revokedOption === 0 && offset === data.length) {
      return {
        cid_record_status: "Active",
        registered_block_number: registeredBlockNumber,
        revoked_block_number: null,
      };
    }
    if (status === 1 && revokedOption === 1 && offset + 4 === data.length) {
      return {
        cid_record_status: "Revoked",
        registered_block_number: registeredBlockNumber,
        revoked_block_number: readU32Le(data, offset),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeBoundedBytes(value: Uint8Array): Uint8Array {
  if (value.length === 0 || value.length > 32 || value.length >= 64) {
    throw new Error("CID 长度不合法");
  }
  return Uint8Array.from([value.length << 2, ...value]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function dateInt(date: Date): number {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return Number(`${year}${month}${day}`);
}

function isValidDateInt(value: number): boolean {
  const year = Math.floor(value / 10000);
  const month = Math.floor((value % 10000) / 100);
  const day = value % 100;
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31)
    return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function readCompactBytes(
  data: Uint8Array,
  offset: number,
  maxLen: number,
): { value: Uint8Array; nextOffset: number } {
  const [length, lengthSize] = readCompactU32(data, offset);
  if (length > maxLen) {
    throw new Error("compact bytes too long");
  }
  const start = offset + lengthSize;
  const end = start + length;
  if (end > data.length) {
    throw new Error("compact bytes out of range");
  }
  return {
    value: data.slice(start, end),
    nextOffset: end,
  };
}

function readCompactU32(data: Uint8Array, offset: number): [number, number] {
  if (offset >= data.length) throw new Error("compact offset out of range");
  const first = data[offset];
  const mode = first & 0x03;
  if (mode === 0) return [first >> 2, 1];
  if (mode === 1) {
    if (offset + 1 >= data.length)
      throw new Error("compact mode1 out of range");
    return [(first >> 2) | (data[offset + 1] << 6), 2];
  }
  if (mode === 2) {
    if (offset + 3 >= data.length)
      throw new Error("compact mode2 out of range");
    return [
      (first >> 2) |
        (data[offset + 1] << 6) |
        (data[offset + 2] << 14) |
        (data[offset + 3] << 22),
      4,
    ];
  }
  throw new Error("compact big integer mode is not supported");
}

function readU32Le(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(
    0,
    true,
  );
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
