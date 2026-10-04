import { HttpError } from '../shared/http';
import { resourceLimit } from '../limits/catalog';
import type { TopupRail } from './config';

/// EVM 稳定币到账验证:只读该链 JSON-RPC,判定一笔 ERC-20 转账是否足额到达收款地址且已确认。
///
/// Worker侧初验与授权结算客户端侧复验基于同一判定口径；客户端会独立再验一遍（四方对账）。

/// ERC-20 `Transfer(address,address,uint256)` 事件 topic0(固定常量)。
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/// 单次 EVM RPC 超时;不在请求内自动重试。
const EVM_RPC_TIMEOUT_MS = 8000;
/// EVM RPC 响应内存硬上限(复用链 RPC 上限)。
const EVM_RPC_MAX_RESPONSE_BYTES = resourceLimit('chain_rpc_response').max_bytes;

/// 到账验证结果:
/// - confirmed:足额到账且已确认 → 可落台账「待支付」并入发币队列。
/// - pending:交易未上链 / 确认数不足 → 过渡态,不落台账(用户端显示处理中)。
/// - rejected:到账不符(错额 / 错收款 / 错币 / 交易失败) → 拒绝,不落台账。
///
/// `block_time_ms` = 付款交易所在区块的时间戳(毫秒)。抢单防护据此判定「付款意图必须
/// 先于付款上链存在」,故它是资金安全字段,取不到时整笔按 pending 处理,绝不放行。
export type EvmVerifyOutcome =
  | { status: 'confirmed'; payer: string; value: bigint; block_number: bigint; block_time_ms: number }
  | { status: 'pending' }
  | { status: 'rejected'; reason: string };

export interface VerifyParams {
  rail: TopupRail;
  rpcUrl: string;
  txHash: string;
  /// 期望收款地址(小写 0x)。
  expectedRecv: string;
  /// 应付稳定币最小单位下限(实际到账须 ≥ 此值)。
  minAmount: bigint;
  /// 期望付款地址(小写 0x);为空则不校验来源。
  expectedPayer?: string;
  /// 最小确认数;0 表示改用 finalized 区块判定。
  minConfirmations: number;
}

interface EvmLog {
  address?: string;
  topics?: string[];
  data?: string;
}

interface EvmReceipt {
  status?: string;
  blockNumber?: string;
  logs?: EvmLog[];
}

interface EvmBlock {
  number?: string;
  timestamp?: string;
}

export async function verifyErc20Payment(params: VerifyParams): Promise<EvmVerifyOutcome> {
  const receipt = (await evmRpc(params.rpcUrl, 'eth_getTransactionReceipt', [params.txHash])) as
    | EvmReceipt
    | null;
  // 收据为空 = 交易尚未上链(过渡态)。
  if (!receipt || typeof receipt !== 'object') {
    return { status: 'pending' };
  }
  if (receipt.status !== '0x1') {
    return { status: 'rejected', reason: 'tx_failed' };
  }

  const matched = matchTransfer(params, receipt.logs ?? []);
  if (!matched) {
    return { status: 'rejected', reason: 'no_matching_transfer' };
  }

  const receiptBlock = safeBigInt(receipt.blockNumber);
  if (receiptBlock === 0n) {
    return { status: 'pending' };
  }

  const confirmed = await isConfirmed(params, receiptBlock);
  if (!confirmed) {
    return { status: 'pending' };
  }

  // 区块时间是抢单防护的判据,取不到就不能放行:按过渡态返回,客户端轮询重试。
  const blockTimeMs = await fetchBlockTimeMs(params, receiptBlock);
  if (blockTimeMs === null) {
    return { status: 'pending' };
  }

  return {
    status: 'confirmed',
    payer: matched.payer,
    value: matched.value,
    block_number: receiptBlock,
    block_time_ms: blockTimeMs,
  };
}

/// 取付款交易所在区块的时间戳并换算成毫秒;缺字段或为 0 返回 null(判为不可用)。
async function fetchBlockTimeMs(params: VerifyParams, receiptBlock: bigint): Promise<number | null> {
  const block = (await evmRpc(params.rpcUrl, 'eth_getBlockByNumber', [
    `0x${receiptBlock.toString(16)}`,
    false,
  ])) as EvmBlock | null;
  if (!block || typeof block !== 'object') return null;
  // EVM 区块时间戳单位是秒,这里统一换算成毫秒,与 Worker 侧 nowMs() 口径一致。
  const seconds = safeBigInt(block.timestamp);
  if (seconds === 0n) return null;
  return Number(seconds) * 1000;
}

/// 在收据日志里找一条「本币轨合约 + 转入收款地址 + 金额达标」的 Transfer。
function matchTransfer(
  params: VerifyParams,
  logs: readonly EvmLog[],
): { payer: string; value: bigint } | null {
  for (const log of logs) {
    if (!log || typeof log !== 'object') continue;
    if ((log.address ?? '').toLowerCase() !== params.rail.token_contract) continue;
    const topics = log.topics ?? [];
    if (topics.length < 3) continue;
    if ((topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = topicToAddress(topics[2]);
    if (to !== params.expectedRecv) continue;
    const value = safeBigInt(log.data);
    if (value < params.minAmount) continue;
    const payer = topicToAddress(topics[1]);
    if (params.expectedPayer && payer !== params.expectedPayer) continue;
    return { payer, value };
  }
  return null;
}

/// 确认数判定:minConfirmations>0 用 latest 计算,否则用 finalized 区块防 reorg。
async function isConfirmed(params: VerifyParams, receiptBlock: bigint): Promise<boolean> {
  if (params.minConfirmations > 0) {
    const latest = safeBigInt(await evmRpc(params.rpcUrl, 'eth_blockNumber', []));
    if (latest === 0n) return false;
    return latest - receiptBlock + 1n >= BigInt(params.minConfirmations);
  }
  const finalized = (await evmRpc(params.rpcUrl, 'eth_getBlockByNumber', ['finalized', false])) as
    | EvmBlock
    | null;
  const finalizedNumber =
    finalized && typeof finalized === 'object' ? safeBigInt(finalized.number) : 0n;
  if (finalizedNumber === 0n) return false;
  return receiptBlock <= finalizedNumber;
}

/// 32 字节 topic → 20 字节地址(取后 40 hex),小写 0x。
function topicToAddress(topic: string | undefined): string {
  if (typeof topic !== 'string' || topic.length < 42) return '';
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/// 十六进制 → bigint;非法或空返回 0n('0x' 单独视为 0)。
function safeBigInt(value: unknown): bigint {
  if (typeof value !== 'string' || value === '' || value === '0x') return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/// 固定方法的 EVM JSON-RPC:强制 https、超时、响应大小硬上限。
async function evmRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  if (!rpcUrl.startsWith('https://')) {
    throw new HttpError(500, 'topup_rpc_invalid_config', 'EVM RPC 必须是 https 地址');
  }
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(EVM_RPC_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'topup_rpc_unreachable', 'EVM 节点不可达');
  }
  if (!response.ok) {
    throw new HttpError(502, 'topup_rpc_error', 'EVM 节点返回错误');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > EVM_RPC_MAX_RESPONSE_BYTES) {
    throw new HttpError(502, 'topup_rpc_response_too_large', 'EVM 节点响应过大');
  }
  const payload = (await response.json()) as { result?: unknown; error?: unknown };
  if (payload && typeof payload === 'object' && payload.error) {
    throw new HttpError(502, 'topup_rpc_error', 'EVM 节点返回错误');
  }
  return (payload as { result?: unknown }).result ?? null;
}
