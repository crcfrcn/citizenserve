import { HttpError } from '../shared/http';
import {
  OP_SIGN_SQUARE_DEVICE_BIND,
  concatBytes,
  scaleString,
  signingMessage,
  u64Le, hexToBytes} from '../shared/signing_message';

// P-256 设备子钥：后台握手用硬件 P-256 子钥（Keystore/SE）静默 ECDSA 签名，
// 私钥永不出硬件，替代原先「静默读 sr25519 seed 签登录挑战」。
//
// 文本编码铁律（ADR-041）：跨端「公钥 / 签名」文本统一为小写 `0x` 加 hex、拒裸。
// - wire pubkey = `0x04 || X(32) || Y(32)`（65B 未压缩点），入口一次 require 0x + strip。
// - wire signature = `0x` + 裸 r||s 64B hex（客户端把平台 DER 签名转 raw）。
// - 内部（SCALE 签名消息 preimage、D1 存储、device_key_hash）继续用裸字节，逐字节不变；
//   0x 只出现在跨端文本，进入系统边界一次规范化为裸后交内部使用。
// - 验签走 Workers Web Crypto ES256（ECDSA over SHA-256），message = 32B 摘要。

const P256_PUBKEY_BYTES = 65; // 0x04 || X(32) || Y(32)
const P256_SIG_BYTES = 64; // r(32) || s(32)
// 中文注释：设备绑定证明与普通设备请求使用同一五分钟时间偏差口径，防止长期保存
// 的此前绑定签名在设备轮换后重新覆盖当前子钥。
export const DEVICE_SKEW_MS = 5 * 60 * 1000;

export interface DeviceBindingInput {
  cid_number: string;
  binding_revision: number;
  account_id: string;
  p256_public_key: string;
  issued_at: number;
}

/// 设备绑定证明消息：sr25519 主钥对 `signing_message(OP_SIGN_SQUARE_DEVICE_BIND)`
/// 签名，证明该 P-256 子钥属于此钱包。SCALE 拼接顺序须与公民端逐字节一致。
export function buildDeviceBindingSigningMessage(input: DeviceBindingInput): Uint8Array {
  const scalePayload = concatBytes(
    scaleString(input.cid_number),
    u64Le(input.binding_revision),
    scaleString(input.account_id),
    scaleString(input.p256_public_key),
    u64Le(input.issued_at),
  );
  return signingMessage(OP_SIGN_SQUARE_DEVICE_BIND, scalePayload);
}

/// 校验跨端 P-256 公钥文本（`0x04` + 128 位小写 hex，65 字节未压缩点），返回**裸**串
/// （strip `0x`）供内部 SCALE / 存储 / hash 使用，保持内部裸字节口径不变（ADR-041）。
export function assertP256PublicKeyHex(value: unknown): string {
  if (typeof value !== 'string' || !/^0x04[0-9a-f]{128}$/.test(value)) {
    throw new HttpError(400, 'invalid_device_pubkey', '设备子钥公钥格式不合法');
  }
  return value.slice(2);
}

/// 规范化跨端 P-256 签名文本（`0x` + 128 位小写 hex，64 字节 r‖s）→ 返回**裸**串；
/// 非法（含裸、大写、错长）返回 null。调用方按各自语义决定 400/401（ADR-041）。
export function normalizeP256SignatureHex(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{128}$/.test(value)) {
    return null;
  }
  return value.slice(2);
}

/// Web Crypto ES256 验签（内部裸函数）：pubkey 裸点 65B、signature 裸 r||s 64B，均**不带 0x**。
/// 跨端文本的 `0x` 前缀必须由调用方在边界经 normalizeP256SignatureHex / assertP256PublicKeyHex
/// 先规范化为裸再传入；本函数按协议拒绝任何带 `0x` 的输入（ADR-041）。
/// [message] 为 `signing_message(op_tag)` 32 字节摘要（ECDSA 内部再 SHA-256）。
export async function verifyP256Signature(
  message: Uint8Array<ArrayBuffer>,
  signatureHex: string,
  pubkeyHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{128}$/.test(signatureHex) || !/^04[0-9a-f]{128}$/.test(pubkeyHex)) {
    return false;
  }
  const sig = hexToBytes(signatureHex);
  const pub = hexToBytes(pubkeyHex);
  if (sig.length !== P256_SIG_BYTES || pub.length !== P256_PUBKEY_BYTES) {
    return false;
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      pub,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig,
      message,
    );
  } catch {
    return false;
  }
}
