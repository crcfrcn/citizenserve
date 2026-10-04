import type { Env } from '../types';
import { HttpError, jsonResponse, parsePositiveInt } from '../shared/http';
import { bytesToHex, hexToBytes } from '../shared/signing_message';
import { fetchChainStorage } from './rpc';
import {
  encodeU32Le,
  encodeU64Le,
  storageDoubleMapKey,
  storageMapKey,
  storageValueKey
} from './storage_key';

/// 立法院模块在 `construct_runtime` 中的 pallet 名；twox128 前缀据此推导，硬编码不读 metadata
/// （metadata 属可升级 runtime，恶意升级可伪造）。与节点守卫 `core/constitution` 的 PALLET_NAME 一致。
const PALLET_NAME = 'LegislationYuan';
/// 宪法固定 law_id=0（tier=Constitution，scope=全国）。
const CONSTITUTION_LAW_ID = 0;
/// 宪法文档缓存默认 TTL（秒）。宪法极少变，短缓存即可让「修宪后自动更新」在一个 TTL 内生效。
const DEFAULT_CONSTITUTION_TTL_SECONDS = 300;
/// 宪法结构存量上界：防御性封顶，越界即判存储异常，避免超大/恶意长度导致 Worker 内存放大。
const MAX_CHAPTERS = 64;
const MAX_SECTIONS_PER_CHAPTER = 64;
const MAX_ARTICLES_PER_SECTION = 256;
const MAX_CLAUSES_PER_ARTICLE = 256;
const MAX_IMMUTABLE_ARTICLES = 512;

export interface ConstitutionClause {
  text_cn: string;
  text_en: string | null;
}

export interface ConstitutionArticle {
  number: number;
  title_cn: string;
  title_en: string | null;
  body_cn: string;
  body_en: string | null;
  immutable: boolean;
  clauses: ConstitutionClause[];
}

export interface ConstitutionSection {
  number: number;
  title_cn: string;
  title_en: string | null;
  articles: ConstitutionArticle[];
}

export interface ConstitutionChapter {
  number: number;
  title_cn: string;
  title_en: string | null;
  sections: ConstitutionSection[];
}

export interface ConstitutionDocument {
  ok: true;
  schema: 'citizenapp.constitution';
  version: number;
  content_hash: string;
  version_label: { cn: string; en: string | null } | null;
  immutable_articles: number[];
  chapters: ConstitutionChapter[];
  generated_at: number;
  cache_ttl_seconds: number;
}

/// 最小 SCALE 读取游标：逐字段对齐 runtime `legislation-yuan` 的
/// Law / LawVersion / Chapter / Section / Article / Clause / LawVersionLabel / ImmutableManifest 结构。
class ScaleReader {
  private readonly data: Uint8Array;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private require(n: number): void {
    if (this.offset + n > this.data.length) {
      throw new HttpError(502, 'constitution_decode_failed', '链上宪法存储解码越界');
    }
  }

  u8(): number {
    this.require(1);
    return this.data[this.offset++];
  }

