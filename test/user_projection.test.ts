import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';

import { purgeIdentity } from '../src/account/purge';
import {
  inspectCachedUserProjectionHealth,
  inspectUserProjectionHealth,
  projectFinalizedUserBlock,
  reconcileFinalizedUserProjection,
  type UserProjectionDeps,
} from '../src/account/user_projection';
import { readUserByAccountId, readUserByCidNumber, readUserProfile } from '../src/account/user_repository';
import { decodeCitizenIdentityEvents } from '../src/chain/citizen_identity_event';
import type { ChainCidProjectionState } from '../src/chain/identity';
import { bytesToHex, concatBytes, hexToBytes, scaleCompact, u64Le } from '../src/shared/signing_message';
import type { Env, UserProjectionCursorRow } from '../src/types';
import { createTestMiniflare } from './miniflare';

const ACCOUNT_A = `0x${'11'.repeat(32)}`;
const ACCOUNT_B = `0x${'22'.repeat(32)}`;
const REGISTRAR_CID = 'CN220-CREG2-100000001-2026';
const CID_NUMBER = 'CN220-CTZN2-198805202-2026';
const SCHEMA_SQL = readFileSync(
  resolve(process.cwd(), 'schema/citizenserve.sql'),
  'utf8',
);

let miniflare: Miniflare;
let env: Env;
let chain: ChainFixture;

describe('CitizenIdentity 官方事件解码', () => {
  it('逐字节解码注册、换绑、身份变化和两种 CID 撤销事件', () => {
    const events = decodeCitizenIdentityEvents(systemEvents([
      eventRecord(5, concatBytes(cid(CID_NUMBER), cid(REGISTRAR_CID), u64Le(1))),
      eventRecord(6, concatBytes(cid(CID_NUMBER), account(ACCOUNT_A), u64Le(1))),
      eventRecord(7, concatBytes(
        cid(CID_NUMBER),
        account(ACCOUNT_A),
        account(ACCOUNT_B),
        u64Le(2),
      )),
      eventRecord(0, concatBytes(account(ACCOUNT_B), cid(CID_NUMBER))),
      eventRecord(4, concatBytes(account(ACCOUNT_B), cid(CID_NUMBER), u64Le(3))),
      eventRecord(8, concatBytes(cid(CID_NUMBER), u64Le(3))),
    ]));

    expect(events.map((event) => event.event_name)).toEqual([
      'CidOccupied',
      'CidSelfOccupied',
      'CidAccountIdRebound',
      'VotingIdentityRegistered',
      'CitizenIdentityRevoked',
      'CidRevoked',
    ]);
    expect(events[2]).toMatchObject({
      cid_number: CID_NUMBER,
      previous_account_id: ACCOUNT_A,
      new_account_id: ACCOUNT_B,
      binding_revision: 2,
    });
  });
});

