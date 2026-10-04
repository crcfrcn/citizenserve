import { blake2AsU8a } from '@polkadot/util-crypto';
import type { Env } from '../types';
import { HttpError, jsonResponse, readJson } from '../shared/http';
import { assertAccountId, createId } from '../shared/ids';
import { bytesToHex, hexToBytes } from '../shared/signing_message';
import { nowMs } from '../shared/time';
import {
  fetchBlockHeader,
  fetchCanonicalBlockHash,
  fetchFinalizedHead,
  fetchSignedBlock,
} from '../chain/rpc';
import { resourceLimit } from '../limits/catalog';
import { railRpcUrl, topupMinConfirmations, topupRail, topupRecvAddress } from './config';
import type { TopupToken } from './config';
import { findOrderById, statusLabel, type TopupOrderRow } from './orders';
import { verifyErc20Payment } from './evm_verify';

/// 授权结算客户端接口。稳定币事实由EVM复核，公民币事实由finalized
/// CitizenChain区块复核；客户端声明本身不能把订单改成paid。
const PENDING_QUERY_LIMIT = 50;
const HISTORY_QUERY_LIMIT = 100;
const HISTORY_STATUSES = ['pending', 'paid', 'exception'] as const;

interface ClaimBody {
  claim_id?: unknown;
}

interface SettledBody {
  claim_id?: unknown;
  gmb_tx_hash?: unknown;
  gmb_block_hash?: unknown;
  gmb_extrinsic_index?: unknown;
  signed_extrinsic_hex?: unknown;
}

interface ExceptionBody {
  claim_id?: unknown;
  reason?: unknown;
}

/// 常量时间比对 Bearer 令牌，缺 Secret 时 fail-closed。
export function requireSettleAuth(request: Request, env: Env): void {
  const expected = env.SETTLE_TOKEN;
  if (!expected) {
    throw new HttpError(503, 'topup_settle_unconfigured', '结算接口未配置');
  }
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!token || !timingSafeEqual(token, expected)) {
    throw new HttpError(401, 'topup_settle_unauthorized', '结算令牌校验失败');
  }
}

