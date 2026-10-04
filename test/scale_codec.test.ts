import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bytesToHex,
  scaleCompact,
  scaleString,
  u64Le,
} from '../src/shared/signing_message';

// SCALE 编码原语金标锁(Worker ⇔ citizenchain)。
//
// 本文件**直接读真源**,Worker 侧不保存镜像副本(与 signing_message.test.ts 同策略)。
//
// 为什么需要:`scaleCompact` / `scaleString` / `u64Le` 是**手写**实现,而链端用
// parity-scale-codec。此前唯一引用它们的 device_subkey.test.ts 是拿它们去**构造期望值**——
// 实现算错期望值同步错,测试照样绿。这些字节直接决定被签 payload,编码差一位
// 签出来就是另一笔交易。
//
// 真源:citizenchain/runtime/primitives/tests/fixtures/scale_codec_vectors.json
// 生成器:citizenchain/runtime/primitives/tests/scale_codec_golden.rs
//        (SCALE_GOLDEN_UPDATE=1 重新生成)

const REPO_ROOT = join(import.meta.dirname, '../..');
const VECTORS_PATH = join(
  REPO_ROOT,
  'citizenchain/runtime/primitives/tests/fixtures/scale_codec_vectors.json',
);

interface CompactVector {
  value: number;
  hex: string;
}
interface StringVector {
  value: string;
  utf8_len: number;
  hex: string;
}
interface U64Vector {
  value: number;
  hex: string;
}

const canonical = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  compact_u32: CompactVector[];
  scale_string: StringVector[];
  u64_le: U64Vector[];
};

describe('SCALE 编码原语与链端一致(直读 citizenchain 真源)', () => {
  it('真源三组向量均可读且非空', () => {
    // 读成空数组时下面的循环一条用例都不生成而整体显示通过,这条挡住金标静默失效。
    expect(canonical.compact_u32.length).toBeGreaterThan(0);
    expect(canonical.scale_string.length).toBeGreaterThan(0);
    expect(canonical.u64_le.length).toBeGreaterThan(0);
  });

  // compact 的三档分支(< 2^6 / < 2^14 / < 2^30)边界是手写实现最易错的地方:
  // 把 `<` 写成 `<=` 会让 63/64、16383/16384 这两对中的一个编错字节数。
  for (const vector of canonical.compact_u32) {
    it(`scaleCompact(${vector.value}) = ${vector.hex}`, () => {
      expect(bytesToHex(scaleCompact(vector.value))).toBe(vector.hex);
    });
  }

  // 长度前缀用的是 **utf8 字节数** 而非字符数;中文与 emoji 用例专门覆盖这一点。
  for (const vector of canonical.scale_string) {
    const label =
      vector.value.length > 24 ? `${vector.value.slice(0, 24)}…` : vector.value;
    it(`scaleString(${JSON.stringify(label)}) 共 ${vector.utf8_len} 字节`, () => {
      expect(bytesToHex(scaleString(vector.value))).toBe(vector.hex);
    });
  }

  for (const vector of canonical.u64_le) {
    it(`u64Le(${vector.value}) = ${vector.hex}`, () => {
      expect(bytesToHex(u64Le(vector.value))).toBe(vector.hex);
    });
  }
});

describe('SCALE 编码原语的 fail-closed 边界', () => {
  // 真源向量只覆盖合法取值。非法输入必须抛错而不是产出错误字节 ——
  // 静默产出会让一笔语义错误的交易被签名。
  it('scaleCompact 拒绝负数、非整数与超出 2^30-1 的值', () => {
    expect(() => scaleCompact(-1)).toThrow(RangeError);
    expect(() => scaleCompact(1.5)).toThrow(RangeError);
    expect(() => scaleCompact(2 ** 30)).toThrow(RangeError);
  });

  it('u64Le 拒绝负数与超出 JS 安全整数的值', () => {
    // 上界差异是已知的跨端事实:TS 守卫在 2^53-1,Dart int 可到 2^63-1。
    // 真源向量取二者交集,这里断言 TS 侧守卫确实生效,不会静默丢精度。
    expect(() => u64Le(-1)).toThrow(RangeError);
    expect(() => u64Le(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => u64Le(1.5)).toThrow(RangeError);
  });
});
