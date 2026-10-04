import { fetchChainAccountIdsByCidAtBlock } from '../chain/identity';
import { decodeSquarePostSubscriptionEvents } from '../chain/square_post_event';
import {
  fetchBlockHeader,
  fetchCanonicalBlockHash,
  fetchFinalizedHead,
  fetchSystemEventsAtBlock,
  isChainRpcConfigured,
} from '../chain/rpc';
import {
  readCreatorPlansBatchAtBlock,
  readSubscriptionsAtBlock,
  type ChainCreatorTier,
  type ChainSubscriptionState,
} from '../chain/subscription';
import { HttpError } from '../shared/http';
import { nowMs } from '../shared/time';
import type { Env, SubscriptionProjectionCursorRow } from '../types';
import { projectPlatformSubscription } from './citizen_coin';
import {
  projectCreatorSubscription,
  replaceCreatorTierProjection,
  type CreatorTierInput,
} from './creator';

const SUBSCRIPTION_PROJECTION_BLOCK_BATCH = 10;

type SubscriptionRelation =
  | { subscriberCidNumber: string; issuer: { kind: 'platform' } }
  | { subscriberCidNumber: string; issuer: { kind: 'creator'; creatorCidNumber: string } };

export interface SubscriptionProjectionDeps {
  fetchFinalizedHead: typeof fetchFinalizedHead;
  fetchBlockHeader: typeof fetchBlockHeader;
  fetchCanonicalBlockHash: typeof fetchCanonicalBlockHash;
  fetchSystemEventsAtBlock: typeof fetchSystemEventsAtBlock;
  readSubscriptionsAtBlock: typeof readSubscriptionsAtBlock;
  readCreatorPlansBatchAtBlock: typeof readCreatorPlansBatchAtBlock;
  fetchChainAccountIdsByCidAtBlock: typeof fetchChainAccountIdsByCidAtBlock;
}

const defaultDeps: SubscriptionProjectionDeps = {
  fetchFinalizedHead,
  fetchBlockHeader,
  fetchCanonicalBlockHash,
  fetchSystemEventsAtBlock,
  readSubscriptionsAtBlock,
  readCreatorPlansBatchAtBlock,
  fetchChainAccountIdsByCidAtBlock,
};

export interface SubscriptionProjectionReconcileResult {
  enabled: boolean;
  processed_block_count: number;
  projected_subscription_count: number;
  projected_creator_count: number;
  finalized_block_number: number | null;
  cursor_block_number: number | null;
}

/**
 * 唯一 finalized 订阅投影任务。Worker 通过既有 Access + Tunnel RPC 读取国储会节点；
 * 事件只定位关系，平台会员、创作者订阅和档位均以同区块 storage 为唯一状态真源。
 */
export async function reconcileFinalizedSubscriptionProjection(
  env: Env,
  deps: SubscriptionProjectionDeps = defaultDeps,
): Promise<SubscriptionProjectionReconcileResult> {
  if (!isChainRpcConfigured(env)) {
    return {
      enabled: false,
      processed_block_count: 0,
      projected_subscription_count: 0,
      projected_creator_count: 0,
      finalized_block_number: null,
      cursor_block_number: null,
    };
  }
  const finalizedHash = await deps.fetchFinalizedHead(env);
  const finalizedHeader = await deps.fetchBlockHeader(env, finalizedHash);
  const finalizedNumber = parseBlockNumber(finalizedHeader.number);
  let cursor = await ensureProjectionCursor(env, deps);
  const canonicalCursorHash = await deps.fetchCanonicalBlockHash(env, cursor.finalized_block_number);
  if (canonicalCursorHash !== cursor.finalized_block_hash) {
    throw new HttpError(409, 'subscription_projection_cursor_not_canonical', '订阅投影游标不属于 canonical 主链');
  }
  const lastBlock = Math.min(
    finalizedNumber,
    cursor.finalized_block_number + SUBSCRIPTION_PROJECTION_BLOCK_BATCH,
  );
  let processedBlocks = 0;
  let projectedSubscriptions = 0;
  let projectedCreators = 0;
  for (let blockNumber = cursor.finalized_block_number + 1; blockNumber <= lastBlock; blockNumber += 1) {
    const blockHash = await deps.fetchCanonicalBlockHash(env, blockNumber);
    const result = await projectCanonicalBlock(env, blockNumber, blockHash, deps);
    cursor = await advanceProjectionCursor(env, cursor, blockNumber, blockHash);
    processedBlocks += 1;
    projectedSubscriptions += result.projectedSubscriptions;
    projectedCreators += result.projectedCreators;
  }
  return {
    enabled: true,
    processed_block_count: processedBlocks,
    projected_subscription_count: projectedSubscriptions,
    projected_creator_count: projectedCreators,
    finalized_block_number: finalizedNumber,
    cursor_block_number: cursor.finalized_block_number,
  };
}