/// GET pending 仅返回业务三态中的 pending；内部 claim 只作为防重复发币锁，不新增用户态。
export async function topupPendingRoute(request: Request, env: Env): Promise<Response> {
  requireSettleAuth(request, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM topup_orders WHERE status = 'pending' ORDER BY confirmed_at ASC LIMIT ?`,
  )
    .bind(PENDING_QUERY_LIMIT)
    .all<TopupOrderRow>();
  return jsonResponse({
    ok: true,
    orders: (rows.results ?? []).map((row) => ({
      order_id: row.order_id,
      chain_id: row.chain_id,
      token: row.token,
      token_contract: row.token_contract,
      evm_tx_hash: row.evm_tx_hash,
      payer_address: row.payer_address,
      recv_address: row.recv_address,
      pay_amount: row.pay_amount,
      account_id: row.account_id,
      coin_fen: row.coin_fen,
      package_id: row.package_id,
      confirmed_at: row.confirmed_at,
      settlement_claimed: Boolean(row.settlement_claim_id),
    })),
  });
}

/// GET history是授权结算客户端重建本地状态的唯一远程镜像源。
/// 结算令牌仍是唯一授权；按 `(confirmed_at, order_id)` 稳定分页，三种业务状态
/// 分别走现有 `(status, confirmed_at)` 索引后合并，不为读镜像单独改生产 Schema。
export async function topupHistoryRoute(request: Request, env: Env): Promise<Response> {
  requireSettleAuth(request, env);
  const url = new URL(request.url);
  const afterConfirmedAtText = url.searchParams.get('after_confirmed_at') ?? '0';
  const afterOrderId = url.searchParams.get('after_order_id') ?? '';
  if (!/^(0|[1-9][0-9]{0,15})$/.test(afterConfirmedAtText)
    || (afterOrderId !== '' && !/^top_[0-9a-z]{16,80}$/.test(afterOrderId))) {
    throw new HttpError(400, 'topup_history_cursor_invalid', '充值台账同步游标不合法');
  }
  const afterConfirmedAt = Number(afterConfirmedAtText);
  if (!Number.isSafeInteger(afterConfirmedAt)) {
    throw new HttpError(400, 'topup_history_cursor_invalid', '充值台账同步游标不合法');
  }

  const batches = await Promise.all(HISTORY_STATUSES.map((status) => env.DB.prepare(
    `SELECT order_id, chain_id, token, token_contract, evm_tx_hash, payer_address,
       recv_address, pay_amount, account_id, coin_fen, package_id, status,
       settlement_claim_id, settlement_claimed_at, gmb_tx_hash, gmb_block_hash,
       gmb_extrinsic_index, exception_reason, confirmed_at, settled_at
     FROM topup_orders
     WHERE status = ? AND (confirmed_at > ? OR (confirmed_at = ? AND order_id > ?))
     ORDER BY confirmed_at ASC, order_id ASC LIMIT ?`,
  ).bind(
    status,
    afterConfirmedAt,
    afterConfirmedAt,
    afterOrderId,
    HISTORY_QUERY_LIMIT + 1,
  ).all<TopupOrderRow>()));
  const merged = batches.flatMap((batch) => batch.results ?? [])
    .sort((left, right) => left.confirmed_at - right.confirmed_at
      || left.order_id.localeCompare(right.order_id));
  const orders = merged.slice(0, HISTORY_QUERY_LIMIT);
  const last = orders.at(-1);
  return jsonResponse({
    ok: true,
    orders,
    has_more: merged.length > HISTORY_QUERY_LIMIT,
    next_cursor: last ? {
      confirmed_at: last.confirmed_at,
      order_id: last.order_id,
    } : null,
  });
}

/// POST claim——发币前原子抢占订单。claim不自动过期：结算客户端中断后必须核链并人工处置，
/// 绝不能靠租约超时自动重发。
export async function topupClaimRoute(request: Request, env: Env, orderId: string): Promise<Response> {
  requireSettleAuth(request, env);
  const body = await readJson<ClaimBody>(request);
  const supplied = normalizeOptionalClaimId(body.claim_id);
  const order = await requireOrder(env, orderId);
  if (order.status !== 'pending') {
    throw new HttpError(409, 'topup_order_not_pending', '订单不处于待支付，无法抢占');
  }
  if (order.settlement_claim_id) {
    if (supplied && timingSafeEqual(supplied, order.settlement_claim_id)) {
      return jsonResponse({ ok: true, claim_id: supplied, deduplicated: true });
    }
    throw new HttpError(409, 'topup_order_already_claimed', '订单已被结算流程抢占，禁止重复发币');
  }

  const claimId = createId('tpc');
  const updated = await env.DB.prepare(
    `UPDATE topup_orders SET settlement_claim_id = ?, settlement_claimed_at = ?
      WHERE order_id = ? AND status = 'pending' AND settlement_claim_id IS NULL`,
  )
    .bind(claimId, nowMs(), orderId)
    .run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    throw new HttpError(409, 'topup_order_already_claimed', '订单已被结算流程抢占，禁止重复发币');
  }
  return jsonResponse({ ok: true, claim_id: claimId });
}

/// POST settled — 必须携带 claim 和完整 finalized 交易证明。
export async function topupSettledRoute(request: Request, env: Env, orderId: string): Promise<Response> {
  requireSettleAuth(request, env);
  const body = await readJson<SettledBody>(request);
  const order = await requireOrder(env, orderId);
  if (order.status === 'paid') {
    return jsonResponse({
      ok: true,
      status: 'paid',
      status_label: statusLabel('paid'),
      order_id: orderId,
      deduplicated: true,
    });
  }
  if (order.status !== 'pending') {
    throw new HttpError(409, 'topup_order_not_pending', '订单不处于待支付，无法结算');
  }
  requireMatchingClaim(order, body.claim_id);

  const proof = await verifyGmbDisbursement(env, order, body);
  const rail = topupRail(env, order.token as TopupToken);
  const outcome = await verifyErc20Payment({
    rail,
    rpcUrl: railRpcUrl(env, rail),
    txHash: order.evm_tx_hash,
    expectedRecv: topupRecvAddress(env),
    minAmount: BigInt(order.pay_amount),
    expectedPayer: order.payer_address,
    minConfirmations: topupMinConfirmations(env),
  });
  if (outcome.status === 'rejected') {
    await markException(env, orderId, `settle_recheck_rejected:${outcome.reason}`, order.settlement_claim_id!);
    throw new HttpError(409, 'topup_settle_recheck_rejected', '结算复核发现到账不一致，已置异常');
  }
  if (outcome.status === 'pending') {
    throw new HttpError(409, 'topup_settle_recheck_pending', '结算复核到账未确认，请稍后重试');
  }

  const updated = await env.DB.prepare(
    `UPDATE topup_orders SET status = 'paid', gmb_tx_hash = ?, gmb_block_hash = ?,
       gmb_extrinsic_index = ?, settled_at = ?
      WHERE order_id = ? AND status = 'pending' AND settlement_claim_id = ?`,
  )
    .bind(
      proof.txHash,
      proof.blockHash,
      proof.extrinsicIndex,
      nowMs(),
      orderId,
      order.settlement_claim_id,
    )
    .run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    const latest = await findOrderById(env, orderId);
    if (latest?.status === 'paid' && latest.gmb_tx_hash === proof.txHash) {
      return jsonResponse({ ok: true, status: 'paid', status_label: statusLabel('paid'), order_id: orderId, deduplicated: true });
    }
    throw new HttpError(409, 'topup_settlement_raced', '订单结算状态已变化');
  }
  return jsonResponse({ ok: true, status: 'paid', status_label: statusLabel('paid'), order_id: orderId });
}

/// POST exception — 只有持有该订单 claim 的结算流程才能置异常。
export async function topupExceptionRoute(request: Request, env: Env, orderId: string): Promise<Response> {
  requireSettleAuth(request, env);
  const body = await readJson<ExceptionBody>(request);
  const order = await requireOrder(env, orderId);
  if (order.status === 'exception') {
    return jsonResponse({ ok: true, status: 'exception', status_label: statusLabel('exception'), order_id: orderId, deduplicated: true });
  }
  if (order.status !== 'pending') {
    throw new HttpError(409, 'topup_order_not_pending', '订单不处于待支付，无法置异常');
  }
  const claimId = requireMatchingClaim(order, body.claim_id);
  const reason = typeof body.reason === 'string' && body.reason.trim() !== ''
    ? body.reason.trim().slice(0, 200)
    : 'unspecified';
  await markException(env, orderId, reason, claimId);
  return jsonResponse({ ok: true, status: 'exception', status_label: statusLabel('exception'), order_id: orderId });
}

async function verifyGmbDisbursement(
  env: Env,
  order: TopupOrderRow,
  body: SettledBody,
): Promise<{ txHash: string; blockHash: string; extrinsicIndex: number }> {
  const txHash = normalizeHash(body.gmb_tx_hash, '公民币发币交易哈希');
  const blockHash = normalizeHash(body.gmb_block_hash, '公民币发币区块哈希');
  const extrinsicIndex = typeof body.gmb_extrinsic_index === 'number'
    ? body.gmb_extrinsic_index
    : Number.NaN;
  if (!Number.isSafeInteger(extrinsicIndex) || extrinsicIndex < 0) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '公民币发币交易索引不合法');
  }
  const signedExtrinsicHex = normalizeExtrinsic(body.signed_extrinsic_hex);
  const encoded = hexToBytes(signedExtrinsicHex);
  if (encoded.length > resourceLimit('chain_extrinsic').max_bytes) {
    throw new HttpError(413, 'topup_gmb_proof_too_large', '公民币发币交易超过大小限制');
  }
  const calculated = `0x${bytesToHex(blake2AsU8a(encoded, 256))}`;
  if (calculated !== txHash) {
    throw new HttpError(409, 'topup_gmb_tx_hash_mismatch', '公民币交易哈希与完整交易不一致');
  }

  const expectedSigner = requireDisburseAccountId(env);
  const call = decodeDisbursementExtrinsic(encoded);
  if (call.signer !== expectedSigner) {
    throw new HttpError(403, 'topup_gmb_signer_mismatch', '公民币发币签名账户不正确');
  }
  if (
    call.destAccountId !== order.account_id ||
    call.amountFen !== BigInt(order.coin_fen) ||
    call.remark !== `topup:${order.order_id}`
  ) {
    throw new HttpError(409, 'topup_gmb_call_mismatch', '公民币链上转账与充值订单不一致');
  }

  const expectedGenesis = normalizeConfiguredHash(env.CHAIN_GENESIS_HASH, '链创世哈希');
  const [actualGenesis, finalizedHead, signedBlock] = await Promise.all([
    fetchCanonicalBlockHash(env, 0),
    fetchFinalizedHead(env),
    fetchSignedBlock(env, blockHash),
  ]);
  if (actualGenesis !== expectedGenesis) {
    throw new HttpError(503, 'topup_chain_identity_mismatch', '链服务节点创世哈希与冻结配置不一致');
  }
  const blockNumber = parseBlockNumber(signedBlock.block.header.number);
  const [finalizedHeader, canonicalHash] = await Promise.all([
    fetchBlockHeader(env, finalizedHead),
    fetchCanonicalBlockHash(env, blockNumber),
  ]);
  if (blockNumber > parseBlockNumber(finalizedHeader.number) || canonicalHash !== blockHash) {
    throw new HttpError(409, 'topup_gmb_block_not_finalized', '公民币发币区块尚未成为 finalized 主链区块');
  }
  if (
    extrinsicIndex >= signedBlock.block.extrinsics.length ||
    normalizeExtrinsic(signedBlock.block.extrinsics[extrinsicIndex]) !== signedExtrinsicHex
  ) {
    throw new HttpError(409, 'topup_gmb_tx_not_in_block', '指定 finalized 区块位置不包含公民币发币交易');
  }
  return { txHash, blockHash, extrinsicIndex };
}

function decodeDisbursementExtrinsic(encoded: Uint8Array): {
  signer: string;
  destAccountId: string;
  amountFen: bigint;
  remark: string;
} {
  const outer = readCompact(encoded, 0);
  if (outer.offset + Number(outer.value) !== encoded.length) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '签名交易长度不一致');
  }
  let offset = outer.offset;
  if (encoded[offset++] !== 0x84 || encoded[offset++] !== 0x00) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '只接受 AccountId 签名交易');
  }
  const signer = `0x${bytesToHex(sliceExact(encoded, offset, 32))}`;
  offset += 32;
  if (encoded[offset++] !== 0x01) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '公民币发币签名类型不合法');
  }
  sliceExact(encoded, offset, 64);
  offset += 64;
  if (encoded[offset++] !== 0x00) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '公民币发币交易必须使用 immortal era');
  }
  offset = readCompact(encoded, offset).offset;
  offset = readCompact(encoded, offset).offset;
  if (encoded[offset++] !== 4 || encoded[offset++] !== 0) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '交易不是公民币带备注转账');
  }
  const destAccountId = `0x${bytesToHex(sliceExact(encoded, offset, 32))}`;
  offset += 32;
  const amountFen = readU128Le(encoded, offset);
  offset += 16;
  const remarkLength = readCompact(encoded, offset);
  offset = remarkLength.offset;
  if (remarkLength.value > 128n) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '公民币发币备注过长');
  }
  const remarkBytes = sliceExact(encoded, offset, Number(remarkLength.value));
  offset += remarkBytes.length;
  if (offset !== encoded.length) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '公民币发币交易含有尾随字节');
  }
  let remark: string;
  try {
    remark = new TextDecoder('utf-8', { fatal: true }).decode(remarkBytes);
  } catch {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '公民币发币备注不是合法 UTF-8');
  }
  return { signer, destAccountId, amountFen, remark };
}

async function markException(env: Env, orderId: string, reason: string, claimId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE topup_orders SET status = 'exception', exception_reason = ?, settled_at = ?
      WHERE order_id = ? AND status = 'pending' AND settlement_claim_id = ?`,
  )
    .bind(reason, nowMs(), orderId, claimId)
    .run();
}

