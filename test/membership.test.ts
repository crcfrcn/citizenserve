import { describe, expect, it } from "vitest";
import {
  isSubscriptionProjectionEffective,
  requireActiveMembership,
  subscriptionIsActive,
} from "../src/membership/service";
import type { Env } from "../src/types";
import type { MembershipRow } from "../src/types";
import { readMembershipUsageState } from "../src/limits/usage";

const NOW = 2_000_000;

describe("平台与创作者统一订阅门禁", () => {
  it("Active 且当前时间早于 paid_until 时放行", () => {
    expect(subscriptionIsActive(membershipRow(), NOW)).toBe(true);
  });

  it("Cancelled 在已付周期内继续放行，到期后立即拒绝", () => {
    expect(subscriptionIsActive(membershipRow({ subscription_status: "cancelled" }), NOW)).toBe(true);
    expect(subscriptionIsActive(membershipRow({
      subscription_status: "cancelled",
      paid_until: 1_999_999,
    }), NOW)).toBe(false);
  });

  it("Terminated 无论 paid_until 是否在未来都拒绝", () => {
    expect(subscriptionIsActive(membershipRow({ subscription_status: "terminated" }), NOW)).toBe(false);
  });

  it("已同步会员有效性不因 D1 写入时间变旧而降级", () => {
    expect(subscriptionIsActive(membershipRow({ verified_at: 1 }), NOW)).toBe(true);
  });

  it("创作者关系复用同一有效口径", () => {
    expect(isSubscriptionProjectionEffective({
      subscription_status: "cancelled",
      paid_until: 2_100_000,
    }, NOW)).toBe(true);
  });
});

describe("手机端发布前用量快照", () => {
  it("返回已用量与在途预留的合计", async () => {
    const statement = {
      bind() { return statement; },
      async first<T>() {
        return { image_count: 12, video_seconds: 345, active_uploads: 2 } as T;
      },
    };
    const env = { DB: { prepare: () => statement } } as unknown as Env;
    const result = await readMembershipUsageState(
      env,
      "CN220-CTZN2-198805200-2026",
      { last_charged_at: 100, paid_until: 200 },
    );
    expect(result).toEqual({
      period_start: 100,
      period_end: 200,
      image_count: 12,
      video_seconds: 345,
      active_uploads: 2,
    });
  });
});

// 中文注释：发布授权只消费 finalized 订阅投影写入的 D1 状态；缺少会员行就是无会员，不在请求路径回链补读。
describe("发布授权只读取 CitizenServe D1", () => {
  it("D1 没有会员记录时直接返回 402，不点查链", async () => {
    await expect(requireActiveMembership(
      membershipEnv(() => null),
      "CN220-CTZN2-198805200-2026",
      `0x${"9".repeat(64)}`,
    )).rejects.toMatchObject({
      status: 402,
      code: "membership_required",
    });
  });

  it("D1 已同步有效会员时直接放行", async () => {
    const membership = membershipRow({ paid_until: Date.now() + 60_000 });
    await expect(requireActiveMembership(
      membershipEnv(() => membership),
      membership.cid_number,
      membership.account_id,
    )).resolves.toBe(membership);
  });
});

function membershipEnv(read: () => MembershipRow | null): Env {
  const statement = {
    bind() {
      return statement;
    },
    async first<T>() {
      return read() as T | null;
    },
  };
  return {
    DB: {
      prepare: () => statement,
    },
  } as unknown as Env;
}


function membershipRow(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    cid_number: "CN220-CTZN2-198805200-2026",
    account_id: "0x9999999999999999999999999999999999999999999999999999999999999999",
    membership_level: "freedom",
    started_at: 1_000_000,
    last_charged_at: 1_000_000,
    last_charged_price_fen: 100,
    paid_until: 2_100_000,
    subscription_status: "active",
    finalized_block_number: 10,
    finalized_block_hash: `0x${"1".repeat(64)}`,
    verified_at: NOW,
    entitlement_lapsed_at: null,
    last_tx_hash: `0x${"2".repeat(64)}`,
    ...overrides,
  };
}
