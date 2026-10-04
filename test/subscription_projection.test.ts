import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';

import { decodeSquarePostSubscriptionEvents } from '../src/chain/square_post_event';
import type { ChainSubscriptionState } from '../src/chain/subscription';
import {
  reconcileFinalizedSubscriptionProjection,
  type SubscriptionProjectionDeps,
} from '../src/membership/subscription_projection';
import { bytesToHex, concatBytes, hexToBytes, scaleCompact, u64Le } from '../src/shared/signing_message';
import type { Env, SubscriptionProjectionCursorRow } from '../src/types';
import { createTestMiniflare } from './miniflare';

const SUBSCRIBER_CID = 'CN220-CTZN2-198805202-2026';
const CREATOR_CID = 'CN220-CTZN2-198805201-2026';
const ACCOUNT = `0x${'11'.repeat(32)}`;
const SCHEMA_SQL = readFileSync(resolve(process.cwd(), 'schema/citizenserve.sql'), 'utf8');

let miniflare: Miniflare;
let env: Env;

// 中文注释：订阅投影按 canonical finalized 区块串行推进唯一游标；任何区块的事件或状态读取失败都不得越过该区块。
describe('SquarePost 官方订阅事件解码', () => {
  it('统一发现平台、创作者关系和创作者档位事件', () => {
    const events = decodeSquarePostSubscriptionEvents(systemEvents([
      eventRecord(1, concatBytes(
        cid(SUBSCRIBER_CID), account(ACCOUNT), new Uint8Array([0]), new Uint8Array([0, 1]),
        new Uint8Array(16), u64Le(100), u64Le(200),
      )),
      eventRecord(6, concatBytes(
        cid(SUBSCRIBER_CID), new Uint8Array([1]), cid(CREATOR_CID), u64Le(300),
      ), 2),
      eventRecord(9, concatBytes(cid(CREATOR_CID), account(ACCOUNT), new Uint8Array(4))),
      eventRecord(10, concatBytes(cid(CREATOR_CID), account(ACCOUNT), scaleBytes('gold'))),
    ]));
    expect(events.map((event) => event.event_name)).toEqual([
      'SubscriptionCharged',
      'SubscriptionRenewalStopped',
      'CreatorPlansSet',
      'CreatorTierNameUpdated',
    ]);
    expect(events[0]).toMatchObject({
      subscriber_cid_number: SUBSCRIBER_CID,
      issuer_kind: 'platform',
      extrinsic_index: 0,
    });
    expect(events[1]).toMatchObject({
      subscriber_cid_number: SUBSCRIBER_CID,
      issuer_kind: 'creator',
      creator_cid_number: CREATOR_CID,
      extrinsic_index: null,
    });
  });
});

