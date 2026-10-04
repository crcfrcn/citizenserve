import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmPublishedPost,
  deletePostCloudflareData,
  deletePostCloudflareDataByCid,
} from "../src/posts/confirm";
import type {
  Env,
  MediaAssetRow,
  PreparedUploadRow,
  SessionState,
} from "../src/types";
import {
  decodeSquarePostPublishedEvents,
  u32Le,
  u64Le,
} from "../src/chain/square_event";
import {
  scaleString as compactBytes,
  scaleCompact as compactU32,
  bytesToHex as hex,
} from "../src/shared/signing_message";
import {
  fetchChainStorage,
  fetchChainStorageBatch,
  fetchFinalizedChainStorage,
} from "../src/chain/rpc";
import { sha256Hex } from "../src/shared/hash";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { abortUploadForSession } from "../src/uploads/service";

const accountIdBytes = Uint8Array.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
);
const accountId = `0x${hex(accountIdBytes)}`;
const postId = "sqp_test";
const contentHash = `0x${"11".repeat(32)}`;
const storageReceiptId = "sqr_test";
const blockHash = `0x${"22".repeat(32)}`;
const extrinsicHex = "0x0400";
const txHash = `0x${hex(blake2AsU8a(bytes(extrinsicHex), 256))}`;
const canonicalManifestKey =
  `square/CN220-CTZN2-198805200-2026/posts/${postId}/manifest.json`;
// 登录会话身份主键(=上传/媒体/帖子归属键);标准测试 cid。
const sessionCid = "CN220-CTZN2-198805200-2026";
// 链上 SquarePostPublished 事件携带的发布者 cid(=已发布帖镜像的身份主键)。
const authorCid = "CN001-CTZN-000000001-2026";

