import type { Env, LoginChallengeRow, SessionState } from '../types';
import { HttpError, jsonResponse, parsePositiveInt, readJson } from '../shared/http';
import { assertAccountId, createId } from '../shared/ids';
import { nowMs, secondsFromNow } from '../shared/time';
import { putKvJson } from '../limits/storage';
import { sha256Hex } from '../shared/hash';
import { verifyTurnstile } from '../security/turnstile';
import { verifyWalletSignature } from './wallet_signature';
import {
  clearStaleIdentitySessions,
  indexIdentitySession,
  rollbackIdentitySession,
  sessionCacheKey
} from './session_index';
import { readUserByAccountId, readUserByCidNumber } from '../account/user_repository';
import { inspectUserProjectionHealth } from '../account/user_projection';
import {
  assertP256PublicKeyHex,
  buildDeviceBindingSigningMessage,
  DEVICE_SKEW_MS,
  normalizeP256SignatureHex,
  verifyP256Signature
} from './device_subkey';
import {
  OP_SIGN_SQUARE_LOGIN,
  bytesToHex,
  concatBytes,
  hexToBytes,
  scaleString,
  signingMessage,
  u64Le
} from '../shared/signing_message';

interface ChallengeRequest {
  account_id?: unknown;
}

interface SessionRequest {
  challenge_id?: unknown;
  account_id?: unknown;
  signature?: unknown;
}

interface DeviceRegisterRequest {
  account_id?: unknown;
  p256_public_key?: unknown;
  issued_at?: unknown;
  binding_signature?: unknown;
  turnstile_token?: unknown;
}

/// 登录挑战的 SCALE payload：
/// `cid_number ‖ binding_revision ‖ account_id ‖ challenge_id ‖ expires_at`。
/// 被签消息 = signing_message(OP_SIGN_SQUARE_LOGIN, payload)，由客户端重算摘要后
/// 用 P-256 设备子钥签名。worker 单侧编码 payload，客户端只 hash+sign，杜绝字段漂移。
function buildLoginScalePayload(
  cidNumber: string,
  bindingRevision: number,
  accountId: string,
  challengeId: string,
  expiresAt: number
): Uint8Array {
  return concatBytes(
    scaleString(cidNumber),
    u64Le(bindingRevision),
    scaleString(accountId),
    scaleString(challengeId),
    u64Le(expiresAt)
  );
}

export async function createLoginChallenge(request: Request, env: Env): Promise<Response> {
  const body = await readJson<ChallengeRequest>(request);
  let accountId: string;
  try {
    accountId = assertAccountId(body.account_id);
  } catch {
    throw new HttpError(400, 'invalid_account_id', '账户标识格式不合法');
  }
  // 登录是普通鉴权，只读取 finalized 用户 D1 投影；未投影账户不能产生无归属挑战。
  const identity = await readUserByAccountId(env, accountId);
  if (!identity) {
    return throwMissingIdentity(env, '该钱包账户未绑定 CID,无法登录');
  }
  const cidNumber = identity.cid_number;

  const challengeId = createId('sqc');
  const expiresAt = secondsFromNow(300);
  const signingPayloadHex = bytesToHex(buildLoginScalePayload(
    cidNumber,
    identity.binding_revision,
    accountId,
    challengeId,
    expiresAt,
  ));

  await env.DB.prepare(
    `INSERT INTO square_login_challenges
      (challenge_id, cid_number, binding_revision, account_id, signing_payload, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`
  )
    .bind(
      challengeId,
      cidNumber,
      identity.binding_revision,
      accountId,
      signingPayloadHex,
      expiresAt,
    )
    .run();

  return jsonResponse({
    ok: true,
    challenge_id: challengeId,
    cid_number: cidNumber,
    binding_revision: identity.binding_revision,
    account_id: accountId,
    op_tag: OP_SIGN_SQUARE_LOGIN,
    signing_payload_hex: signingPayloadHex,
    expires_at: expiresAt
  });
}

