import type { Env } from '../types';
import { HttpError, jsonResponse, readJson } from '../shared/http';
import { assertAccountId, assertCidNumber, createId } from '../shared/ids';
import { nowMs } from '../shared/time';
import { fetchChainIdentityState } from '../chain/identity';
import {
  findPackage,
  isEvmAddress,
  isEvmTxHash,
  isTopupToken,
  railRpcUrl,
  topupMinConfirmations,
  topupNetwork,
  topupPackages,
  topupRail,
  topupRails,
  topupRecvAddress,
  type TopupToken,
} from './config';
import { verifyErc20Payment } from './evm_verify';
import { enforceEdgeRate, enforcePersistentRateLimit } from '../security/request_guard';

/// 充值订单三态台账(仅此三种):
/// pending=稳定币已确认、公民币待发 / paid=公民币已发 / exception=异常、交人工。
export type TopupOrderStatus = 'pending' | 'paid' | 'exception';

export interface TopupOrderRow {
  order_id: string;
  intent_id: string;
  chain_id: number;
  token: string;
  token_contract: string;
  evm_tx_hash: string;
  payer_address: string;
  recv_address: string;
  pay_amount: string;
  /// 付款意图签发时，目标账户在 finalized 链上的身份归属；未绑定身份的账户为空。
  cid_number: string | null;
  account_id: string;
  coin_fen: string;
  package_id: string;
  status: TopupOrderStatus;
  settlement_claim_id: string | null;
  settlement_claimed_at: number | null;
  gmb_tx_hash: string | null;
  gmb_block_hash: string | null;
  gmb_extrinsic_index: number | null;
  exception_reason: string | null;
  confirmed_at: number;
  settled_at: number | null;
}

interface IntentBody {
  account_id?: unknown;
  token?: unknown;
  package_id?: unknown;
  payer_address?: unknown;
}

interface ConfirmBody {
  payment_intent?: unknown;
  evm_tx_hash?: unknown;
}

interface StatusBody {
  order_id?: unknown;
  payment_intent?: unknown;
}

interface PaymentIntent {
  intent_id: string;
  cid_number: string | null;
  account_id: string;
  payer_address: string;
  token: TopupToken;
  package_id: string;
  chain_id: number;
  token_contract: string;
  recv_address: string;
  pay_amount: string;
  coin_fen: string;
  issued_at: number;
  expires_at: number;
}

const INTENT_TTL_MS = 10 * 60 * 1000;

export interface TopupIntentDeps {
  resolveCidNumber: (env: Env, accountId: string) => Promise<string | null>;
}

const defaultTopupIntentDeps: TopupIntentDeps = {
  resolveCidNumber: async (env, accountId) => {
    // 充值意图是后续订单身份归属的唯一入口，必须直接读取 finalized 双向绑定；
    // 禁止用展示缓存的软降级把链读取失败误记成“未绑定”，否则注销会漏删订单。
    const identity = await fetchChainIdentityState(env, accountId);
    return identity.cid_number === null ? null : assertCidNumber(identity.cid_number);
  },
};

/// 台账状态 → 用户可读中文标签。
export function statusLabel(status: TopupOrderStatus): string {
  return status === 'pending' ? '待支付' : status === 'paid' ? '已支付' : '异常';
}

/// GET /square/topup/config — 公开报价。付款前的最终报价以后续签名意图为准。
export async function topupConfigRoute(_request: Request, env: Env): Promise<Response> {
  const rails = topupRails(env);
  if (rails.length === 0) {
    throw new HttpError(503, 'topup_unconfigured', '充值渠道尚未配置');
  }
  const recvAddress = topupRecvAddress(env);
  return jsonResponse({
    ok: true,
    network: topupNetwork(env),
    recv_address: recvAddress,
    rails: rails.map((rail) => ({
      token: rail.token,
      chain_id: rail.chain_id,
      token_contract: rail.token_contract,
      token_decimals: rail.token_decimals,
      label: rail.label,
    })),
    packages: topupPackages(),
  });
}

