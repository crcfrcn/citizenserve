import type { Env } from '../types';
import { HttpError } from '../shared/http';
import { resourceLimit } from '../limits/catalog';
import { readLimitedBytes } from '../limits/request';
import { enforceEdgeRate, requestIpKey } from '../security/request_guard';
import { requestChainRpc } from './rpc';

/** 公共钱包入口与 App API 分开；上游地址和 Access 凭据只由服务端提供。 */
export const ETHEREUM_RPC_HOST = 'rpc.crcfrcn.com';
const methods = [
  'eth_accounts', 'eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_estimateGas',
  'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash', 'eth_getBlockTransactionCountByNumber',
  'eth_getCode', 'eth_getLogs', 'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex', 'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas', 'eth_sendRawTransaction', 'eth_syncing',
  'net_listening', 'net_version', 'web3_clientVersion', 'eth_feeHistory',
] as const;
export type EthereumRpcMethod = typeof methods[number];
type Id = string | number;
type RpcRequest = { jsonrpc: '2.0'; id: Id; method: EthereumRpcMethod; params: unknown[] };
type RpcReply = { jsonrpc: '2.0'; id: Id | null; result?: unknown; error?: { code: number; message: string } };
const supported = new Set<string>(methods);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is Id =>
  (typeof value === 'number' && Number.isSafeInteger(value)) ||
  (typeof value === 'string' && value.length > 0 && value.length <= 128);
const quantity = (value: unknown): value is string =>
  typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) && value.length <= 66;
const bytes = (value: unknown): value is string =>
  typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const address = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const block = (value: unknown): boolean => quantity(value) ||
  ['latest', 'earliest', 'pending', 'safe', 'finalized'].includes(String(value));
const failure = (id: Id | null, code: number, message: string): RpcReply =>
  ({ jsonrpc: '2.0', id, error: { code, message } });

