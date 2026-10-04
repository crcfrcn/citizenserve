import { blake2AsU8a } from '@polkadot/util-crypto/blake2';

// 全仓钱包签名唯一原语（Worker 侧）—— 逐字节对齐 citizenchain
// `runtime/primitives/src/sign.rs::signing_message` + 金标向量
// `tests/fixtures/signing_domain_vectors.json`。
//
// 死规则：任何签名的被签消息一律 = signing_message(op_tag) =
// blake2_256( GMB(3B) || op_tag(1B) || SCALE(payload) )。禁止另造版本化字符串域；
// 全仓唯一允许的版本化协议标识是 QR_V1。

/// 签名域分隔符 GMB(3 字节 ASCII)，单源对齐 core_const::GMB。
export const GMB_SIGN_DOMAIN = [0x47, 0x4d, 0x42];

// 本 Worker 会验签的链下哈希域 op_tag（单源 citizenchain primitives::sign）。
// CID 换绑授权只在钱包与 runtime 间验证，Worker 不提供第二授权 endpoint。
/// 广场 BFF 登录挑战（设备子钥 ES256 签 digest）。
export const OP_SIGN_SQUARE_LOGIN = 0x1b;
/// 广场 BFF 设备子钥绑定（sr25519 主钥签）。
export const OP_SIGN_SQUARE_DEVICE_BIND = 0x1c;

/// 签名消息唯一原语：`blake2_256(GMB || op_tag || scalePayload)`，返回 32 字节摘要。
/// 返回 ArrayBuffer 背衬的视图，便于直接喂给 Web Crypto（ECDSA 验签）。
export function signingMessage(opTag: number, scalePayload: Uint8Array): Uint8Array<ArrayBuffer> {
  const digest = blake2AsU8a(
    new Uint8Array([...GMB_SIGN_DOMAIN, opTag & 0xff, ...scalePayload]),
    256,
  );
  return new Uint8Array(digest);
}

/// SCALE 编码字符串：`compact(len) || utf8(value)`。
export function scaleString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes(scaleCompact(bytes.length), bytes);
}

/// SCALE compact 编码非负整数（支持到 2^30-1，足够 payload 各长度/时间戳字段）。
export function scaleCompact(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('SCALE compact value must be a non-negative safe integer');
  }
  if (value < 1 << 6) {
    return new Uint8Array([value << 2]);
  }
  if (value < 1 << 14) {
    const encoded = (value << 2) | 0x01;
    return new Uint8Array([encoded & 0xff, (encoded >> 8) & 0xff]);
  }
  if (value < 1 << 30) {
    const encoded = (value << 2) | 0x02;
    return new Uint8Array([
      encoded & 0xff,
      (encoded >> 8) & 0xff,
      (encoded >> 16) & 0xff,
      (encoded >> 24) & 0xff,
    ]);
  }
  throw new RangeError('SCALE compact value is too large');
}

/// u64 小端 8 字节（时间戳等定长字段）。
export function u64Le(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('u64 value must be a non-negative safe integer');
  }
  let current = BigInt(value);
  const out = new Uint8Array(8);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

export function concatBytes(...items: Uint8Array[]): Uint8Array {
  const total = items.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of items) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

/// 字节 → 小写 hex（无 `0x` 前缀）。
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/// hex → 字节（容忍 `0x` 前缀与大小写）。
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new RangeError('invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
