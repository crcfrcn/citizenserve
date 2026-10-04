import { blake2AsU8a } from '@polkadot/util-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  topupConfigRoute,
  topupConfirmRoute,
  topupIntentRoute,
  topupStatusRoute,
  type TopupIntentDeps,
} from '../src/topup/orders';
import {
  topupClaimRoute,
  topupExceptionRoute,
  topupHistoryRoute,
  topupPendingRoute,
  topupSettledRoute,
} from '../src/topup/settlement';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC_FIXTURE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const RECV = `0x${'ab'.repeat(20)}`;
const PAYER = `0x${'cd'.repeat(20)}`;
const ACCOUNT_ID = `0x${'77'.repeat(32)}`;
const OTHER_ACCOUNT_ID = `0x${'66'.repeat(32)}`;
const DISBURSE_ACCOUNT_ID = `0x${'55'.repeat(32)}`;
const TX_HASH = `0x${'11'.repeat(32)}`;
const BLOCK_HASH = `0x${'33'.repeat(32)}`;
const GENESIS_HASH = `0x${'44'.repeat(32)}`;
const CID_NUMBER = 'CN220-CTZN2-198805200-2026';

describe('topup 稳定币充值后端', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('config 仅返回已配置公开报价', async () => {
    const response = await topupConfigRoute(
      new Request('https://x.test/square/topup/config'),
      makeEnv(new FakeDb()),
    );
    const body = await response.json<{ rails: { token: string; chain_id: number }[]; packages: unknown[] }>();
    expect(body.rails.map((rail) => rail.token)).toEqual(['USDC', 'USDT']);
    expect(body.rails[0].chain_id).toBe(8453);
    expect(body.packages).toHaveLength(2);
  });

  it('intent 把请求指定的 account_id 与 payer、报价绑定', async () => {
    const env = makeEnv(new FakeDb());
    const intent = await createIntent(env, ACCOUNT_ID);
    const payload = JSON.parse(Buffer.from(intent.split('.')[0], 'base64url').toString()) as {
      cid_number: string | null;
      account_id: string;
      payer_address: string;
      pay_amount: string;
    };
    expect(payload).toMatchObject({
      cid_number: CID_NUMBER,
      account_id: ACCOUNT_ID,
      payer_address: PAYER,
      pay_amount: '15000000',
    });
  });

  it('无会话、无 CID 的任意账户(含冷钱包)都能充值到自己指定的账户', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    // 冷钱包只有公钥、链上无 CID:请求不带任何 Authorization,目标账户由请求体指定。
    const intent = await createIntent(env, OTHER_ACCOUNT_ID, null);
    vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex: '' }));
    const order = await (await confirm(env, intent)).json<{ status: string; order_id: string }>();
    expect(order.status).toBe('pending');
    expect(db.rows.get(order.order_id)).toMatchObject({
      cid_number: null,
      account_id: OTHER_ACCOUNT_ID,
    });
  });

  it('confirm 篡改 intent → 拒绝且不访问 EVM', async () => {
    const env = makeEnv(new FakeDb());
    const intent = await createIntent(env, ACCOUNT_ID);
    const [payload, signature] = intent.split('.');
    // 固定翻转签名首字符；不能把末字符无条件替换成 x，否则原字符恰好为 x 时没有篡改。
    const tamperedSignature = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(confirm(env, `${payload}.${tamperedSignature}`)).rejects.toMatchObject({
      code: 'topup_intent_invalid',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('confirm 足额 finalized 到账 → 创建 pending 订单并保持幂等', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const intent = await createIntent(env, ACCOUNT_ID);
    vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex: '' }));

    const first = await (await confirm(env, intent)).json<{ status: string; order_id: string }>();
    const second = await (await confirm(env, intent)).json<{ status: string; order_id: string }>();
    expect(first.status).toBe('pending');
    expect(second.order_id).toBe(first.order_id);
    expect(db.rows.size).toBe(1);
    expect(db.rows.get(first.order_id)).toMatchObject({
      cid_number: CID_NUMBER,
      account_id: ACCOUNT_ID,
      payer_address: PAYER,
      coin_fen: '1000000',
    });
  });

  it('抢单防护:付款意图晚于付款上链 → 拒绝入账', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    // 模拟攻击者:先看见链上付款(区块时间在过去),之后才造出指向自己账户的意图。
    const intent = await createIntent(env, OTHER_ACCOUNT_ID);
    vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex: '', blockTimeMs: Date.now() - 60_000 }));
    await expect(confirm(env, intent)).rejects.toMatchObject({ code: 'topup_intent_superseded' });
    expect(db.rows.size).toBe(0);
  });

  it('区块时间取不到时按过渡态处理,绝不放行入账', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const intent = await createIntent(env, ACCOUNT_ID);
    vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex: '', blockTimeMs: null }));
    const body = await (await confirm(env, intent)).json<{ status: string }>();
    expect(body.status).toBe('confirming');
    expect(db.rows.size).toBe(0);
  });

  it('status 凭本笔付款意图读取，换一份意图读不到', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const intent = await createIntent(env, ACCOUNT_ID);
    vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex: '' }));
    const orderId = (await (await confirm(env, intent)).json<{ order_id: string }>()).order_id;

    const own = await (await status(env, orderId, intent)).json<{ order_id: string }>();
    expect(own.order_id).toBe(orderId);

    const foreignIntent = await createIntent(env, OTHER_ACCOUNT_ID);
    await expect(status(env, orderId, foreignIntent)).rejects.toMatchObject({
      code: 'topup_order_not_found',
    });
  });

  it('全局硬顶：命中外部 EVM RPC 的次数不分账户/IP,总量到顶即 429', async () => {
    // account_id 无需注册、免费换号,账户级 10/60s 限流可被无限换号绕过;IP 级限流
    // 同理可被换 IP(代理池)绕过。二者都挡不住"分布式滥用把外部 RPC 配额/账单打爆",
    // 只有不按维度分桶的全局硬顶能挡。本用例逐次换全新账户 + 全新 tx hash,证明前两层
    // 限流全程不介入(每个账户只用一次、每个 tx hash 从未出现过、dedupe 不短路),
    // 唯一能拦下第 301 次的只有 enforceGlobalEvmRpcLimit。
    const db = new FakeDb();
    const env = makeEnv(db);
    vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex: '' }));
    const globalLimit = 300;

    for (let i = 0; i < globalLimit; i++) {
      const accountId = `0x${(i + 1).toString(16).padStart(64, '0')}`;
      const txHash = `0x${(i + 1).toString(16).padStart(64, '0')}`;
      const intent = await createIntent(env, accountId);
      const response = await topupConfirmRoute(
        post('https://x.test/square/topup/confirm', {
          payment_intent: intent,
          evm_tx_hash: txHash,
        }),
        env,
      );
      expect(response.status).toBe(200);
    }

    const overflowAccountId = `0x${(globalLimit + 1).toString(16).padStart(64, '0')}`;
    const overflowTxHash = `0x${(globalLimit + 2).toString(16).padStart(64, '0')}`;
    const overflowIntent = await createIntent(env, overflowAccountId);
    await expect(
      topupConfirmRoute(
        post('https://x.test/square/topup/confirm', {
          payment_intent: overflowIntent,
          evm_tx_hash: overflowTxHash,
        }),
        env,
      ),
    ).rejects.toMatchObject({ code: 'request_rate_exceeded' });
  });

  it('claim 原子抢占且不自动过期，第二个结算流程不能重复抢占', async () => {
    const { env, orderId } = await preparedOrder();
    const response = await topupClaimRoute(settlePost(`https://x.test/square/topup/settlement/${orderId}/claim`, {}), env, orderId);
    const claim = await response.json<{ claim_id: string }>();
    expect(claim.claim_id).toMatch(/^tpc_[0-9a-f]{32}$/);
    await expect(
      topupClaimRoute(settlePost(`https://x.test/square/topup/settlement/${orderId}/claim`, {}), env, orderId),
    ).rejects.toMatchObject({ code: 'topup_order_already_claimed' });
  });

  it('settled 必须同时通过 EVM 与 finalized CitizenChain 完整交易证明', async () => {
    const { env, db, orderId } = await preparedOrder();
    const claim = await (
      await topupClaimRoute(settlePost(`https://x.test/square/topup/settlement/${orderId}/claim`, {}), env, orderId)
    ).json<{ claim_id: string }>();
    const signedExtrinsicHex = makeDisbursementExtrinsic(orderId);
    const gmbTxHash = `0x${Buffer.from(blake2AsU8a(hexBytes(signedExtrinsicHex), 256)).toString('hex')}`;
    vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex }));

    const response = await topupSettledRoute(
      settlePost(`https://x.test/square/topup/settlement/${orderId}/settled`, {
        claim_id: claim.claim_id,
        gmb_tx_hash: gmbTxHash,
        gmb_block_hash: BLOCK_HASH,
        gmb_extrinsic_index: 0,
        signed_extrinsic_hex: signedExtrinsicHex,
      }),
      env,
      orderId,
    );
    expect((await response.json<{ status: string }>()).status).toBe('paid');
    expect(db.rows.get(orderId)).toMatchObject({
      status: 'paid',
      gmb_tx_hash: gmbTxHash,
      gmb_block_hash: BLOCK_HASH,
      gmb_extrinsic_index: 0,
    });
  });

  it('exception 没有匹配 claim 时 fail-closed', async () => {
    const { env, orderId } = await preparedOrder();
    await expect(
      topupExceptionRoute(
        settlePost(`https://x.test/square/topup/settlement/${orderId}/exception`, { reason: 'bad' }),
        env,
        orderId,
      ),
    ).rejects.toMatchObject({ code: 'topup_claim_mismatch' });
  });

  it('pending 队列只暴露是否已 claim，不泄露 claim_id', async () => {
    const { env, orderId } = await preparedOrder();
    await topupClaimRoute(settlePost(`https://x.test/square/topup/settlement/${orderId}/claim`, {}), env, orderId);
    const response = await topupPendingRoute(settleGet('https://x.test/square/topup/settlement/pending'), env);
    const body = await response.json<{ orders: Record<string, unknown>[] }>();
    expect(body.orders[0].settlement_claimed).toBe(true);
    expect(body.orders[0]).not.toHaveProperty('settlement_claim_id');
  });

  it('历史镜像经结算令牌鉴权并使用稳定游标重建结算客户端状态', async () => {
    const { env, orderId } = await preparedOrder();
    const response = await topupHistoryRoute(
      settleGet('https://x.test/square/topup/settlement/history?after_confirmed_at=0&after_order_id='),
      env,
    );
    const body = await response.json<{
      orders: Row[];
      has_more: boolean;
      next_cursor: { confirmed_at: number; order_id: string };
    }>();
    expect(body.orders.map((order) => order.order_id)).toEqual([orderId]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toEqual({
      confirmed_at: body.orders[0].confirmed_at,
      order_id: orderId,
    });
    await expect(topupHistoryRoute(
      settleGet('https://x.test/square/topup/settlement/history?after_confirmed_at=bad'),
      env,
    )).rejects.toMatchObject({ code: 'topup_history_cursor_invalid' });
  });
});