describe('finalized 用户投影', () => {
  beforeEach(async () => {
    miniflare = createTestMiniflare({
      d1Bindings: ['DB'],
      r2Bindings: ['SQUARE_PRIVATE', 'SQUARE_PUBLIC_MEDIA'],
      kvBindings: ['SQUARE_CACHE'],
      textBindings: {
        CHAIN_URL: 'https://chain.test',
        CHAIN_ID: 'client-id',
        CHAIN_SECRET: 'client-secret',
      },
    });
    env = await miniflare.getBindings<Env>();
    await applySchema(env);
    const genesis = await env.DB.prepare(
      'SELECT * FROM users WHERE registration_finalized_block_number = 0',
    ).first<import('../src/types').UserRow>();
    if (!genesis) throw new Error('schema缺少创世身份');
    chain = new ChainFixture(genesis);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('最终schema直接含创世身份，未核验时不能登录；已有游标也补齐验证', async () => {
    expect(await readUserByCidNumber(env, chain.genesis.cid_number)).toMatchObject({
      registration_finalized_block_number: 0, binding_revision: 1,
    });
    expect(await readUserByAccountId(env, chain.genesis.account_id)).toBeNull();
    await env.DB.prepare(`INSERT INTO user_projection_cursor VALUES (1, 0, ?, 0)`)
      .bind(chain.hash(0)).run();
    expect(await readUserByAccountId(env, chain.genesis.account_id)).toBeNull();
    expect((await inspectUserProjectionHealth(env, chain.deps({ finalizedBlockNumber: 0 }))).identity_projection_status).toBe('pending');
    await env.DB.prepare('DELETE FROM user_projection_cursor').run();
    await env.DB.prepare(`INSERT INTO user_projection_cursor VALUES (1, 3, ?, 0)`)
      .bind(chain.hash(3)).run();
    expect((await inspectUserProjectionHealth(env, chain.deps())).identity_projection_status).toBe('pending');
    const result = await reconcileFinalizedUserProjection(env, chain.deps());
    expect(result.processed_block_count).toBe(0);
    expect(await readUserByAccountId(env, chain.genesis.account_id)).toMatchObject({
      binding_finalized_block_number: 0, identity_finalized_block_number: 3,
    });
    expect((await inspectUserProjectionHealth(env, chain.deps())).identity_projection_status).toBe('ready');
  });

  it('重复初始化保留已更新绑定与资料；撤销身份不得因基线重放重新获得授权', async () => {
    const nextAccount = `0x${'33'.repeat(32)}`;
    chain.genesisState = { ...chain.genesisState, account_id: nextAccount, binding_revision: 2 };
    await reconcileFinalizedUserProjection(env, chain.deps());
    await env.DB.prepare('UPDATE user_profiles SET bio = ? WHERE cid_number = ?')
      .bind('保留资料', chain.genesis.cid_number).run();
    await applySchema(env);
    expect(await readUserByCidNumber(env, chain.genesis.cid_number)).toMatchObject({
      account_id: nextAccount, binding_revision: 2,
    });
    expect(await readUserProfile(env, chain.genesis.cid_number)).toMatchObject({ bio: '保留资料' });
    chain.genesisState = { ...chain.genesisState, cid_record_status: 'Revoked', revoked_block_number: 3 };
    await reconcileFinalizedUserProjection(env, chain.deps());
    expect(await readUserByAccountId(env, nextAccount)).toBeNull();
    await applySchema(env);
    expect(await readUserByAccountId(env, chain.genesis.account_id)).toBeNull();
    await reconcileFinalizedUserProjection(env, chain.deps());
    expect(await readUserByCidNumber(env, chain.genesis.cid_number)).toBeNull();
  });

  it('拒绝错误创世链锚点，失败不推进游标', async () => {
    chain.hashes.set(0, `0x${'aa'.repeat(32)}`);
    await expect(reconcileFinalizedUserProjection(env, chain.deps()))
      .rejects.toMatchObject({ code: 'user_projection_genesis_mismatch' });
    expect(await cursor()).toMatchObject({ finalized_block_number: 0 });
  });

  it('按精确区块完成注册、换绑、身份升级和 finalized 撤销', async () => {
    await projectFinalizedUserBlock(env, chain.hash(1), chain.deps());
    expect(await readUserByCidNumber(env, CID_NUMBER)).toMatchObject({
      account_id: ACCOUNT_A,
      binding_revision: 1,
      identity_level: 'visitor',
      registration_finalized_block_number: 1,
    });
    expect(await readUserProfile(env, CID_NUMBER)).not.toBeNull();

    await projectFinalizedUserBlock(env, chain.hash(2), chain.deps());
    expect(await readUserByCidNumber(env, CID_NUMBER)).toMatchObject({
      account_id: ACCOUNT_B,
      binding_revision: 2,
      identity_level: 'voting',
      binding_finalized_block_number: 2,
      identity_finalized_block_number: 2,
    });

    const revoked = await projectFinalizedUserBlock(env, chain.hash(3), chain.deps());
    expect(revoked.revoked_user_count).toBe(1);
    expect(await readUserByCidNumber(env, CID_NUMBER)).toBeNull();
    expect(await readUserProfile(env, CID_NUMBER)).toBeNull();
  });

  it('拒绝未 finalized 区块和同高度非 canonical 区块', async () => {
    const nonFinalDeps = chain.deps({ finalizedBlockNumber: 1 });
    await expect(
      projectFinalizedUserBlock(env, chain.hash(2), nonFinalDeps),
    ).rejects.toMatchObject({ code: 'user_projection_block_not_finalized' });

    const forkHash = `0x${'ff'.repeat(32)}`;
    const forkDeps = chain.deps({
      blockNumberByHash: new Map([[forkHash, 1]]),
    });
    await expect(
      projectFinalizedUserBlock(env, forkHash, forkDeps),
    ).rejects.toMatchObject({ code: 'user_projection_block_not_canonical' });
  });

  it('CidRegistry::Revoked 没有同区块撤销事件时失败关闭', async () => {
    chain.events.set(chain.hash(3), systemEvents([
      eventRecord(3, concatBytes(account(ACCOUNT_B), cid(CID_NUMBER))),
    ]));
    await projectFinalizedUserBlock(env, chain.hash(1), chain.deps());
    await projectFinalizedUserBlock(env, chain.hash(2), chain.deps());
    await expect(
      projectFinalizedUserBlock(env, chain.hash(3), chain.deps()),
    ).rejects.toMatchObject({ code: 'user_projection_revocation_event_missing' });
    expect(await readUserByCidNumber(env, CID_NUMBER)).not.toBeNull();
  });

  it('Cron 失败不越过故障区块，恢复后从原游标幂等续跑', async () => {
    chain.failedEventBlock = 2;
    await expect(
      reconcileFinalizedUserProjection(env, chain.deps()),
    ).rejects.toThrow('events unavailable');
    expect(await cursor()).toMatchObject({ finalized_block_number: 1 });
    expect(await readUserByCidNumber(env, CID_NUMBER)).toMatchObject({ account_id: ACCOUNT_A });

    chain.failedEventBlock = null;
    const result = await reconcileFinalizedUserProjection(env, chain.deps());
    expect(result).toMatchObject({
      processed_block_count: 2,
      cursor_block_number: 3,
      revoked_user_count: 1,
    });
    expect(await readUserByCidNumber(env, CID_NUMBER)).toBeNull();
  });

  // 中文注释：同一现有游标依次覆盖落后、追平和链配置缺失三种公开健康状态。
  it('缺失账户只有在游标追平 finalized 后才能解释为确实未绑定', async () => {
    chain.failedEventBlock = 2;
    await expect(
      reconcileFinalizedUserProjection(env, chain.deps()),
    ).rejects.toThrow('events unavailable');
    await expect(inspectUserProjectionHealth(env, chain.deps())).resolves.toEqual({
      identity_projection_status: 'pending',
      finalized_block_number: 3,
      cursor_block_number: 1,
    });

    chain.failedEventBlock = null;
    await reconcileFinalizedUserProjection(env, chain.deps());
    await expect(inspectUserProjectionHealth(env, chain.deps())).resolves.toEqual({
      identity_projection_status: 'ready',
      finalized_block_number: 3,
      cursor_block_number: 3,
    });

    const withoutChain = { ...env, CHAIN_URL: undefined } as Env;
    await expect(inspectUserProjectionHealth(withoutChain, chain.deps())).resolves.toEqual({
      identity_projection_status: 'unavailable',
      finalized_block_number: null,
      cursor_block_number: null,
    });
  });

  // 中文注释：公共健康接口可以短时复用真值，但缺失账户鉴权不会调用这个缓存入口。
  it('公共投影健康检查使用现有 KV 短缓存避免放大链 RPC', async () => {
    await reconcileFinalizedUserProjection(env, chain.deps());
    let finalizedReads = 0;
    const deps = chain.deps();
    const healthDeps = {
      ...deps,
      fetchFinalizedHead: async (bindings: Env) => {
        finalizedReads += 1;
        return deps.fetchFinalizedHead(bindings);
      },
    };

    await expect(inspectCachedUserProjectionHealth(env, healthDeps)).resolves.toMatchObject({
      identity_projection_status: 'ready',
    });
    await expect(inspectCachedUserProjectionHealth(env, healthDeps)).resolves.toMatchObject({
      identity_projection_status: 'ready',
    });
    expect(finalizedReads).toBe(1);
  });

  it('较旧区块重放不能覆盖已经确认的较新绑定和身份', async () => {
    await projectFinalizedUserBlock(env, chain.hash(1), chain.deps());
    await projectFinalizedUserBlock(env, chain.hash(2), chain.deps());
    await expect(
      projectFinalizedUserBlock(env, chain.hash(1), chain.deps()),
    ).resolves.toMatchObject({ projected_user_count: 1 });
    expect(await readUserByCidNumber(env, CID_NUMBER)).toMatchObject({
      account_id: ACCOUNT_B,
      binding_revision: 2,
      identity_level: 'voting',
    });
  });
});

class ChainFixture {
  readonly hashes = new Map<number, string>([
    [0, `0x${'00'.repeat(32)}`],
    [1, `0x${'01'.repeat(32)}`],
    [2, `0x${'02'.repeat(32)}`],
    [3, `0x${'03'.repeat(32)}`],
  ]);
  readonly events = new Map<string, string>();
  readonly states = new Map<string, ChainCidProjectionState>();
  readonly timestamps = new Map<string, number>();
  failedEventBlock: number | null = null;

  genesisState: ChainCidProjectionState;
  constructor(readonly genesis: import('../src/types').UserRow) {
    this.hashes.set(0, genesis.registration_finalized_block_hash);
    this.genesisState = {
      cid_number: genesis.cid_number, cid_record_status: 'Active',
      account_id: genesis.account_id, binding_revision: genesis.binding_revision,
      identity_level: genesis.identity_level, registered_block_number: 0,
      revoked_block_number: null,
    };
    this.events.set(this.hash(1), systemEvents([
      // 注册局事件本身没有 account_id；投影必须从同区块 AccountIdByCid 取值。
      eventRecord(5, concatBytes(cid(CID_NUMBER), cid(REGISTRAR_CID), u64Le(1))),
    ]));
    this.events.set(this.hash(2), systemEvents([
      eventRecord(7, concatBytes(
        cid(CID_NUMBER),
        account(ACCOUNT_A),
        account(ACCOUNT_B),
        u64Le(2),
      )),
      eventRecord(0, concatBytes(account(ACCOUNT_B), cid(CID_NUMBER))),
    ]));
    // revoke_identity 会同时 tombstone CidRegistry，因此 CitizenIdentityRevoked 也是用户注销。
    this.events.set(this.hash(3), systemEvents([
      eventRecord(4, concatBytes(account(ACCOUNT_B), cid(CID_NUMBER), u64Le(3))),
    ]));
    this.states.set(this.stateKey(1), state('Active', ACCOUNT_A, 1, 'visitor', null));
    this.states.set(this.stateKey(2), state('Active', ACCOUNT_B, 2, 'voting', null));
    this.states.set(this.stateKey(3), state('Revoked', ACCOUNT_B, 3, 'visitor', 3));
    this.timestamps.set(this.hash(0), 0);
    this.timestamps.set(this.hash(1), 1_000);
    this.timestamps.set(this.hash(2), 2_000);
    this.timestamps.set(this.hash(3), 3_000);
  }

  hash(blockNumber: number): string {
    const value = this.hashes.get(blockNumber);
    if (!value) throw new Error(`missing hash ${blockNumber}`);
    return value;
  }

  deps(overrides: {
    finalizedBlockNumber?: number;
    blockNumberByHash?: Map<string, number>;
  } = {}): UserProjectionDeps {
    const finalizedBlockNumber = overrides.finalizedBlockNumber ?? 3;
    const reverse = new Map(
      [...this.hashes].map(([number, hash]) => [hash, number]),
    );
    for (const [hash, number] of overrides.blockNumberByHash ?? []) {
      reverse.set(hash, number);
    }
    return {
      fetchFinalizedHead: async () => this.hash(finalizedBlockNumber),
      fetchBlockHeader: async (_env, blockHash) => {
        const blockNumber = reverse.get(blockHash);
        if (blockNumber === undefined) throw new Error('unknown block hash');
        return { number: `0x${blockNumber.toString(16)}` };
      },
      fetchCanonicalBlockHash: async (_env, blockNumber) => this.hash(blockNumber),
      fetchSystemEventsAtBlock: async (_env, blockHash) => {
        const blockNumber = reverse.get(blockHash);
        if (blockNumber === this.failedEventBlock) throw new Error('events unavailable');
        return this.events.get(blockHash) ?? '0x00';
      },
      readChainTimestampAtBlock: async (_env, blockHash) => {
        const value = this.timestamps.get(blockHash);
        if (value === undefined) throw new Error('timestamp unavailable');
        return value;
      },
      fetchChainCidProjectionStatesAtBlock: async (_env, cidNumbers, blockHash) => {
        const blockNumber = reverse.get(blockHash);
        return new Map(cidNumbers.map((cidNumber) => [
          cidNumber,
          cidNumber === this.genesis.cid_number ? this.genesisState :
          cidNumber === CID_NUMBER && blockNumber !== undefined
            ? this.states.get(this.stateKey(blockNumber)) ?? null
            : null,
        ]));
      },
      purgeIdentity,
    };
  }

  private stateKey(blockNumber: number): string {
    return `${blockNumber}:${CID_NUMBER}`;
  }
}

function state(
  cidRecordStatus: 'Active' | 'Revoked',
  accountId: string,
  bindingRevision: number,
  identityLevel: 'visitor' | 'voting' | 'candidate',
  revokedBlockNumber: number | null,
): ChainCidProjectionState {
  return {
    cid_number: CID_NUMBER,
    cid_record_status: cidRecordStatus,
    account_id: accountId,
    binding_revision: bindingRevision,
    identity_level: identityLevel,
    registered_block_number: 1,
    revoked_block_number: revokedBlockNumber,
  };
}

function eventRecord(eventIndex: number, payload: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0, 0, 0, 0, 0]), // Phase::ApplyExtrinsic(0)
    new Uint8Array([10, eventIndex]),
    payload,
    new Uint8Array([0]), // topics = Vec::new()
  );
}

function systemEvents(records: Uint8Array[]): string {
  return `0x${bytesToHex(concatBytes(scaleCompact(records.length), ...records))}`;
}

function cid(value: string): Uint8Array {
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
  for (const statement of statements) {
    await bindings.DB.prepare(statement).run();
  }
}

async function cursor(): Promise<UserProjectionCursorRow | null> {
  return env.DB.prepare(
    'SELECT cursor_id, finalized_block_number, finalized_block_hash, updated_at FROM user_projection_cursor WHERE cursor_id = 1',
  ).first<UserProjectionCursorRow>();
}
