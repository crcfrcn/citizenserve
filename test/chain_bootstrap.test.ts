import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildChainBootstrapResponse,
  buildCitizenSdkBootstrapResponse,
} from '../src/chain/bootstrap';
import { routeRequest } from '../src/routes';
import type { Env } from '../src/types';

const bootnodeA =
  '/dns4/nrcgch.crcfrcn.com/tcp/30333/wss/p2p/12D3KooWHepcMGD3h9VC1XNWmrac3pXo63RimV5jhTU2nC2TLAyS';
const bootnodeB =
  '/dns4/prczss.crcfrcn.com/tcp/30333/wss/p2p/12D3KooWPjWNXvCzPv6PPuiGnF3J5uToW3ySfaB7rKkwUrN2CALv';
const testGenesisHash = `0x${'11'.repeat(32)}`;
const testStateRoot = `0x${'22'.repeat(32)}`;
// 金标由CitizenSDK所有者测试目录持有；单独检出服务端时只读同一不可变Git提交。
let citizenSdkFixture: ReturnType<typeof buildCitizenSdkBootstrapResponse>;
beforeAll(async () => {
  const url = 'https://raw.githubusercontent.com/crcfrcn/citizensdk/'
    + '52b83f8f33a9424f3a92161da4f183678263ab7c/test/node/citizensdk_bootstrap_manifest.json';
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('SDK固定金标取得失败');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('SDK金标尺寸无效');
  citizenSdkFixture = JSON.parse(text) as ReturnType<typeof buildCitizenSdkBootstrapResponse>;
}, 35_000);

function normalizedCitizenSdkResponse(
  value: ReturnType<typeof buildCitizenSdkBootstrapResponse>,
): ReturnType<typeof buildCitizenSdkBootstrapResponse> {
  return { ...value, generated_at: citizenSdkFixture.generated_at };
}

function expectCitizenSdkExactKeys(value: ReturnType<typeof buildCitizenSdkBootstrapResponse>): void {
  expect(Object.keys(value).sort()).toEqual([
    'cache_ttl_seconds', 'chain', 'generated_at', 'light_client',
    'ok', 'p2p', 'schema', 'security',
  ]);
  expect(Object.keys(value.chain).sort()).toEqual([
    'chain_id', 'genesis_hash', 'protocol_id', 'ss58_format',
    'state_root', 'token_decimals', 'token_symbol',
  ]);
  expect(Object.keys(value.light_client).sort()).toEqual([
    'api_is_truth', 'bundled_assets_required', 'mode', 'truth_source',
  ]);
  expect(Object.keys(value.p2p).sort()).toEqual(['bootnodes', 'min_peer_count_hint']);
  expect(Object.keys(value.security).sort()).toEqual([
    'exposes_private_key_material', 'exposes_rpc_url', 'rpc_proxy', 'validator_rpc_public',
  ]);
}