function response(payload: unknown, status = 200): Response {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** 数值范围及字段白名单限制昂贵查询；费用、余额和链身份始终读取真实节点。 */
function validParams(method: EthereumRpcMethod, p: unknown[]): boolean {
  const noParams = ['eth_accounts', 'eth_blockNumber', 'eth_chainId', 'eth_gasPrice',
    'eth_maxPriorityFeePerGas', 'eth_syncing', 'net_listening', 'net_version', 'web3_clientVersion'];
  if (noParams.includes(method)) return p.length === 0;
  if (['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockTransactionCountByHash'].includes(method)) {
    return p.length === 1 && hash(p[0]);
  }
  if (method === 'eth_getBlockTransactionCountByNumber') return p.length === 1 && block(p[0]);
  if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') {
    return p.length === 2 && (method.endsWith('Hash') ? hash(p[0]) : block(p[0])) && typeof p[1] === 'boolean';
  }
  if (method === 'eth_getTransactionByBlockHashAndIndex' || method === 'eth_getTransactionByBlockNumberAndIndex') {
    return p.length === 2 && (method.includes('Hash') ? hash(p[0]) : block(p[0])) && quantity(p[1]);
  }
  if (['eth_getBalance', 'eth_getCode', 'eth_getTransactionCount'].includes(method)) {
    return p.length === 2 && address(p[0]) && block(p[1]);
  }
  if (method === 'eth_getStorageAt') return p.length === 3 && address(p[0]) && quantity(p[1]) && block(p[2]);
  if (method === 'eth_sendRawTransaction') return p.length === 1 && bytes(p[0]) && p[0].length > 2;
  if (method === 'eth_call' || method === 'eth_estimateGas') {
    if (!record(p[0]) || !(p.length === 1 || p.length === 2 && block(p[1]))) return false;
    if (method === 'eth_call' && p.length !== 2) return false;
    const tx = p[0];
    const keys = ['from', 'to', 'gas', 'gasPrice', 'value', 'data', 'input', 'nonce', 'type',
      'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList', 'chainId'];
    if (Object.keys(tx).some(key => !keys.includes(key)) || tx.to !== undefined && tx.to !== null && !address(tx.to)) return false;
    if ((tx.to === undefined || tx.to === null) && !bytes(tx.data ?? tx.input)) return false;
    if (tx.from !== undefined && !address(tx.from)) return false;
    for (const key of ['gas', 'gasPrice', 'value', 'nonce', 'type', 'maxFeePerGas', 'maxPriorityFeePerGas', 'chainId']) {
      if (tx[key] !== undefined && !quantity(tx[key])) return false;
    }
    for (const key of ['data', 'input']) if (tx[key] !== undefined && !bytes(tx[key])) return false;
    if (tx.data !== undefined && tx.input !== undefined && tx.data !== tx.input) return false;
    if (tx.accessList !== undefined && (!Array.isArray(tx.accessList) || tx.accessList.length > 64 ||
      tx.accessList.some(entry => !record(entry) || Object.keys(entry).some(key => !['address', 'storageKeys'].includes(key)) ||
        !address(entry.address) || !Array.isArray(entry.storageKeys) || entry.storageKeys.length > 64 || !entry.storageKeys.every(hash)))) return false;
    return true;
  }
  if (method === 'eth_feeHistory') {
    return p.length === 3 && quantity(p[0]) && BigInt(p[0]) > 0n && BigInt(p[0]) <= 1024n && block(p[1]) &&
      Array.isArray(p[2]) && p[2].length <= 100 && p[2].every((v, i, values) =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 && (i === 0 || v >= values[i - 1]));
  }
  if (method === 'eth_getLogs') {
    if (p.length !== 1 || !record(p[0])) return false;
    const filter = p[0];
    if (Object.keys(filter).some(key => !['fromBlock', 'toBlock', 'blockHash', 'address', 'topics'].includes(key))) return false;
    if (filter.blockHash !== undefined) {
      if (!hash(filter.blockHash) || filter.fromBlock !== undefined || filter.toBlock !== undefined) return false;
    } else if (!quantity(filter.fromBlock) || !quantity(filter.toBlock) ||
      BigInt(filter.toBlock) < BigInt(filter.fromBlock) || BigInt(filter.toBlock) - BigInt(filter.fromBlock) >= 1000n) return false;
    if (filter.address !== undefined && !(address(filter.address) || Array.isArray(filter.address) &&
      filter.address.length > 0 && filter.address.length <= 32 && filter.address.every(address))) return false;
    if (filter.topics !== undefined && !(Array.isArray(filter.topics) && filter.topics.length <= 4 &&
      filter.topics.every(v => v === null || hash(v) || Array.isArray(v) && v.length <= 32 && v.every(hash)))) return false;
    return true;
  }
  return false;
}

function normalize(value: unknown): RpcRequest | RpcReply {
  const id = record(value) && validId(value.id) ? value.id : null;
  if (!record(value) || value.jsonrpc !== '2.0' || id === null || typeof value.method !== 'string' ||
    Object.keys(value).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) {
    return failure(id, -32600, 'JSON-RPC 请求无效');
  }
  if (!supported.has(value.method)) return failure(id, -32601, '该 RPC 方法不对外提供');
  const method = value.method as EthereumRpcMethod;
  const params = Object.hasOwn(value, 'params') ? value.params : [];
  if (!Array.isArray(params) || !validParams(method, params)) return failure(id, -32602, 'RPC 参数无效或查询范围超限');
  return { jsonrpc: '2.0', id, method, params };
}

