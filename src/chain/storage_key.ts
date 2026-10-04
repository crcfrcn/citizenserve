import { blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto';
import { accountIdBytes } from '../shared/ids';

/// 链上 storage 读取的共用底座：规范 AccountId 解码 + `Blake2_128Concat` map key 拼装。
/// 由链身份和其他明确需要读取 storage map 的业务共用，避免各自复制。

/** 小写 `0x` + 64 位 hex AccountId → 32 字节；不接受 SS58 或宽松格式。 */
export function decodeAccountId(accountId: string): Uint8Array {
  return accountIdBytes(accountId);
}

/**
 * 拼 `Blake2_128Concat` 单键 map 的完整 storage key：
 * xxhash128(pallet) ++ xxhash128(storage) ++ blake2_128(key) ++ key。
 */
export function storageMapKey(
  palletName: string,
  storageName: string,
  keyData: Uint8Array
): Uint8Array {
  const palletHash = xxhashAsU8a(palletName, 128);
  const storageHash = xxhashAsU8a(storageName, 128);
  const keyHash = blake2AsU8a(keyData, 128);
  return concat([palletHash, storageHash, keyHash, keyData]);
}

/**
 * 拼 `StorageValue` 的完整 storage key：xxhash128(pallet) ++ xxhash128(storage)。
 * 无键 map，用于 `ConstitutionImmutableManifest` 这类单值存储。
 */
export function storageValueKey(palletName: string, storageName: string): Uint8Array {
  return concat([xxhashAsU8a(palletName, 128), xxhashAsU8a(storageName, 128)]);
}

/**
 * 拼 `Blake2_128Concat × Blake2_128Concat` 双键 DoubleMap 的完整 storage key：
 * xxhash128(pallet) ++ xxhash128(storage) ++ blake2_128(k1) ++ k1 ++ blake2_128(k2) ++ k2。
 * 用于 `LawVersions[law_id][version]` / `LawVersionLabels[law_id][version]`。
 */
export function storageDoubleMapKey(
  palletName: string,
  storageName: string,
  key1Data: Uint8Array,
  key2Data: Uint8Array
): Uint8Array {
  return concat([
    xxhashAsU8a(palletName, 128),
    xxhashAsU8a(storageName, 128),
    blake2AsU8a(key1Data, 128),
    key1Data,
    blake2AsU8a(key2Data, 128),
    key2Data
  ]);
}

/** SCALE 定长 u64 小端编码（map 键用；`u64.encode()` 逐字节对齐）。 */
export function encodeU64Le(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

/** SCALE 定长 u32 小端编码（map 键用；`u32.encode()` 逐字节对齐）。 */
export function encodeU32Le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

/** 顺序拼接多段字节。 */
export function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