export async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<SessionRequest>(request);
  if (
    typeof body.challenge_id !== 'string'
    || !body.challenge_id.startsWith('sqc_')
    || typeof body.signature !== 'string'
  ) {
    throw new HttpError(400, 'invalid_session_request', '登录请求缺少挑战或签名');
  }

  let accountId: string;
  try {
    accountId = assertAccountId(body.account_id);
  } catch {
    throw new HttpError(400, 'invalid_account_id', '账户标识格式不合法');
  }

  const challenge = await env.DB.prepare(
    `SELECT challenge_id, cid_number, binding_revision, account_id, signing_payload, expires_at, used_at
      FROM square_login_challenges
      WHERE challenge_id = ?`
  )
    .bind(body.challenge_id)
    .first<LoginChallengeRow>();

  if (!challenge || challenge.account_id !== accountId) {
    throw new HttpError(401, 'invalid_challenge', '钱包登录挑战不存在');
  }
  if (challenge.used_at !== null) {
    throw new HttpError(401, 'used_challenge', '钱包登录挑战已使用');
  }
  if (challenge.expires_at <= nowMs()) {
    throw new HttpError(401, 'expired_challenge', '钱包登录挑战已过期');
  }

  // Session 签发再次读取强一致 D1 用户投影；挑战后投影发生换绑时必须拒绝。
  const identity = await readUserByCidNumber(env, challenge.cid_number);
  if (!identity) {
    return throwMissingIdentity(env, '该钱包账户未绑定 CID,无法登录');
  }
  const cidNumber = identity.cid_number;
  if (
    identity.account_id !== accountId
    || challenge.binding_revision !== identity.binding_revision
  ) {
    throw new HttpError(401, 'cid_binding_changed', 'CID 当前绑定账户已变更，请重新登录');
  }

  // 后台握手用 P-256 设备子钥（硬件、静默）验签 signing_message(OP_SIGN_SQUARE_LOGIN)。
  // 子钥挂在当前 (cid_number, binding_revision, account_id) 下（同一身份可多设备）；
  // 换绑后的旧 revision 子钥即使仍残留，也不得参与登录验签。
  const subkeys = await env.DB.prepare(
    `SELECT p256_public_key
      FROM square_device_subkeys
      WHERE cid_number = ? AND binding_revision = ? AND account_id = ?`
  )
    .bind(cidNumber, identity.binding_revision, accountId)
    .all<{ p256_public_key: string }>();
  if (!subkeys.results || subkeys.results.length === 0) {
    throw new HttpError(401, 'device_not_registered', '设备子钥未注册，请先注册设备子钥');
  }
  const loginMessage = signingMessage(
    OP_SIGN_SQUARE_LOGIN,
    hexToBytes(challenge.signing_payload)
  );
  // 跨端签名文本须为 `0x`+128hex（ADR-041）；规范化为裸后交内部裸函数验签，
  // 裸/大写/错长与验签失败一律按既有 401 语义处理（不泄漏格式细节）。
  const signatureBare = normalizeP256SignatureHex(body.signature);
  let matchedP256: string | null = null;
  if (signatureBare !== null) {
    for (const row of subkeys.results) {
      if (await verifyP256Signature(loginMessage, signatureBare, row.p256_public_key)) {
        matchedP256 = row.p256_public_key;
        break;
      }
    }
  }
  if (!matchedP256) {
    throw new HttpError(401, 'invalid_signature', '设备子钥签名校验失败');
  }

  // 中文注释：签名通过后用条件 UPDATE 原子占用挑战。并发请求即使都在上方读到
  // used_at=NULL，也只有一个能把 changes 改成 1；挑战一经占用便不释放。
  const claimedAt = nowMs();
  const claimed = await env.DB.prepare(
    `UPDATE square_login_challenges
      SET used_at = ?
      WHERE challenge_id = ?
        AND cid_number = ?
        AND binding_revision = ?
        AND account_id = ?
        AND used_at IS NULL
        AND expires_at > ?`
  )
    .bind(
      claimedAt,
      challenge.challenge_id,
      cidNumber,
      identity.binding_revision,
      accountId,
      claimedAt,
    )
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    if (challenge.expires_at <= claimedAt) {
      throw new HttpError(401, 'expired_challenge', '钱包登录挑战已过期');
    }
    throw new HttpError(401, 'used_challenge', '钱包登录挑战已使用');
  }

  // Session 只证明当前设备控制已登记的钱包子钥。链账户是否存在、余额和公民资格
  // 必须由具体业务动作自行校验，不能阻塞会员页和端到端加密数据同步。
  const sessionTtlSeconds = parsePositiveInt(env.SESSION_TTL_SECONDS, 86_400);
  const sessionToken = createId('sqs');
  const session: SessionState = {
    cid_number: cidNumber,
    binding_revision: identity.binding_revision,
    account_id: accountId,
    device_key_hash: await sha256Hex(matchedP256),
    created_at: nowMs(),
    expires_at: secondsFromNow(sessionTtlSeconds)
  };

  const sessionKey = await sessionCacheKey(sessionToken);
  try {
    await putKvJson(env, sessionKey, session, 'session_cache', {
      expirationTtl: sessionTtlSeconds
    });
    await indexIdentitySession(env, sessionToken, session);
  } catch (error) {
    // 中文注释：KV/D1 任一写入失败时烧毁挑战并清除两侧半成品，客户端只能重新
    // 申请挑战，禁止孤立 Session 或恢复旧挑战造成并发重放窗口。
    await rollbackIdentitySession(env, sessionToken).catch(() => undefined);
    throw error;
  }

  return jsonResponse({
    ok: true,
    session_token: sessionToken,
    cid_number: cidNumber,
    binding_revision: identity.binding_revision,
    account_id: accountId,
    expires_at: session.expires_at
  });
}