async function projectCanonicalBlock(
  env: Env,
  blockNumber: number,
  blockHash: string,
  deps: SubscriptionProjectionDeps,
): Promise<{ projectedSubscriptions: number; projectedCreators: number }> {
  const events = decodeSquarePostSubscriptionEvents(await deps.fetchSystemEventsAtBlock(env, blockHash));
  const relations = new Map<string, SubscriptionRelation>();
  const creatorCidNumbers = new Set<string>();
  for (const event of events) {
    if (event.subscriber_cid_number && event.issuer_kind === 'platform') {
      const relation: SubscriptionRelation = {
        subscriberCidNumber: event.subscriber_cid_number,
        issuer: { kind: 'platform' },
      };
      relations.set(relationKey(relation), relation);
    }
    if (event.subscriber_cid_number && event.issuer_kind === 'creator' && event.creator_cid_number) {
      const relation: SubscriptionRelation = {
        subscriberCidNumber: event.subscriber_cid_number,
        issuer: { kind: 'creator', creatorCidNumber: event.creator_cid_number },
      };
      relations.set(relationKey(relation), relation);
    }
    if (!event.subscriber_cid_number && event.creator_cid_number) {
      creatorCidNumbers.add(event.creator_cid_number);
    }
  }
  const relationList = [...relations.values()];
  const creatorList = [...creatorCidNumbers];
  const identityCidNumbers = [...new Set([
    ...relationList.flatMap((relation) => relation.issuer.kind === 'creator'
      ? [relation.subscriberCidNumber, relation.issuer.creatorCidNumber]
      : [relation.subscriberCidNumber]),
    ...creatorList,
  ])];
  const [states, creatorPlans, accountIds, projectedCidNumbers] = await Promise.all([
    deps.readSubscriptionsAtBlock(env, relationList, blockHash),
    deps.readCreatorPlansBatchAtBlock(env, creatorList, blockHash),
    deps.fetchChainAccountIdsByCidAtBlock(env, identityCidNumbers, blockHash),
    readProjectedCidNumbers(env, identityCidNumbers, blockNumber),
  ]);
  const point = { blockNumber, blockHash, verifiedAt: nowMs(), lastTxHash: null };

  // 会员表保留 users 外键：同区块链上仍有效、但 D1 用户投影尚未落库时必须停止游标，
  // 等 Cron 先完成用户 finalized 投影后原区块重放，禁止伪造用户或永久跳过会员。
  for (const cidNumber of identityCidNumbers) {
    if (accountIds.has(cidNumber) && !projectedCidNumbers.has(cidNumber)) {
      throw new HttpError(
        409,
        'subscription_identity_projection_pending',
        `会员投影等待用户 finalized 投影：${cidNumber}`,
      );
    }
  }

  for (let index = 0; index < relationList.length; index += 1) {
    const relation = relationList[index];
    const state = states[index] ?? null;
    const subscriberAccountId = accountIds.get(relation.subscriberCidNumber) ?? null;
    if (!subscriberAccountId) {
      await deleteRelationProjection(env, relation, blockNumber);
      continue;
    }
    if (relation.issuer.kind === 'platform') {
      if (state === null) await deleteRelationProjection(env, relation, blockNumber);
      else {
        assertPlanKind(state, 'platform');
        await projectPlatformSubscription(env, relation.subscriberCidNumber, subscriberAccountId, state, point);
      }
      continue;
    }
    const creatorAccountId = accountIds.get(relation.issuer.creatorCidNumber) ?? null;
    if (!creatorAccountId || state === null) {
      await deleteRelationProjection(env, relation, blockNumber);
      continue;
    }
    assertPlanKind(state, 'creator');
    await projectCreatorSubscription(
      env,
      relation.subscriberCidNumber,
      subscriberAccountId,
      relation.issuer.creatorCidNumber,
      creatorAccountId,
      state,
      point,
    );
  }
  for (let index = 0; index < creatorList.length; index += 1) {
    const creatorCidNumber = creatorList[index];
    const creatorAccountId = accountIds.get(creatorCidNumber) ?? null;
    if (!creatorAccountId) continue;
    await replaceCreatorTierProjection(
      env,
      creatorCidNumber,
      creatorAccountId,
      projectionTiers(creatorPlans[index] ?? []),
      point,
    );
  }
  return { projectedSubscriptions: relationList.length, projectedCreators: creatorList.length };
}