  u32(): number {
    this.require(4);
    const value = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.offset,
      4
    ).getUint32(0, true);
    this.offset += 4;
    return value;
  }

  skip(n: number): void {
    this.require(n);
    this.offset += n;
  }

  /// 读定长 n 字节原样返回（如 content_hash [u8;32]）。
  raw(n: number): Uint8Array {
    this.require(n);
    const start = this.offset;
    this.offset += n;
    return this.data.subarray(start, this.offset);
  }

  /// SCALE 紧凑整数（仅用于向量长度/字节长度，支持 mode 0..2 + 大整数模式，越界即抛）。
  compact(): number {
    this.require(1);
    const first = this.data[this.offset];
    const mode = first & 0x03;
    if (mode === 0) {
      this.offset += 1;
      return first >>> 2;
    }
    if (mode === 1) {
      this.require(2);
      const value =
        new DataView(this.data.buffer, this.data.byteOffset + this.offset, 2).getUint16(0, true) >>>
        2;
      this.offset += 2;
      return value;
    }
    if (mode === 2) {
      this.require(4);
      const value =
        new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getUint32(0, true) >>>
        2;
      this.offset += 4;
      return value;
    }
    // mode 3：大整数，长度 = (first >> 2) + 4 字节；宪法字段不会走到，越界即判异常。
    const byteLength = (first >>> 2) + 4;
    this.offset += 1;
    this.require(byteLength);
    let value = 0n;
    for (let i = 0; i < byteLength; i += 1) {
      value |= BigInt(this.data[this.offset + i]) << BigInt(8 * i);
    }
    this.offset += byteLength;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HttpError(502, 'constitution_decode_failed', '链上宪法存储长度超出安全范围');
    }
    return Number(value);
  }

  /// 读一段紧凑长度前缀的字节（`Vec<u8>`）。
  bytes(): Uint8Array {
    const length = this.compact();
    this.require(length);
    const start = this.offset;
    this.offset += length;
    return this.data.subarray(start, this.offset);
  }

  /// 读 `Vec<u8>` 并按 UTF-8 解码为字符串。
  text(): string {
    return utf8(this.bytes());
  }

  /// 读 `Option<Vec<u8>>`：0x00=None，0x01=Some(text)。
  optionText(): string | null {
    const flag = this.u8();
    if (flag === 0) return null;
    if (flag === 1) return this.text();
    throw new HttpError(502, 'constitution_decode_failed', '链上宪法 Option 标志非法');
  }

  /// 读 `Option<u32>`。
  optionU32(): number | null {
    const flag = this.u8();
    if (flag === 0) return null;
    if (flag === 1) return this.u32();
    throw new HttpError(502, 'constitution_decode_failed', '链上宪法 Option 标志非法');
  }

  /// 读定长向量长度（带上界防御）。
  vecLen(max: number): number {
    const length = this.compact();
    if (length > max) {
      throw new HttpError(502, 'constitution_decode_failed', '链上宪法结构长度超限');
    }
    return length;
  }
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/// 解码 `Law`（到 effective_version 即可）。字段序：law_id u64、tier u8、scope_code u32、
/// houses `Vec<CidNumber>`、effective_version `Option<u32>`。
/// `CidNumber` 是 SCALE `Vec<u8>`；这里必须逐项读 compact length，不能按历史
/// “机构码 + AccountId = 36B” 固定长度跳过，否则会把 effective_version 读偏。
/// 只读显式 effective_version：宪法只展示已生效版，不提前露修宪待生效版（ADR-027 §6.1）。
export function decodeEffectiveVersion(lawBytes: Uint8Array): number | null {
  const reader = new ScaleReader(lawBytes);
  reader.skip(8); // law_id: u64
  reader.u8(); // tier: 枚举变体索引
  reader.u32(); // scope_code
  const housesLen = reader.vecLen(16); // 立法机构院数（单院/两院）
  for (let i = 0; i < housesLen; i += 1) {
    reader.bytes(); // 每院 = CidNumber(Vec<u8>)
  }
  return reader.optionU32();
}

function decodeClause(reader: ScaleReader): ConstitutionClause {
  reader.u32(); // number：款号不参与展示（text 已含「第N款」前缀）
  const textCn = reader.text();
  const textEn = reader.optionText();
  return { text_cn: textCn, text_en: textEn };
}

function decodeArticle(reader: ScaleReader, immutable: ReadonlySet<number>): ConstitutionArticle {
  const number = reader.u32();
  const titleCn = reader.text();
  const titleEn = reader.optionText();
  const bodyCn = reader.text();
  const bodyEn = reader.optionText();
  const clauseCount = reader.vecLen(MAX_CLAUSES_PER_ARTICLE);
  const clauses: ConstitutionClause[] = [];
  for (let i = 0; i < clauseCount; i += 1) {
    clauses.push(decodeClause(reader));
  }
  return {
    number,
    title_cn: titleCn,
    title_en: titleEn,
    body_cn: bodyCn,
    body_en: bodyEn,
    immutable: immutable.has(number),
    clauses
  };
}