/// 注册 P-256 设备子钥：客户端用 sr25519 主钥对
/// `signing_message(OP_SIGN_SQUARE_DEVICE_BIND,
/// cid_number ‖ binding_revision ‖ account_id ‖ p256_public_key ‖ issued_at)`
/// 签名做绑定证明；后端复用 sr25519 验签确认子钥归属，再由 D1 用户投影解析出身份主键
/// cid_number，落库主键 (cid_number, device_id)：同一身份可多设备并存（各一行），
/// 同设备（同 P-256 公钥）重注册按 issued_at 单调覆盖 = 轮换/续期。子钥属生成它的
/// 钱包 account_id；换绑后此前账户子钥由每请求 D1 绑定复查自然失效。此后登录挑战改由
/// 该子钥静默签名。
export async function registerDeviceSubkey(request: Request, env: Env): Promise<Response> {
  const body = await readJson<DeviceRegisterRequest>(request);
  await verifyTurnstile(request, env, body.turnstile_token);
  let accountId: string;
  try {
    accountId = assertAccountId(body.account_id);
  } catch {
    throw new HttpError(400, 'invalid_account_id', '账户标识格式不合法');
  }
  const p256PublicKey = assertP256PublicKeyHex(body.p256_public_key);
  const now = nowMs();
  if (
    typeof body.issued_at !== 'number' ||
    !Number.isSafeInteger(body.issued_at) ||
    Math.abs(now - body.issued_at) > DEVICE_SKEW_MS
  ) {
    throw new HttpError(400, 'invalid_issued_at', '设备绑定时间戳不合法');
  }
  if (typeof body.binding_signature !== 'string') {
    throw new HttpError(400, 'invalid_binding', '设备绑定签名缺失');
  }

  // 设备登记是普通鉴权，只读取 finalized 用户 D1 投影；账户签名证明实际控制权。
  const identity = await readUserByAccountId(env, accountId);
  if (!identity || identity.binding_revision <= 0) {
    return throwMissingIdentity(env, '该钱包账户未绑定 CID,无法注册设备子钥');
  }
  const cidNumber = identity.cid_number;
  const bindingMessage = buildDeviceBindingSigningMessage({
    cid_number: cidNumber,
    binding_revision: identity.binding_revision,
    account_id: accountId,
    p256_public_key: p256PublicKey,
    issued_at: body.issued_at
  });
  const isValid = await verifyWalletSignature(
    bindingMessage,
    body.binding_signature,
    accountId
  );
  if (!isValid) {
    throw new HttpError(401, 'invalid_binding_signature', '设备绑定签名校验失败');
  }

  // device_id = 该设备 P-256 公钥的 sha256:同一身份多设备各一行;换机(新公钥)=新设备。
  const deviceId = await sha256Hex(p256PublicKey);

  const updated = await env.DB.prepare(
    `INSERT INTO square_device_subkeys
      (cid_number, device_id, binding_revision, account_id, p256_public_key, issued_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cid_number, device_id) DO UPDATE SET
        binding_revision = excluded.binding_revision,
        account_id = excluded.account_id,
        p256_public_key = excluded.p256_public_key,
        issued_at = excluded.issued_at,
        updated_at = excluded.updated_at
      WHERE excluded.binding_revision > square_device_subkeys.binding_revision
        OR (excluded.binding_revision = square_device_subkeys.binding_revision
          AND excluded.issued_at > square_device_subkeys.issued_at)`
  )
    .bind(
      cidNumber,
      deviceId,
      identity.binding_revision,
      accountId,
      p256PublicKey,
      body.issued_at,
      now,
      now,
    )
    .run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    throw new HttpError(409, 'stale_device_binding', '设备绑定证明已使用或早于当前绑定');
  }

  // 新账户的设备子钥已经由新账户签名并成功落库，证明新鉴权钥已经上岗；此后才清理
  // 此前 revision / 此前账户凭证。App 已先用当前钱包账户派生并验证用途子钥，因而清理
  // 失败只会让本次登记重试，不会留下“旧钥已删、新钥未上岗”的断层。
  await revokeStaleBindingCredentials(
    env,
    cidNumber,
    identity.binding_revision,
    accountId,
  );

  return jsonResponse({
    ok: true,
    cid_number: cidNumber,
    binding_revision: identity.binding_revision,
  });
}

