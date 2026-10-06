import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 真实scheduled入口使用可控投影及独立清理，验证完成时序与失败隔离。
const scheduled = vi.hoisted(() => ({
  users: vi.fn<() => Promise<unknown>>(), subscriptions: vi.fn<() => Promise<unknown>>(),
  cleanup: vi.fn(async () => undefined),
}));
vi.mock('../src/account/user_projection', async (original) => ({
  ...await original<object>(), reconcileFinalizedUserProjection: scheduled.users,
}));
vi.mock('../src/membership/subscription_projection', async (original) => ({
  ...await original<object>(), reconcileFinalizedSubscriptionProjection: scheduled.subscriptions,
}));
vi.mock('../src/uploads/service', async (original) => ({...await original<object>(), cleanupExpiredUploads: scheduled.cleanup}));
vi.mock('../src/security/request_guard', async (original) => ({...await original<object>(), cleanupSecurityState: scheduled.cleanup}));
vi.mock('../src/limits/usage', async (original) => ({...await original<object>(), cleanupExpiredReservations: scheduled.cleanup}));
vi.mock('../src/auth/session_index', async (original) => ({...await original<object>(), cleanupExpiredSessionIndexes: scheduled.cleanup}));
vi.mock('../src/auth/push_endpoint', async (original) => ({...await original<object>(), cleanupExpiredPushEndpoints: scheduled.cleanup}));

describe('定时身份与会员依赖', () => {
  it('会员等待身份完成，等待期间清理已经独立运行', async () => {
    scheduled.users.mockReset(); scheduled.subscriptions.mockReset(); scheduled.cleanup.mockClear();
    let complete!: () => void;
    scheduled.users.mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
    scheduled.subscriptions.mockResolvedValue(undefined);
    const { default: worker } = await import('../src/index');
    let completion!: Promise<void>;
    await worker.scheduled({cron: '*/5 * * * *', scheduledTime: 0} as ScheduledController,
      {} as import('../src/types').Env,
      {waitUntil: (promise: Promise<void>) => { completion = promise; }} as ExecutionContext);
    expect(scheduled.users).toHaveBeenCalledTimes(1);
    expect(scheduled.subscriptions).not.toHaveBeenCalled();
    expect(scheduled.cleanup).toHaveBeenCalledTimes(5);
    complete(); await completion;
    expect(scheduled.subscriptions).toHaveBeenCalledTimes(1);
  });
  it('身份失败不启动会员，也不阻断清理', async () => {
    scheduled.users.mockReset(); scheduled.subscriptions.mockReset(); scheduled.cleanup.mockClear();
    scheduled.users.mockRejectedValue({code: 'identity_projection_failed'});
    const { default: worker } = await import('../src/index');
    let completion!: Promise<void>;
    await worker.scheduled({cron: '*/5 * * * *', scheduledTime: 0} as ScheduledController,
      {} as import('../src/types').Env,
      {waitUntil: (promise: Promise<void>) => { completion = promise; }} as ExecutionContext);
    await expect(completion).rejects.toThrow('project-users:identity_projection_failed');
    expect(scheduled.subscriptions).not.toHaveBeenCalled();
    expect(scheduled.cleanup).toHaveBeenCalledTimes(5);
  });
});

// CitizenServe 只验证自身产品合同，以及必须与链运行时一致的链上存储项。
// 聊天通用协议由TataChatSDK与TataChatServer各自验证，本产品只保留短期授权控制面。
const REPOSITORY_ROOT = join(import.meta.dirname, "../..");
const WRANGLER_CONFIGURATION = readFileSync(
  join(import.meta.dirname, "../scripts/wrangler.toml"),
  "utf8",
);

describe("链上 storage 项名锁(Worker ⇔ citizenchain pallet)", () => {
  // 真实事故:citizenchain 把 WalletAccountByCid/CidByWalletAccount 改名为
  // AccountIdByCid/CidByAccountId,Flutter 跟了、Worker 没跟 —— storage key 拼错
  // 后 state_getStorage 返回 null(不是报错),表现为"所有人都未绑定 CID",
  // 登录/鉴权/主页全线失效且软降级掩盖。此处把名字钉死在 pallet 源码上。
  const identity = readFileSync(
    join(import.meta.dirname, "../src/chain/identity.ts"),
    "utf8",
  );
  const palletPath = join(
    REPOSITORY_ROOT,
    "citizenchain/runtime/misc/citizen-identity/src/lib.rs",
  );

  it("Worker 用的 storage 项名必须存在于 citizen-identity pallet", () => {
    const pallet = readFileSync(palletPath, "utf8");
    for (const storageName of [
      "AccountIdByCid",
      "CidByAccountId",
      "CidRegistry",
      "VotingIdentityByCid",
      "CandidateIdentityByCid",
    ]) {
      expect(identity).toContain(`"${storageName}"`);
      expect(pallet).toContain(`pub type ${storageName}`);
    }
    // 改名前的旧项名不得复活。
    expect(identity).not.toContain("WalletAccountByCid");
    expect(identity).not.toContain("CidByWalletAccount");
  });
});

