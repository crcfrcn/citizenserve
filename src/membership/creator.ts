import type { Env } from "../types";
import { HttpError, jsonResponse, readJson, requireSession } from "../shared/http";
import { sha256Hex } from "../shared/hash";
import { nowMs } from "../shared/time";
import {
  bindFinalizedTransactionConfirmation,
  readCreatorPlansAtBlock,
  readSubscriptionAtBlock,
  verifyFinalizedSubscriptionTransaction,
  type BillingPeriod,
  type ChainCreatorTier,
  type ChainSubscriptionState,
  type FinalizedTransactionProofInput,
  type VerifiedFinalizedTransaction,
} from "../chain/subscription";
import {
  getMembership,
  isSubscriptionProjectionEffective,
  requireActiveMembership,
  subscriptionIsActive,
} from "./service";
import { fetchChainIdentityStateByCid } from "../chain/identity";

// 创作者统计与门禁只读取 CitizenServe D1；用户主动交易由手机同步，禁止在读取路径扫链。

/**
 * 创作者会员 BFF：身份主键 `cid_number` 是链上及边缘投影的唯一业务归属；
 * account_id 仅保留为 finalized 交易签名/付款审计字段。
 * 档位名称、价格、订阅关系和统计只保存 finalized 投影。业务字段与订阅有效性来自链上，
 * Cloudflare 不扣款、不续费、不计算订阅公历；所有订阅 storage 读取都直接使用 CID。
 */

/// 仅为 D1 审计字段解析 CID 当前绑定账户，不参与订阅定位或授权。
async function currentAccountId(env: Env, cidNumber: string): Promise<string> {
  const identity = await fetchChainIdentityStateByCid(env, cidNumber);
  if (!identity.account_id) {
    throw new HttpError(409, "cid_binding_unavailable", "创作者 CID 当前无有效绑定账户");
  }
  return identity.account_id;
}

const PERIODS = ["monthly", "quarterly", "yearly"] as const;
type Period = (typeof PERIODS)[number];
type CreatorAction = "subscribe" | "cancel" | "change";
const MAX_TIERS = 10;

export interface CreatorTierInput {
  tier_id: string;
  tier_name: string;
  prices_fen: Partial<Record<Period, number>>;
}

interface CreatorPlanRow {
  creator_cid_number: string;
  tier_id: string;
  tier_name: string;
  tier_order: number;
  monthly_price_fen: number | null;
  quarterly_price_fen: number | null;
  yearly_price_fen: number | null;
  verified_at: number;
}

interface CreatorConfirmBody {
  tx_hash?: unknown;
  block_hash?: unknown;
}

interface CreatorPlanBody {
  tx_hash?: unknown;
  block_hash?: unknown;
}

export interface CreatorSubscriptionConfirmDeps {
  verifyTransaction: typeof verifyFinalizedSubscriptionTransaction;
  readSubscriptionAtBlock: (
    env: Env,
    subscriberCidNumber: string,
    creatorCidNumber: string,
    blockHash: string,
  ) => Promise<ChainSubscriptionState | null>;
  currentCreatorAccountId: (env: Env, creatorCidNumber: string) => Promise<string>;
}

export interface CreatorPlanSaveDeps {
  verifyTransaction: typeof verifyFinalizedSubscriptionTransaction;
  readCreatorPlansAtBlock: typeof readCreatorPlansAtBlock;
  readPlatformSubscriptionAtBlock: (
    env: Env,
    creatorCidNumber: string,
    blockHash: string,
  ) => Promise<ChainSubscriptionState | null>;
}

const defaultCreatorPlanSaveDeps: CreatorPlanSaveDeps = {
  verifyTransaction: verifyFinalizedSubscriptionTransaction,
  readCreatorPlansAtBlock,
  readPlatformSubscriptionAtBlock: (env, creatorCidNumber, blockHash) =>
    readSubscriptionAtBlock(env, creatorCidNumber, { kind: "platform" }, blockHash),
};

