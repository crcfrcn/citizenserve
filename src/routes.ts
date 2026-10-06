import type { Env, FeedKind } from "./types";
import {
  confirmFinalizedUsersRoute,
  inspectCachedUserProjectionHealth,
} from "./account/user_projection";
import { createMlsChallenge, createSession, registerMlsDevice } from "./auth/service";
import { issueChatServerAccess } from "./auth/chatserver_access";
import { registerPushEndpoint } from "./auth/push_endpoint";
import { chainBootstrapRoute, citizenSdkBootstrapRoute } from "./chain/bootstrap";
import { constitutionRoute } from "./chain/constitution";
import { relaySignedExtrinsicRoute } from "./chain/extrinsic_relay";
import { contactMlsRoute } from "./contacts";
import { feedRoute } from "./feeds/service";
import { followRoute, setFollowNotifyRoute, unfollowRoute } from "./feeds/follows";
import { getNotifyUnreadRoute, markNotifyReadRoute } from "./feeds/notify";
import { mediaRoute } from "./media";
import { platformSubscriptionConfirmRoute } from "./membership/citizen_coin";
import { membershipRoute } from "./membership/service";
import {
  creatorOverviewRoute,
  creatorPlanOfRoute,
  creatorPlanRoute,
  creatorPlanSaveRoute,
  creatorSubscriptionConfirmRoute,
} from "./membership/creator";
import { isTopupPath, routeTopup } from "./topup/routes";
import { confirmPostRoute, deletePostRoute, getPostDetailRoute } from "./posts/confirm";
import { selfPostCopiesRoute } from "./posts/local_copy";
import { prepareProfileAsset, putProfileAsset } from "./profiles/assets";
import {
  getUserFollowsRoute,
  getUserPostsRoute,
  getUserProfileRoute,
  putProfileRoute,
} from "./profiles/service";
import {
  completeUpload,
  abortUpload,
  putManifest,
  prepareUpload,
} from "./uploads/service";
import { HttpError, jsonResponse, optionsResponse } from "./shared/http";
import { guardRequest, normalizeApiPath } from "./security/request_guard";
import { turnstileConfigRoute, turnstilePageRoute } from "./security/turnstile";
import { assertKnownRoute } from "./limits/request";
import {
  citizenchainDownloadRoute,
  citizenchainPublicationRoute,
  isCitizenchainDownloadPath,
  isCitizenchainPublicationPath,
} from "./citizenchain_download";