describe("Cloudflare Workers Paid 成本硬边界", () => {
  // Paid 套餐把三个高频对账任务合并到同一五分钟 Cron，但各任务仍必须保留自身批次硬顶。
  const wrangler = readFileSync(join(import.meta.dirname, "../scripts/wrangler.toml"), "utf8");
  const worker = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
  const media = readFileSync(join(import.meta.dirname, "../src/media.ts"), "utf8");
  const cleanup = readFileSync(
    join(import.meta.dirname, "../src/membership/expiration_cleanup.ts"),
    "utf8",
  );

  it("只登记五分钟与每日两条 Cron，并保持各任务批次硬顶", () => {
    const cronConfig = wrangler.match(/crons = (\[[^\n]+\])/);
    expect(cronConfig).not.toBeNull();
    expect(JSON.parse(cronConfig![1])).toEqual([
      "*/5 * * * *",
      "4 3 * * *",
    ]);
    expect(wrangler).not.toContain("[limits]");
    expect(wrangler).not.toContain("cpu_ms");
    expect(wrangler).not.toContain("subrequests =");
    for (const cron of ["*/5 * * * *", "4 3 * * *"]) {
      expect(worker).toContain(`_controller.cron === '${cron}'`);
    }
    for (const removed of ["1-56/5 * * * *", "2-57/5 * * * *", "3-58/5 * * * *"]) {
      expect(worker).not.toContain(`_controller.cron === '${removed}'`);
      expect(wrangler).not.toContain(removed);
    }
    for (const task of [
      "reconcileFinalizedUserProjection(env)",
      "reconcileFinalizedSubscriptionProjection(env)",
    ]) expect(worker).toContain(task);
    expect(worker).not.toContain("reconcileFinalizedMembershipProjection(env)");
    expect(worker).not.toContain("reconcileSubscriptions(env)");
  });

  it("R2、Cache Purge 与每日内容清理均有官方批次硬顶", () => {
    expect(media).toContain("const R2_DELETE_BATCH = 1000");
    expect(media).toContain("const CACHE_PURGE_URL_BATCH = 100");
    expect(cleanup).toContain("const MAX_IDENTITIES_PER_SWEEP = 3");
    expect(cleanup).toContain("const MAX_CONTENT_ITEMS_PER_SWEEP = 4");
  });

  it("正式 Release 声明完整的 R2 HTTPS 预签名绑定", () => {
    expect(WRANGLER_CONFIGURATION).toMatch(
      /\[vars\][\s\S]*CF_ACCOUNT_ID = "[0-9a-f]{32}"/u,
    );
    expect(WRANGLER_CONFIGURATION).toMatch(
      /\[secrets\][\s\S]*required = \[[\s\S]*"R2_KEY", "R2_SECRET"[\s\S]*\]/u,
    );
    expect(WRANGLER_CONFIGURATION).toContain('binding = "SQUARE_PRIVATE"');
    expect(WRANGLER_CONFIGURATION).toContain('bucket_name = "citizenserve-private"');
    expect(WRANGLER_CONFIGURATION).toContain('binding = "SQUARE_PUBLIC_MEDIA"');
    expect(WRANGLER_CONFIGURATION).toContain('bucket_name = "citizenserve-media"');
  });
});

describe("CitizenServe 最终结构和定时任务保持单一合同", () => {
  it("最终结构中的表和索引可安全重复执行", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const schema = await readFile(resolve(process.cwd(), "schema/citizenserve.sql"), "utf8");

    // 明确最终MLS表闭集，缺表、多表或旧设备表残留均失败。
    const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]).sort();
    expect(tables).toEqual([
      "chain_extrinsic_relays",
      "chain_transaction_confirmations",
      "contact_mls_groups",
      "contact_mls_messages",
      "contact_mls_operations",
      "contact_mls_packages",
      "membership_projection_cursor",
      "mls_authentication_challenges",
      "mls_devices",
      "push_endpoints",
      "rate_windows",
      "resource_reservations",
      "resource_totals",
      "resource_usage",
      "square_browse_days",
      "square_creator_subscriptions",
      "square_creator_tiers",
      "square_follows",
      "square_media_assets",
      "square_memberships",
      "square_notify_reads",
      "square_posts",
      "square_sessions",
      "square_uploads",
      "topup_orders",
      "user_profiles",
      "user_projection_cursor",
      "users"
    ]);
    expect(schema).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS )/);
    expect(schema).not.toMatch(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS )/);
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS push_endpoints");
  });

  it("清理失败不会阻断身份与会员投影启动", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(resolve(process.cwd(), "src/index.ts"), "utf8");

    expect(source).toContain("Promise.allSettled");
    expect(source).toContain("name: 'project-users'");
    expect(source).toContain("name: 'project-subscriptions'");
    expect(source).not.toContain("ctx.waitUntil(job.catch");
  });
});
// CitizenServe发布契约必须同时固定公开账户标识、机密访问凭据和广场私有媒体桶。

// 中文注释：Wrangler 配置新增公开绑定后必须同步生成类型，避免正式 CI 才发现绑定声明过期。
describe("CitizenServe Worker 绑定类型保持同步", () => {
  it("公开 R2 账户标识和聊天服务根地址必须进入配置与生成类型", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const types = await readFile(resolve(process.cwd(), "scripts/worker-configuration.d.ts"), "utf8");
    expect(types).toMatch(/\bCF_ACCOUNT_ID:/);
    expect(WRANGLER_CONFIGURATION).toContain(
      'CHAT_SERVER_URL = "https://chat.crcfrcn.com"',
    );
    expect(types).toContain(
      'CHAT_SERVER_URL: "https://chat.crcfrcn.com";',
    );
  });

  it("聊天授权只保留唯一正式路由", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const routes = await readFile(resolve(process.cwd(), "src/routes.ts"), "utf8");
    expect(routes).toContain('path === "/auth/chatserver/access"');
    expect(routes.match(/path === "\/auth\/chatserver\/access"/gu)).toHaveLength(1);
  });
});
