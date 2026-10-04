import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Miniflare } from 'miniflare';
import type { Env } from '../src/types';
import { routeRequest } from '../src/routes';
import { citizenchainDownloadRoute } from '../src/citizenchain_download';
import { createTestMiniflare } from './miniflare';

interface CitizenChainPublicationInteropFixture {
  contract_version: number;
  github_repository: string;
  action_tag_field: string;
  publication_tag_field: string;
  platform: string;
  download_path: string;
  put_body_json: string;
  snapshot_json: string;
  snapshot_anchor: string;
  location: string;
}

const secret = 'citizenchain-download-test-secret-32-bytes';
const basePath = '/operations/citizenchain/download-publications/';
const downloadSchema = readFileSync(resolve(process.cwd(), 'schema/download.sql'), 'utf8');
const interopFixture = JSON.parse(readFileSync(resolve(
  process.cwd(), 'test/citizenchain_download_publication_interop_v1.json',
), 'utf8')) as CitizenChainPublicationInteropFixture;
let miniflare: Miniflare;
let env: Env;

beforeEach(async () => {
  miniflare = createTestMiniflare({
    d1Bindings: ['DB', 'CITIZENCHAIN_DOWNLOAD_DB'],
  });
  env = await miniflare.getBindings<Env>();
  (env as Env & { CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET: string })
    .CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET = secret;
  const database = env.CITIZENCHAIN_DOWNLOAD_DB;
  if (!database) throw new Error('测试缺少公民链下载数据库 binding');
  for (const statement of schemaStatements(downloadSchema)) await database.prepare(statement).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await miniflare.dispose();
});