async function preparedOrder(): Promise<{ env: Env; db: FakeDb; orderId: string }> {
  const db = new FakeDb();
  const env = makeEnv(db);
  const intent = await createIntent(env, ACCOUNT_ID);
  vi.stubGlobal('fetch', rpcFetch({ signedExtrinsicHex: '' }));
  const orderId = (await (await confirm(env, intent)).json<{ order_id: string }>()).order_id;
  return { env, db, orderId };
}

/// 充值三个接口一律不带 Authorization:鉴权已从广场会话解耦,目标账户由请求体指定。
async function createIntent(
  env: Env,
  accountId: string,
  cidNumber: string | null = CID_NUMBER,
): Promise<string> {
  const deps: TopupIntentDeps = {
    resolveCidNumber: async (_env, resolvedAccountId) => {
      expect(resolvedAccountId).toBe(accountId);
      return cidNumber;
    },
  };
  const response = await topupIntentRoute(
    post('https://x.test/square/topup/intent', {
      account_id: accountId,
      token: 'USDC',
      package_id: 'pkg_15',
      payer_address: PAYER,
    }),
    env,
    deps,
  );
  return (await response.json<{ payment_intent: string }>()).payment_intent;
}

function confirm(env: Env, paymentIntent: string): Promise<Response> {
  return topupConfirmRoute(
    post('https://x.test/square/topup/confirm', {
      payment_intent: paymentIntent,
      evm_tx_hash: TX_HASH,
    }),
    env,
  );
}