async function readProjectedCidNumbers(env: Env, cidNumbers: string[], blockNumber: number): Promise<Set<string>> {
  const distinct = [...new Set(cidNumbers)];
  if (distinct.length === 0) return new Set();
  const placeholders = distinct.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT cid_number FROM users WHERE cid_number IN (${placeholders})
       AND (registration_finalized_block_number <> 0 OR (identity_finalized_block_number > 0 AND identity_finalized_block_number >= ?))`,
  ).bind(...distinct, blockNumber).all<{ cid_number: string }>();
  return new Set((result.results ?? []).map((row) => row.cid_number));
}

async function deleteRelationProjection(
  env: Env,
  relation: SubscriptionRelation,
  blockNumber: number,
): Promise<void> {
  if (relation.issuer.kind === 'platform') {
    await env.DB.prepare(
      'DELETE FROM square_memberships WHERE cid_number = ? AND finalized_block_number <= ?',
    ).bind(relation.subscriberCidNumber, blockNumber).run();
    return;
  }
  await env.DB.prepare(
    `DELETE FROM square_creator_subscriptions
      WHERE subscriber_cid_number = ? AND creator_cid_number = ?
        AND finalized_block_number <= ?`,
  ).bind(relation.subscriberCidNumber, relation.issuer.creatorCidNumber, blockNumber).run();
}

function assertPlanKind(state: ChainSubscriptionState, kind: 'platform' | 'creator'): void {
  if (state.plan.kind !== kind) {
    throw new HttpError(502, 'subscription_projection_plan_mismatch', '链上订阅关系与计划类型不一致');
  }
}

function projectionTiers(tiers: ChainCreatorTier[]): CreatorTierInput[] {
  return tiers.map((tier) => {
    if (tier.tierName === null) {
      throw new HttpError(502, 'creator_tier_name_missing', '链上创作者档位名称缺失');
    }
    return {
      tier_id: tier.tierId,
      tier_name: tier.tierName,
      prices_fen: Object.fromEntries(
        Object.entries(tier.pricesFen).map(([period, price]) => [period, safePrice(price)]),
      ),
    };
  });
}

function safePrice(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(502, 'subscription_price_out_of_range', '链上订阅价格超出边缘服务范围');
  }
  return Number(value);
}

function relationKey(relation: SubscriptionRelation): string {
  return relation.issuer.kind === 'platform'
    ? `${relation.subscriberCidNumber}:platform`
    : `${relation.subscriberCidNumber}:creator:${relation.issuer.creatorCidNumber}`;
}

async function ensureProjectionCursor(
  env: Env,
  deps: SubscriptionProjectionDeps,
): Promise<SubscriptionProjectionCursorRow> {
  const existing = await readProjectionCursor(env);
  if (existing) return existing;
  const genesisHash = await deps.fetchCanonicalBlockHash(env, 0);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO membership_projection_cursor
      (cursor_id, finalized_block_number, finalized_block_hash, updated_at)
      VALUES (1, 0, ?, ?)`,
  ).bind(genesisHash, nowMs()).run();
  const created = await readProjectionCursor(env);
  if (!created) throw new Error('订阅投影游标初始化失败');
  return created;
}

async function readProjectionCursor(env: Env): Promise<SubscriptionProjectionCursorRow | null> {
  return env.DB.prepare(
    `SELECT cursor_id, finalized_block_number, finalized_block_hash, updated_at
      FROM membership_projection_cursor WHERE cursor_id = 1`,
  ).first<SubscriptionProjectionCursorRow>();
}

async function advanceProjectionCursor(
  env: Env,
  previous: SubscriptionProjectionCursorRow,
  blockNumber: number,
  blockHash: string,
): Promise<SubscriptionProjectionCursorRow> {
  const updatedAt = nowMs();
  const result = await env.DB.prepare(
    `UPDATE membership_projection_cursor
      SET finalized_block_number = ?, finalized_block_hash = ?, updated_at = ?
      WHERE cursor_id = 1 AND finalized_block_number = ? AND finalized_block_hash = ?`,
  ).bind(
    blockNumber,
    blockHash,
    updatedAt,
    previous.finalized_block_number,
    previous.finalized_block_hash,
  ).run();
  if (result.meta.changes !== 1) {
    throw new HttpError(409, 'subscription_projection_cursor_conflict', '订阅投影游标被并发修改');
  }
  return {
    cursor_id: 1,
    finalized_block_number: blockNumber,
    finalized_block_hash: blockHash,
    updated_at: updatedAt,
  };
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
