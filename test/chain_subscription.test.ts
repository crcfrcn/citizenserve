import { describe, expect, it } from "vitest";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { bytesToHex, hexToBytes } from "../src/shared/signing_message";
import { storageValueKey } from "../src/chain/storage_key";
import {
  buildCreatorPlansKey,
  buildCreatorTierNameKey,
  buildSubscriptionKey,
  bindFinalizedTransactionConfirmation,
  decodeCreatorPlans,
  decodeCreatorTierName,
  decodeSubscriptionState,
  verifyFinalizedSubscriptionTransaction,
} from "../src/chain/subscription";
import type { Env } from "../src/types";

const CID_NUMBER = "CN220-CTZN2-198805200-2026";

function accountId(bytes: Uint8Array): string {
  return `0x${bytesToHex(bytes)}`;
}

// 与 runtime 金标 state_platform 逐字节一致（无延迟生效套餐字段，末尾含
// authorized_price_fen + suspend_reason）。
const STATE_PLATFORM =
  "00020068e5cf8b0100000068e5cf8b0100001c8d5b0000000000000000000000000000fc1a478c010000001c8d5b0000000000000000000000000000";
// 拆分点：status 字节位于 [-36,-34)，authorized_price_fen 位于 [-34,-2)，suspend_reason 位于 [-2)。
const STATE_PREFIX = STATE_PLATFORM.slice(0, -36);
const STATE_AUTHORIZED = STATE_PLATFORM.slice(-34, -2);

describe("decodeSubscriptionState", () => {
  it("严格解码平台 Active 状态和链上 paid_until", () => {
    const state = decodeSubscriptionState(hexToBytes(STATE_PLATFORM));
    expect(state).toEqual({
      plan: { kind: "platform", membershipLevel: "spark" },
      startedAt: 1_700_000_000_000,
      lastChargedAt: 1_700_000_000_000,
      lastChargedPriceFen: 5_999_900n,
      paidUntil: 1_702_000_000_000,
      status: "active",
      authorizedPriceFen: 5_999_900n,
      suspendReason: null,
    });
  });

  it("解码 Terminated 状态", () => {
    const terminated = STATE_PREFIX + "02" + STATE_AUTHORIZED + "00";
    expect(decodeSubscriptionState(hexToBytes(terminated)).status).toBe("terminated");
  });

  it("解码 Suspended（待再签名）与 IssuerPaused 状态", () => {
    const suspended = STATE_PREFIX + "03" + STATE_AUTHORIZED + "0100";
    const s = decodeSubscriptionState(hexToBytes(suspended));
    expect(s.status).toBe("suspended");
    expect(s.suspendReason).toBe("needReconsent");
    const identityUnavailable =
      STATE_PREFIX + "03" + STATE_AUTHORIZED + "0102";
    expect(
      decodeSubscriptionState(hexToBytes(identityUnavailable)).suspendReason,
    ).toBe("identityBindingUnavailable");

    const issuerPaused = STATE_PREFIX + "04" + STATE_AUTHORIZED + "00";
    const c = decodeSubscriptionState(hexToBytes(issuerPaused));
    expect(c.status).toBe("issuerPaused");
    expect(c.suspendReason).toBeNull();
  });

  it("解码创作者 tier_id 和自然周期枚举", () => {
    const plan = "0124737570706f7274657201";
    const stateHex =
      plan +
      "0068e5cf8b010000" +
      "0068e5cf8b010000" +
      "32000000000000000000000000000000" +
      "00fc1a478c010000" +
      "00" +
      "32000000000000000000000000000000" +
      "00";
    const state = decodeSubscriptionState(hexToBytes(stateHex));
    expect(state.plan).toEqual({
      kind: "creator",
      tierId: "supporter",
      billingPeriod: "quarterly",
    });
  });

  it("拒绝非法枚举、截断、尾随字节和非法 suspend_reason", () => {
    expect(() => decodeSubscriptionState(hexToBytes("0003"))).toThrow();
    expect(() => decodeSubscriptionState(hexToBytes(STATE_PLATFORM.slice(0, 40)))).toThrow();
    expect(() => decodeSubscriptionState(hexToBytes(STATE_PLATFORM + "00"))).toThrow();
    // suspend_reason Option 标记非法（02）。
    expect(() => decodeSubscriptionState(hexToBytes(STATE_PREFIX + "00" + STATE_AUTHORIZED + "02"))).toThrow();
    expect(() => decodeSubscriptionState(new Uint8Array())).toThrow();
  });
});