const defaultSubscriptionConfirmDeps: CreatorSubscriptionConfirmDeps = {
  verifyTransaction: verifyFinalizedSubscriptionTransaction,
  readSubscriptionAtBlock: (env, subscriberCidNumber, creatorCidNumber, blockHash) =>
    readSubscriptionAtBlock(
      env,
      subscriberCidNumber,
      { kind: "creator", creatorCidNumber },
      blockHash,
    ),
  currentCreatorAccountId: currentAccountId,
};

/** 严格校验并归一化档位；价格只用于与链上 signed call 和 finalized storage 对照。 */
function validateTiers(raw: unknown): CreatorTierInput[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_tiers", "档位必须是数组");
  if (raw.length > MAX_TIERS) {
    throw new HttpError(400, "too_many_tiers", `最多 ${MAX_TIERS} 个会员档`);
  }
  const tiers: CreatorTierInput[] = [];
  const seen = new Set<string>();
  for (const item of raw as Array<Record<string, unknown>>) {
    const tierId = typeof item.tier_id === "string" ? item.tier_id : "";
    const tierName = typeof item.tier_name === "string" ? item.tier_name : "";
    const tierNameBytes = new TextEncoder().encode(tierName);
    const tierNameScalars = Array.from(tierName);
    if (!tierId || tierNameBytes.length === 0) {
      throw new HttpError(400, "invalid_tier", "档位需含 tier_id 与 tier_name");
    }
    if (
      tierName.trim() !== tierName || tierNameScalars.length > 20 || tierNameBytes.length > 80 ||
      tierNameScalars.some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      })
    ) {
      throw new HttpError(400, "invalid_tier_name", "tier_name 必须为 1-20 个 Unicode 标量、最多 80 字节且无首尾空白或控制字符");
    }
    if (seen.has(tierId)) throw new HttpError(400, "duplicate_tier", "档位标识重复");
    seen.add(tierId);
    const rawPrices =
      typeof item.prices_fen === "object" && item.prices_fen !== null
        ? (item.prices_fen as Record<string, unknown>)
        : {};
    const pricesFen: Partial<Record<Period, number>> = {};
    for (const period of PERIODS) {
      const value = rawPrices[period];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new HttpError(400, "invalid_price", "价格必须为正整数分");
      }
      pricesFen[period] = value;
    }
    if (Object.keys(pricesFen).length === 0) {
      throw new HttpError(400, "no_period", "每档至少开一个周期并填价");
    }
    tiers.push({ tier_id: tierId, tier_name: tierName, prices_fen: pricesFen });
  }
  return tiers;
}

function chainTiersFromInput(tiers: CreatorTierInput[]): ChainCreatorTier[] {
  return tiers.map((tier) => ({
    tierId: tier.tier_id,
    tierName: tier.tier_name,
    pricesFen: Object.fromEntries(
      PERIODS.flatMap((period) => {
        const value = tier.prices_fen[period];
        return value === undefined ? [] : [[period, BigInt(value)]];
      }),
    ) as Partial<Record<BillingPeriod, bigint>>,
  }));
}

function verifiedProjectionTiers(
  requested: CreatorTierInput[],
  chainTiers: ChainCreatorTier[],
): CreatorTierInput[] {
  const expected = chainTiersFromInput(requested);
  if (!creatorTiersEqual(expected, chainTiers)) {
    throw new HttpError(409, "creator_plans_not_finalized", "链上创作者档位尚未最终确认");
  }
  return chainTiers.map((tier) => {
    if (tier.tierName === null) {
      throw new HttpError(409, "creator_tier_name_missing", "链上创作者档位名称尚未设置");
    }
    return {
      tier_id: tier.tierId,
      tier_name: tier.tierName,
      prices_fen: Object.fromEntries(PERIODS.flatMap((period) => {
        const value = tier.pricesFen[period];
        return value === undefined ? [] : [[period, safePrice(value)]];
      })) as Partial<Record<Period, number>>,
    };
  });
}