describe('chain bootstrap manifest', () => {
  it('returns the exact running Worker version for deployment verification', async () => {
    const response = await routeRequest(
      new Request('https://worker.test/health'),
      env({ CF_VERSION_METADATA: { id: 'candidate-version', tag: '', timestamp: '2026-08-03T00:00:00Z' } })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: 'citizenapp',
      worker_version_id: 'candidate-version',
      // 测试环境没有链 RPC；健康接口必须明确报告投影不可用，不能伪造为已就绪。
      identity_projection_status: 'unavailable',
      finalized_block_number: null,
      cursor_block_number: null,
    });
  });

  it('returns a light-node bootstrap manifest without exposing RPC', () => {
    const response = buildChainBootstrapResponse(
      new Request('https://api.onchina.org/api/chain/bootstrap'),
      env({
        CHAIN_BOOTNODES: `${bootnodeA}\n${bootnodeB}\n${bootnodeA}`,
        BOOT_TTL_SECONDS: '120',
        CHAIN_URL: 'https://rpc.internal.example',
        CHAIN_ID: 'worker-rpc.access',
        CHAIN_SECRET: 'test-access-secret'
      })
    );

    expect(response.schema).toBe('citizenapp.chain.bootstrap');
    expect(response.chain.ss58_format).toBe(2027);
    expect(response.light_client.mode).toBe('smoldot');
    expect(response.light_client.api_is_truth).toBe(false);
    expect(response.light_client).toEqual({
      mode: 'smoldot',
      truth_source: 'p2p_finalized_storage',
      api_is_truth: false,
      bundled_assets_required: ['assets/chainspec.json', 'assets/light_sync_state.json']
    });
    expect(response.p2p.bootnodes).toEqual([bootnodeA, bootnodeB]);
    expect(response.services.square_base_url).toBe('https://api.onchina.org/api/square');
    expect(response.services.media_base_url).toBe('https://api.onchina.org/api/square/media');
    expect(response.services.signed_extrinsic_relay.enabled).toBe(false);
    expect(response.services.signed_extrinsic_relay.path).toBeNull();
    expect(response.security.rpc_proxy).toBe(false);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('rpc.internal.example');
    expect(serialized).not.toContain('checkpoint');
    expect(serialized).not.toContain('light_sync_state_url');
    expect(serialized).not.toContain('light_sync_state_sha256');
  });

  it('exposes only the signed extrinsic relay path when the relay is enabled', () => {
    const response = buildChainBootstrapResponse(
      new Request('https://api.onchina.org/api/chain/bootstrap'),
      env({
        RELAY_ENABLED: '1',
        CHAIN_URL: 'https://rpc.internal.example',
        CHAIN_ID: 'worker-rpc.access',
        CHAIN_SECRET: 'test-access-secret'
      })
    );

    expect(response.services.signed_extrinsic_relay).toEqual({
      enabled: true,
      path: '/chain/extrinsics/relay'
    });
    expect(JSON.stringify(response)).not.toContain('rpc.internal.example');
  });

  it('keeps the relay disabled when the Access service token is incomplete', () => {
    const response = buildChainBootstrapResponse(
      new Request('https://api.onchina.org/api/chain/bootstrap'),
      env({
        RELAY_ENABLED: '1',
        CHAIN_URL: 'https://rpc.internal.example',
        CHAIN_ID: 'worker-rpc.access'
      })
    );

    expect(response.services.signed_extrinsic_relay).toEqual({
      enabled: false,
      path: null
    });
  });

  it('falls back to bundled chainspec bootNodes when Worker config is empty', () => {
    const response = buildChainBootstrapResponse(
      new Request('https://worker.test/chain/bootstrap'),
      env()
    );

    expect(response.p2p.bootnodes).toEqual([]);
    expect(response.p2p.bootnodes_source).toBe('bundled_chainspec');
    expect(Object.keys(response.light_client).sort()).toEqual(
      ['api_is_truth', 'bundled_assets_required', 'mode', 'truth_source'].sort()
    );
    expect(response.services.square_base_url).toBe('https://worker.test/square');
  });

  it('routes production GET /api/chain/bootstrap with cache headers', async () => {
    const response = await routeRequest(
      new Request('https://api.onchina.org/api/chain/bootstrap'),
      env({ BOOT_TTL_SECONDS: '90' })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=90');
    const body = (await response.json()) as { schema: string; ok: boolean };
    expect(body).toMatchObject({
      ok: true,
      schema: 'citizenapp.chain.bootstrap'
    });
  });

  it('routes an SDK-only bootstrap without host product services', async () => {
    const sdkEnvironment = env({
      BOOT_TTL_SECONDS: '300',
      CHAIN_BOOTNODES: `${bootnodeA}\n${bootnodeB}`,
    });
    const direct = buildCitizenSdkBootstrapResponse(
      new Request('https://api.onchina.org/api/chain/citizensdk/bootstrap'),
      sdkEnvironment,
    );
    expect(normalizedCitizenSdkResponse(direct)).toStrictEqual(citizenSdkFixture);
    expectCitizenSdkExactKeys(direct);
    expect(direct).not.toHaveProperty('services');
    expect(direct).not.toHaveProperty('degradation');
    expect(direct.chain).not.toHaveProperty('chain_name');
    expect(direct.chain).not.toHaveProperty('chain_type');
    expect(direct.p2p).not.toHaveProperty('bootnodes_source');

    const response = await routeRequest(
      new Request('https://api.onchina.org/api/chain/citizensdk/bootstrap'),
      sdkEnvironment,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await response.json() as ReturnType<typeof buildCitizenSdkBootstrapResponse>;
    expect(normalizedCitizenSdkResponse(body)).toStrictEqual(citizenSdkFixture);
    expectCitizenSdkExactKeys(body);
  });

  it('fails closed when the public chain identity is missing or invalid', () => {
    const request = new Request('https://worker.test/chain/bootstrap');
    expect(() => buildChainBootstrapResponse(
      request,
      env({ CHAIN_GENESIS_HASH: '' }),
    )).toThrow('CHAIN_GENESIS_HASH');
    expect(() => buildChainBootstrapResponse(
      request,
      env({ CHAIN_STATE_ROOT: '0x1234' }),
    )).toThrow('CHAIN_STATE_ROOT');
  });
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    SQUARE_PRIVATE: {} as R2Bucket,
    SQUARE_PUBLIC_MEDIA: {} as R2Bucket,
    SQUARE_CACHE: {} as KVNamespace,
    CHAIN_GENESIS_HASH: testGenesisHash,
    CHAIN_STATE_ROOT: testStateRoot,
    ...overrides
  };
}