describe("decodeCreatorPlans", () => {
  it("严格解码 tier_id 与链上月/年价格", () => {
    const price50 = "32000000000000000000000000000000";
    const price500 = "f4010000000000000000000000000000";
    const tiers = decodeCreatorPlans(
      hexToBytes(`0424737570706f727465720800${price50}02${price500}`),
    );
    expect(tiers).toEqual([
      {
        tierId: "supporter",
        tierName: null,
        pricesFen: { monthly: 50n, yearly: 500n },
      },
    ]);
  });

  it("严格解码 tier_name 及 80 字节 Compact 边界", () => {
    expect(decodeCreatorTierName(hexToBytes("24e694afe68c81e88085"))).toBe("支持者");
    const tierName = "🙂".repeat(20);
    expect(decodeCreatorTierName(Uint8Array.from([
      0x41,
      0x01,
      ...new TextEncoder().encode(tierName),
    ]))).toBe(tierName);
    expect(() => decodeCreatorTierName(hexToBytes("082061"))).toThrow();
  });

  it("拒绝重复周期、截断和尾随字节", () => {
    const price = "32000000000000000000000000000000";
    expect(() => decodeCreatorPlans(hexToBytes(`0404740800${price}00${price}`))).toThrow();
    expect(() => decodeCreatorPlans(hexToBytes("04047404"))).toThrow();
    expect(() => decodeCreatorPlans(hexToBytes("0000"))).toThrow();
  });
});

describe("buildSubscriptionKey", () => {
  it("平台键保持 Blake2_128Concat 单键布局", () => {
    const subscriberCidNumber = "CN220-CTZN2-100000001-2026";
    const key = buildSubscriptionKey(subscriberCidNumber, { kind: "platform" });
    const prefix = storageValueKey("SquarePost", "Subscriptions");
    expect(Array.from(key.slice(0, 32))).toEqual(Array.from(prefix));
    expect(key.length).toBe(50 + subscriberCidNumber.length);
    expect(key[key.length - 1]).toBe(0x00);
  });

  it("创作者键只包含订阅者 CID 与创作者 CID", () => {
    const subscriberCidNumber = "CN220-CTZN2-100000001-2026";
    const creatorCidNumber = "CN220-CTZN2-900000001-2026";
    const key = buildSubscriptionKey(subscriberCidNumber, {
      kind: "creator",
      creatorCidNumber,
    });
    expect(key.length).toBe(
      51 + subscriberCidNumber.length + creatorCidNumber.length,
    );
    expect(key[49 + subscriberCidNumber.length]).toBe(0x01);
  });

  it("CreatorPlans 键使用创作者 CID 作为 Blake2_128Concat 单键", () => {
    const creatorCidNumber = "CN220-CTZN2-900000001-2026";
    const key = buildCreatorPlansKey(creatorCidNumber);
    const prefix = storageValueKey("SquarePost", "CreatorPlans");
    expect(Array.from(key.slice(0, 32))).toEqual(Array.from(prefix));
    expect(key.length).toBe(49 + creatorCidNumber.length);
  });

  it("CreatorTierNames 键使用 CID 与 tier_id 双 Blake2_128Concat", () => {
    const creatorCidNumber = "CN220-CTZN2-900000001-2026";
    const key = buildCreatorTierNameKey(creatorCidNumber, "supporter");
    const prefix = storageValueKey("SquarePost", "CreatorTierNames");
    expect(Array.from(key.slice(0, 32))).toEqual(Array.from(prefix));
    expect(key.length).toBe(32 + 16 + 1 + creatorCidNumber.length + 16 + 1 + 9);
  });
});

