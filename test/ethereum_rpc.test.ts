import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleEthereumRpc } from '../src/chain/ethereum_rpc';
import worker from '../src/index';
import type { Env } from '../src/types';

type Reply = { jsonrpc: string; id: string | number | null; result?: unknown; error?: { code: number; message: string } };
const rpcBody = async (response: Response): Promise<Reply> => await response.json() as Reply;

const recipient = '0x' + '12'.repeat(20);
const txHash = '0x' + '34'.repeat(32);
const rpc = (method = 'eth_chainId', params: unknown[] = [], id: number | string = 1) =>
  ({ jsonrpc: '2.0', method, params, id });
function setup() {
  const read = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const write = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const env = { CHAIN_URL: 'https://protected.example.test/private-route', CHAIN_ID: 'fixture-access-id',
    CHAIN_SECRET: 'fixture-access-secret', HASH_KEY: 'fixture-ip-hash', RATE_READ: { limit: read }, RATE_WRITE: { limit: write } } as unknown as Env;
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const reply = (item: ReturnType<typeof rpc>) => ({ jsonrpc: '2.0', id: item.id,
      result: item.method === 'eth_chainId' ? '0x7eb' : item.method === 'net_version' ? '2027' : txHash });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply).reverse() : reply(body)), {
      headers: { 'set-cookie': 'private=fixture', 'x-upstream': 'private-origin' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const request = (payload: unknown, init: RequestInit = {}, url = 'https://rpc.crcfrcn.com/') => new Request(url, {
    method: 'POST', body: JSON.stringify(payload), ...init,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.8', ...init.headers },
  });
  return { env, read, write, fetch, request };
}
afterEach(() => vi.unstubAllGlobals());

describe('公民链公共钱包 RPC', () => {
  it('从真实上游读取链身份，凭据只随服务端请求发送', async () => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(rpc()), t.env);
    expect(await result.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x7eb' });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = t.fetch.mock.calls[0];
    expect(url).toBe(t.env.CHAIN_URL);
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ 'CF-Access-Client-Id': 'fixture-access-id', 'CF-Access-Client-Secret': 'fixture-access-secret' });
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
    expect(result.headers.has('access-control-allow-credentials')).toBe(false);
    expect(result.headers.has('set-cookie')).toBe(false);
    expect(result.headers.has('x-upstream')).toBe(false);
  });
  it('按请求 ID 还原逆序批量响应，一批只有一次上游调用', async () => {
    const t = setup();
    const result = await handleEthereumRpc(t.request([rpc('eth_chainId', [], 1), rpc('net_version', [], '1')]), t.env);
    expect(await result.json()).toEqual([{ jsonrpc: '2.0', id: 1, result: '0x7eb' }, { jsonrpc: '2.0', id: '1', result: '2027' }]);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.read).toHaveBeenCalledTimes(2);
  });
  it('已签名交易受写预算限制，不接受客户端覆盖上游凭据', async () => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(rpc('eth_sendRawTransaction', ['0x1234']), {
      headers: { 'CF-Access-Client-Id': 'client-id', 'CF-Access-Client-Secret': 'client-secret', 'x-forwarded-for': '1.1.1.1' },
    }), t.env);
    expect(result.status).toBe(200);
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(t.fetch.mock.calls[0][1].headers).toMatchObject({ 'CF-Access-Client-Secret': 'fixture-access-secret' });
    expect(t.read.mock.calls[0][0].key).toMatch(/^ethereum_rpc:[0-9a-f]{32}$/);
  });
  it.each(['eth_sendTransaction', 'personal_sign', 'admin_peers', 'debug_traceTransaction', 'author_submitExtrinsic', 'state_getStorage', 'eth_subscribe'])('拒绝危险或非公开方法 %s', async method => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(rpc(method)), t.env);
    expect((await rpcBody(result)).error!.code).toBe(-32601);
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('混合批量只转发有效项，错误项保留自己的 ID', async () => {
    const t = setup();
    const result = await handleEthereumRpc(t.request([rpc('eth_sendTransaction', [], 1), rpc('eth_chainId', [], 2)]), t.env);
    const body = await result.json() as Reply[];
    expect(body[0].error!.code).toBe(-32601);
    expect(body[1].result).toBe('0x7eb');
    expect(JSON.parse(t.fetch.mock.calls[0][1].body as string)).toEqual([rpc('eth_chainId', [], 2)]);
  });
  it.each([
    ['eth_sendRawTransaction', ['0x']], ['eth_sendRawTransaction', ['0x123']], ['eth_sendRawTransaction', ['0xzz']],
    ['eth_getBalance', [recipient]], ['eth_getBalance', ['invalid', 'latest']],
    ['eth_feeHistory', ['0x401', 'latest', []]], ['eth_feeHistory', ['0x1', 'latest', [50, 1]]],
    ['eth_getLogs', [{}]], ['eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x3e8' }]],
    ['eth_getLogs', [{ blockHash: txHash, fromBlock: '0x0' }]],
    ['eth_call', [{ to: recipient, arbitrary: true }, 'latest']],
    ['eth_estimateGas', [{}]],
  ])('拒绝参数错误及无界查询 %s %j', async (method, params) => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(rpc(method as string, params as unknown[])), t.env);
    expect((await rpcBody(result)).error!.code).toBe(-32602);
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['eth_getBalance', [recipient, 'latest']], ['eth_getCode', [recipient, 'latest']],
    ['eth_getStorageAt', [recipient, '0x0', 'latest']], ['eth_getTransactionCount', [recipient, 'pending']],
    ['eth_estimateGas', [{ from: recipient, to: recipient, value: '0x1' }]],
    ['eth_call', [{ to: recipient, data: '0x1234' }, 'latest']],
    ['eth_feeHistory', ['0x400', 'latest', [0, 50, 100]]],
    ['eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x3e7', address: recipient, topics: [null, [txHash]] }]],
    ['eth_getLogs', [{ blockHash: txHash }]],
    ['eth_estimateGas', [{ data: '0x1234', value: '0x0' }]],
    ['eth_getBlockByHash', [txHash, false]], ['eth_getBlockByNumber', ['latest', false]],
    ['eth_getBlockTransactionCountByHash', [txHash]], ['eth_getBlockTransactionCountByNumber', ['latest']],
    ['eth_getTransactionByBlockHashAndIndex', [txHash, '0x0']], ['eth_getTransactionByBlockNumberAndIndex', ['latest', '0x0']],
    ['eth_getTransactionByHash', [txHash]], ['eth_getTransactionReceipt', [txHash]],
    ['eth_accounts', []], ['eth_blockNumber', []], ['eth_gasPrice', []], ['eth_maxPriorityFeePerGas', []],
    ['eth_syncing', []], ['net_listening', []], ['web3_clientVersion', []],
  ])('转发钱包有效查询 %s', async (method, params) => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(rpc(method as string, params as unknown[])), t.env);
    expect(result.status).toBe(200);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect((await rpcBody(result)).result).toBe(txHash);
  });
  it.each([[], Array.from({ length: 21 }, (_, id) => rpc('eth_chainId', [], id)), [rpc(), rpc()],
    { jsonrpc: '2.0', method: 'eth_chainId' }, rpc('eth_chainId', [], Number.MAX_SAFE_INTEGER + 1)])('拒绝无效批量、通知或 ID %j', async payload => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(payload), t.env);
    expect((await rpcBody(result)).error).toBeDefined();
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('实际流式请求超过 64KiB 即拒绝', async () => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(rpc('eth_sendRawTransaction', ['0x' + '12'.repeat(33 * 1024)])), t.env);
    expect(result.status).toBe(413);
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it.each(['{', '\ufffd'])('拒绝错误 JSON %s', async body => {
    const t = setup();
    const result = await handleEthereumRpc(t.request(null, { body }), t.env);
    expect((await rpcBody(result)).error!.code).toBe(-32700);
  });
  it('读限流、写限流以及缺失边缘身份均不调用上游', async () => {
    for (const kind of ['read', 'write', 'ip', 'binding']) {
      const t = setup();
      if (kind === 'read') t.read.mockResolvedValue({ success: false });
      if (kind === 'write') t.write.mockResolvedValue({ success: false });
      if (kind === 'binding') delete (t.env as unknown as { RATE_READ?: unknown }).RATE_READ;
      const request = t.request(rpc('eth_sendRawTransaction', ['0x1234']));
      if (kind === 'ip') request.headers.delete('cf-connecting-ip');
      const result = await handleEthereumRpc(request, t.env);
      expect(result.status).toBe(['read', 'write'].includes(kind) ? 429 : 503);
      expect(t.fetch).not.toHaveBeenCalled();
    }
  });
  it.each([
    { jsonrpc: '2.0', id: 2, result: '0x7eb' }, { jsonrpc: '2.0', id: 1, result: '0x1' },
    { jsonrpc: '2.0', id: 1, result: '0x7eb', error: null }, { jsonrpc: '2.0', id: 1 },
  ])('拒绝错 ID、错链及畸形上游 %j', async payload => {
    const t = setup();
    t.fetch.mockImplementation(async () => new Response(JSON.stringify(payload)));
    const result = await handleEthereumRpc(t.request(rpc()), t.env);
    expect(result.status).toBe(502);
  });
  it('上游重复、缺失及错误批量 ID 都拒绝', async () => {
    for (const payload of [[{ jsonrpc: '2.0', id: 1, result: '0x7eb' }],
      [{ jsonrpc: '2.0', id: 1, result: '0x7eb' }, { jsonrpc: '2.0', id: 1, result: '2027' }]]) {
      const t = setup();
      t.fetch.mockImplementation(async () => new Response(JSON.stringify(payload)));
      expect((await handleEthereumRpc(t.request([rpc(), rpc('net_version', [], 2)]), t.env)).status).toBe(502);
    }
  });
  it('上游业务错误不回显内部信息', async () => {
    const t = setup();
    t.fetch.mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1,
      error: { code: -32000, message: 'fixture-access-secret private-route', data: 'private-path' } })));
    const result = await handleEthereumRpc(t.request(rpc()), t.env);
    expect(await result.text()).not.toMatch(/fixture-access-secret|private-route|private-path/);
  });
  it('HTTP 重定向、网络错误和超时均不重试', async () => {
    for (const mode of ['redirect', 'network', 'timeout']) {
      const t = setup();
      t.fetch.mockImplementation(async () => {
        if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://other.example.test/' } });
        throw mode === 'timeout' ? new DOMException('fixture', 'TimeoutError') : Error('private-transport-detail');
      });
      const result = await handleEthereumRpc(t.request(rpc('eth_sendRawTransaction', ['0x1234'])), t.env);
      expect(result.status).toBe(mode === 'timeout' ? 504 : 502);
      expect(t.fetch).toHaveBeenCalledTimes(1);
      expect(await result.text()).not.toContain('private-transport-detail');
    }
  });
  it('拒绝超过既有 4MiB 硬上限的上游响应', async () => {
    const t = setup();
    t.fetch.mockImplementation(async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)));
    expect((await handleEthereumRpc(t.request(rpc()), t.env)).status).toBe(502);
  });
  it('标准网页可预检，无需 App 登录会话', async () => {
    const t = setup();
    const result = await handleEthereumRpc(new Request('https://rpc.crcfrcn.com/', { method: 'OPTIONS',
      headers: { origin: 'https://wallet.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' } }), t.env);
    expect(result.status).toBe(204);
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('拒绝命名参数、显式空参数、非法预检和媒体类型', async () => {
    const t = setup();
    for (const params of [null, {}]) {
      const result = await handleEthereumRpc(t.request({ ...rpc(), params }), t.env);
      expect((await rpcBody(result)).error!.code).toBe(-32602);
    }
    expect((await handleEthereumRpc(new Request('https://rpc.crcfrcn.com/', { method: 'OPTIONS',
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } }), t.env)).status).toBe(400);
    expect((await handleEthereumRpc(t.request(rpc(), { headers: { 'content-type': 'text/plain' } }), t.env)).status).toBe(415);
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('拒绝明文、其他地址、非根路径、查询参数和非 POST 请求', async () => {
    const t = setup();
    for (const url of ['http://rpc.crcfrcn.com/', 'https://other.example.test/', 'https://rpc.crcfrcn.com/path', 'https://rpc.crcfrcn.com/?method=eth_chainId']) {
      expect((await handleEthereumRpc(t.request(rpc(), {}, url), t.env)).status).toBe(400);
    }
    expect((await handleEthereumRpc(new Request('https://rpc.crcfrcn.com/'), t.env)).status).toBe(405);
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('Worker 精确按公网域名分流，普通 App API 保持既有路由与来源限制', async () => {
    const t = setup();
    expect((await worker.fetch(t.request(rpc()), t.env)).status).toBe(200);
    const ordinary = await worker.fetch(new Request('https://www.crcfrcn.com/api/unknown', {
      headers: { origin: 'https://wallet.example.test' },
    }), t.env);
    expect(ordinary.status).toBe(404);
    expect(ordinary.headers.get('access-control-allow-origin')).toBeNull();
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });
});