describe('公民链官网显式发布指针', () => {
  it('公民与钱包安装器只查询准确GitHub仓库并保留失败状态', async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const downloadEnv = { HASH_KEY: 'download-route-fixture',
      RATE_READ: { limit: async () => ({ success: true }) } } as unknown as Env;
    try {
      // 请求桩只替代外网；入口、正式版筛选和失败转换均执行真实服务端路由。
      for (const product of ['citizenapp', 'citizenwallet']) {
        const location = `https://github.com/crcfrcn/${product}/releases/download/${product}-release-android-v1.0.1/${product}.apk`;
        globalThis.fetch = async (input) => {
          requests.push(String(input));
          return Response.json([{ tag_name: `${product}-release-android-v1.0.1`,
            draft: false, prerelease: false, assets: [{ name: `${product}.apk`, browser_download_url: location }] }]);
        };
        const request = new Request(`https://www.crcfrcn.com/download/${product}/android`);
        const response = await routeRequest(request, downloadEnv);
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), location);
        globalThis.fetch = async (input) => { requests.push(String(input)); return new Response(null, { status: 503 }); };
        await assert.rejects(routeRequest(request, downloadEnv), { code: 'release_lookup_failed', status: 502 });
        globalThis.fetch = async (input) => { requests.push(String(input)); return Response.json([]); };
        await assert.rejects(routeRequest(request, downloadEnv), { code: 'release_asset_not_found', status: 404 });
      }
      assert.equal(requests.length, 6);
      assert.deepEqual(requests, ['citizenapp', 'citizenwallet'].flatMap(
        product => Array(3).fill('https://api.github.com/repos/crcfrcn/' + product + '/releases?per_page=100')));
    } finally { globalThis.fetch = originalFetch; }
  });

  it('唯一基线只建立四条七字段精简空指针', async () => {
    const database = env.CITIZENCHAIN_DOWNLOAD_DB;
    if (!database) throw new Error('测试缺少公民链下载数据库 binding');
    const rows = await database.prepare(
      'SELECT * FROM citizenchain_download_publications ORDER BY platform',
    ).all<Record<string, unknown>>();
    expect(rows.results.map((row) => row.platform)).toEqual([
      'linux-amd', 'linux-arm', 'macos', 'windows',
    ]);
    expect(Object.keys(rows.results[0]).sort()).toEqual([
      'asset_name', 'asset_sha256', 'platform', 'published_at',
      'revision', 'source_sha', 'version_tag',
    ]);
    expect(rows.results.every((row) => row.revision === 0 && row.version_tag === null)).toBe(true);
    const businessTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'citizenchain_download_publications'",
    ).all();
    expect(businessTables.results).toEqual([]);
  });

  it('下载数据库最终schema可重复执行且不复制四个平台指针', async () => {
    const database = env.CITIZENCHAIN_DOWNLOAD_DB;
    if (!database) throw new Error('测试缺少公民链下载数据库 binding');
    for (const statement of schemaStatements(downloadSchema)) await database.prepare(statement).run();
    const count = await database.prepare(
      'SELECT COUNT(*) AS n FROM citizenchain_download_publications',
    ).first<{ n: number }>();
    expect(count?.n).toBe(4);
  });

  it('未显式发布时官网入口返回未发布且不查询 GitHub', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(citizenchainDownloadRoute(
      env, '/download/citizenchain/LinuxARM',
    )).rejects.toMatchObject({ code: 'release_asset_not_found', status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('产品自有publication wire golden固定互操作字段并拒绝动作域字段', async () => {
    expect(Object.keys(interopFixture).sort()).toEqual([
      'action_tag_field', 'contract_version', 'download_path', 'github_repository',
      'location', 'platform', 'publication_tag_field', 'put_body_json',
      'snapshot_anchor', 'snapshot_json',
    ]);
    expect(interopFixture).toMatchObject({
      contract_version: 1,
      github_repository: 'crcfrcn/citizenchain',
      action_tag_field: 'release_tag',
      publication_tag_field: 'version_tag',
      platform: 'macos',
      download_path: '/download/citizenchain/macOS',
    });
    const putBody = JSON.parse(interopFixture.put_body_json) as {
      expected_revision: number;
      publication: Record<string, unknown>;
    };
    const snapshot = JSON.parse(interopFixture.snapshot_json) as Record<string, unknown>;
    expect(Object.keys(putBody.publication).sort()).toEqual([
      'asset_name', 'asset_sha256', 'source_sha', 'version_tag',
    ]);
    expect(Object.keys(snapshot).sort()).toEqual([
      'asset_name', 'asset_sha256', 'platform', 'published_at',
      'revision', 'source_sha', 'version_tag',
    ]);
    expect(snapshot).not.toHaveProperty('release_tag');

    vi.spyOn(Date, 'now').mockReturnValue(Number(snapshot.published_at));
    const path = `${basePath}${interopFixture.platform}`;
    const putResponse = await routeRequest(await signedRequest(
      'PUT', path, interopFixture.put_body_json,
    ), env);
    expect(await putResponse.json()).toEqual({ ok: true, publication: snapshot });

    const getResponse = await routeRequest(await signedRequest('GET', path, ''), env);
    expect(await getResponse.json()).toEqual({ ok: true, publication: snapshot });
    const download = await citizenchainDownloadRoute(env, interopFixture.download_path);
    expect(download.headers.get('location')).toBe(interopFixture.location);

    // 只通过唯一互操作 golden 构造应被拒绝的旧动作域输入；这不是兼容读取或回退合同。
    const legacyPublication: Record<string, unknown> = {
      ...putBody.publication,
      [interopFixture.action_tag_field]: putBody.publication.version_tag,
    };
    delete legacyPublication.version_tag;
    const legacyBody = JSON.stringify({
      expected_revision: snapshot.revision,
      publication: legacyPublication,
    });
    await expect(routeRequest(await signedRequest('PUT', path, legacyBody), env))
      .rejects.toMatchObject({ code: 'publication_payload_invalid', status: 400 });
  });

  it('只切换签名请求指定的平台并生成固定 GitHub 资产地址', async () => {
    const publication = linuxArmPublication('1.0.1');
    const response = await routeRequest(await signedPut('linux-arm', {
      expected_revision: 0, publication,
    }), env);
    expect(response.status).toBe(200);
    expect((await response.json() as { publication: { revision: number } }).publication.revision).toBe(1);

    const download = await citizenchainDownloadRoute(
      env, '/download/citizenchain/LinuxARM',
    );
    expect(download.status).toBe(302);
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect(download.headers.get('location')).toBe(
      'https://github.com/crcfrcn/citizenchain/releases/download/'
      + 'citizenchain-linux-arm-v1.0.1/citizenchain-node-LinuxARM-v1.0.1.deb',
    );
    await expect(citizenchainDownloadRoute(
      env, '/download/citizenchain/LinuxAMD',
    )).rejects.toMatchObject({ code: 'release_asset_not_found' });
  });

  it('四端标准公开路径精确映射到既有发布指针并拒绝全部旧入口', async () => {
    const cases = [
      {
        platform: 'macos', path: '/download/citizenchain/macOS',
        tag: 'citizenchain-macos-v1.2.3',
        asset: 'citizenchain-node-macOS-v1.2.3.dmg',
      },
      {
        platform: 'windows', path: '/download/citizenchain/Windows',
        tag: 'citizenchain-windows-v1.2.3',
        asset: 'citizenchain-node-Windows-v1.2.3.exe',
      },
      {
        platform: 'linux-arm', path: '/download/citizenchain/LinuxARM',
        tag: 'citizenchain-linux-arm-v1.2.3',
        asset: 'citizenchain-node-LinuxARM-v1.2.3.deb',
      },
      {
        platform: 'linux-amd', path: '/download/citizenchain/LinuxAMD',
        tag: 'citizenchain-linux-amd-v1.2.3',
        asset: 'citizenchain-node-LinuxAMD-v1.2.3.deb',
      },
    ] as const;
    for (const item of cases) {
      const publication = {
        version_tag: item.tag,
        source_sha: 'a'.repeat(40),
        asset_name: item.asset,
        asset_sha256: 'b'.repeat(64),
      };
      await routeRequest(await signedPut(
        item.platform, { expected_revision: 0, publication },
      ), env);
      const response = await citizenchainDownloadRoute(env, item.path);
      expect(response.headers.get('location')).toBe(
        `https://github.com/crcfrcn/citizenchain/releases/download/${item.tag}/${item.asset}`,
      );
    }
    for (const oldPath of [
      '/download/citizenchain/macos' + '-arm64',
      '/download/citizenchain/windows-x86_64',
      '/download/citizenchain/linux-arm64',
      '/download/citizenchain/linux-amd64',
      '/download/citizenchain/linux-arm',
      '/download/citizenchain/linux-amd',
    ]) {
      await expect(citizenchainDownloadRoute(env, oldPath))
        .rejects.toMatchObject({ code: 'download_not_found', status: 404 });
    }
  });

  it('同一内容重试幂等，旧 revision 不得覆盖新指针', async () => {
    const publication = linuxArmPublication('1.0.1');
    await routeRequest(await signedPut('linux-arm', { expected_revision: 0, publication }), env);
    const repeated = await routeRequest(
      await signedPut('linux-arm', { expected_revision: 0, publication }), env,
    );
    expect((await repeated.json() as { publication: { revision: number } }).publication.revision).toBe(1);
    await expect(routeRequest(await signedPut('linux-arm', {
      expected_revision: 0, publication: linuxArmPublication('1.0.2'),
    }), env)).rejects.toMatchObject({ code: 'publication_revision_conflict', status: 409 });
  });

  it('平台、Tag、资产名和摘要必须完全一致', async () => {
    await expect(routeRequest(await signedPut('linux-arm', {
      expected_revision: 0,
      publication: {
        ...linuxArmPublication('1.0.1'),
        asset_name: 'citizenchain-node-LinuxAMD-v1.0.1.deb',
      },
    }), env)).rejects.toMatchObject({ code: 'publication_identity_invalid' });
    // 旧架构拼接式资产即使与原平台 Tag 匹配，也不能重新进入正式 publication。
    for (const legacy of [
      {
        platform: 'linux-arm', tag: 'citizenchain-linux-arm-v1.0.1',
        asset: 'citizenchain-node-linux-arm64-v1.0.1.deb',
      },
      {
        platform: 'linux-amd', tag: 'citizenchain-linux-amd-v1.0.1',
        asset: 'citizenchain-node-linux-amd64-v1.0.1.deb',
      },
      {
        platform: 'macos', tag: 'citizenchain-macos-v1.0.1',
        asset: 'citizenchain-node-macos' + '-arm64-v1.0.1.dmg',
      },
      {
        platform: 'windows', tag: 'citizenchain-windows-v1.0.1',
        asset: 'citizenchain-node-windows-x86_64-v1.0.1.exe',
      },
    ] as const) {
      await expect(routeRequest(await signedPut(legacy.platform, {
        expected_revision: 0,
        publication: {
          version_tag: legacy.tag,
          source_sha: 'a'.repeat(40),
          asset_name: legacy.asset,
          asset_sha256: 'b'.repeat(64),
        },
      }), env)).rejects.toMatchObject({ code: 'publication_identity_invalid' });
    }
    await expect(routeRequest(await signedPut('linux-arm', {
      expected_revision: 0,
      publication: { ...linuxArmPublication('1.0.1'), asset_sha256: 'bad' },
    }), env)).rejects.toMatchObject({ code: 'publication_digest_invalid' });
  });

  // 完整产品Tag与Node资产名称各有职责，旧拆分Tag即使配正确资产也必须拒绝。
  it('拒绝四个平台的旧Node拆分Tag', async () => {
    for (const [platform, asset] of [
      ['linux-arm', 'citizenchain-node-LinuxARM-v1.0.1.deb'],
      ['linux-amd', 'citizenchain-node-LinuxAMD-v1.0.1.deb'],
      ['macos', 'citizenchain-node-macOS-v1.0.1.dmg'],
      ['windows', 'citizenchain-node-Windows-v1.0.1.exe'],
    ] as const) {
      await expect(routeRequest(await signedPut(platform, {
        expected_revision: 0,
        publication: { version_tag: `citizenchain-node-${platform}-v1.0.1`,
          source_sha: 'a'.repeat(40), asset_name: asset, asset_sha256: 'b'.repeat(64) },
      }), env)).rejects.toMatchObject({ code: 'publication_identity_invalid' });
    }
  });

  it('回滚到空指针仍推进 revision，旧首次发布请求不能重放', async () => {
    const publication = linuxArmPublication('1.0.1');
    await routeRequest(await signedPut('linux-arm', { expected_revision: 0, publication }), env);
    const rollback = await routeRequest(
      await signedPut('linux-arm', { expected_revision: 1, publication: null }), env,
    );
    expect((await rollback.json() as { publication: { revision: number } }).publication.revision).toBe(2);
    await expect(citizenchainDownloadRoute(
      env, '/download/citizenchain/LinuxARM',
    )).rejects.toMatchObject({ code: 'release_asset_not_found' });
    await expect(routeRequest(
      await signedPut('linux-arm', { expected_revision: 0, publication }), env,
    )).rejects.toMatchObject({ code: 'publication_revision_conflict' });
  });

  it('错误或过期的产品发布签名在读取D1前拒绝', async () => {
    const path = `${basePath}macos`;
    const invalid = new Request(`https://worker.test/api${path}`, {
      headers: {
        'x-citizenserve-request-time': String(Date.now()),
        'x-citizenserve-request-nonce': '11'.repeat(16),
        'x-citizenserve-request-signature': '00'.repeat(32),
      },
    });
    await expect(routeRequest(invalid, env)).rejects.toMatchObject({
      code: 'publication_signature_invalid', status: 401,
    });
    const expired = await signedRequest('GET', path, '', Date.now() - 6 * 60 * 1000);
    await expect(routeRequest(expired, env)).rejects.toMatchObject({
      code: 'publication_signature_invalid', status: 401,
    });
  });

  it('macOS updater 与安装包严格共用同一发布指针', async () => {
    const publication = {
      version_tag: 'citizenchain-macos-v1.2.3',
      source_sha: 'a'.repeat(40),
      asset_name: 'citizenchain-node-macOS-v1.2.3.dmg',
      asset_sha256: 'b'.repeat(64),
    };
    await routeRequest(await signedPut('macos', { expected_revision: 0, publication }), env);
    const updater = await citizenchainDownloadRoute(
      env, '/download/citizenchain/macOS/updater',
    );
    expect(updater.headers.get('location')).toBe(
      'https://github.com/crcfrcn/citizenchain/releases/download/'
      + 'citizenchain-macos-v1.2.3/citizenchain-node-latest-macOS.json',
    );
    await expect(citizenchainDownloadRoute(
      env, '/download/citizenchain/macos' + '-arm64-updater',
    )).rejects.toMatchObject({ code: 'download_not_found', status: 404 });
  });
});

function linuxArmPublication(version: string) {
  return {
    version_tag: `citizenchain-linux-arm-v${version}`,
    source_sha: 'a'.repeat(40),
    asset_name: `citizenchain-node-LinuxARM-v${version}.deb`,
    asset_sha256: 'b'.repeat(64),
  };
}

async function signedPut(platform: string, value: unknown): Promise<Request> {
  const body = JSON.stringify(value);
  return signedRequest('PUT', `${basePath}${platform}`, body);
}

async function signedRequest(
  method: string,
  path: string,
  body: string,
  timestamp = Date.now(),
): Promise<Request> {
  const nonce = '12'.repeat(16);
  const bodyHash = await sha256Hex(new TextEncoder().encode(body));
  const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = bytesHex(new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(canonical),
  )));
  const headers: Record<string, string> = {
    'x-citizenserve-request-time': String(timestamp),
    'x-citizenserve-request-nonce': nonce,
    'x-citizenserve-request-signature': signature,
  };
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(new TextEncoder().encode(body).byteLength);
  }
  return new Request(`https://worker.test/api${path}`, {
    method,
    headers,
    body: body || undefined,
  });
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', Uint8Array.from(value).buffer,
  )));
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function schemaStatements(value: string): string[] {
  return value.split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}