export async function routeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizeApiPath(url.pathname);
  assertKnownRoute(request.method, path);
  if (request.method === "OPTIONS") {
    return optionsResponse();
  }
  await guardRequest(request, env, path);

  if (request.method === "GET" && path === "/health") {
    const projection = await inspectCachedUserProjectionHealth(env);
    return jsonResponse({
      ok: true,
      service: "citizenapp",
      storage_backend: "d1-r2",
      // 发布器用此不可伪造的运行时绑定确认Version Override和正式切流命中同一候选版本。
      worker_version_id: env.CF_VERSION_METADATA?.id ?? null,
      // 广场正文元数据进入 D1，manifest、图片、视频和衍生图统一进入 R2。
      content_on_chain: false,
      // 发布器据此确认用户投影已追到当前 finalized 头；这里只读现有游标，不迁移数据。
      ...projection,
    });
  }

  if (isCitizenchainPublicationPath(path)) {
    return citizenchainPublicationRoute(request, env, path);
  }

  if (request.method === "GET" && isCitizenchainDownloadPath(path)) {
    return citizenchainDownloadRoute(env, path);
  }

  if (request.method === "GET" && path.startsWith("/download/")) {
    return installerDownloadRoute(path);
  }

  if (request.method === "GET" && path === "/chain/bootstrap") {
    return chainBootstrapRoute(request, env);
  }
  if (request.method === "GET" && path === "/chain/citizensdk/bootstrap") {
    return citizenSdkBootstrapRoute(request, env);
  }
  if (request.method === "GET" && path === "/constitution") {
    return constitutionRoute(request, env);
  }
  if (request.method === "GET" && path === "/security/turnstile") {
    return turnstilePageRoute(env);
  }
  if (request.method === "GET" && path === "/security/config") {
    return turnstileConfigRoute(env);
  }
  if (request.method === "POST" && path === "/chain/extrinsics/relay") {
    return relaySignedExtrinsicRoute(request, env);
  }

  if (request.method === "POST" && path === "/square/auth/challenge") {
    return createMlsChallenge(request, env);
  }
  if (request.method === "POST" && path === "/square/auth/session") {
    return createSession(request, env);
  }
  if (request.method === "POST" && path === "/square/auth/device/register") {
    return registerMlsDevice(request, env);
  }
  if (request.method === "POST" && path === "/auth/chatserver/access") {
    return issueChatServerAccess(request, env);
  }
  if (request.method === "GET" && path === "/square/membership") {
    return membershipRoute(request, env);
  }
  // 平台会员公民币轨：订阅/取消由 App 热钱包 extrinsic 上链，此处只做上链后镜像确认。
  if (request.method === "POST" && path === "/square/membership/confirm") {
    return platformSubscriptionConfirmRoute(request, env);
  }
  if (request.method === "POST" && path === "/square/users/confirm") {
    return confirmFinalizedUsersRoute(request, env);
  }
  // 稳定币充值购买公民币：App(config/submit/status)+授权结算客户端(settlement/*)。
  if (isTopupPath(path)) {
    return routeTopup(request, env, path);
  }
  if (request.method === "GET" && path === "/square/creator/plan") {
    return creatorPlanRoute(request, env);
  }
  if (request.method === "GET" && path === "/square/creator/overview") {
    return creatorOverviewRoute(request, env);
  }
  if (request.method === "POST" && path === "/square/creator/plan") {
    return creatorPlanSaveRoute(request, env);
  }
  if (request.method === "POST" && path === "/square/creator/subscription/confirm") {
    return creatorSubscriptionConfirmRoute(request, env);
  }
  if (request.method === "GET" && path.startsWith("/square/creator/plan/")) {
    return creatorPlanOfRoute(request, env, path.slice("/square/creator/plan/".length));
  }
  if (request.method === "POST" && path === "/square/contacts/mls") {
    return contactMlsRoute(request, env);
  }
  if (request.method === "POST" && path === "/square/uploads/prepare") {
    return prepareUpload(request, env);
  }
  if (request.method === "PUT" && path === "/square/uploads/manifest") {
    return putManifest(request, env);
  }
  if (request.method === "POST" && path === "/square/uploads/complete") {
    return completeUpload(request, env);
  }
  if (request.method === "DELETE" && path.startsWith("/square/uploads/")) {
    return abortUpload(request, env, path.slice("/square/uploads/".length));
  }
  if (request.method === "POST" && path === "/square/posts/confirm") {
    return confirmPostRoute(request, env);
  }
  if (request.method === "GET" && path === "/square/posts/self") {
    return selfPostCopiesRoute(request, env);
  }
  if (request.method === "GET" && path.startsWith("/square/posts/")) {
    return getPostDetailRoute(request, env, path.slice("/square/posts/".length));
  }
  if (request.method === "DELETE" && path.startsWith("/square/posts/")) {
    return deletePostRoute(request, env, path.slice("/square/posts/".length));
  }
  if (request.method === "GET" && path.startsWith("/square/media/")) {
    return mediaRoute(request, env, path);
  }
  if (request.method === "GET" && path.startsWith("/square/feed/")) {
    return feedRoute(request, env, parseFeedKind(path));
  }
  if (request.method === "PUT" && path === "/square/profile") {
    return putProfileRoute(request, env);
  }
  if (request.method === "POST" && path === "/square/profile/assets/prepare") {
    return prepareProfileAsset(request, env);
  }
  if (request.method === "PUT" && path === "/square/profile/assets") {
    return putProfileAsset(request, env);
  }
  if (request.method === "GET" && path.startsWith("/square/users/")) {
    return routeUserPath(request, env, path);
  }
  if (request.method === "POST" && path === "/square/follows") {
    return followRoute(request, env);
  }
  if (
    request.method === "PUT" &&
    path.startsWith("/square/follows/") &&
    path.endsWith("/notify")
  ) {
    return setFollowNotifyRoute(request, env);
  }
  if (request.method === "DELETE" && path.startsWith("/square/follows/")) {
    return unfollowRoute(request, env);
  }
  if (request.method === "GET" && path === "/square/notify/unread") {
    return getNotifyUnreadRoute(request, env);
  }
  if (request.method === "POST" && path === "/square/notify/read") {
    return markNotifyReadRoute(request, env);
  }
  if (request.method === "PUT" && path === "/square/push-endpoint") {
    return registerPushEndpoint(request, env);
  }
  throw new HttpError(404, "route_not_found", "广场接口不存在");
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

