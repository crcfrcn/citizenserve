import { describe, expect, it } from 'vitest';
import { readChainSource } from './chain_source.mjs';
import {
  bytesToHex,
  hexToBytes,
  signingMessage,
  OP_SIGN_MLS_DEVICE_BIND,
} from '../src/shared/signing_message';

// 金标直接读取同一准确公开提交，验真失败即拒绝，不依赖本机链目录。

interface SigningVector {
  name: string;
  op_tag: string;
  scale_payload_hex: string;
  message_hex: string;
}

const canonical = JSON.parse((await readChainSource('runtime/primitives/tests/fixtures/signing_domain_vectors.json')).toString('utf8')) as {
  domain: string;
  vectors: SigningVector[];
};

describe('signingMessage 金标向量(直读 citizenchain 真源)', () => {
  it('真源可读、域为 GMB 且向量非空', () => {
    // 读不到或读成空数组时,下面的 for 循环会一条用例都不生成而整体显示通过。
    // 这条断言挡住"金标静默失效"这种最坏情况。
    expect(canonical.domain).toBe('GMB');
    expect(canonical.vectors.length).toBeGreaterThan(0);
  });

  // 全部 op_tag 都过一遍:signingMessage 是通用原语,op_tag 只是输入字节,
  // 覆盖 Worker 当前未使用的域也能锁住 blake2 实现与拼接顺序。
  for (const vector of canonical.vectors) {
    it(`${vector.name} (op_tag ${vector.op_tag}) 与链端金标逐字节一致`, () => {
      const message = signingMessage(
        Number(vector.op_tag),
        hexToBytes(vector.scale_payload_hex),
      );
      expect(bytesToHex(message)).toBe(vector.message_hex.toLowerCase());
    });
  }
});

describe('Worker op_tag 常量与真源登记值一致', () => {
  // 摘要算对不代表常量用对:Worker 若把某个 op_tag 常量写错,会去验一个
  // 密码学上完全合法、但语义是另一种操作的签名。按真源的 name 反查 op_tag,
  // 把常量值本身钉死。
  const byName = new Map(canonical.vectors.map((vector) => [vector.name, vector]));

  const constants: ReadonlyArray<readonly [string, number]> = [
    ['OP_SIGN_MLS_DEVICE_BIND', OP_SIGN_MLS_DEVICE_BIND],
  ];

  for (const [name, value] of constants) {
    it(`${name} = 0x${value.toString(16)}`, () => {
      const vector = byName.get(name);
      expect(vector, `真源缺少 ${name} 向量`).toBeDefined();
      expect(value).toBe(Number(vector!.op_tag));
    });
  }
});
