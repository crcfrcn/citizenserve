import type { Env } from '../types';
import { HttpError } from '../shared/http';
import { topupConfigRoute, topupConfirmRoute, topupIntentRoute, topupStatusRoute } from './orders';
import {
  topupClaimRoute,
  topupExceptionRoute,
  topupHistoryRoute,
  topupPendingRoute,
  topupSettledRoute,
} from './settlement';

/// 稳定币充值(topup)子路由分派。挂在 `/square/topup/` 前缀下。
/// App 端:config(公开只读) / intent(公开,充值目标由请求指定) / confirm / status
/// (后两者凭 Worker 签发的 HMAC 付款意图自证,不需要账户会话)。
/// 授权结算客户端：settlement/*（SETTLE_TOKEN鉴权）。
const SETTLEMENT_PREFIX = '/square/topup/settlement/';

export function isTopupPath(path: string): boolean {
  return path === '/square/topup/config' || path.startsWith('/square/topup/');
}

export async function routeTopup(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'GET' && path === '/square/topup/config') {
    return topupConfigRoute(request, env);
  }
  if (request.method === 'POST' && path === '/square/topup/intent') {
    return topupIntentRoute(request, env);
  }
  if (request.method === 'POST' && path === '/square/topup/confirm') {
    return topupConfirmRoute(request, env);
  }
  if (request.method === 'POST' && path === '/square/topup/status') {
    return topupStatusRoute(request, env);
  }
  if (request.method === 'GET' && path === '/square/topup/settlement/pending') {
    return topupPendingRoute(request, env);
  }
  if (request.method === 'GET' && path === '/square/topup/settlement/history') {
    return topupHistoryRoute(request, env);
  }
  if (request.method === 'POST' && path.startsWith(SETTLEMENT_PREFIX) && path.endsWith('/claim')) {
    const orderId = path.slice(SETTLEMENT_PREFIX.length, -'/claim'.length);
    return topupClaimRoute(request, env, orderId);
  }
  if (request.method === 'POST' && path.startsWith(SETTLEMENT_PREFIX) && path.endsWith('/settled')) {
    const orderId = path.slice(SETTLEMENT_PREFIX.length, -'/settled'.length);
    return topupSettledRoute(request, env, orderId);
  }
  if (request.method === 'POST' && path.startsWith(SETTLEMENT_PREFIX) && path.endsWith('/exception')) {
    const orderId = path.slice(SETTLEMENT_PREFIX.length, -'/exception'.length);
    return topupExceptionRoute(request, env, orderId);
  }
  throw new HttpError(404, 'route_not_found', '充值接口不存在');
}