interface InstallerDownloadTarget {
  releaseTag?: string;
  releaseTagPrefix?: string;
  assetName?: string;
  assetNamePattern?: RegExp;
}

const INSTALLER_DOWNLOAD_TARGETS: Readonly<Record<string, InstallerDownloadTarget>> = {
  "/download/citizenapp/android": {
    releaseTagPrefix: "citizenapp-release-android-v",
    assetName: "citizenapp.apk",
  },
  "/download/citizenwallet/android": {
    releaseTagPrefix: "citizenwallet-release-android-v",
    assetName: "citizenwallet.apk",
  },
};

/**
 * 官网下载只解析固定的正式安装包，然后跳转 GitHub 不可变 Release 资产。
 * 安装包正文不得经 Worker 代理，避免大文件重复下载放大请求与 CPU 费用。
 */
async function installerDownloadRoute(path: string): Promise<Response> {
  const target = INSTALLER_DOWNLOAD_TARGETS[path];
  if (!target) {
    throw new HttpError(404, "download_not_found", "下载项不存在");
  }
  // 公开下载只查询固定路由对应的准确产品仓，禁止继续查询旧聚合仓。
  const product = path === "/download/citizenapp/android" ? "citizenapp" : "citizenwallet";
  const releasesResponse = await fetch(
    "https://api.github.com/repos/crcfrcn/" + product + "/releases?per_page=100",
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "CitizenApp-Download-Proxy",
      },
      cf: { cacheEverything: true, cacheTtl: 300 },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!releasesResponse.ok) {
    throw new HttpError(502, "release_lookup_failed", "正式版信息读取失败");
  }
  const releases = await releasesResponse.json() as GitHubRelease[];
  const matchingReleases = releases.filter((item) =>
    !item.draft &&
    !item.prerelease &&
    (target.releaseTag
      ? item.tag_name === target.releaseTag
      : item.tag_name.startsWith(target.releaseTagPrefix ?? ""))
  );
  const release = matchingReleases.sort((left, right) =>
    compareSemanticVersions(right.tag_name, left.tag_name)
  )[0];
  const matchingAssets = release?.assets.filter((item) =>
    target.assetName
      ? item.name === target.assetName
      : target.assetNamePattern?.test(item.name)
  ) ?? [];
  const asset = matchingAssets.sort((left, right) =>
    compareSemanticVersions(right.name, left.name)
  )[0];
  if (!asset) {
    throw new HttpError(404, "release_asset_not_found", "正式安装包尚未发布");
  }
  const assetUrl = new URL(asset.browser_download_url);
  if (assetUrl.protocol !== "https:" || assetUrl.hostname !== "github.com") {
    throw new HttpError(502, "release_download_url_invalid", "正式安装包下载地址不合法");
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: assetUrl.toString(),
      "cache-control": "public, max-age=300",
    },
  });
}

function compareSemanticVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = value.match(/(?:^|[-v])(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < leftVersion.length; index += 1) {
    const difference = leftVersion[index] - rightVersion[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function routeUserPath(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const rest = path.slice("/square/users/".length);
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  // 路由末段就是目标身份主键 cid_number；社交关系与主页内容不按钱包账户寻址。
  const cidNumber = segments[0] ?? "";
  if (segments.length === 1) {
    return getUserProfileRoute(request, env, cidNumber);
  }
  if (segments.length === 2 && segments[1] === "posts") {
    return getUserPostsRoute(request, env, cidNumber);
  }
  if (segments.length === 2 && segments[1] === "follows") {
    return getUserFollowsRoute(request, env, cidNumber);
  }
  throw new HttpError(404, "route_not_found", "广场接口不存在");
}

function parseFeedKind(path: string): FeedKind {
  const feedKind = path.split("/").pop();
  if (
    feedKind === "recommended" ||
    feedKind === "following" ||
    feedKind === "campaign"
  ) {
    return feedKind;
  }
  throw new HttpError(404, "feed_not_found", "广场信息流不存在");
}
