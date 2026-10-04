import type { Env } from "../types";
import { HttpError, jsonResponse, readJson, requireSession } from "../shared/http";
import { sha256Hex } from "../shared/hash";
import { nowMs } from "../shared/time";
import {
  bindFinalizedTransactionConfirmation,
  readSubscriptionAtBlock,
  verifyFinalizedSubscriptionTransaction,
  type ChainSubscriptionState,
  type FinalizedTransactionProofInput,
  type PlatformLevel,
  type SubscriptionBusinessAction,
  type VerifiedFinalizedTransaction,
} from "../chain/subscription";
import { assertMembershipLevel } from "./plans";
import { membershipPayload } from "./service";

/**
 * 平台订阅 BFF 只接收 CitizenApp 已完成交易的 tx_hash 与 finalized block_hash。Worker
 * 从指定区块取得交易，校验当前钱包并解析真实动作，再读取同一区块订阅状态写入 D1。
 * 任何 HTTP 重试都只使用 Bearer 会话，不产生第二次账户或设备签名。
 */

type PlatformAction = "subscribe" | "cancel" | "change";

interface PlatformConfirmBody {
  tx_hash?: unknown;
  block_hash?: unknown;
}

export interface PlatformSubscriptionConfirmDeps {
  verifyTransaction: (
    env: Env,
    accountId: string,
    proof: FinalizedTransactionProofInput,
  ) => Promise<VerifiedFinalizedTransaction>;
  readSubscriptionAtBlock: (
    env: Env,
    cidNumber: string,
    blockHash: string,
  ) => Promise<ChainSubscriptionState | null>;
}

const defaultConfirmDeps: PlatformSubscriptionConfirmDeps = {
  verifyTransaction: verifyFinalizedSubscriptionTransaction,
  readSubscriptionAtBlock: (env, cidNumber, blockHash) =>
    readSubscriptionAtBlock(env, cidNumber, { kind: "platform" }, blockHash),
};

/** POST /square/membership/confirm —— finalized 平台订阅投影确认（严格幂等）。 */
export async function platformSubscriptionConfirmRoute(
  request: Request,
  env: Env,
  deps: PlatformSubscriptionConfirmDeps = defaultConfirmDeps,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<PlatformConfirmBody>(request);
  const proof = transactionProof(body);
  const transaction = await deps.verifyTransaction(
    env,
    session.account_id,
    proof,
  );
  const { action, membershipLevel } = verifiedPlatformAction(transaction.action);
  const state = await deps.readSubscriptionAtBlock(
    env,
    session.cid_number,
    transaction.blockHash,
  );
  assertPlatformStateMatches(state, action, membershipLevel);

  const confirmedAt = nowMs();
  const requestHash = await sha256Hex(
    JSON.stringify({ action, membership_level: membershipLevel }),
  );
  await bindFinalizedTransactionConfirmation(
    env,
    session.cid_number,
    session.account_id,
    transaction,
    requestHash,
    confirmedAt,
  );
  await projectPlatformSubscription(env, session.cid_number, session.account_id, state!, {
    blockNumber: transaction.blockNumber,
    blockHash: transaction.blockHash,
    verifiedAt: confirmedAt,
    lastTxHash: transaction.txHash,
  });
  return jsonResponse(await membershipPayload(env, session.cid_number));
}

function verifiedPlatformAction(
  action: SubscriptionBusinessAction,
): { action: PlatformAction; membershipLevel: PlatformLevel | null } {
  if (action.kind === "platform_cancel") return { action: "cancel", membershipLevel: null };
  if (action.kind === "platform_subscribe") {
    return { action: "subscribe", membershipLevel: assertMembershipLevel(action.membershipLevel) };
  }
  if (action.kind === "platform_change") {
    return { action: "change", membershipLevel: assertMembershipLevel(action.membershipLevel) };
  }
  throw new HttpError(409, "subscription_tx_action_mismatch", "链上交易不是平台会员操作");
}

function transactionProof(body: PlatformConfirmBody): FinalizedTransactionProofInput {
  if (
    typeof body.tx_hash !== "string" ||
    typeof body.block_hash !== "string"
  ) {
    throw new HttpError(400, "invalid_transaction_proof", "finalized 交易证明不完整");
  }
  return {
    txHash: body.tx_hash,
    blockHash: body.block_hash,
  };
}

function assertPlatformStateMatches(
  state: ChainSubscriptionState | null,
  action: PlatformAction,
  requestedLevel: PlatformLevel | null,
): void {
  if (state === null || state.plan.kind !== "platform") {
    throw new HttpError(409, "subscription_state_not_finalized", "链上平台订阅状态尚未最终确认");
  }
  if (action === "cancel") {
    if (state.status !== "cancelled") {
      throw new HttpError(409, "subscription_state_not_finalized", "链上取消状态尚未最终确认");
    }
    return;
  }
  // 换挡即时生效（无 pending）：确认后链上 plan 已是目标档。
  if (
    state.status !== "active" ||
    state.plan.membershipLevel !== requestedLevel
  ) {
    throw new HttpError(409, "subscription_state_not_finalized", "链上平台订阅或换档状态尚未最终确认");
  }
}

export async function projectPlatformSubscription(
  env: Env,
  cidNumber: string,
  accountId: string,
  state: ChainSubscriptionState,
  point: {
    blockNumber: number;
    blockHash: string;
    verifiedAt: number;
    lastTxHash: string | null;
  },
): Promise<void> {
  if (state.plan.kind !== "platform") {
    throw new HttpError(409, "subscription_state_not_finalized", "链上平台订阅计划不合法");
  }
  const lastChargedPriceFen = safePrice(state.lastChargedPriceFen);
  const entitlementLapsedAt = state.status === "active" ? null : state.paidUntil;
  // 归属主键 = 身份主键 cid_number;account_id 记当前付款/签名账户(链上事实)。
  await env.DB.prepare(
    `INSERT INTO square_memberships
      (cid_number, account_id, membership_level, started_at,
       last_charged_at, last_charged_price_fen, paid_until, subscription_status,
       finalized_block_number, finalized_block_hash, verified_at,
       entitlement_lapsed_at, last_tx_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cid_number) DO UPDATE SET
        account_id = excluded.account_id,
        membership_level = excluded.membership_level,
        started_at = excluded.started_at,
        last_charged_at = excluded.last_charged_at,
        last_charged_price_fen = excluded.last_charged_price_fen,
        paid_until = excluded.paid_until,
        subscription_status = excluded.subscription_status,
        finalized_block_number = excluded.finalized_block_number,
        finalized_block_hash = excluded.finalized_block_hash,
        verified_at = excluded.verified_at,
        entitlement_lapsed_at = excluded.entitlement_lapsed_at,
        storage_cleanup_notified_at = CASE
          WHEN excluded.subscription_status = 'active' THEN NULL
          ELSE square_memberships.storage_cleanup_notified_at END,
        last_tx_hash = COALESCE(excluded.last_tx_hash, square_memberships.last_tx_hash)
      WHERE excluded.finalized_block_number >= square_memberships.finalized_block_number`,
  )
    .bind(
      cidNumber,
      accountId,
      state.plan.membershipLevel,
      state.startedAt,
      state.lastChargedAt,
      lastChargedPriceFen,
      state.paidUntil,
      state.status,
      point.blockNumber,
      point.blockHash,
      point.verifiedAt,
      entitlementLapsedAt,
      point.lastTxHash,
    )
    .run();
}

function safePrice(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(502, "subscription_price_out_of_range", "链上订阅价格超出边缘服务范围");
  }
  return Number(value);
}