/// POST /square/topup/intent — 钱包连接后、付款前创建短期付款意图。
///
/// 充值 = 付款人自掏稳定币给某个公民链账户打公民币,收款方无需证明账户所有权(同转账),
/// 故本接口不做账户鉴权:`account_id` 即充值目标,由客户端指定,任意钱包账户(含冷钱包、
/// 含他人账户)均可作目标。Worker 同时把目标账户当时的 finalized CID 归属写进签名意图；
/// 未绑定身份的账户记 null。付款鉴权发生在外部 EVM 钱包侧。防滥用靠 IP 限流 + 意图 TTL。
export async function topupIntentRoute(
  request: Request,
  env: Env,
  deps: TopupIntentDeps = defaultTopupIntentDeps,
): Promise<Response> {
  const body = await readJson<IntentBody>(request);
  const accountId = parseAccountId(body.account_id);
  await enforceTopupWriteLimit(env, accountId);
  if (!isTopupToken(body.token)) {
    throw new HttpError(400, 'topup_token_invalid', '不支持的充值币种');
  }
  const packageId = typeof body.package_id === 'string' ? body.package_id : '';
  const pkg = findPackage(packageId);
  if (!pkg) {
    throw new HttpError(400, 'topup_package_invalid', '充值套餐不存在');
  }
  const payerAddress = normalizeAddress(body.payer_address);
  const rail = topupRail(env, body.token);
  const cidNumber = await deps.resolveCidNumber(env, accountId);
  const issuedAt = nowMs();
  const intent: PaymentIntent = {
    intent_id: createId('tpi'),
    cid_number: cidNumber === null ? null : assertCidNumber(cidNumber),
    account_id: accountId,
    payer_address: payerAddress,
    token: rail.token,
    package_id: pkg.package_id,
    chain_id: rail.chain_id,
    token_contract: rail.token_contract,
    recv_address: topupRecvAddress(env),
    pay_amount: pkg.pay_amount,
    coin_fen: pkg.coin_fen,
    issued_at: issuedAt,
    expires_at: issuedAt + INTENT_TTL_MS,
  };
  return jsonResponse({
    ok: true,
    payment_intent: await signIntent(env, intent),
    expires_at: intent.expires_at,
  });
}

