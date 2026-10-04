import type { Env, MembershipRow } from '../types';
import { HttpError, jsonResponse, requireSession } from '../shared/http';
import { membershipPlanList } from './plans';
import { nowMs } from '../shared/time';
import { readMembershipUsageState } from '../limits/usage';

/// 会员状态读取 + 门禁（写入 finalized 投影见 `citizen_coin.ts`）。
/// 会员与身份彻底解耦（ADR-037）：会员权益只看订阅是否有效（subscriptionIsActive），
/// 不再读链上身份、不再有「身份≠档位」冻结或暂停收款。身份展示由 chain/identity 与
/// profiles 各自负责，会员侧一概不涉身份。
/// 价格、状态和到期时间都来自 finalized `square-post`；BFF 不计算公历。

const MEMBERSHIP_COLUMNS =
  `m.cid_number, m.account_id, m.membership_level, m.started_at,
    m.last_charged_at, m.last_charged_price_fen, m.paid_until,
    m.subscription_status, m.finalized_block_number, m.finalized_block_hash,
    m.verified_at, m.entitlement_lapsed_at, m.last_tx_hash`;

/// 会员投影按身份主键 cid_number 读取(account_id 仅为当前付款账户,不作归属键)。
export async function getMembership(env: Env, cidNumber: string): Promise<MembershipRow | null> {
  return env.DB.prepare(
    `SELECT ${MEMBERSHIP_COLUMNS}
      FROM square_memberships m
      WHERE m.cid_number = ?`
  )
    .bind(cidNumber)
    .first<MembershipRow>();
}

/// 批量读会员：一页去重作者(身份主键 cid_number)一条 IN() 查询（≤50 占位符），避免逐作者点查。
export async function batchMemberships(
  env: Env,
  cidNumbers: string[]
): Promise<Map<string, MembershipRow>> {
  const distinct = [...new Set(cidNumbers)];
  const map = new Map<string, MembershipRow>();
  if (distinct.length === 0) {
    return map;
  }
  const placeholders = distinct.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT ${MEMBERSHIP_COLUMNS}
      FROM square_memberships m
      WHERE m.cid_number IN (${placeholders})`
  )
    .bind(...distinct)
    .all<MembershipRow>();
  for (const row of result.results ?? []) {
    map.set(row.cid_number, row);
  }
  return map;
}

/// 发布闸门（门禁2）：只要求订阅当前有效；解耦后不再校验身份、不再冻结。
export async function requireActiveMembership(
  env: Env,
  cidNumber: string,
  _accountId: string,
): Promise<MembershipRow> {
  // 发布门禁只读取 CitizenServe 已由 finalized 交易确认写入的 D1 会员记录。
  // 订阅状态变更由手机端独立同步；发布路径禁止点查链、修复投影或等待链时钟。
  const membership = await getMembership(env, cidNumber);
  if (!membership) {
    throw new HttpError(402, 'membership_required', '需要有效会员才能发布广场内容');
  }
  if (!subscriptionIsActive(membership)) {
    throw new HttpError(402, 'membership_inactive', '会员订阅未生效或已过期');
  }
  // 已移除账户总储存上限维度（对齐 YouTube/推特）：仅校验会员有效，不再核算容量。
  return membership;
}

export async function membershipRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  return jsonResponse(await membershipPayload(env, session.cid_number));
}

/// 会员查询与 finalized 交易确认共用同一份 D1 响应，禁止形成两套手机缓存口径。
export async function membershipPayload(env: Env, cidNumber: string): Promise<Record<string, unknown>> {
  const membership = await getMembership(env, cidNumber);
  const active = membership ? subscriptionIsActive(membership) : false;
  const usageState = active && membership
    ? await readMembershipUsageState(env, cidNumber, membership)
    : null;
  return {
    ok: true,
    plans: membershipPlanList(),
    membership,
    // 解耦后权益态即订阅态（无身份冻结）；两字段等值，保留 subscription_active 供 App 判续订。
    subscription_active: active,
    active,
    usage_state: usageState,
  };
}

/// Active 或已签名取消但尚在已付周期内的 Cancelled 都有效；其余状态或过期拒绝。
export function subscriptionIsActive(
  membership: MembershipRow,
  observedNow: number = nowMs(),
): boolean {
  return isSubscriptionProjectionEffective({
    subscription_status: membership.subscription_status,
    paid_until: membership.paid_until,
  }, observedNow);
}

/// D1 行已经由 finalized 会员变更确认写入；读取和发布不再以全局链时钟二次降级。
export function membershipProjectionIsCurrent(
  membership: MembershipRow,
  observedNow: number = nowMs(),
): boolean {
  void membership;
  void observedNow;
  return true;
}

export function isSubscriptionProjectionEffective(
  projection: {
    subscription_status: string;
    paid_until: number;
  },
  observedNow: number = nowMs(),
): boolean {
  if (projection.subscription_status !== 'active' && projection.subscription_status !== 'cancelled') {
    return false;
  }
  return observedNow < projection.paid_until;
}
