import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bytesToHex,
  hexToBytes,
  signingMessage,
  OP_SIGN_SQUARE_LOGIN,
  OP_SIGN_SQUARE_DEVICE_BIND,
} from '../src/shared/signing_message';

// 签名域金标锁(Worker ⇔ citizenchain)。
//
// 本文件**直接读真源**,Worker 侧不保存镜像副本 —— 沿用 cross_end_contract.test.ts
// 的做法(直接读另一端的源文件)。原先向量是硬编码在本文件里的常量数组:那种形态下,
// 同时改实现与改向量,本端测试依旧全绿,两端就此静默分叉;而 Worker 是**服务端校验方**,
// 算错的表现是静默放行或静默拒绝合法请求,开发期不会暴露。直读真源让这种漂移在
// 物理上不可能发生,比"复制一份再靠 CI 比对"更强,因此本端不登记进
// .github/scripts/gmb-repository/ci-repository.mjs golden-vectors 的 mirrors。
//
// 真源:citizenchain/runtime/primitives/tests/fixtures/signing_domain_vectors.json
// 规范实现:citizenchain/runtime/primitives/src/sign.rs::signing_message
// 契约:被签消息 = blake2_256( GMB(3B) || op_tag(1B) || SCALE(payload) )

const REPO_ROOT = join(import.meta.dirname, '../..');
const VECTORS_PATH = join(
  REPO_ROOT,
  'citizenchain/runtime/primitives/tests/fixtures/signing_domain_vectors.json',
);

interface SigningVector {
  name: string;
  op_tag: string;
  scale_payload_hex: string;
  message_hex: string;
}

const canonical = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
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
    ['OP_SIGN_SQUARE_LOGIN', OP_SIGN_SQUARE_LOGIN],
    ['OP_SIGN_SQUARE_DEVICE_BIND', OP_SIGN_SQUARE_DEVICE_BIND],
  ];

  for (const [name, value] of constants) {
    it(`${name} = 0x${value.toString(16)}`, () => {
      const vector = byName.get(name);
      expect(vector, `真源缺少 ${name} 向量`).toBeDefined();
      expect(value).toBe(Number(vector!.op_tag));
    });
  }
});