/// POST /square/topup/confirm — 付款后提交交易哈希。
///
/// 凭据是 Worker 用 `TOPUP_INTENT_SECRET` 签发的 HMAC 意图(不可伪造,内部钉死付款人、
/// 收款地址、金额、充值目标和签发时间),不是公开的 tx hash,也不需要账户会话。
/// Worker 核验意图与最终 EVM 事实后才创建三态订单。
export async function topupConfirmRoute(request: Request, env: Env): Promise<Response> {
  const body = await readJson<ConfirmBody>(request);
  const encodedIntent = typeof body.payment_intent === 'string' ? body.payment_intent.trim() : '';
  const intent = await verifyIntent(env, encodedIntent);
  await enforceTopupWriteLimit(env, intent.account_id);
  if (intent.expires_at <= nowMs()) {
    throw new HttpError(409, 'topup_intent_expired', '付款意图已过期，请重新发起');
  }
  assertIntentStillMatchesConfig(env, intent);

  const txHash = typeof body.evm_tx_hash === 'string' ? body.evm_tx_hash.trim().toLowerCase() : '';
  if (!isEvmTxHash(txHash)) {
    throw new HttpError(400, 'topup_txhash_invalid', 'EVM 交易哈希不合法');
  }

  const existing = await findOrderByTx(env, intent.chain_id, txHash);
  if (existing) {
    if (existing.intent_id !== intent.intent_id) {
      throw new HttpError(409, 'topup_txhash_claimed', '该链上付款已绑定其它付款意图');
    }
    return orderResponse(existing, true);
  }

  // 命中外部 EVM RPC 前的全局硬顶(见 enforceGlobalEvmRpcLimit 注释)：放在 dedupe
  // 短路之后——已有订单的重复轮询不打 RPC，不该消耗这个全局配额。
  await enforceGlobalEvmRpcLimit(env, intent.chain_id);

  const rail = topupRail(env, intent.token);
  const outcome = await verifyErc20Payment({
    rail,
    rpcUrl: railRpcUrl(env, rail),
    txHash,
    expectedRecv: intent.recv_address,
    minAmount: BigInt(intent.pay_amount),
    expectedPayer: intent.payer_address,
    minConfirmations: topupMinConfirmations(env),
  });
  if (outcome.status === 'pending') {
    return jsonResponse({ ok: true, status: 'confirming' });
  }
  if (outcome.status === 'rejected') {
    throw new HttpError(400, 'topup_payment_invalid', `未确认到有效到账:${outcome.reason}`);
  }

  // 抢单防护:付款意图必须先于付款上链存在。
  //
  // 付款人地址、收款地址和金额都是公链上人人可见的数据,若不设时间序,攻击者可以盯住
  // 收款地址的入账,用受害者的付款地址造一个指向自己账户的意图,抢先 confirm 冒领这笔
  // 公民币((chain_id, evm_tx_hash) 唯一索引先到先得)。合法用户的意图必然建在付款之前,
  // 而攻击者只能在交易上链、可被观察到之后才造得出意图,故按签发时间早于区块时间判定。
  if (intent.issued_at >= outcome.block_time_ms) {
    throw new HttpError(
      409,
      'topup_intent_superseded',
      '付款意图晚于该笔链上付款,不予入账',
    );
  }

  const orderId = createId('top');
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO topup_orders
      (order_id, intent_id, chain_id, token, token_contract, evm_tx_hash, payer_address,
       recv_address, pay_amount, cid_number, account_id, coin_fen, package_id, status, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(
      orderId,
      intent.intent_id,
      intent.chain_id,
      intent.token,
      intent.token_contract,
      txHash,
      outcome.payer,
      intent.recv_address,
      intent.pay_amount,
      intent.cid_number,
      intent.account_id,
      intent.coin_fen,
      intent.package_id,
      nowMs(),
    )
    .run();

  if ((inserted.meta?.changes ?? 0) !== 1) {
    const raced = await findOrderByTx(env, intent.chain_id, txHash)
      ?? await findOrderByIntent(env, intent.intent_id);
    if (raced && raced.intent_id === intent.intent_id) {
      return orderResponse(raced, true);
    }
    throw new HttpError(409, 'topup_payment_already_bound', '付款或付款意图已被处理');
  }
  return jsonResponse({
    ok: true,
    status: 'pending',
    status_label: statusLabel('pending'),
    order_id: orderId,
  });
}

/// POST /square/topup/status — 只允许持有该笔付款意图的一方查询。
///
/// 用 POST 而非 GET:凭据是 HMAC 付款意图,不能出现在 URL 里。归属判据取
/// `order.intent_id === intent.intent_id`(比只比账户更严,且天然覆盖账户归属)。
export async function topupStatusRoute(request: Request, env: Env): Promise<Response> {
  const body = await readJson<StatusBody>(request);
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  if (!/^top_[0-9a-f]{32}$/.test(orderId)) {
    throw new HttpError(400, 'topup_order_id_invalid', '充值订单 ID 不合法');
  }
  const encodedIntent = typeof body.payment_intent === 'string' ? body.payment_intent.trim() : '';
  const intent = await verifyIntent(env, encodedIntent);
  const order = await findOrderById(env, orderId);
  if (!order || order.intent_id !== intent.intent_id) {
    throw new HttpError(404, 'topup_order_not_found', '充值订单不存在');
  }
  return orderResponse(order, false);
}

export async function findOrderByTx(
  env: Env,
  chainId: number,
  txHash: string,
): Promise<TopupOrderRow | null> {
  return env.DB.prepare('SELECT * FROM topup_orders WHERE chain_id = ? AND evm_tx_hash = ?')
    .bind(chainId, txHash)
    .first<TopupOrderRow>();
}

export async function findOrderByIntent(env: Env, intentId: string): Promise<TopupOrderRow | null> {
  return env.DB.prepare('SELECT * FROM topup_orders WHERE intent_id = ?')
    .bind(intentId)
    .first<TopupOrderRow>();
}

export async function findOrderById(env: Env, orderId: string): Promise<TopupOrderRow | null> {
  return env.DB.prepare('SELECT * FROM topup_orders WHERE order_id = ?')
    .bind(orderId)
    .first<TopupOrderRow>();
}

function orderResponse(order: TopupOrderRow, deduplicated: boolean): Response {
  return jsonResponse({
    ok: true,
    status: order.status,
    status_label: statusLabel(order.status),
    order_id: order.order_id,
    gmb_tx_hash: order.gmb_tx_hash,
    coin_fen: order.coin_fen,
    ...(deduplicated ? { deduplicated: true } : {}),
  });
}

function parseAccountId(value: unknown): string {
  try {
    return assertAccountId(value);
  } catch {
    throw new HttpError(400, 'invalid_account_id', '账户标识格式不合法');
  }
}

/// 充值写接口的账户维度限流。会话取消后 guard 只剩 IP 维度,这里补一层按充值目标
/// 计数,避免单一目标账户被大量意图/确认打爆。
function enforceTopupWriteLimit(env: Env, accountId: string): Promise<void> {
  return enforceEdgeRate(env, 'RATE_AUTH', `topup_write:account_id:${accountId}`);
}

/// 命中外部 EVM RPC(`verifyErc20Payment`)前的全局硬顶,按 `chain_id` 分桶。
///
/// `account_id` 由请求指定、无需注册,`account_id` 维度限流可以被无限换号绕过;
/// IP 维度限流可以被换 IP(代理池/僵尸网络)绕过。二者都挡不住"分布式滥用把
/// 外部 RPC 配额/账单打爆"这类攻击——这条不按 IP/账户维度,是唯一挡得住的手段。
/// 阈值是当前开发期零用户下的保守估计(见任务卡),真实流量出现后按用量复核。
function enforceGlobalEvmRpcLimit(env: Env, chainId: number): Promise<void> {
  return enforcePersistentRateLimit(env, `topup_confirm_evm_rpc:chain:${chainId}`, 300, 60);
}

function normalizeAddress(value: unknown): string {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isEvmAddress(address)) {
    throw new HttpError(400, 'topup_payer_invalid', '付款地址不合法');
  }
  return address;
}