function upstreamReplies(payload: unknown, requests: RpcRequest[], batch: boolean): Map<Id, RpcReply> {
  const values = batch ? payload : [payload];
  if (!Array.isArray(values) || values.length !== requests.length) throw new HttpError(502, 'ethereum_rpc_invalid_response', '节点响应无效');
  const expected = new Map(requests.map(item => [item.id, item]));
  const replies = new Map<Id, RpcReply>();
  for (const value of values) {
    if (!record(value) || value.jsonrpc !== '2.0' || !validId(value.id) || !expected.has(value.id) || replies.has(value.id) ||
      Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) throw new HttpError(502, 'ethereum_rpc_invalid_response', '节点响应无效');
    if (Object.hasOwn(value, 'error')) {
      if (!record(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string') {
        throw new HttpError(502, 'ethereum_rpc_invalid_response', '节点响应无效');
      }
      // 不向公开客户端返回上游异常正文、内部路径或任意 error.data。
      const code = value.error.code as number;
      replies.set(value.id, failure(value.id, code, code === -32601 ? '链节点尚未提供该 RPC 方法' : '链节点拒绝该请求'));
    } else {
      const method = expected.get(value.id)!.method;
      if (method === 'eth_chainId' && value.result !== '0x7eb' || method === 'net_version' && value.result !== '2027') {
        throw new HttpError(502, 'ethereum_rpc_wrong_chain', '节点链身份不匹配');
      }
      replies.set(value.id, { jsonrpc: '2.0', id: value.id, result: value.result });
    }
  }
  return replies;
}

export async function handleEthereumRpc(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.hostname !== ETHEREUM_RPC_HOST || url.port || url.pathname !== '/' || url.search) {
      return response(failure(null, -32600, 'RPC 地址无效'), 400);
    }
    if (request.method === 'OPTIONS') {
      if (request.headers.get('access-control-request-method') !== 'POST' ||
        (request.headers.get('access-control-request-headers') ?? '').split(',').some(v => v.trim() && v.trim().toLowerCase() !== 'content-type')) {
        return response(failure(null, -32600, '预检请求无效'), 400);
      }
      return response(undefined, 204);
    }
    if (request.method !== 'POST') return response(failure(null, -32600, 'RPC 仅接受 POST'), 405);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return response(failure(null, -32600, 'RPC 需要 JSON 请求'), 415);
    }
    // Cloudflare 边缘按真实客户端 IP 计数，不信任用户提交的转发头。
    if (!request.headers.get('cf-connecting-ip')?.trim()) throw new HttpError(503, 'ethereum_rpc_edge_ip_missing', '边缘客户端身份不可用');
    const ipKey = await requestIpKey(request, env);
    await enforceEdgeRate(env, 'RATE_READ', 'ethereum_rpc:' + ipKey);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readLimitedBytes(request, 'ethereum_rpc_request'))); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      return response(failure(null, -32700, 'JSON 解析失败'), 400);
    }
    const batch = Array.isArray(payload);
    const values = batch ? payload as unknown[] : [payload];
    if (values.length === 0 || values.length > resourceLimit('ethereum_rpc_request').max_items!) {
      return response(failure(null, -32600, 'RPC 批量请求数量超限'), 400);
    }
    const items = values.map(normalize);
    const ids = items.filter(item => item.id !== null).map(item => item.id);
    if (new Set(ids).size !== ids.length) return response(failure(null, -32600, 'RPC 请求 ID 重复'), 400);
    const requests = items.filter((item): item is RpcRequest => 'method' in item);
    // 每个方法单独扣预算；批量调用不能绕过读请求及交易广播限制。
    for (let i = 1; i < items.length; i++) await enforceEdgeRate(env, 'RATE_READ', 'ethereum_rpc:' + ipKey);
    for (const item of requests) if (item.method === 'eth_sendRawTransaction') {
      await enforceEdgeRate(env, 'RATE_WRITE', 'ethereum_rpc_send:' + ipKey);
    }
    if (requests.length === 0) return response(batch ? items : items[0]);
    // 整批只调用一次上游；任何失败都不自动重试已签名交易。
    const replies = upstreamReplies(await requestChainRpc(env, batch ? requests : requests[0]), requests, batch);
    const output = items.map(item => 'method' in item ? replies.get(item.id)! : item);
    return response(batch ? output : output[0]);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = status === 429 ? 'RPC 请求过于频繁' : status === 413 ? 'RPC 请求体超限' : status === 504 ? '链节点请求超时' :
      status === 503 ? 'RPC 服务未就绪' : 'RPC 服务暂时不可用';
    return response(failure(null, -32000, message), status);
  }
}