async function readPlan(env: Env, creatorCidNumber: string): Promise<unknown> {
  const rows = await env.DB.prepare(
    `SELECT creator_cid_number, tier_id, tier_name, tier_order, monthly_price_fen,
        quarterly_price_fen, yearly_price_fen, verified_at
      FROM square_creator_tiers
      WHERE creator_cid_number = ? ORDER BY tier_order ASC`,
  )
    .bind(creatorCidNumber)
    .all<CreatorPlanRow>();
  const items = rows.results ?? [];
  if (items.length === 0) return null;
  return {
    creator_cid_number: creatorCidNumber,
    tiers: items.map(rowToTier),
    updated_at: Math.max(...items.map((row) => row.verified_at)),
  };
}

function rowToTier(row: CreatorPlanRow): CreatorTierInput {
  const pricesFen: Partial<Record<Period, number>> = {};
  if (row.monthly_price_fen !== null) pricesFen.monthly = row.monthly_price_fen;
  if (row.quarterly_price_fen !== null) pricesFen.quarterly = row.quarterly_price_fen;
  if (row.yearly_price_fen !== null) pricesFen.yearly = row.yearly_price_fen;
  return {
    tier_id: row.tier_id,
    tier_name: row.tier_name,
    prices_fen: pricesFen,
  };
}

function monthStartMs(): number {
  const now = new Date(nowMs());
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** GET /square/creator/plan —— 当前钱包的档位；平台订阅门禁在服务端复核。 */
export async function creatorPlanRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  await requireActiveMembership(env, session.cid_number, session.account_id);
  return jsonResponse({ plan: await readPlan(env, session.cid_number) });
}

/** GET /square/creator/plan/:cid —— 仅返回当前仍具平台订阅资格的创作者档位。 */
export async function creatorPlanOfRoute(
  request: Request,
  env: Env,
  cid: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const creatorCidNumber = decodeURIComponent(cid);
  const membership = await getMembership(env, creatorCidNumber);
  const plan = membership && subscriptionIsActive(membership)
    ? await readPlan(env, creatorCidNumber)
    : null;
  const subscription = await env.DB.prepare(
    `SELECT tier_id, billing_period, subscription_status, paid_until
      FROM square_creator_subscriptions
      WHERE subscriber_cid_number = ? AND creator_cid_number = ?`,
  )
    .bind(session.cid_number, creatorCidNumber)
    .first<{
      tier_id: string;
      billing_period: string;
      subscription_status: string;
      paid_until: number;
    }>();
  return jsonResponse({
    plan,
    tier_id: subscription?.tier_id ?? null,
    billing_period: subscription?.billing_period ?? null,
    subscription_status: subscription?.subscription_status ?? null,
    paid_until: subscription?.paid_until ?? 0,
    active: subscription ? isSubscriptionProjectionEffective(subscription) : false,
  });
}

/** GET /square/creator/overview —— 只统计 D1 中当前仍有效的订阅关系。 */
export async function creatorOverviewRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  await requireActiveMembership(env, session.cid_number, session.account_id);
  const creatorCidNumber = session.cid_number;
  const observedAt = nowMs();
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt
      FROM square_creator_subscriptions s
      WHERE s.creator_cid_number = ?
        AND s.subscription_status IN ('active', 'cancelled')
        AND ? < s.paid_until`,
  )
    .bind(creatorCidNumber, observedAt)
    .first<{ cnt: number }>();
  const incomeRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(last_charged_price_fen), 0) AS total
      FROM square_creator_subscriptions s
      WHERE creator_cid_number = ? AND last_charged_at >= ?`,
  )
    .bind(creatorCidNumber, monthStartMs())
    .first<{ total: number }>();
  const plan = await readPlan(env, creatorCidNumber) as { tiers?: unknown[] } | null;
  return jsonResponse({
    overview: {
      subscriber_count: Number(countRow?.cnt ?? 0),
      month_income_fen: Number(incomeRow?.total ?? 0),
      tier_count: plan?.tiers?.length ?? 0,
    },
  });
}