function status(env: Env, orderId: string, paymentIntent: string): Promise<Response> {
  return topupStatusRoute(
    post('https://x.test/square/topup/status', {
      order_id: orderId,
      payment_intent: paymentIntent,
    }),
    env,
  );
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function settleGet(url: string): Request {
  return new Request(url, { headers: { authorization: 'Bearer settle-secret' } });
}

function settlePost(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { authorization: 'Bearer settle-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/// [blockTimeMs] = 付款区块时间戳(毫秒);默认取"晚于本用例创建的付款意图",即合法时序。
/// 传过去的时间用于模拟抢单,传 null 用于模拟区块时间取不到。
function rpcFetch({
  signedExtrinsicHex,
  blockTimeMs = Date.now() + 60_000,
}: {
  signedExtrinsicHex: string;
  blockTimeMs?: number | null;
}) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { method: string; params: unknown[]; id: number };
    if (body.method === 'eth_getTransactionReceipt') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: confirmedReceipt() });
    }
    if (body.method === 'eth_getBlockByNumber') {
      // 同一分支同时服务 finalized 高度判定(读 number)与付款区块时间(读 timestamp)。
      const timestamp =
        blockTimeMs === null ? undefined : `0x${Math.floor(blockTimeMs / 1000).toString(16)}`;
      return Response.json({ jsonrpc: '2.0', id: 1, result: { number: '0x20', timestamp } });
    }
    if (body.method === 'chain_getFinalizedHead') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: BLOCK_HASH });
    }
    if (body.method === 'chain_getHeader') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { number: '0x10' } });
    }
    if (body.method === 'chain_getBlock') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { block: { header: { number: '0x10' }, extrinsics: [signedExtrinsicHex] } },
      });
    }
    if (body.method === 'chain_getBlockHash') {
      const result = body.params[0] === 0 ? GENESIS_HASH : BLOCK_HASH;
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: null });
  });
}