function decodeSection(reader: ScaleReader, immutable: ReadonlySet<number>): ConstitutionSection {
  const number = reader.u32();
  const titleCn = reader.text();
  const titleEn = reader.optionText();
  const articleCount = reader.vecLen(MAX_ARTICLES_PER_SECTION);
  const articles: ConstitutionArticle[] = [];
  for (let i = 0; i < articleCount; i += 1) {
    articles.push(decodeArticle(reader, immutable));
  }
  return { number, title_cn: titleCn, title_en: titleEn, articles };
}

function decodeChapter(reader: ScaleReader, immutable: ReadonlySet<number>): ConstitutionChapter {
  const number = reader.u32();
  const titleCn = reader.text();
  const titleEn = reader.optionText();
  const sectionCount = reader.vecLen(MAX_SECTIONS_PER_CHAPTER);
  const sections: ConstitutionSection[] = [];
  for (let i = 0; i < sectionCount; i += 1) {
    sections.push(decodeSection(reader, immutable));
  }
  return { number, title_cn: titleCn, title_en: titleEn, sections };
}

/// 读一个 `Vec<Chapter>`（章>节>条>款）。
function readChapters(reader: ScaleReader, immutable: ReadonlySet<number>): ConstitutionChapter[] {
  const chapterCount = reader.vecLen(MAX_CHAPTERS);
  const chapters: ConstitutionChapter[] = [];
  for (let i = 0; i < chapterCount; i += 1) {
    chapters.push(decodeChapter(reader, immutable));
  }
  return chapters;
}

/// 解码裸 `ChaptersOf`（= 创世 `constitution.scale` 的编码）为章节树。供测试直接喂真 .scale。
export function decodeChaptersScale(
  bytes: Uint8Array,
  immutable: ReadonlySet<number> = new Set()
): ConstitutionChapter[] {
  return readChapters(new ScaleReader(bytes), immutable);
}

/// 解码 `LawVersion` 头部到 chapters + content_hash。字段序：law_id u64、version u32、
/// title、title_en、chapters `Vec<Chapter>`、content_hash [u8;32]。
function decodeVersionChapters(
  versionBytes: Uint8Array,
  immutable: ReadonlySet<number>
): { chapters: ConstitutionChapter[]; contentHash: string } {
  const reader = new ScaleReader(versionBytes);
  reader.skip(8); // law_id: u64
  reader.u32(); // version: u32
  reader.bytes(); // title
  reader.optionText(); // title_en
  const chapters = readChapters(reader, immutable);
  // content_hash 紧跟 chapters，是 [u8;32]。
  const contentHash = `0x${bytesToHex(reader.raw(32))}`;
  return { chapters, contentHash };
}

/// 解码不可修改条款 manifest：`{ article_numbers: Vec<u32>, article_hashes: Vec<[u8;32]> }`。
/// 只取条号集用于「不可修改条款」徽章。
export function decodeImmutableArticles(manifestBytes: Uint8Array): number[] {
  const reader = new ScaleReader(manifestBytes);
  const count = reader.vecLen(MAX_IMMUTABLE_ARTICLES);
  const numbers: number[] = [];
  for (let i = 0; i < count; i += 1) {
    numbers.push(reader.u32());
  }
  return numbers;
}

/// 解码 `LawVersionLabel`：`{ title: Vec<u8>, title_en: Option<Vec<u8>> }`（版本展示名）。
export function decodeVersionLabel(labelBytes: Uint8Array): { cn: string; en: string | null } {
  const reader = new ScaleReader(labelBytes);
  const cn = reader.text();
  const en = reader.optionText();
  return { cn, en };
}

async function readStorage(env: Env, key: Uint8Array): Promise<Uint8Array | null> {
  const hex = await fetchChainStorage(env, `0x${bytesToHex(key)}`);
  return hex ? hexToBytes(hex) : null;
}