/** POST /square/creator/plan —— 一次链签名后的 finalized 查询投影。 */
export async function creatorPlanSaveRoute(
  request: Request,
  env: Env,
  deps: CreatorPlanSaveDeps = defaultCreatorPlanSaveDeps,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<CreatorPlanBody>(request);
  const proof = transactionProof(body);
  const transaction = await deps.verifyTransaction(
    env,
    session.account_id,
    proof,
  );
  const [chainTiers, platformState] = await Promise.all([
    deps.readCreatorPlansAtBlock(env, session.cid_number, transaction.blockHash),
    deps.readPlatformSubscriptionAtBlock(env, session.cid_number, transaction.blockHash),
  ]);
  const requested = creatorPlanTiers(transaction.action, chainTiers);
  const tiers = verifiedProjectionTiers(requested, chainTiers);
  if (!subscriptionStateEffective(platformState, transaction.chainTimestamp)) {
    throw new HttpError(402, "membership_required", "需要有效平台订阅才能开通创作者会员");
  }
  const verifiedAt = nowMs();
  const requestHash = await sha256Hex(JSON.stringify({ action: "set_creator_plans", tiers }));
  await bindFinalizedTransactionConfirmation(
    env,
    session.cid_number,
    session.account_id,
    transaction,
    requestHash,
    verifiedAt,
  );
  await replaceCreatorTierProjection(
    env,
    session.cid_number,
    session.account_id,
    tiers,
    {
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
      verifiedAt,
      lastTxHash: transaction.txHash,
    },
  );
  return jsonResponse({
    plan: {
      creator_cid_number: session.cid_number,
      tiers,
      updated_at: verifiedAt,
    },
  });
}

/** POST /square/creator/subscription/confirm —— finalized 创作者订阅投影确认。 */
export async function creatorSubscriptionConfirmRoute(
  request: Request,
  env: Env,
  deps: CreatorSubscriptionConfirmDeps = defaultSubscriptionConfirmDeps,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson<CreatorConfirmBody>(request);
  const proof = transactionProof(body);
  const transaction = await deps.verifyTransaction(
    env,
    session.account_id,
    proof,
  );
  const { action, creatorCidNumber, tierId, billingPeriod } =
    creatorSubscriptionAction(transaction.action);
  const state = await deps.readSubscriptionAtBlock(
    env,
    session.cid_number,
    creatorCidNumber,
    transaction.blockHash,
  );
  assertCreatorStateMatches(state, action, tierId, billingPeriod);
  const verifiedAt = nowMs();
  const requestHash = await sha256Hex(
    JSON.stringify({ action, creator_cid_number: creatorCidNumber, tier_id: tierId, billing_period: billingPeriod }),
  );
  await bindFinalizedTransactionConfirmation(
    env,
    session.cid_number,
    session.account_id,
    transaction,
    requestHash,
    verifiedAt,
  );
  const creatorAccountId =
    await deps.currentCreatorAccountId(env, creatorCidNumber);
  await projectCreatorSubscription(
    env,
    session.cid_number,
    session.account_id,
    creatorCidNumber,
    creatorAccountId,
    state!,
    {
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
      verifiedAt,
      lastTxHash: transaction.txHash,
    },
  );
  return jsonResponse({
    ok: true,
    subscription_status: state!.status,
    paid_until: state!.paidUntil,
  });
}