function confirmedReceipt(): unknown {
  return {
    status: '0x1',
    blockNumber: '0x10',
    logs: [{
      address: USDC_FIXTURE,
      topics: [TRANSFER_TOPIC, addrTopic(PAYER), addrTopic(RECV)],
      data: `0x${15000000n.toString(16).padStart(64, '0')}`,
    }],
  };
}

function addrTopic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function makeDisbursementExtrinsic(orderId: string): string {
  const body = [
    0x84,
    0x00,
    ...hexBytes(DISBURSE_ACCOUNT_ID),
    0x01,
    ...new Uint8Array(64),
    0x00,
    0x00,
    0x00,
    4,
    0,
    ...hexBytes(ACCOUNT_ID),
    ...u128Le(1000000n),
    ...scaleBytes(new TextEncoder().encode(`topup:${orderId}`)),
  ];
  const encoded = Uint8Array.from([...compact(BigInt(body.length)), ...body]);
  return `0x${Buffer.from(encoded).toString('hex')}`;
}

function compact(value: bigint): number[] {
  if (value < 64n) return [Number(value << 2n)];
  if (value < 16384n) {
    const encoded = Number((value << 2n) | 1n);
    return [encoded & 0xff, encoded >> 8];
  }
  throw new Error('test compact too large');
}

function scaleBytes(bytes: Uint8Array): number[] {
  return [...compact(BigInt(bytes.length)), ...bytes];
}

function u128Le(value: bigint): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < 16; index += 1) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return bytes;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

/// 充值已不读广场会话,故这里不再桩任何 session 缓存。
function makeEnv(db: FakeDb): Env {
  return {
    DB: db,
    TOPUP_NETWORK: 'mainnet',
    TOPUP_RECV_ADDRESS: RECV,
    TOPUP_BASE_RPC_URL: 'https://base-mainnet.example',
    SETTLE_TOKEN: 'settle-secret',
    TOPUP_INTENT_SECRET: 'intent-secret-that-is-longer-than-thirty-two-bytes',
    TOPUP_DISBURSE_ACCOUNT_ID: DISBURSE_ACCOUNT_ID,
    CHAIN_URL: 'https://chain.test',
    CHAIN_ID: 'access-id',
    CHAIN_SECRET: 'access-secret',
    CHAIN_GENESIS_HASH: GENESIS_HASH,
    RATE_AUTH: fakeRate(db, 10),
    RATE_WRITE: fakeRate(db, 30),
    RATE_READ: fakeRate(db, 120),
  } as unknown as Env;
}

function fakeRate(db: FakeDb, limit: number): RateLimit {
  return {
    async limit({ key }) {
      const rateKey = `edge:${key}`;
      const current = db.rateWindows.get(rateKey) ?? 0;
      if (current >= limit) return { success: false };
      db.rateWindows.set(rateKey, current + 1);
      return { success: true };
    },
  } as RateLimit;
}

interface Row {
  order_id: string;
  intent_id: string;
  chain_id: number;
  token: string;
  token_contract: string;
  evm_tx_hash: string;
  payer_address: string;
  recv_address: string;
  pay_amount: string;
  cid_number: string | null;
  account_id: string;
  coin_fen: string;
  package_id: string;
  status: 'pending' | 'paid' | 'exception';
  settlement_claim_id: string | null;
  settlement_claimed_at: number | null;
  gmb_tx_hash: string | null;
  gmb_block_hash: string | null;
  gmb_extrinsic_index: number | null;
  exception_reason: string | null;
  confirmed_at: number;
  settled_at: number | null;
}

