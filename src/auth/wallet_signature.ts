import { signatureVerify } from '@polkadot/util-crypto/signature/verify';

/// sr25519 主钥验签。[message] 为 `signing_message(op_tag)` 的 32 字节摘要
/// （不是任何字符串域原文）。签名/公钥非法一律返回 false。
export async function verifyWalletSignature(
  message: Uint8Array,
  signature: string,
  accountId: string
): Promise<boolean> {
  try {
    return signatureVerify(message, signature, accountId).isValid;
  } catch {
    return false;
  }
}