describe("square chain confirmation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes SquarePostPublished from System.Events bytes", () => {
    const eventsHex = buildEventsHex({
      cidNumber: authorCid,
    });
    const events = decodeSquarePostPublishedEvents(eventsHex);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      post_id: postId,
      account_id: accountId,
      cid_number: authorCid,
      post_type: "document",
      post_category: "campaign",
      content_hash: contentHash,
      storage_receipt_id: storageReceiptId,
      storage_until: 1800000000000,
      created_block: 88,
    });
  });

  it.each([
    ["document", 0],
    ["article", 1],
    ["video", 2],
  ] as const)("decodes %s post_type from the shared SCALE event order", (postType, postTypeByte) => {
    const [event] = decodeSquarePostPublishedEvents(buildEventsHex({
      cidNumber: authorCid,
      postTypeByte,
    }));
    expect(event?.post_type).toBe(postType);
    expect(event?.storage_until).toBe(1_800_000_000_000);
  });

  it("confirms completed upload and writes published post", async () => {
    const db = new FakeDb();
    const manifestText = JSON.stringify({
      schema: "citizenapp.square.post",
      cid_number: sessionCid,
      post_type: "document",
      text: "普通动态",
      media_items: [
        {
          media_kind: "image",
          file_name: "a.webp",
          content_type: "image/webp",
          byte_size: 1024,
          sha256: "aa".repeat(32),
          width: 1200,
          height: 800,
        },
      ],
    });
    const actualContentHash = await sha256Hex(manifestText);
    const upload: PreparedUploadRow = {
      upload_id: "squ_test",
      post_id: postId,
      cid_number: sessionCid,
      account_id: accountId,
      post_type: "document",
      manifest_hash: actualContentHash,
      manifest_byte_size: new TextEncoder().encode(manifestText).byteLength,
      content_hash: actualContentHash,
      storage_receipt_id: storageReceiptId,
      estimated_bytes: 1024,
      status: "completed",
      expires_at: Date.now() + 60_000,
      created_at: 1,
      completed_at: 2,
    };
    db.uploads.set(postId, upload);
    db.mediaAssets.set(upload.upload_id, [
      {
        upload_id: upload.upload_id,
        post_id: postId,
        cid_number: sessionCid,
        account_id: accountId,
        media_index: 0,
        media_kind: "image",
        object_key: `square/${sessionCid}/posts/${postId}/media/0/source.webp`,
        upload_method: "r2_put",
        resource_key: "square_image_freedom",
        content_type: "image/webp",
        byte_size: 1024,
        sha256: "aa".repeat(32),
        derivative_kind: "thumbnail",
        derivative_object_key: `square/${sessionCid}/posts/${postId}/media/0/thumbnail.webp`,
        derivative_content_type: "image/webp",
        derivative_byte_size: 256,
        derivative_sha256: "bb".repeat(32),
        asset_state: "ready",
        duration_seconds: null,
        width: 1200,
        height: 800,
        error_code: null,
        created_at: 1,
        updated_at: 2,
        ready_at: 2,
      },
    ]);
    const env = {
      DB: db,
      SQUARE_PRIVATE: new FakeR2({
        [canonicalManifestKey]:
          manifestText,
      }),
      SQUARE_PUBLIC_MEDIA: {} as R2Bucket,
      SQUARE_PUBLIC_MEDIA_BASE_URL: "https://media.crcfrcn.com",
      SQUARE_CACHE: {},
      CHAIN_URL: "https://chain.test",
      CHAIN_ID: "worker-rpc.access",
      CHAIN_SECRET: "test-access-secret",
    } as unknown as Env;
    let storageCall = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as
        { id: number; method: string } | Array<{ id: number; method: string }>;
      const reply = (rpc: { id: number; method: string }) => {
        let result: unknown;
        if (rpc.method === "chain_getFinalizedHead") result = blockHash;
        else if (rpc.method === "chain_getBlock") {
          result = { block: { header: { number: "0x58" }, extrinsics: [extrinsicHex] } };
        } else if (rpc.method === "chain_getHeader") result = { number: "0x58" };
        else if (rpc.method === "chain_getBlockHash") result = blockHash;
        else if (rpc.method === "state_getStorage") {
          storageCall += 1;
          result = [
            buildEventsHex({
              cidNumber: sessionCid,
              postCategory: "normal",
              contentHash: `0x${actualContentHash}`,
            }),
            `0x${hex(u64Le(Date.now()))}`,
            accountId,
            activeCidRecordHex(sessionCid),
            `0x${hex(u64Le(1))}`,
            null,
            null,
            activePlatformSubscriptionHex(),
          ][storageCall - 1];
        }
        return { jsonrpc: "2.0", id: rpc.id, result };
      };
      return Response.json(Array.isArray(body) ? body.map(reply) : reply(body));
    }));

    const post = await confirmPublishedPost(env, session(), {
      post_id: postId,
      block_hash: blockHash,
      tx_hash: txHash,
    });

    expect(post.excerpt).toBe("普通动态");
    expect(post.cid_number).toBe(sessionCid);
    expect(post.media_items?.[0]).toMatchObject({
      object_key: `square/${sessionCid}/posts/${postId}/media/0/source.webp`,
      url: `https://media.crcfrcn.com/square/${sessionCid}/posts/${postId}/media/0/source.webp`,
      asset_state: "ready",
    });
    expect(db.posts.get(postId)?.post_state).toBe("published");
  });

  it("sends state_getStorage only through the Access-protected HTTPS upstream", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body as string) as {
        id: number;
        method: string;
        params: string[];
      };
      expect(url).toBe("https://chain.test/");
      expect(headers.get("CF-Access-Client-Id")).toBe("worker-rpc.access");
      expect(headers.get("CF-Access-Client-Secret")).toBe("test-access-secret");
      expect(body.method).toBe("state_getStorage");
      expect(body.params).toEqual(["0x1234", blockHash]);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0xabcd" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchChainStorage(chainRpcEnv(), "0x1234", blockHash);

    expect(result).toBe("0xabcd");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("同区块多个 storage key 只产生一次 JSON-RPC batch HTTP", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Array<{
        id: number;
        method: string;
        params: string[];
      }>;
      expect(body).toHaveLength(3);
      expect(body.every((request) => request.method === "state_getStorage")).toBe(true);
      return Response.json(body.slice().reverse().map((request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: request.params[0] === "0x02" ? null : `0x${request.params[0].slice(2).repeat(2)}`,
      })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchChainStorageBatch(chainRpcEnv(), [
      { storageKeyHex: "0x01", blockHashHex: blockHash },
      { storageKeyHex: "0x02", blockHashHex: blockHash },
      { storageKeyHex: "0x03", blockHashHex: blockHash },
    ]);

    expect(result).toEqual(["0x0101", null, "0x0303"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("业务状态先取 finalized head，再钉该区块读取 storage", async () => {
    const finalized = `0x${"33".repeat(32)}`;
    const calls: Array<{ method: string; params: string[] }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          id: number;
          method: string;
          params: string[];
        };
        calls.push({ method: body.method, params: body.params });
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "chain_getFinalizedHead" ? finalized : "0xabcd",
        });
      }),
    );

    await expect(
      fetchFinalizedChainStorage(chainRpcEnv(), "0x1234"),
    ).resolves.toBe("0xabcd");
    expect(calls).toEqual([
      { method: "chain_getFinalizedHead", params: [] },
      { method: "state_getStorage", params: ["0x1234", finalized] },
    ]);
  });

  it("rejects non-HTTPS RPC configuration before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchChainStorage(
        chainRpcEnv({ CHAIN_URL: "http://127.0.0.1:9944" }),
        "0x1234",
      ),
    ).rejects.toMatchObject({ code: "chain_rpc_invalid_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized RPC response before buffering its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(4 * 1024 * 1024 + 1) },
          }),
      ),
    );

    await expect(
      fetchChainStorage(chainRpcEnv(), "0x1234"),
    ).rejects.toMatchObject({
      code: "chain_rpc_response_too_large",
    });
  });

  it("hard-deletes Cloudflare-side post data", async () => {
    const db = new FakeDb();
    const manifestKey = canonicalManifestKey;
    const upload = completedUpload(manifestKey);
    db.uploads.set(postId, upload);
    db.mediaAssets.set(upload.upload_id, [imageAsset(upload.upload_id)]);
    db.posts.set(postId, {
      post_id: postId,
      account_id: accountId,
      cid_number: sessionCid,
      post_category: "normal",
      post_type: "document",
      title: "旧标题",
      excerpt: "旧动态",
      content_hash: contentHash,
      storage_receipt_id: storageReceiptId,
      chain_block: 88,
      chain_block_hash: blockHash,
      tx_hash: `0x${"33".repeat(32)}`,
      created_at: 1,
      post_state: "published",
    });
    const r2 = new FakeR2({
      [manifestKey]: JSON.stringify({
        schema: "citizenapp.square.post",
        cid_number: sessionCid,
        post_type: "document",
        text: "旧动态",
        media_items: [],
      }),
    });
    const env = {
      DB: db,
      SQUARE_PRIVATE: r2,
      SQUARE_PUBLIC_MEDIA: r2,
      SQUARE_CACHE: {},
      SQUARE_PUBLIC_MEDIA_BASE_URL: "https://media.crcfrcn.com",
      ZONE_ID: "0123456789abcdef0123456789abcdef",
      PURGE: "purge-token",
    } as unknown as Env;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, result: {} })),
    );

    const result = await deletePostCloudflareData(env, session(), postId);

    expect(result).toMatchObject({
      deleted_media_assets: 1,
      deleted_r2_objects: 3,
    });
    // 硬删除：帖子行 + 上传行 + 媒体资产 + R2 对象全部清空，无软删残行。
    expect(db.posts.has(postId)).toBe(false);
    expect(db.uploads.has(postId)).toBe(false);
    expect(db.mediaAssets.get(upload.upload_id)).toEqual([]);
    expect(r2.deletedKeys).toEqual([
      [imageAsset(upload.upload_id).object_key, imageAsset(upload.upload_id).derivative_object_key],
      manifestKey,
    ]);

    // 再删同一帖子 → 已无残行，报 404，证明是彻底删除而非软删。
    await expect(
      deletePostCloudflareData(env, session(), postId),
    ).rejects.toMatchObject({
      code: "post_not_found",
    });
  });

  it("hard-deletes an upload-only content item after membership expiry", async () => {
    const db = new FakeDb();
    const manifestKey = canonicalManifestKey;
    const upload = completedUpload(manifestKey);
    db.uploads.set(postId, upload);
    db.mediaAssets.set(upload.upload_id, [imageAsset(upload.upload_id)]);
    const r2 = new FakeR2({ [manifestKey]: "{}" });
    const env = {
      DB: db,
      SQUARE_PRIVATE: r2,
      SQUARE_PUBLIC_MEDIA: r2,
      SQUARE_PUBLIC_MEDIA_BASE_URL: "https://media.crcfrcn.com",
      ZONE_ID: "0123456789abcdef0123456789abcdef",
      PURGE: "purge-token",
    } as unknown as Env;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, result: {} })),
    );

    await deletePostCloudflareDataByCid(
      env,
      sessionCid,
      postId,
      10_000,
    );

    expect(db.uploads.has(postId)).toBe(false);
    expect(db.mediaAssets.get(upload.upload_id)).toEqual([]);
    expect(r2.deletedKeys).toEqual([
      [imageAsset(upload.upload_id).object_key, imageAsset(upload.upload_id).derivative_object_key],
      manifestKey,
    ]);
  });

  it("aborts a completed orphan upload only after finalized storage is empty", async () => {
    const db = new FakeDb();
    const upload = completedUpload(canonicalManifestKey);
    db.uploads.set(postId, upload);
    db.mediaAssets.set(upload.upload_id, []);
    const r2 = new FakeR2({ [canonicalManifestKey]: "{}" });
    const env = {
      ...chainRpcEnv(),
      DB: db,
      SQUARE_PRIVATE: r2,
      SQUARE_PUBLIC_MEDIA: r2,
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "chain_getFinalizedHead" ? blockHash : null,
      });
    }));

    const result = await abortUploadForSession(env, session(), upload.upload_id);

    expect(result).toMatchObject({ ok: true, post_id: postId, deleted_media_assets: 0 });
    expect(db.uploads.has(postId)).toBe(false);
    expect(r2.deletedKeys).toEqual([canonicalManifestKey]);
  });

  it("refuses orphan cleanup when finalized SquarePosts already contains the post", async () => {
    const db = new FakeDb();
    const upload = completedUpload(canonicalManifestKey);
    db.uploads.set(postId, upload);
    const r2 = new FakeR2({ [canonicalManifestKey]: "{}" });
    const env = {
      ...chainRpcEnv(),
      DB: db,
      SQUARE_PRIVATE: r2,
      SQUARE_PUBLIC_MEDIA: r2,
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "chain_getFinalizedHead" ? blockHash : "0x01",
      });
    }));

    await expect(
      abortUploadForSession(env, session(), upload.upload_id),
    ).rejects.toMatchObject({ code: "finalized_upload_cannot_abort" });
    expect(db.uploads.has(postId)).toBe(true);
    expect(r2.deletedKeys).toEqual([]);
  });

  it("retains a published post when its upload object index is missing", async () => {
    const db = new FakeDb();
    db.posts.set(postId, publishedPost());
    const r2 = new FakeR2({ [canonicalManifestKey]: "{}" });
    const providerDelete = vi.fn();
    vi.stubGlobal("fetch", providerDelete);
    const env = {
      DB: db,
      SQUARE_PRIVATE: r2,
      SQUARE_PUBLIC_MEDIA: r2,
    } as unknown as Env;

    await expect(
      deletePostCloudflareDataByCid(env, sessionCid, postId, 10_000),
    ).rejects.toMatchObject({ code: "post_upload_index_missing" });

    expect(providerDelete).not.toHaveBeenCalled();
    expect(r2.deletedKeys).toEqual([]);
    expect(db.posts.has(postId)).toBe(true);
  });

  it("keeps D1 cleanup indexes when R2 deletion fails", async () => {
    const db = new FakeDb();
    const manifestKey = canonicalManifestKey;
    const upload = completedUpload(manifestKey);
    db.uploads.set(postId, upload);
    db.mediaAssets.set(upload.upload_id, [imageAsset(upload.upload_id)]);
    db.posts.set(postId, {
      post_id: postId,
      account_id: accountId,
      cid_number: sessionCid,
      post_category: "normal",
      post_type: "document",
      title: null,
      excerpt: "保留到重试",
      content_hash: contentHash,
      storage_receipt_id: storageReceiptId,
      chain_block: 88,
      chain_block_hash: blockHash,
      tx_hash: `0x${"33".repeat(32)}`,
      created_at: 1,
      post_state: "published",
    });
    const r2 = new FakeR2({ [manifestKey]: "{}" });
    const env = {
      DB: db,
      SQUARE_PRIVATE: r2,
      SQUARE_PUBLIC_MEDIA: r2,
    } as unknown as Env;
    r2.delete = vi.fn(async () => { throw new Error("r2 unavailable"); });

    await expect(
      deletePostCloudflareDataByCid(env, sessionCid, postId, 10_000),
    ).rejects.toThrow("r2 unavailable");

    expect(db.posts.has(postId)).toBe(true);
    expect(db.uploads.has(postId)).toBe(true);
    expect(db.mediaAssets.get(upload.upload_id)).toHaveLength(1);
    expect(r2.deletedKeys).toEqual([]);
  });
});

function chainRpcEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    SQUARE_PRIVATE: {} as R2Bucket,
    SQUARE_PUBLIC_MEDIA: {} as R2Bucket,
    SQUARE_CACHE: {} as KVNamespace,
    SQUARE_PUBLIC_MEDIA_BASE_URL: "https://media.crcfrcn.com",
    ZONE_ID: "0123456789abcdef0123456789abcdef",
    PURGE: "purge-token",
    CHAIN_URL: "https://chain.test",
    CHAIN_ID: "worker-rpc.access",
    CHAIN_SECRET: "test-access-secret",
    ...overrides,
  };
}

function session(): SessionState {
  return {
    cid_number: sessionCid,
    binding_revision: 1,
    account_id: accountId,
    device_key_hash: "a".repeat(64),
    created_at: 1,
    expires_at: Date.now() + 100000,
  };
}

function completedUpload(_manifestKey: string): PreparedUploadRow {
  return {
    upload_id: "squ_test",
    post_id: postId,
    cid_number: sessionCid,
    account_id: accountId,
    post_type: "document",
    manifest_hash: contentHash.slice(2),
    manifest_byte_size: 512,
    content_hash: contentHash.slice(2),
    storage_receipt_id: storageReceiptId,
    estimated_bytes: 1024,
    status: "completed",
    expires_at: Date.now() + 60_000,
    created_at: 1,
    completed_at: 2,
  };
}