// 中文注释：交易确认只接受 canonical finalized 区块中的真实签名 extrinsic；同一交易哈希只能绑定同一规范业务请求，客户端声明不能覆盖链上动作。
describe("finalized 订阅交易证明", () => {
  it("校验交易哈希、签名账户、调用参数、区块包含关系和 finalized 主链", async () => {
    const signer = new Uint8Array(32).fill(7);
    const signerAccountId = accountId(signer);
    const call = Uint8Array.from([34, 1, 0, 0, 2, ...new Uint8Array(16).fill(1)]);
    const signed = signedExtrinsic(signer, call);
    const signedHex = `0x${bytesToHex(signed)}`;
    const txHash = `0x${bytesToHex(blake2AsU8a(signed, 256))}`;
    const blockHash = `0x${"a".repeat(64)}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = rpcFetch({ blockHash, signedHex });
    try {
      await expect(verifyFinalizedSubscriptionTransaction(
        rpcEnv(),
        signerAccountId,
        { txHash, blockHash },
      )).resolves.toMatchObject({
        txHash,
        blockHash,
        blockNumber: 16,
        extrinsicIndex: 0,
        chainTimestamp: 1_700_000_000_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("动作直接由链上交易解析，客户端没有声明另一档位的入口", async () => {
    const signer = new Uint8Array(32).fill(7);
    const signed = signedExtrinsic(
      signer,
      Uint8Array.from([34, 1, 0, 0, 2, ...new Uint8Array(16).fill(1)]),
    );
    const signedHex = `0x${bytesToHex(signed)}`;
    const blockHash = `0x${"a".repeat(64)}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = rpcFetch({ blockHash, signedHex });
    try {
      await expect(verifyFinalizedSubscriptionTransaction(
        rpcEnv(),
        accountId(signer),
        {
          txHash: `0x${bytesToHex(blake2AsU8a(signed, 256))}`,
          blockHash,
        },
      )).resolves.toMatchObject({
        action: { kind: "platform_subscribe", membershipLevel: "spark" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("创作者交易按 CID 解码并校验，不接受账户键语义", async () => {
    const signer = new Uint8Array(32).fill(7);
    const creatorCidNumber = "CN220-CTZN2-900000001-2026";
    const creatorCid = new TextEncoder().encode(creatorCidNumber);
    const tier = new TextEncoder().encode("supporter");
    const call = Uint8Array.from([
      34,
      1,
      1,
      creatorCid.length << 2,
      ...creatorCid,
      1,
      tier.length << 2,
      ...tier,
      0,
      ...new Uint8Array(16).fill(1),
    ]);
    const signed = signedExtrinsic(signer, call);
    const signedHex = `0x${bytesToHex(signed)}`;
    const txHash = `0x${bytesToHex(blake2AsU8a(signed, 256))}`;
    const blockHash = `0x${"a".repeat(64)}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = rpcFetch({ blockHash, signedHex });
    try {
      await expect(
        verifyFinalizedSubscriptionTransaction(
          rpcEnv(),
          accountId(signer),
          { txHash, blockHash },
        ),
      ).resolves.toMatchObject({
        action: { kind: "creator_subscribe", creatorCidNumber },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("创作者档位改名从 finalized 交易解析，不接收客户端档位声明", async () => {
    const signer = new Uint8Array(32).fill(7);
    const tierId = new TextEncoder().encode("supporter");
    const tierName = new TextEncoder().encode("core");
    const signed = signedExtrinsic(
      signer,
      Uint8Array.from([34, 6, tierId.length << 2, ...tierId, tierName.length << 2, ...tierName]),
    );
    const signedHex = `0x${bytesToHex(signed)}`;
    const txHash = `0x${bytesToHex(blake2AsU8a(signed, 256))}`;
    const blockHash = `0x${"a".repeat(64)}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = rpcFetch({ blockHash, signedHex });
    try {
      await expect(
        verifyFinalizedSubscriptionTransaction(
          rpcEnv(),
          accountId(signer),
          { txHash, blockHash },
        ),
      ).resolves.toMatchObject({
        action: { kind: "creator_tier_name_update", tierId: "supporter", tierName: "core" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("同一 tx_hash 只允许绑定同一规范化业务请求，原请求可幂等重试", async () => {
    const db = new ProofDb();
    const env = { DB: db as unknown as D1Database } as Env;
    const transaction = {
      txHash: `0x${"1".repeat(64)}`,
      blockHash: `0x${"2".repeat(64)}`,
      blockNumber: 10,
      extrinsicIndex: 1,
      chainTimestamp: 1000,
      action: { kind: "platform_cancel" as const },
    };
    const account = `0x${"33".repeat(32)}`;
    await bindFinalizedTransactionConfirmation(
      env,
      CID_NUMBER,
      account,
      transaction,
      "a".repeat(64),
      2000,
    );
    await expect(bindFinalizedTransactionConfirmation(
      env,
      CID_NUMBER,
      account,
      transaction,
      "a".repeat(64),
      3000,
    )).resolves.toBeUndefined();
    await expect(bindFinalizedTransactionConfirmation(
      env,
      CID_NUMBER,
      account,
      transaction,
      "b".repeat(64),
      3000,
    )).rejects.toMatchObject({ code: "subscription_tx_already_bound" });
    await expect(bindFinalizedTransactionConfirmation(
      env,
      "CN220-CTZN2-199001010-2026",
      account,
      transaction,
      "a".repeat(64),
      3000,
    )).rejects.toMatchObject({ code: "subscription_tx_already_bound" });
  });
});

class ProofDb {
  row: Record<string, unknown> | null = null;
  prepare(sql: string): ProofStmt { return new ProofStmt(this, sql); }
}

class ProofStmt {
  private args: unknown[] = [];
  constructor(private readonly db: ProofDb, private readonly sql: string) {}
  bind(...args: unknown[]): ProofStmt { this.args = args; return this; }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT OR IGNORE") && !this.db.row) {
      this.db.row = {
        cid_number: this.args[1],
        account_id: this.args[2],
        block_hash: this.args[3],
        block_number: this.args[4],
        extrinsic_index: this.args[5],
        action_kind: this.args[6],
        request_hash: this.args[7],
        chain_timestamp: this.args[8],
      };
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async first<T>(): Promise<T | null> {
    return this.db.row as T | null;
  }
}

function signedExtrinsic(signer: Uint8Array, call: Uint8Array): Uint8Array {
  const body = Uint8Array.from([
    0x84,
    0x00,
    ...signer,
    0x01,
    ...new Uint8Array(64).fill(9),
    0x00,
    0x00,
    0x00,
    ...call,
  ]);
  return Uint8Array.from([...compact(body.length), ...body]);
}

function compact(value: number): number[] {
  if (value < 64) return [value << 2];
  const encoded = (value << 2) | 1;
  return [encoded & 0xff, (encoded >> 8) & 0xff];
}

function rpcEnv(): Env {
  return {
    CHAIN_URL: "https://node.internal/rpc",
    CHAIN_ID: "access-id",
    CHAIN_SECRET: "access-secret",
  } as Env;
}

function rpcFetch(input: { blockHash: string; signedHex: string }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    let result: unknown;
    switch (request.method) {
      case "chain_getFinalizedHead":
        result = input.blockHash;
        break;
      case "chain_getBlock":
        result = { block: { header: { number: "0x10" }, extrinsics: [input.signedHex] } };
        break;
      case "chain_getHeader":
        result = { number: "0x10" };
        break;
      case "chain_getBlockHash":
        result = input.blockHash;
        break;
      case "state_getStorage":
        result = "0x0068e5cf8b010000";
        break;
      default:
        throw new Error(`unexpected rpc ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