/// D1 没查到用户时，必须先证明投影已经追到当前 finalized 头；否则不能误报未绑定。
async function throwMissingIdentity(env: Env, unboundMessage: string): Promise<never> {
  const projection = await inspectUserProjectionHealth(env);
  if (projection.identity_projection_status === 'pending') {
    throw new HttpError(409, 'identity_projection_pending', '当前钱包身份仍在同步，请稍后重试');
  }
  if (projection.identity_projection_status === 'unavailable') {
    throw new HttpError(503, 'identity_projection_unavailable', '身份投影服务暂时不可用，请稍后重试');
  }
  throw new HttpError(403, 'cid_not_bound', unboundMessage);
}

/// finalized 当前绑定的新设备登记成功后，收敛全部可撤销的旧鉴权材料。
/// CID 公开业务数据、通讯录此前版本密文、动态、文章和订阅均不在删除范围。
async function revokeStaleBindingCredentials(
  env: Env,
  cidNumber: string,
  bindingRevision: number,
  accountId: string,
): Promise<void> {
  await clearStaleIdentitySessions(env, cidNumber, bindingRevision, accountId);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM square_login_challenges
        WHERE cid_number = ? AND (binding_revision <> ? OR account_id <> ?)`,
    ).bind(cidNumber, bindingRevision, accountId),
    env.DB.prepare(
      `DELETE FROM push_endpoints
        WHERE cid_number = ? AND (binding_revision <> ? OR account_id <> ?)`,
    ).bind(cidNumber, bindingRevision, accountId),
    env.DB.prepare(
      `DELETE FROM square_device_subkeys
        WHERE cid_number = ? AND (binding_revision <> ? OR account_id <> ?)`,
    ).bind(cidNumber, bindingRevision, accountId),
  ]);
}
