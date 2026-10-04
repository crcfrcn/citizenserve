import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/chain/rpc', () => ({
  fetchChainStorage: vi.fn()
}));

import { fetchChainStorage } from '../src/chain/rpc';
import {
  decodeChaptersScale,
  decodeEffectiveVersion,
  decodeImmutableArticles,
  decodeVersionLabel,
  fetchConstitutionDocument
} from '../src/chain/constitution';
import type { Env } from '../src/types';

const mockFetch = fetchChainStorage as unknown as ReturnType<typeof vi.fn>;

/// 真源：runtime 内置的宪法全文 SCALE（= 裸 ChaptersOf 编码）。
const CONSTITUTION_SCALE = readFileSync(
  resolve(
    __dirname,
    '../../citizenchain/runtime/public/legislation-yuan/src/constitution.scale'
  )
);

// ── SCALE 编码小工具（仅测试构造夹具用）──
function compactLen(value: number): Uint8Array {
  if (value < 0x40) return Uint8Array.of(value << 2);
  if (value < 0x4000) {
    const v = (value << 2) | 1;
    return Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
  }
  const v = (value << 2) | 2;
  return Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}
function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}
function u64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
function toHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
function cidNumber(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return cat(compactLen(bytes.length), bytes);
}

describe('constitution SCALE 解码', () => {
  it('对真 constitution.scale 解出 7 章，第三/四章为极简标题', () => {
    const chapters = decodeChaptersScale(new Uint8Array(CONSTITUTION_SCALE));
    expect(chapters).toHaveLength(7);

    const ch3 = chapters.find((c) => c.number === 3);
    expect(ch3?.title_cn).toBe('第三章 教委会');
    expect(ch3?.title_en).toBe('Chapter III Education Committee');

    const ch4 = chapters.find((c) => c.number === 4);
    expect(ch4?.title_cn).toBe('第四章 储委会');
    expect(ch4?.title_en).toBe('Chapter IV Reserve Committee');

    // 第一章总则含 52 条，验证章>节>条嵌套解码到位。
    const ch1 = chapters.find((c) => c.number === 1);
    const ch1Articles = (ch1?.sections ?? []).flatMap((s) => s.articles);
    expect(ch1Articles).toHaveLength(52);
  });

  it('不可修改条号标记落到对应条文', () => {
    const chapters = decodeChaptersScale(new Uint8Array(CONSTITUTION_SCALE), new Set([1, 5]));
    const articles = chapters.flatMap((c) => c.sections).flatMap((s) => s.articles);
    expect(articles.find((a) => a.number === 1)?.immutable).toBe(true);
    expect(articles.find((a) => a.number === 5)?.immutable).toBe(true);
    expect(articles.find((a) => a.number === 2)?.immutable).toBe(false);
  });

  it('decodeEffectiveVersion 跳过 houses 读出生效版本', () => {
    // law_id=0, tier=0, scope=0, houses=1 项(CidNumber=Vec<u8>), effective_version=Some(1)。
    // 线上宪法 Law(0) 的 house CID 长度为 26B；旧固定 36B 跳过会读偏成 None。
    const law = cat(
      u64le(0),
      Uint8Array.of(0),
      u32le(0),
      compactLen(1),
      cidNumber('ZS001-NLF13-581844128-2026'),
      Uint8Array.of(1),
      u32le(1)
    );
    expect(decodeEffectiveVersion(law)).toBe(1);
  });

  it('decodeEffectiveVersion 对 None 返回 null（无生效版）', () => {
    const law = cat(u64le(0), Uint8Array.of(0), u32le(0), compactLen(0), Uint8Array.of(0));
    expect(decodeEffectiveVersion(law)).toBeNull();
  });

  it('decodeImmutableArticles 取条号集', () => {
    const manifest = cat(
      compactLen(2),
      u32le(7),
      u32le(19),
      compactLen(2),
      new Uint8Array(32),
      new Uint8Array(32)
    );
    expect(decodeImmutableArticles(manifest)).toEqual([7, 19]);
  });

  it('decodeVersionLabel 解出中英展示名', () => {
    const cn = new TextEncoder().encode('创世版');
    const en = new TextEncoder().encode('Genesis Edition');
    const label = cat(compactLen(cn.length), cn, Uint8Array.of(1), compactLen(en.length), en);
    expect(decodeVersionLabel(label)).toEqual({ cn: '创世版', en: 'Genesis Edition' });
  });
});

describe('fetchConstitutionDocument 端到端（mock 链读）', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function env(): Env {
    return {} as unknown as Env;
  }

  it('组装生效版宪法文档（章节 + 版本 + 徽章 + 版本标签）', async () => {
    const law = cat(
      u64le(0),
      Uint8Array.of(0),
      u32le(0),
      compactLen(1),
      cidNumber('ZS001-NLF13-581844128-2026'),
      Uint8Array.of(1),
      u32le(1)
    );
    // LawVersion = law_id + version + title(空) + title_en(None) + chapters(真.scale) + content_hash(32)
    const lawVersion = cat(
      u64le(0),
      u32le(1),
      compactLen(0),
      Uint8Array.of(0),
      new Uint8Array(CONSTITUTION_SCALE),
      new Uint8Array(32)
    );
    const cn = new TextEncoder().encode('创世版');
    const label = cat(compactLen(cn.length), cn, Uint8Array.of(0));
    const manifest = cat(compactLen(1), u32le(1), compactLen(1), new Uint8Array(32));

    // 依 fetchConstitutionDocument 的读取顺序：Law → (LawVersion, Label, Manifest) 并行。
    mockFetch
      .mockResolvedValueOnce(toHex(law))
      .mockResolvedValueOnce(toHex(lawVersion))
      .mockResolvedValueOnce(toHex(label))
      .mockResolvedValueOnce(toHex(manifest));

    const doc = await fetchConstitutionDocument(env());
    expect(doc.version).toBe(1);
    expect(doc.chapters).toHaveLength(7);
    expect(doc.chapters.find((c) => c.number === 3)?.title_cn).toBe('第三章 教委会');
    expect(doc.version_label).toEqual({ cn: '创世版', en: null });
    expect(doc.immutable_articles).toEqual([1]);
    const article1 = doc.chapters
      .flatMap((c) => c.sections)
      .flatMap((s) => s.articles)
      .find((a) => a.number === 1);
    expect(article1?.immutable).toBe(true);
  });

  it('无生效版本抛 404', async () => {
    const law = cat(u64le(0), Uint8Array.of(0), u32le(0), compactLen(0), Uint8Array.of(0));
    mockFetch.mockResolvedValueOnce(toHex(law));
    await expect(fetchConstitutionDocument(env())).rejects.toMatchObject({ status: 404 });
  });
});