/** 创作者付费内容的统一服务端门禁；未知、陈旧、终止或过期全部拒绝。 */
export async function requireCreatorSubscription(
  env: Env,
  subscriberCidNumber: string,
  creatorCidNumber: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT subscription_status, paid_until
      FROM square_creator_subscriptions
      WHERE s.subscriber_cid_number = ? AND s.creator_cid_number = ?`,
  )
    .bind(subscriberCidNumber, creatorCidNumber)
    .first<{
      subscription_status: string;
      paid_until: number;
    }>();
  if (!row || !isSubscriptionProjectionEffective(row)) {
    throw new HttpError(402, "creator_subscription_required", "需订阅该创作者会员");
  }
}

export async function replaceCreatorTierProjection(
  env: Env,
  creatorCidNumber: string,
  creatorAccountId: string,
  tiers: CreatorTierInput[],
  point: {
    blockNumber: number;
    blockHash: string;
    verifiedAt: number;
    lastTxHash: string | null;
  },
): Promise<void> {
  // 归属主键 = 创作者身份主键 creator_cid_number;creator_account_id 记当前签名账户(链上事实)。
  const statements: D1PreparedStatement[] = [];
  tiers.forEach((tier, index) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO square_creator_tiers
          (creator_cid_number, creator_account_id, tier_id, tier_name, tier_order, monthly_price_fen,
           quarterly_price_fen, yearly_price_fen, finalized_block_number,
           finalized_block_hash, verified_at, last_tx_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(creator_cid_number, tier_id) DO UPDATE SET
            creator_account_id = excluded.creator_account_id,
            tier_name = excluded.tier_name,
            tier_order = excluded.tier_order,
            monthly_price_fen = excluded.monthly_price_fen,
            quarterly_price_fen = excluded.quarterly_price_fen,
            yearly_price_fen = excluded.yearly_price_fen,
            finalized_block_number = excluded.finalized_block_number,
            finalized_block_hash = excluded.finalized_block_hash,
            verified_at = excluded.verified_at,
            last_tx_hash = COALESCE(excluded.last_tx_hash, square_creator_tiers.last_tx_hash)
          WHERE excluded.finalized_block_number >= square_creator_tiers.finalized_block_number`,
      ).bind(
        creatorCidNumber,
        creatorAccountId,
        tier.tier_id,
        tier.tier_name,
        index,
        tier.prices_fen.monthly ?? null,
        tier.prices_fen.quarterly ?? null,
        tier.prices_fen.yearly ?? null,
        point.blockNumber,
        point.blockHash,
        point.verifiedAt,
        point.lastTxHash,
      ),
    );
  });
  const tierIds = tiers.map((tier) => tier.tier_id);
  const staleTierSql = tierIds.length === 0
    ? `DELETE FROM square_creator_tiers
        WHERE creator_cid_number = ? AND finalized_block_number <= ?`
    : `DELETE FROM square_creator_tiers
        WHERE creator_cid_number = ? AND finalized_block_number <= ?
          AND tier_id NOT IN (${tierIds.map(() => '?').join(', ')})`;
  statements.push(
    env.DB.prepare(staleTierSql).bind(creatorCidNumber, point.blockNumber, ...tierIds),
  );
  await env.DB.batch(statements);
}

export async function projectCreatorSubscription(
  env: Env,
  subscriberCidNumber: string,
  subscriberAccountId: string,
  creatorCidNumber: string,
  creatorAccountId: string,
  state: ChainSubscriptionState,
  point: {
    blockNumber: number;
    blockHash: string;
    verifiedAt: number;
    lastTxHash: string | null;
  },
): Promise<void> {
  if (state.plan.kind !== "creator") {
    throw new HttpError(409, "subscription_state_not_finalized", "链上创作者订阅计划不合法");
  }
  // 归属主键 = (订阅者身份, 创作者身份);两 account_id 记各自当前签名/付款账户(链上事实)。
  await env.DB.prepare(
    `INSERT INTO square_creator_subscriptions
      (subscriber_cid_number, creator_cid_number, subscriber_account_id, creator_account_id,
       tier_id, billing_period, started_at, last_charged_at,
       last_charged_price_fen, paid_until, subscription_status,
       finalized_block_number, finalized_block_hash, verified_at, last_tx_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscriber_cid_number, creator_cid_number) DO UPDATE SET
        subscriber_account_id = excluded.subscriber_account_id,
        creator_account_id = excluded.creator_account_id,
        tier_id = excluded.tier_id,
        billing_period = excluded.billing_period,
        started_at = excluded.started_at,
        last_charged_at = excluded.last_charged_at,
        last_charged_price_fen = excluded.last_charged_price_fen,
        paid_until = excluded.paid_until,
        subscription_status = excluded.subscription_status,
        finalized_block_number = excluded.finalized_block_number,
        finalized_block_hash = excluded.finalized_block_hash,
        verified_at = excluded.verified_at,
        last_tx_hash = COALESCE(excluded.last_tx_hash, square_creator_subscriptions.last_tx_hash)
      WHERE excluded.finalized_block_number >= square_creator_subscriptions.finalized_block_number`,
  )
    .bind(
      subscriberCidNumber,
      creatorCidNumber,
      subscriberAccountId,
      creatorAccountId,
      state.plan.tierId,
      state.plan.billingPeriod,
      state.startedAt,
      state.lastChargedAt,
      safePrice(state.lastChargedPriceFen),
      state.paidUntil,
      state.status,
      point.blockNumber,
      point.blockHash,
      point.verifiedAt,
      point.lastTxHash,
    )
    .run();
}