describe('finalized 订阅统一游标', () => {
  beforeEach(async () => {
    miniflare = createTestMiniflare({
      d1Bindings: ['DB'],
      textBindings: {
        CHAIN_URL: 'https://chain.test',
        CHAIN_ID: 'client-id',
        CHAIN_SECRET: 'client-secret',
      },
    });
    env = await miniflare.getBindings<Env>();
    await applySchema(env);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('故障区块不推进游标，恢复后从原区块继续', async () => {
    let failBlockTwo = true;
    const hashes = new Map([
      [0, `0x${'00'.repeat(32)}`],
      [1, `0x${'01'.repeat(32)}`],
      [2, `0x${'02'.repeat(32)}`],
    ]);
    const deps: SubscriptionProjectionDeps = {
      fetchFinalizedHead: async () => hashes.get(2)!,
      fetchBlockHeader: async () => ({ number: '0x2' }),
      fetchCanonicalBlockHash: async (_bindings, number) => hashes.get(number)!,
      fetchSystemEventsAtBlock: async (_bindings, hash) => {
        if (hash === hashes.get(2) && failBlockTwo) throw new Error('events unavailable');
        return '0x00';
      },
      readSubscriptionsAtBlock: async () => [],
      readCreatorPlansBatchAtBlock: async () => [],
      fetchChainAccountIdsByCidAtBlock: async () => new Map(),
    };
    await expect(reconcileFinalizedSubscriptionProjection(env, deps)).rejects.toThrow('events unavailable');
    await expect(cursor()).resolves.toMatchObject({ finalized_block_number: 1 });
    failBlockTwo = false;
    await expect(reconcileFinalizedSubscriptionProjection(env, deps)).resolves.toMatchObject({
      processed_block_count: 1,
      cursor_block_number: 2,
    });
  });

  it('用户投影未就绪时停止游标，补齐后从原区块恢复平台会员', async () => {
    const genesisHash = `0x${'00'.repeat(32)}`;
    const blockHash = `0x${'01'.repeat(32)}`;
    const state: ChainSubscriptionState = {
      plan: { kind: 'platform', membershipLevel: 'freedom' },
      startedAt: 100,
      lastChargedAt: 100,
      lastChargedPriceFen: 29900n,
      paidUntil: 9999999999999,
      status: 'active',
      authorizedPriceFen: 29900n,
      suspendReason: null,
    };
    const deps: SubscriptionProjectionDeps = {
      fetchFinalizedHead: async () => blockHash,
      fetchBlockHeader: async () => ({ number: '0x1' }),
      fetchCanonicalBlockHash: async (_bindings, number) =>
        number === 0 ? genesisHash : blockHash,
      fetchSystemEventsAtBlock: async () => systemEvents([
        eventRecord(1, concatBytes(
          cid(SUBSCRIBER_CID),
          account(ACCOUNT),
          new Uint8Array([0]),
          new Uint8Array([0, 1]),
          new Uint8Array(16),
          u64Le(100),
          u64Le(9999999999999),
        )),
      ]),
      readSubscriptionsAtBlock: async () => [state],
      readCreatorPlansBatchAtBlock: async () => [],
      fetchChainAccountIdsByCidAtBlock: async (_bindings, cidNumbers) =>
        new Map(cidNumbers.map((cidNumber) => [cidNumber, ACCOUNT])),
    };

    await expect(reconcileFinalizedSubscriptionProjection(env, deps)).rejects.toMatchObject({
      code: 'subscription_identity_projection_pending',
    });
    await expect(cursor()).resolves.toMatchObject({ finalized_block_number: 0 });

    // 模拟同一次 Cron 的前置用户 finalized 投影完成；会员任务随后重放同一区块。
    await env.DB.prepare(
      `INSERT INTO users
        (cid_number, account_id, binding_revision, identity_level,
         registration_finalized_block_number, registration_finalized_block_hash,
         binding_finalized_block_number, binding_finalized_block_hash,
         identity_finalized_block_number, identity_finalized_block_hash,
         registered_at, binding_updated_at, identity_updated_at)
       VALUES (?, ?, 1, 'visitor', 1, ?, 1, ?, 1, ?, 100, 100, 100)`,
    ).bind(SUBSCRIBER_CID, ACCOUNT, blockHash, blockHash, blockHash).run();

    await reconcileFinalizedSubscriptionProjection(env, deps);

    const membership = await env.DB.prepare(
      'SELECT cid_number, account_id, membership_level FROM square_memberships WHERE cid_number = ?',
    ).bind(SUBSCRIBER_CID).first<Record<string, unknown>>();
    expect(membership).toMatchObject({
      cid_number: SUBSCRIBER_CID,
      account_id: ACCOUNT,
      membership_level: 'freedom',
    });
    await expect(cursor()).resolves.toMatchObject({ finalized_block_number: 1 });
  });
});

function eventRecord(eventIndex: number, payload: Uint8Array, phase = 0): Uint8Array {
  const phaseBytes = phase === 0 ? new Uint8Array([0, 0, 0, 0, 0]) : new Uint8Array([phase]);
  return concatBytes(phaseBytes, new Uint8Array([34, eventIndex]), payload, new Uint8Array([0]));
}

function systemEvents(records: Uint8Array[]): string {
  return `0x${bytesToHex(concatBytes(scaleCompact(records.length), ...records))}`;
}

function cid(value: string): Uint8Array {
  return scaleBytes(value);
}

function scaleBytes(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes(scaleCompact(bytes.length), bytes);
}

function account(value: string): Uint8Array {
  return hexToBytes(value);
}

async function applySchema(bindings: Env): Promise<void> {
  const statements = SCHEMA_SQL
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await bindings.DB.prepare(statement).run();
}

async function cursor(): Promise<SubscriptionProjectionCursorRow | null> {
  return env.DB.prepare(
    `SELECT cursor_id, finalized_block_number, finalized_block_hash, updated_at
      FROM membership_projection_cursor WHERE cursor_id = 1`,
  ).first<SubscriptionProjectionCursorRow>();
}