async function requireOrder(env: Env, orderId: string): Promise<TopupOrderRow> {
  const order = await findOrderById(env, orderId);
  if (!order) throw new HttpError(404, 'topup_order_not_found', '充值订单不存在');
  return order;
}

function requireMatchingClaim(order: TopupOrderRow, value: unknown): string {
  const claimId = normalizeOptionalClaimId(value);
  if (!claimId || !order.settlement_claim_id || !timingSafeEqual(claimId, order.settlement_claim_id)) {
    throw new HttpError(409, 'topup_claim_mismatch', '结算抢占凭证不匹配');
  }
  return claimId;
}

function normalizeOptionalClaimId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^tpc_[0-9a-f]{32}$/.test(value)) return null;
  return value;
}

function requireDisburseAccountId(env: Env): string {
  try {
    return assertAccountId(env.TOPUP_DISBURSE_ACCOUNT_ID);
  } catch {
    throw new HttpError(503, 'topup_disburse_account_unconfigured', '公民币发放账户未配置');
  }
}

function normalizeHash(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', `${label}不合法`);
  }
  return normalized;
}

function normalizeConfiguredHash(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new HttpError(503, 'topup_chain_identity_unconfigured', `${label}未配置`);
  }
  return normalized;
}

function normalizeExtrinsic(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^0x(?:[0-9a-f]{2})+$/.test(normalized)) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '完整签名交易编码不合法');
  }
  return normalized;
}

