import type { Env } from "../types";
import { HttpError } from "../shared/http";
import { resourceLimit } from "../limits/catalog";

const systemEventsStorageKey =
  "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";

/// 单次链 RPC 请求超时；Worker 不在请求内自动重试，避免重复广播已签名交易。
const CHAIN_RPC_TIMEOUT_MS = 3000;
/// System.Events 可能较大，但必须给 Worker 内存设置硬边界。
const CHAIN_RPC_MAX_RESPONSE_BYTES =
  resourceLimit("chain_rpc_response").max_bytes;

type ChainRpcMethod =
  | "chain_getFinalizedHead"
  | "chain_getHeader"
  | "chain_getBlock"
  | "chain_getBlockHash"
  | "state_getStorage"
  | "author_submitExtrinsic";
type JsonRpcId = number | string;

interface ChainRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: ChainRpcMethod;
  params: unknown[];
}

interface ChainRpcConfig {
  url: string;
  accessClientId: string;
  accessClientSecret: string;
}

export async function fetchSystemEventsAtBlock(
  env: Env,
  blockHashHex: string,
): Promise<string> {
  const result = await fetchChainStorage(
    env,
    systemEventsStorageKey,
    blockHashHex,
  );
  if (!result) {
    throw new HttpError(
      404,
      "chain_events_not_found",
      "指定区块没有 System.Events",
    );
  }
  return result;
}

export async function fetchChainStorage(
  env: Env,
  storageKeyHex: string,
  blockHashHex?: string,
): Promise<string | null> {
  const params = blockHashHex ? [storageKeyHex, blockHashHex] : [storageKeyHex];
  const result = await callChainRpc(env, "state_getStorage", params, 1);
  if (result !== null && typeof result !== "string") {
    throw new HttpError(
      502,
      "chain_rpc_invalid_response",
      "链服务节点返回了无效存储数据",
    );
  }
  return result;
}

/** 同一 finalized 区块的 storage 点读合并为一个标准 JSON-RPC batch，避免事件数放大 fetch。 */
export async function fetchChainStorageBatch(
  env: Env,
  requests: ReadonlyArray<{ storageKeyHex: string; blockHashHex?: string }>,
): Promise<Array<string | null>> {
  if (requests.length === 0) return [];
  const payload: ChainRpcRequest[] = requests.map((request, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "state_getStorage",
    params: request.blockHashHex
      ? [request.storageKeyHex, request.blockHashHex]
      : [request.storageKeyHex],
  }));
  const response = await requestChainRpc(env, payload);
  if (!Array.isArray(response) || response.length !== payload.length) {
    throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点返回了无效 JSON-RPC batch");
  }
  const byId = new Map<JsonRpcId, Record<string, unknown>>();
  for (const item of response) {
    if (!isRecord(item) || item.jsonrpc !== "2.0" ||
        (typeof item.id !== "number" && typeof item.id !== "string") || byId.has(item.id)) {
      throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点返回了无效 JSON-RPC batch");
    }
    byId.set(item.id, item);
  }
  return payload.map((request) => {
    const item = byId.get(request.id);
    if (!item) {
      throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点响应缺少 batch result");
    }
    const value = rpcResult(item, request.id);
    if (value !== null && typeof value !== "string") {
      throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点返回了无效存储数据");
    }
    return value;
  });
}

export interface ChainBlockHeader {
  number: string;
}

export interface ChainSignedBlock {
  block: {
    header: ChainBlockHeader;
    extrinsics: string[];
  };
}

/** 读取并校验最终区块头；所有订阅镜像都从这里取得唯一 finalized 锚点。 */
export async function fetchFinalizedHead(env: Env): Promise<string> {
  const finalizedHead = await callChainRpc(
    env,
    "chain_getFinalizedHead",
    [],
    1,
  );
  if (
    typeof finalizedHead !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(finalizedHead)
  ) {
    throw new HttpError(
      502,
      "chain_rpc_invalid_response",
      "链服务节点未返回有效最终区块",
    );
  }
  return finalizedHead.toLowerCase();
}

/** 读取指定区块头；调用方必须另行校验它属于 finalized 主链。 */
export async function fetchBlockHeader(
  env: Env,
  blockHashHex: string,
): Promise<ChainBlockHeader> {
  const result = await callChainRpc(env, "chain_getHeader", [blockHashHex], 1);
  if (!isRecord(result) || typeof result.number !== "string") {
    throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点返回了无效区块头");
  }
  return { number: result.number };
}

/** 读取指定区块本体；只保留订阅证明需要的头和 extrinsic 列表。 */
export async function fetchSignedBlock(
  env: Env,
  blockHashHex: string,
): Promise<ChainSignedBlock> {
  const result = await callChainRpc(env, "chain_getBlock", [blockHashHex], 1);
  if (!isRecord(result) || !isRecord(result.block)) {
    throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点返回了无效区块");
  }
  const header = result.block.header;
  const extrinsics = result.block.extrinsics;
  if (
    !isRecord(header) ||
    typeof header.number !== "string" ||
    !Array.isArray(extrinsics) ||
    extrinsics.some((value) => typeof value !== "string")
  ) {
    throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点返回了无效区块内容");
  }
  return {
    block: {
      header: { number: header.number },
      extrinsics: extrinsics as string[],
    },
  };
}