/// RAW 读链上宪法存储并解码为结构化文档。安全口径与节点 `constitution_getDocument` 一致：
/// 走 `state_getStorage` RAW 读（不走可被恶意升级伪造的 runtime API），只暴露已生效版。
export async function fetchConstitutionDocument(env: Env): Promise<ConstitutionDocument> {
  const cacheTtlSeconds = parsePositiveInt(
    env.CONSTITUTION_TTL_SECONDS,
    DEFAULT_CONSTITUTION_TTL_SECONDS
  );

  // 1. RAW 读 Law(0)，解出显式 effective_version。
  const lawBytes = await readStorage(
    env,
    storageMapKey(PALLET_NAME, 'Laws', encodeU64Le(CONSTITUTION_LAW_ID))
  );
  if (!lawBytes) {
    throw new HttpError(404, 'constitution_not_found', '链上宪法尚未初始化');
  }
  const version = decodeEffectiveVersion(lawBytes);
  if (version === null) {
    throw new HttpError(404, 'constitution_not_effective', '链上宪法尚无生效版本');
  }

  // 2. 并行 RAW 读该版本 LawVersion / 版本标签 / 不可修改条款 manifest。
  const [versionBytes, labelBytes, manifestBytes] = await Promise.all([
    readStorage(
      env,
      storageDoubleMapKey(
        PALLET_NAME,
        'LawVersions',
        encodeU64Le(CONSTITUTION_LAW_ID),
        encodeU32Le(version)
      )
    ),
    readStorage(
      env,
      storageDoubleMapKey(
        PALLET_NAME,
        'LawVersionLabels',
        encodeU64Le(CONSTITUTION_LAW_ID),
        encodeU32Le(version)
      )
    ),
    readStorage(env, storageValueKey(PALLET_NAME, 'ConstitutionImmutableManifest'))
  ]);

  if (!versionBytes) {
    throw new HttpError(404, 'constitution_version_missing', `链上宪法版本不存在(v${version})`);
  }

  const immutableArticles = manifestBytes ? decodeImmutableArticles(manifestBytes) : [];
  const immutableSet = new Set(immutableArticles);
  const { chapters, contentHash } = decodeVersionChapters(versionBytes, immutableSet);
  const versionLabel = labelBytes ? decodeVersionLabel(labelBytes) : null;

  return {
    ok: true,
    schema: 'citizenapp.constitution',
    version,
    content_hash: contentHash,
    version_label: versionLabel,
    immutable_articles: immutableArticles,
    chapters,
    generated_at: Date.now(),
    cache_ttl_seconds: cacheTtlSeconds
  };
}

/// KV 短缓存 key：宪法全局单文档，无需按用户分片。
const CONSTITUTION_CACHE_KEY = 'constitution_document';

/// 公开 GET /constitution：官网「公民宪法」tab 数据源。
/// 命中 KV 缓存直接返回；未命中读链解码后回写 KV，让一个 TTL 内的重复访问不再打节点。
export async function constitutionRoute(_request: Request, env: Env): Promise<Response> {
  const cached = await readCachedDocument(env);
  if (cached) {
    return documentResponse(cached);
  }

  const document = await fetchConstitutionDocument(env);
  try {
    await env.SQUARE_CACHE.put(CONSTITUTION_CACHE_KEY, JSON.stringify(document), {
      expirationTtl: document.cache_ttl_seconds
    });
  } catch {
    // 缓存写失败忽略，不影响本次返回。
  }
  return documentResponse(document);
}

async function readCachedDocument(env: Env): Promise<ConstitutionDocument | null> {
  try {
    const cached = await env.SQUARE_CACHE.get(CONSTITUTION_CACHE_KEY);
    return cached ? (JSON.parse(cached) as ConstitutionDocument) : null;
  } catch {
    return null;
  }
}

function documentResponse(document: ConstitutionDocument): Response {
  return jsonResponse(document, {
    headers: {
      'cache-control': `public, max-age=${document.cache_ttl_seconds}`
    }
  });
}
