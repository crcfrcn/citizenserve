import type { Env, SessionState } from '../types';
import { consumeMlsAuthentication } from '../auth/mls_authentication';
import { readUserByCidNumber } from '../account/user_repository';
import { HttpError, requireSession } from '../shared/http';
import { sha256Hex } from '../shared/hash';
import { nowMs } from '../shared/time';
import { assertRequestBodyLimit } from '../limits/request';

const DEFAULT_WEB_ORIGIN = 'https://www.crcfrcn.com';

interface RateWindowRow {
  request_count: number;
  expires_at: number;
}

/** `/api` 是唯一生产部署前缀，内部业务路由使用无版本路径。 */
export function normalizeApiPath(pathname: string): string {
  const prefix = '/api';
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

/** 浏览器只允许官网同源；原生 App 没有 Origin，后续由设备证明校验。 */
export function assertAllowedOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  if (!allowedOrigins(env).has(origin)) {
    throw new HttpError(403, 'origin_forbidden', '请求来源不受信任');
  }
}

export function applyCors(request: Request, env: Env, response: Response): Response {
  const origin = request.headers.get('origin');
  if (!origin) return response;
  // 被 guard 拒绝的来源仍需返回原始 403，不能在错误响应阶段再次抛异常变成 500。
  if (!allowedOrigins(env).has(origin)) return response;
  const next = new Response(response.body, response);
  next.headers.set('access-control-allow-origin', origin);
  next.headers.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  next.headers.set(
    'access-control-allow-headers',
    'authorization,content-type,x-mls-proof'
  );
  next.headers.set('access-control-max-age', '600');
  next.headers.append('vary', 'origin');
  return next;
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

/**
 * 统一入口风控：预登录按 IP 粗限流，登录后按CID精确限流；写接口和计费型读取
 * 必须提供 MLS 设备证明；R2 直传地址由受保护的 prepare 接口限时签发。
 */
export async function guardRequest(request: Request, env: Env, path: string): Promise<void> {
  if (new URL(request.url).protocol !== 'https:') throw new HttpError(400, 'https_required', '服务请求必须使用HTTPS');
  assertAllowedOrigin(request, env);
  assertRequestBodyLimit(request, path);

  // 鉴权建立/自证路由(挑战、会话):由 当前CID投影、MLS持钥证明与一次性挑战门控,不依赖广场会话。
  // 一次冷启动握手 = challenge + session 两请求;客户端已 in-flight 去重,同账户并发只跑一套。
  if (
    path === '/square/auth/challenge' ||
    path === '/square/auth/session'
  ) {
    const ipKey = await requestIpKey(request, env);
    await enforceEdgeRate(env, 'RATE_AUTH', `auth:${ipKey}`);
    return;
  }
  // MLS身份登记是每CID设备的稀有操作,独立限流桶,避免与频繁的握手互相挤占配额。
  if (path === '/square/auth/device/register') {
    const ipKey = await requestIpKey(request, env);
    await enforceEdgeRate(env, 'RATE_AUTH', `authreg:${ipKey}`);
    return;
  }
  // 公开只读/自证路由白名单(免会话)。/security/* 在登录前渲染,必须免会话。
  if (
    path === '/health' ||
    path === '/chain/bootstrap' ||
    path === '/chain/citizensdk/bootstrap' ||
    path.startsWith('/security/')
  ) {
    // 这些简单公开路由不读 D1/R2 或外部服务；媒体由独立 R2 域直接交付。
    return;
  }
  // 安装包解析会访问 GitHub，宪法读取会访问链 RPC；先用原生限流
  // 阻断单源放大外部请求。媒体仍由独立 R2 域直接交付。
  if (path.startsWith('/download/') || path === '/constitution') {
    const ipKey = await requestIpKey(request, env);
    await enforceEdgeRate(env, 'RATE_READ', `public:${path}:${ipKey}`);
    return;
  }
  // 广播模块保留跨 PoP 精确硬顶；原生限流先拦住攻击流量，避免其每次读 D1。
  if (path === '/chain/extrinsics/relay') {
    const ipKey = await requestIpKey(request, env);
    await enforceEdgeRate(env, 'RATE_WRITE', `relay:${ipKey}`);
    return;
  }
  // finalized 用户确认只接收区块哈希，账户/CID/状态全部从 canonical 事件与 storage 读取。
  // 新注册用户尚无 Session，因此按 IP 限流后放行；handler 不接受客户端自报身份事实。
  if (path === '/square/users/confirm') {
    const ipKey = await requestIpKey(request, env);
    await enforceEdgeRate(env, 'RATE_WRITE', `user_projection:${ipKey}`);
    return;
  }
  // 结算子接口只给授权结算客户端调用，handler内用SETTLE_TOKEN鉴权，
  // 不套IP限流（避免批量补发被节流）。
  if (path.startsWith('/square/topup/settlement/')) return;
  // 公民链官网下载指针只接受handler内的产品发布HMAC，不得回落到普通用户Session。
  if (path.startsWith('/operations/citizenchain/download-publications/')) return;
  // 充值整片免广场会话:充值是"付款人自掏稳定币给某个公民链账户打公民币",收款方无需
  // 证明账户所有权(同转账),冷钱包本机也没有私钥可签。绑定会话既挡不住抢单(见 orders.ts
  // 时间序防护),又会把冷钱包和代充一起挡死,故整体解除。写接口各自凭 HMAC 付款意图自证,
  // 并在 handler 内按 account_id 再限流一层;这里只做 IP 维度的量控。
  if (path.startsWith('/square/topup/')) {
    const ipKey = await requestIpKey(request, env);
    await enforceEdgeRate(
      env,
      request.method === 'GET' ? 'RATE_READ' : 'RATE_WRITE',
      `topup:${ipKey}`,
    );
    return;
  }
  // 默认拒绝:走到这里都是非公开路由,一律强制有效会话(缺 Bearer / 校验失败 → 401)。
  // 不再"无会话即放行、把鉴权全交给各 handler 自觉"——新增受保护路由默认即受保护,
  // 某 handler 漏调 requireSession 也不会退化成公开接口。
  const session = await requireSession(request, env);
  // D1 用户投影复查：会话三元组必须仍是当前 finalized 绑定。换绑投影落库后旧会话立即拒绝，
  // 普通请求不再读取链；身份是 cid_number，凭证是当前绑定钱包账户。
  const identity = await readUserByCidNumber(env, session.cid_number);
  if (
    !identity
    || identity.cid_number !== session.cid_number
    || identity.binding_revision !== session.binding_revision
    || identity.account_id !== session.account_id
  ) {
    throw new HttpError(401, 'cid_binding_changed', '钱包账户绑定已变更,请重新登录');
  }
  const rate = routeRate(path, request.method);
  await enforceEdgeRate(
    env,
    rate.binding,
    `cid_number:${session.cid_number}:${rate.key}`,
  );

  if (requiresDeviceProof(path, request.method)) {
    await consumeMlsAuthentication(request, env, 'request', session);
  }
  // 上传每小时硬顶必须跨 PoP 精确一致；MLS认证通过后才计入上传硬顶，非法签名不能消耗上传配额。
  if (path === '/square/uploads/prepare') {
    await enforcePersistentRateLimit(
      env,
      `upload:cid_number:${session.cid_number}`,
      30,
      3600,
    );
  }
}

function requiresDeviceProof(path: string, method: string): boolean {
  if (path.startsWith('/square/auth/')) return false;
  // 这些回执对应的链上业务已经由账户签名并 finalized；再次要求设备签名会让同一业务
  // 产生第二次签名。handler 仍强制校验 Bearer 会话、交易哈希和 finalized 链状态。
  if (
    method === 'POST' &&
    (path === '/square/membership/confirm' ||
      path === '/square/creator/subscription/confirm' ||
      path === '/square/creator/plan')
  ) {
    return false;
  }
  // Image.network 只能稳定携带 Bearer header；资料媒体仍由 handler 强制校验钱包
  // session，但不要求它动态生成 MLS 请求签名。
  if (path.startsWith('/square/media/')) return false;
  if (path === '/chain/extrinsics/relay') return true;
  return path.startsWith('/square/') && method !== 'OPTIONS';
}

type RateBinding = 'RATE_AUTH' | 'RATE_WRITE' | 'RATE_READ';

function routeRate(path: string, method: string): { binding: RateBinding; key: string } {
  if (path === '/square/contacts' && method === 'GET') {
    return { binding: 'RATE_READ', key: 'contacts_read' };
  }
  if (path.startsWith('/square/contacts/')) {
    return { binding: 'RATE_WRITE', key: 'contacts_write' };
  }
  if (method === 'GET') return { binding: 'RATE_READ', key: 'read' };
  return { binding: 'RATE_WRITE', key: 'write' };
}

export async function requestIpKey(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const secret = env.HASH_KEY?.trim();
  if (!secret) {
    throw new HttpError(503, 'hash_key_not_configured', '请求哈希密钥未配置');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** 边缘原生限流不写 D1；计数按 Cloudflare location 最终一致，适合请求量控。 */
export async function enforceEdgeRate(
  env: Env,
  binding: RateBinding,
  rateKey: string,
): Promise<void> {
  const limiter = env[binding];
  if (!limiter) {
    throw new HttpError(503, 'rate_limit_not_configured', '请求限流未配置');
  }
  const outcome = await limiter.limit({ key: rateKey });
  if (!outcome.success) {
    throw new HttpError(429, 'request_rate_exceeded', '请求过于频繁，请稍后再试');
  }
}

/** 仅供必须跨 PoP 精确一致的少量硬顶；到顶后的拒绝请求只读不写 D1。 */
export async function enforcePersistentRateLimit(
  env: Env,
  rateKey: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  const now = nowMs();
  const expiresAt = now + windowSeconds * 1000;
  const row = await env.DB.prepare(
    `INSERT INTO rate_windows (rate_key, request_count, expires_at)
      VALUES (?, 1, ?)
      ON CONFLICT(rate_key) DO UPDATE SET
        request_count = CASE WHEN rate_windows.expires_at <= ? THEN 1
          ELSE rate_windows.request_count + 1 END,
        expires_at = CASE WHEN rate_windows.expires_at <= ? THEN excluded.expires_at
          ELSE rate_windows.expires_at END
      WHERE rate_windows.expires_at <= ?
        OR rate_windows.request_count < ?
      RETURNING request_count, expires_at`
  ).bind(rateKey, expiresAt, now, now, now, limit).first<RateWindowRow>();
  // 窗口已到上限时 WHERE 不执行 UPDATE，之后的每个拒绝请求只读不写 D1。
  if (!row) {
    throw new HttpError(429, 'request_rate_exceeded', '请求过于频繁，请稍后再试');
  }
}

export async function cleanupSecurityState(env: Env): Promise<void> {
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mls_authentication_challenges WHERE expires_at_millis <= ?').bind(now),
    env.DB.prepare('DELETE FROM rate_windows WHERE expires_at <= ?').bind(now)
  ]);
}