/** 按高度读取主链区块哈希，用于排除同高度的非 canonical 分叉块。 */
export async function fetchCanonicalBlockHash(
  env: Env,
  blockNumber: number,
): Promise<string> {
  const result = await callChainRpc(env, "chain_getBlockHash", [blockNumber], 1);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new HttpError(502, "chain_rpc_invalid_response", "链服务节点未返回主链区块哈希");
  }
  return result.toLowerCase();
}

/// 在 finalized 头读取 storage。订阅、余额和权限等业务真态不得读取 best 头，
/// 否则短暂分叉可能把尚未最终确定的状态写入 D1 或用于放行权限。
export async function fetchFinalizedChainStorage(
  env: Env,
  storageKeyHex: string,
): Promise<string | null> {
  const finalizedHead = await fetchFinalizedHead(env);
  return fetchChainStorage(env, storageKeyHex, finalizedHead);
}

/// 内部链 RPC 只允许代码声明的固定方法，不接受 App 传入 method 或 RPC URL。
export async function callChainRpc(
  env: Env,
  method: ChainRpcMethod,
  params: unknown[],
  requestId: JsonRpcId,
): Promise<unknown> {
  const payload: ChainRpcRequest = {
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  };
  return rpcResult(await requestChainRpc(env, payload), requestId);
}

async function requestChainRpc(
  env: Env,
  requestBody: ChainRpcRequest | ChainRpcRequest[],
): Promise<unknown> {
  const config = requireChainRpcConfig(env);
  const timeoutSignal = AbortSignal.timeout(CHAIN_RPC_TIMEOUT_MS);
  const body = JSON.stringify(requestBody);
  if (new TextEncoder().encode(body).byteLength > CHAIN_RPC_MAX_RESPONSE_BYTES) {
    throw new HttpError(502, "chain_rpc_request_too_large", "链服务节点请求超过大小限制");
  }
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "CF-Access-Client-Id": config.accessClientId,
        "CF-Access-Client-Secret": config.accessClientSecret,
      },
      body,
      // workerd 只支持 manual/follow；manual 可阻止 Access 服务令牌被带到其他主机。
      redirect: "manual",
      signal: timeoutSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted || isTimeoutError(error)) {
      throw new HttpError(504, "chain_rpc_timeout", "链服务节点请求超时");
    }
    throw new HttpError(
      502,
      "chain_rpc_transport_failed",
      "无法连接链服务节点",
    );
  }

  if (!response.ok) {
    throw new HttpError(
      502,
      "chain_rpc_http_failed",
      "链服务节点 HTTP 请求失败",
    );
  }

  let responsePayload: unknown;
  try {
    responsePayload = await readBoundedJson(response);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (timeoutSignal.aborted || isTimeoutError(error)) {
      throw new HttpError(504, "chain_rpc_timeout", "链服务节点请求超时");
    }
    throw new HttpError(
      502,
      "chain_rpc_transport_failed",
      "读取链服务节点响应失败",
    );
  }
  return responsePayload;
}

function rpcResult(payload: unknown, requestId: JsonRpcId): unknown {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id !== requestId) {
    throw new HttpError(
      502,
      "chain_rpc_invalid_response",
      "链服务节点返回了无效 JSON-RPC 响应",
    );
  }
  if (payload.error !== undefined && payload.error !== null) {
    const message = rpcErrorMessage(payload.error);
    throw new HttpError(502, "chain_rpc_rejected", message);
  }
  if (!Object.hasOwn(payload, "result")) {
    throw new HttpError(
      502,
      "chain_rpc_invalid_response",
      "链服务节点响应缺少 result",
    );
  }
  return payload.result;
}

/// bootstrap 只据此判断 relay 是否可用，不暴露具体缺失项或 Secret 内容。
export function isChainRpcConfigured(env: Env): boolean {
  try {
    requireChainRpcConfig(env);
    return true;
  } catch {
    return false;
  }
}

function requireChainRpcConfig(env: Env): ChainRpcConfig {
  const rawUrl = env.CHAIN_URL?.trim();
  if (!rawUrl) {
    throw new HttpError(
      503,
      "chain_rpc_not_configured",
      "链服务节点 RPC 未配置",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new HttpError(
      503,
      "chain_rpc_invalid_config",
      "链服务节点 RPC 配置无效",
    );
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new HttpError(
      503,
      "chain_rpc_invalid_config",
      "链服务节点 RPC 必须使用受保护的 HTTPS 地址",
    );
  }

  const accessClientId = env.CHAIN_ID?.trim();
  const accessClientSecret = env.CHAIN_SECRET?.trim();
  if (!accessClientId || !accessClientSecret) {
    throw new HttpError(
      503,
      "chain_rpc_access_not_configured",
      "链服务节点 Access 服务令牌未配置",
    );
  }

  return {
    url: parsedUrl.toString(),
    accessClientId,
    accessClientSecret,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (
      Number.isFinite(parsedLength) &&
      parsedLength > CHAIN_RPC_MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new HttpError(
        502,
        "chain_rpc_response_too_large",
        "链服务节点响应超过大小限制",
      );
    }
  }

  if (!response.body) {
    throw new HttpError(
      502,
      "chain_rpc_invalid_response",
      "链服务节点返回了空响应",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > CHAIN_RPC_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new HttpError(
          502,
          "chain_rpc_response_too_large",
          "链服务节点响应超过大小限制",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new HttpError(
      502,
      "chain_rpc_invalid_response",
      "链服务节点返回了无效 JSON",
    );
  }
}

function rpcErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") {
    const message = value.message.trim().slice(0, 512);
    if (message) {
      return message;
    }
  }
  return "链服务节点拒绝了 JSON-RPC 请求";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}
