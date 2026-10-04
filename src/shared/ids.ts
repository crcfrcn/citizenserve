import { hexToBytes } from './signing_message';

const ACCOUNT_ID_PATTERN = /^0x[0-9a-f]{64}$/;
// cid_number ≤32 字节,由链上占号校验;此模式仅纵深防御,确保可安全用作 R2 对象键路径段
// 与 D1 主键(禁 '/'、'.'、控制字符等路径穿越/注入),起始为字母数字。
const CID_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

/// AccountId 与 sr25519 签名公钥使用同一组 32 字节；二维码 `u` 只取无前缀 hex。
export function signerPublicKeyHex(accountId: string): string {
  return assertAccountId(accountId).slice(2);
}

export function assertAccountId(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error('account_id must be lowercase 0x followed by 64 hexadecimal characters');
  }
  return value;
}

/// cid_number = 用户唯一身份主键(链上解析,可信);此校验为纵深防御,确保可安全用作
/// R2 对象键路径段与 D1 主键。
export function assertCidNumber(value: unknown): string {
  if (typeof value !== 'string' || !CID_NUMBER_PATTERN.test(value)) {
    throw new Error('cid_number must be 1-32 chars of [A-Za-z0-9-] starting alphanumeric');
  }
  return value;
}

/// 仅在链 storage key 或验签库需要原始字节时转换；HTTP、D1、KV、DO、Queue 和 R2
/// 始终保存规范文本 AccountId。
export function accountIdBytes(value: unknown): Uint8Array {
  return hexToBytes(assertAccountId(value));
}
