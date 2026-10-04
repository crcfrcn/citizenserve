import type { Env } from './types';
import { HttpError, jsonResponse } from './shared/http';
import { readLimitedJson } from './limits/request';

export type CitizenchainDownloadPlatform = 'linux-arm' | 'linux-amd' | 'macos' | 'windows';

interface PublicationRow {
  platform: CitizenchainDownloadPlatform;
  version_tag: string | null;
  source_sha: string | null;
  asset_name: string | null;
  asset_sha256: string | null;
  revision: number;
  published_at: number | null;
}

interface PublicationInput {
  version_tag: string;
  source_sha: string;
  asset_name: string;
  asset_sha256: string;
}

interface UpdateInput {
  expected_revision: number;
  publication: PublicationInput | null;
}

const publicationPrefix = '/operations/citizenchain/download-publications/';
// 正式下载仓库必须与GMB产品发布身份完全一致。
const githubDownloadPrefix = 'https://github.com/crcfrcn/citizenchain/releases/download/';
const maxClockSkewMs = 5 * 60 * 1000;

// URL 平台段使用统一公开名称；Map 值只是在 D1 和发布事务中沿用的内部记录键。
const downloadPlatforms = new Map<string, CitizenchainDownloadPlatform>([
  ['/download/citizenchain/macOS', 'macos'],
  ['/download/citizenchain/macOS/updater', 'macos'],
  ['/download/citizenchain/Windows', 'windows'],
  ['/download/citizenchain/LinuxARM', 'linux-arm'],
  ['/download/citizenchain/LinuxAMD', 'linux-amd'],
]);

// Release Tag绑定完整公民链及真实平台；资产名保留既有Node软件合同，旧拆分Tag拒绝。
const platformContracts: Readonly<Record<CitizenchainDownloadPlatform, {
  tag: RegExp;
  asset: (version: string) => string;
}>> = {
  'linux-arm': {
    tag: /^citizenchain-linux-arm-v(\d+\.\d{1,2}\.\d{1,2})$/,
    asset: (version) => `citizenchain-node-LinuxARM-v${version}.deb`,
  },
  'linux-amd': {
    tag: /^citizenchain-linux-amd-v(\d+\.\d{1,2}\.\d{1,2})$/,
    asset: (version) => `citizenchain-node-LinuxAMD-v${version}.deb`,
  },
  macos: {
    tag: /^citizenchain-macos-v(\d+\.\d{1,2}\.\d{1,2})$/,
    asset: (version) => `citizenchain-node-macOS-v${version}.dmg`,
  },
  windows: {
    tag: /^citizenchain-windows-v(\d+\.\d{1,2}\.\d{1,2})$/,
    asset: (version) => `citizenchain-node-Windows-v${version}.exe`,
  },
};

export function isCitizenchainDownloadPath(path: string): boolean {
  return downloadPlatforms.has(path);
}

export function isCitizenchainPublicationPath(path: string): boolean {
  return path.startsWith(publicationPrefix) && parsePlatform(path) !== null;
}

export async function citizenchainDownloadRoute(env: Env, path: string): Promise<Response> {
  const platform = downloadPlatforms.get(path);
  if (!platform) throw new HttpError(404, 'download_not_found', '下载项不存在');
  const row = await readPublication(env, platform);
  if (!isPublished(row)) {
    throw new HttpError(404, 'release_asset_not_found', '正式安装包尚未发布');
  }
  validatePublication(platform, row);
  const assetName = path.endsWith('/updater')
    ? 'citizenchain-node-latest-macOS.json'
    : row.asset_name;
  const location = `${githubDownloadPrefix}${encodeURIComponent(row.version_tag)}/${encodeURIComponent(assetName)}`;
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  });
}

export async function citizenchainPublicationRoute(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const platform = parsePlatform(path);
  if (!platform) throw new HttpError(404, 'publication_target_not_found', '发布目标不存在');
  await requireCitizenServeRequestSignature(request, env, path);
  if (request.method === 'GET') {
    return jsonResponse({ ok: true, publication: await readPublication(env, platform) });
  }
  if (request.method !== 'PUT') {
    throw new HttpError(405, 'method_not_allowed', '发布指针方法不受支持');
  }
  const input = await readLimitedJson<UpdateInput>(request);
  assertExactKeys(input, ['expected_revision', 'publication'], '发布指针请求');
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
    throw new HttpError(400, 'publication_revision_invalid', '发布指针 revision 无效');
  }
  if (input.publication !== null) {
    assertExactKeys(
      input.publication,
      ['version_tag', 'source_sha', 'asset_name', 'asset_sha256'],
      '发布指针',
    );
    validatePublication(platform, { platform, ...input.publication });
  }
  const current = await readPublication(env, platform);
  if (samePublication(current, input.publication)) {
    return jsonResponse({ ok: true, publication: current });
  }
  if (current.revision !== input.expected_revision) {
    throw new HttpError(409, 'publication_revision_conflict', '发布指针已被其它事务更新');
  }
  const nextRevision = current.revision + 1;
  const publishedAt = input.publication === null ? null : Date.now();
  const value = input.publication;
  const result = await requireDownloadDatabase(env).prepare(
    `UPDATE citizenchain_download_publications
      SET version_tag = ?, source_sha = ?, asset_name = ?, asset_sha256 = ?,
          revision = ?, published_at = ?
      WHERE platform = ? AND revision = ?`,
  ).bind(
    value?.version_tag ?? null,
    value?.source_sha ?? null,
    value?.asset_name ?? null,
    value?.asset_sha256 ?? null,
    nextRevision,
    publishedAt,
    platform,
    current.revision,
  ).run();
  if (result.meta.changes !== 1) {
    throw new HttpError(409, 'publication_revision_conflict', '发布指针已被其它事务更新');
  }
  return jsonResponse({
    ok: true,
    publication: {
      platform,
      version_tag: value?.version_tag ?? null,
      source_sha: value?.source_sha ?? null,
      asset_name: value?.asset_name ?? null,
      asset_sha256: value?.asset_sha256 ?? null,
      revision: nextRevision,
      published_at: publishedAt,
    } satisfies PublicationRow,
  });
}