function publishedPost(): Record<string, unknown> {
  return {
    post_id: postId,
    account_id: accountId,
    cid_number: sessionCid,
    post_category: "normal",
    post_type: "document",
    title: null,
    excerpt: "保留到重试",
    content_hash: contentHash,
    storage_receipt_id: storageReceiptId,
    chain_block: 88,
    chain_block_hash: blockHash,
    tx_hash: `0x${"33".repeat(32)}`,
    created_at: 1,
    post_state: "published",
  };
}

function imageAsset(uploadId: string): MediaAssetRow {
  return {
    upload_id: uploadId,
    post_id: postId,
    cid_number: sessionCid,
    account_id: accountId,
    media_index: 0,
    media_kind: "image",
    object_key: `square/${sessionCid}/posts/${postId}/media/0/source.webp`,
    upload_method: "r2_put",
    resource_key: "square_image_freedom",
    content_type: "image/webp",
    byte_size: 1024,
    sha256: "aa".repeat(32),
    derivative_kind: "thumbnail",
    derivative_object_key: `square/${sessionCid}/posts/${postId}/media/0/thumbnail.webp`,
    derivative_content_type: "image/webp",
    derivative_byte_size: 256,
    derivative_sha256: "bb".repeat(32),
    asset_state: "ready",
    duration_seconds: null,
    width: 1200,
    height: 800,
    error_code: null,
    created_at: 1,
    updated_at: 2,
    ready_at: 2,
  };
}