class FakeDb {
  rows = new Map<string, Row>();
  /// 限流窗口:rate_key → 本窗口计数(充值写接口按 account_id 计数)。
  rateWindows = new Map<string, number>();
  prepare(sql: string) { return new FakeStmt(this, sql); }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(private readonly db: FakeDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('INSERT INTO rate_windows')) {
      const [rateKey, expiresAt] = this.args as [string, number];
      const current = this.db.rateWindows.get(rateKey) ?? 0;
      const limit = this.args[5] as number;
      if (current >= limit) return null;
      const count = current + 1;
      this.db.rateWindows.set(rateKey, count);
      return { request_count: count, expires_at: expiresAt } as T;
    }
    if (this.sql.includes('WHERE chain_id = ? AND evm_tx_hash = ?')) {
      const [chainId, txHash] = this.args as [number, string];
      return ([...this.db.rows.values()].find((row) => row.chain_id === chainId && row.evm_tx_hash === txHash) ?? null) as T | null;
    }
    if (this.sql.includes('WHERE intent_id = ?')) {
      return ([...this.db.rows.values()].find((row) => row.intent_id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes('WHERE order_id = ?')) {
      return (this.db.rows.get(this.args[0] as string) ?? null) as T | null;
    }
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes('INSERT OR IGNORE INTO topup_orders')) {
      const [
        orderId,
        intentId,
        chainId,
        token,
        tokenContract,
        txHash,
        payer,
        recv,
        payAmount,
        cidNumber,
        accountId,
        coinFen,
        packageId,
        confirmedAt,
      ] = this.args;
      if ([...this.db.rows.values()].some((row) => row.intent_id === intentId || (row.chain_id === chainId && row.evm_tx_hash === txHash))) {
        return { meta: { changes: 0 } };
      }
      this.db.rows.set(orderId as string, {
        order_id: orderId as string,
        intent_id: intentId as string,
        chain_id: chainId as number,
        token: token as string,
        token_contract: tokenContract as string,
        evm_tx_hash: txHash as string,
        payer_address: payer as string,
        recv_address: recv as string,
        pay_amount: payAmount as string,
        cid_number: cidNumber as string | null,
        account_id: accountId as string,
        coin_fen: coinFen as string,
        package_id: packageId as string,
        status: 'pending',
        settlement_claim_id: null,
        settlement_claimed_at: null,
        gmb_tx_hash: null,
        gmb_block_hash: null,
        gmb_extrinsic_index: null,
        exception_reason: null,
        confirmed_at: confirmedAt as number,
        settled_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes('SET settlement_claim_id = ?')) {
      const [claimId, claimedAt, orderId] = this.args as [string, number, string];
      const row = this.db.rows.get(orderId);
      if (!row || row.status !== 'pending' || row.settlement_claim_id) return { meta: { changes: 0 } };
      row.settlement_claim_id = claimId;
      row.settlement_claimed_at = claimedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("SET status = 'paid'")) {
      const [txHash, blockHash, index, settledAt, orderId, claimId] = this.args as [string, string, number, number, string, string];
      const row = this.db.rows.get(orderId);
      if (!row || row.status !== 'pending' || row.settlement_claim_id !== claimId) return { meta: { changes: 0 } };
      Object.assign(row, { status: 'paid', gmb_tx_hash: txHash, gmb_block_hash: blockHash, gmb_extrinsic_index: index, settled_at: settledAt });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("SET status = 'exception'")) {
      const [reason, settledAt, orderId, claimId] = this.args as [string, number, string, string];
      const row = this.db.rows.get(orderId);
      if (!row || row.status !== 'pending' || row.settlement_claim_id !== claimId) return { meta: { changes: 0 } };
      Object.assign(row, { status: 'exception', exception_reason: reason, settled_at: settledAt });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('WHERE status = ? AND (confirmed_at > ?')) {
      const [status, afterConfirmedAt, , afterOrderId, limit] = this.args as [
        Row['status'], number, number, string, number,
      ];
      const results = [...this.db.rows.values()]
        .filter((row) => row.status === status
          && (row.confirmed_at > afterConfirmedAt
            || (row.confirmed_at === afterConfirmedAt && row.order_id > afterOrderId)))
        .sort((a, b) => a.confirmed_at - b.confirmed_at || a.order_id.localeCompare(b.order_id))
        .slice(0, limit);
      return { results: results as T[] };
    }
    const results = [...this.db.rows.values()]
      .filter((row) => row.status === 'pending')
      .sort((a, b) => a.confirmed_at - b.confirmed_at);
    return { results: results as T[] };
  }
}