async function readPublication(
  env: Env,
  platform: CitizenchainDownloadPlatform,
): Promise<PublicationRow> {
  const row = await requireDownloadDatabase(env).prepare(
    `SELECT platform, version_tag, source_sha, asset_name, asset_sha256, revision, published_at
      FROM citizenchain_download_publications WHERE platform = ?`,
  ).bind(platform).first<PublicationRow>();
  if (!row || row.platform !== platform || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new HttpError(503, 'publication_state_unavailable', '正式安装包发布状态不可用');
  }
  return row;
}

function requireDownloadDatabase(env: Env): D1Database {
  const database = env.CITIZENCHAIN_DOWNLOAD_DB;
  if (!database) {
    throw new HttpError(503, 'publication_state_unavailable', '公民链下载数据库尚未配置');
  }
  return database;
}

function validatePublication(
  platform: CitizenchainDownloadPlatform,
  publication: Partial<PublicationRow> | PublicationInput,
): void {
  const tag = String(publication.version_tag ?? '');
  const version = platformContracts[platform].tag.exec(tag)?.[1];
  if (!version || publication.asset_name !== platformContracts[platform].asset(version)) {
    throw new HttpError(400, 'publication_identity_invalid', 'Release Tag 或安装包名称与平台不匹配');
  }
  if (!/^[0-9a-f]{40}$/.test(String(publication.source_sha ?? ''))
    || !/^[0-9a-f]{64}$/.test(String(publication.asset_sha256 ?? ''))) {
    throw new HttpError(400, 'publication_digest_invalid', '发布源码或安装包摘要无效');
  }
}

function isPublished(row: PublicationRow): row is PublicationRow & {
  version_tag: string;
  source_sha: string;
  asset_name: string;
  asset_sha256: string;
  published_at: number;
} {
  return row.version_tag !== null && row.source_sha !== null && row.asset_name !== null
    && row.asset_sha256 !== null && row.published_at !== null;
}

function samePublication(row: PublicationRow, value: PublicationInput | null): boolean {
  if (value === null) return !isPublished(row);
  return row.version_tag === value.version_tag && row.source_sha === value.source_sha
    && row.asset_name === value.asset_name && row.asset_sha256 === value.asset_sha256;
}

function parsePlatform(path: string): CitizenchainDownloadPlatform | null {
  if (!path.startsWith(publicationPrefix)) return null;
  const value = path.slice(publicationPrefix.length);
  return Object.hasOwn(platformContracts, value) ? value as CitizenchainDownloadPlatform : null;
}

async function requireCitizenServeRequestSignature(request: Request, env: Env, path: string): Promise<void> {
  const secret = env.CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET;
  const timestamp = request.headers.get('x-citizenserve-request-time') ?? '';
  const nonce = request.headers.get('x-citizenserve-request-nonce') ?? '';
  const signature = request.headers.get('x-citizenserve-request-signature') ?? '';
  const timestampValue = Number(timestamp);
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new HttpError(503, 'publication_auth_unavailable', '发布指针认证尚未配置');
  }
  if (!Number.isSafeInteger(timestampValue) || Math.abs(Date.now() - timestampValue) > maxClockSkewMs
    || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new HttpError(401, 'publication_signature_invalid', '发布指针签名无效');
  }
  const body = await request.clone().arrayBuffer();
  const bodyHash = await digestHex(body);
  const canonical = `${request.method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const verified = await crypto.subtle.verify(
    'HMAC', key, hexBytes(signature), new TextEncoder().encode(canonical),
  );
  if (!verified) throw new HttpError(401, 'publication_signature_invalid', '发布指针签名无效');
}

async function digestHex(value: ArrayBuffer): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexBytes(value: string): ArrayBuffer {
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16),
  ).buffer;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new HttpError(400, 'publication_payload_invalid', `${label}字段集合无效`);
  }
}