function assertIntentStillMatchesConfig(env: Env, intent: PaymentIntent): void {
  const rail = topupRail(env, intent.token);
  const pkg = findPackage(intent.package_id);
  if (
    !pkg ||
    rail.chain_id !== intent.chain_id ||
    rail.token_contract !== intent.token_contract ||
    topupRecvAddress(env) !== intent.recv_address ||
    pkg.pay_amount !== intent.pay_amount ||
    pkg.coin_fen !== intent.coin_fen
  ) {
    throw new HttpError(409, 'topup_intent_config_changed', '充值配置已变化，请重新发起');
  }
}

async function signIntent(env: Env, intent: PaymentIntent): Promise<string> {
  const secret = requireIntentSecret(env);
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(intent)));
  const signature = await crypto.subtle.sign('HMAC', await importIntentKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyIntent(env: Env, token: string): Promise<PaymentIntent> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HttpError(400, 'topup_intent_invalid', '付款意图不合法');
  }
  let signature: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    signature = base64UrlDecode(parts[1]);
    payloadBytes = base64UrlDecode(parts[0]);
  } catch {
    throw new HttpError(400, 'topup_intent_invalid', '付款意图不合法');
  }
  const valid = await crypto.subtle.verify(
    'HMAC',
    await importIntentKey(requireIntentSecret(env)),
    Uint8Array.from(signature),
    new TextEncoder().encode(parts[0]),
  );
  if (!valid) {
    throw new HttpError(400, 'topup_intent_invalid', '付款意图签名不合法');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new HttpError(400, 'topup_intent_invalid', '付款意图内容不合法');
  }
  if (!isPaymentIntent(decoded)) {
    throw new HttpError(400, 'topup_intent_invalid', '付款意图内容不合法');
  }
  return decoded;
}

function requireIntentSecret(env: Env): string {
  const secret = env.TOPUP_INTENT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new HttpError(503, 'topup_intent_unconfigured', '充值付款意图密钥未配置');
  }
  return secret;
}

function importIntentKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function isPaymentIntent(value: unknown): value is PaymentIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Record<string, unknown>;
  return (
    typeof intent.intent_id === 'string' &&
    /^tpi_[0-9a-f]{32}$/.test(intent.intent_id) &&
    (intent.cid_number === null ||
      (typeof intent.cid_number === 'string' && isValidCidNumber(intent.cid_number))) &&
    typeof intent.account_id === 'string' &&
    /^0x[0-9a-f]{64}$/.test(intent.account_id) &&
    typeof intent.payer_address === 'string' &&
    isEvmAddress(intent.payer_address) &&
    isTopupToken(intent.token) &&
    typeof intent.package_id === 'string' &&
    typeof intent.chain_id === 'number' &&
    Number.isSafeInteger(intent.chain_id) &&
    typeof intent.token_contract === 'string' &&
    isEvmAddress(intent.token_contract) &&
    typeof intent.recv_address === 'string' &&
    isEvmAddress(intent.recv_address) &&
    typeof intent.pay_amount === 'string' &&
    /^\d+$/.test(intent.pay_amount) &&
    typeof intent.coin_fen === 'string' &&
    /^\d+$/.test(intent.coin_fen) &&
    typeof intent.issued_at === 'number' &&
    Number.isSafeInteger(intent.issued_at) &&
    typeof intent.expires_at === 'number' &&
    Number.isSafeInteger(intent.expires_at)
  );
}

function isValidCidNumber(value: string): boolean {
  try {
    assertCidNumber(value);
    return true;
  } catch {
    return false;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