function buildEventsHex(input: {
  cidNumber: string;
  postCategory?: "normal" | "campaign";
  contentHash?: string;
  postTypeByte?: 0 | 1 | 2;
}): string {
  const chunks = [
    Uint8Array.of(0x00),
    u32Le(0),
    Uint8Array.of(34, 0),
    compactBytes(postId),
    compactBytes(input.cidNumber),
    accountIdBytes,
    Uint8Array.of(input.postTypeByte ?? 0),
    Uint8Array.of(input.postCategory === "normal" ? 0 : 1),
    bytes(input.contentHash ?? contentHash),
    compactBytes(storageReceiptId),
    u64Le(1800000000000),
    u32Le(88),
    compactU32(0),
  ];
  const record = concat(chunks);
  return `0x${hex(concat([compactU32(1), record]))}`;
}

function activeCidRecordHex(cidNumber: string): string {
  return `0x${hex(concat([
    compactBytes(cidNumber),
    accountIdBytes,
    compactBytes(""),
    compactBytes(""),
    Uint8Array.of(0),
    u32Le(1),
    Uint8Array.of(0),
  ]))}`;
}

function activePlatformSubscriptionHex(): string {
  return `0x${hex(concat([
    // SubscriptionPlan::Platform(Democracy)
    Uint8Array.of(0, 1),
    u64Le(1_700_000_000_000),
    u64Le(1_700_000_000_000),
    u128Le(100n),
    u64Le(1_800_000_000_000),
    Uint8Array.of(0),
    u128Le(100n),
    Uint8Array.of(0),
  ]))}`;
}