function assertCreatorStateMatches(
  state: ChainSubscriptionState | null,
  action: CreatorAction,
  tierId: string | null,
  billingPeriod: BillingPeriod | null,
): void {
  if (state === null || state.plan.kind !== "creator") {
    throw new HttpError(409, "subscription_state_not_finalized", "链上创作者订阅状态尚未最终确认");
  }
  if (action === "cancel") {
    if (state.status !== "cancelled") {
      throw new HttpError(409, "subscription_state_not_finalized", "链上取消状态尚未最终确认");
    }
    return;
  }
  // 换挡即时生效（无 pending）：确认后链上 plan 已是目标档位/周期。
  const currentMatches = state.plan.tierId === tierId && state.plan.billingPeriod === billingPeriod;
  if (state.status !== "active" || !currentMatches) {
    throw new HttpError(409, "subscription_state_not_finalized", "链上创作者订阅或换档状态尚未最终确认");
  }
}

function transactionProof(body: CreatorConfirmBody | CreatorPlanBody): FinalizedTransactionProofInput {
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

function creatorPlanTiers(
  action: VerifiedFinalizedTransaction["action"],
  chainTiers: ChainCreatorTier[],
): CreatorTierInput[] {
  if (action.kind !== "creator_plans_set" && action.kind !== "creator_tier_name_update") {
    throw new HttpError(400, "invalid_subscription_action", "交易不是创作者档位变更");
  }
  return validateTiers(
    chainTiers.map((tier) => ({
      tier_id: tier.tierId,
      tier_name: tier.tierName,
      prices_fen: Object.fromEntries(
        Object.entries(tier.pricesFen).map(([period, price]) => [period, Number(price)]),
      ),
    })),
  );
}

function creatorSubscriptionAction(action: VerifiedFinalizedTransaction["action"]): {
  action: CreatorAction;
  creatorCidNumber: string;
  tierId: string | null;
  billingPeriod: "monthly" | "quarterly" | "yearly" | null;
} {
  if (action.kind === "creator_cancel") {
    return {
      action: "cancel",
      creatorCidNumber: action.creatorCidNumber,
      tierId: null,
      billingPeriod: null,
    };
  }
  if (action.kind === "creator_subscribe" || action.kind === "creator_change") {
    return {
      action: action.kind === "creator_subscribe" ? "subscribe" : "change",
      creatorCidNumber: action.creatorCidNumber,
      tierId: action.tierId,
      billingPeriod: action.billingPeriod,
    };
  }
  throw new HttpError(400, "invalid_subscription_action", "交易不是创作者订阅操作");
}

function requireString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new HttpError(400, "invalid_request", message);
}

function creatorTiersEqual(left: ChainCreatorTier[], right: ChainCreatorTier[]): boolean {
  return left.length === right.length && left.every((tier, index) => {
    const other = right[index];
    return !!other && tier.tierId === other.tierId && tier.tierName === other.tierName && PERIODS.every(
      (period) => tier.pricesFen[period] === other.pricesFen[period],
    );
  });
}

function subscriptionStateEffective(
  state: ChainSubscriptionState | null,
  chainTimestamp: number,
): boolean {
  return !!state &&
    (state.status === "active" || state.status === "cancelled") &&
    chainTimestamp < state.paidUntil;
}

function safePrice(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(502, "creator_price_out_of_range", "链上创作者价格超出边缘服务范围");
  }
  return Number(value);
}