function readCompact(data: Uint8Array, offset: number): { value: bigint; offset: number } {
  if (offset >= data.length) throw new HttpError(400, 'topup_gmb_proof_invalid', 'SCALE compact 缺失');
  const first = data[offset];
  const mode = first & 0x03;
  if (mode === 0) return { value: BigInt(first >> 2), offset: offset + 1 };
  if (mode === 1) {
    sliceExact(data, offset, 2);
    return { value: BigInt(((data[offset + 1] << 8) | first) >> 2), offset: offset + 2 };
  }
  if (mode === 2) {
    sliceExact(data, offset, 4);
    const value = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
    return { value: BigInt(value >>> 2), offset: offset + 4 };
  }
  const byteLength = (first >> 2) + 4;
  if (byteLength > 16) throw new HttpError(400, 'topup_gmb_proof_invalid', 'SCALE compact 过大');
  const bytes = sliceExact(data, offset + 1, byteLength);
  let value = 0n;
  for (let index = byteLength - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  return { value, offset: offset + 1 + byteLength };
}

function readU128Le(data: Uint8Array, offset: number): bigint {
  const bytes = sliceExact(data, offset, 16);
  let value = 0n;
  for (let index = 15; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

function sliceExact(data: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset < 0 || length < 0 || offset + length > data.length) {
    throw new HttpError(400, 'topup_gmb_proof_invalid', '签名交易被截断');
  }
  return data.slice(offset, offset + length);
}

function parseBlockNumber(value: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new HttpError(502, 'chain_rpc_invalid_response', '链服务节点返回了无效区块高度');
  }
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(502, 'chain_rpc_invalid_response', '链服务节点区块高度超出范围');
  }
  return parsed;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