function u128Le(value: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let current = value;
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function bytes(input: string): Uint8Array {
  const text = input.startsWith("0x") ? input.slice(2) : input;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

class FakeDb {
  uploads = new Map<string, PreparedUploadRow>();
  mediaAssets = new Map<string, MediaAssetRow[]>();
  posts = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }

  async batch(statements: FakeStmt[]) {
    for (const statement of statements) {
      await statement.run();
    }
    return statements.map(() => ({ success: true }));
  }
}

class FakeStmt {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.includes("FROM square_memberships")) {
      return {
        account_id: accountId,
        membership_level: "democracy",
        started_at: Date.now() - 60_000,
        last_charged_at: Date.now() - 60_000,
        last_charged_price_fen: 100,
        paid_until: Date.now() + 60_000,
        subscription_status: "active",
        finalized_block_number: 1,
        finalized_block_hash: `0x${"1".repeat(64)}`,
        verified_at: Date.now(),
        entitlement_lapsed_at: null,
        last_tx_hash: null,
        chain_timestamp: Date.now(),
        chain_observed_at: Date.now(),
      } as T;
    }
    if (this.sql.includes("FROM square_uploads")) {
      const key = this.args[0] as string;
      return (this.db.uploads.get(key) ??
        [...this.db.uploads.values()].find((upload) => upload.upload_id === key) ??
        null) as T | null;
    }
    if (this.sql.includes("FROM square_posts")) {
      return (this.db.posts.get(this.args[0] as string) ?? null) as T | null;
    }
    return null;
  }

  async run() {
    if (this.sql.includes("INSERT OR IGNORE INTO square_posts")) {
      this.db.posts.set(this.args[0] as string, {
        post_id: this.args[0],
        cid_number: this.args[1],
        account_id: this.args[2],
        post_category: this.args[3],
        post_type: this.args[4],
        title: this.args[5],
        excerpt: this.args[6],
        content_hash: this.args[7],
        storage_receipt_id: this.args[8],
        chain_block: this.args[9],
        chain_block_hash: this.args[10],
        tx_hash: this.args[11],
        created_at: this.args[12],
        post_state: "published",
      });
    }
    if (this.sql.includes("DELETE FROM square_posts")) {
      // 硬删除：帖子行整行移除，不保留软删残行。
      this.db.posts.delete(this.args[0] as string);
    }
    if (this.sql.includes("DELETE FROM square_media_assets")) {
      this.db.mediaAssets.set(this.args[0] as string, []);
    }
    if (this.sql.includes("DELETE FROM square_uploads")) {
      // 上传行按 upload_id 删；本假库以 post_id 为键，故按值反查。
      const uploadId = this.args[0] as string;
      for (const [postKey, row] of this.db.uploads) {
        if (row.upload_id === uploadId) {
          this.db.uploads.delete(postKey);
        }
      }
    }
    return { success: true, meta: { changes: 1 } };
  }

  async all<T>() {
    if (this.sql.includes("FROM square_media_assets")) {
      if (this.sql.includes("WHERE post_id IN")) {
        const postIds = new Set(this.args as string[]);
        return {
          results: [...this.db.mediaAssets.values()]
            .flat()
            .filter((asset) => postIds.has(asset.post_id)) as T[],
        };
      }
      return {
        results: (this.db.mediaAssets.get(this.args[0] as string) ?? []) as T[],
      };
    }
    return { results: [] as T[] };
  }
}

class FakeR2 {
  readonly deletedKeys: Array<string | string[]> = [];

  constructor(private readonly objects: Record<string, string>) {}

  async get(key: string) {
    const value = this.objects[key];
    if (!value) return null;
    const bytes = new TextEncoder().encode(value);
    return {
      size: bytes.byteLength,
      body: { cancel: async () => undefined },
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
      text: async () => value,
    };
  }

  async delete(key: string | string[]) {
    this.deletedKeys.push(key);
    for (const item of Array.isArray(key) ? key : [key]) delete this.objects[item];
  }
}
