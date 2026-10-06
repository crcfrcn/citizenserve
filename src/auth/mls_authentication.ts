import type { Env, MlsAuthenticationChallengeRow, MlsAuthenticationProof, MlsAuthenticationPurpose, MlsDeviceRow, SessionState } from '../types';
import { readUserByAccountId } from '../account/user_repository';
import { resourceLimit } from '../limits/catalog';
import { readLimitedBytes } from '../limits/request';
import { HttpError } from '../shared/http';
import { assertAccountId, assertCidNumber } from '../shared/ids';
import { sha256Hex } from '../shared/hash';
import { bytesToHex, concatBytes, hexToBytes, OP_SIGN_MLS_DEVICE_BIND, scaleString, signingMessage, u64Le } from '../shared/signing_message';

export const MLS_PROOF_HEADER = 'x-mls-proof';
const encoder = new TextEncoder();
const PROOF_FIELDS = ['user_id', 'device_id', 'public_key', 'account_id', 'binding_revision', 'service_origin', 'challenge', 'expires_at_millis', 'method', 'request_target', 'body_sha256', 'signature'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** 所有认证只复用已经登记的MLS签名身份，公开编号不是独立设备密钥。 */
export function assertMlsPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw invalidProof();
  return value;
}

export function assertMlsOrigin(value: unknown): string {
  if (typeof value !== 'string') throw invalidProof();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidProof(); }
  const hostname = url.hostname;
  const dns = hostname.length <= 253 && hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || (!dns && !hostname.startsWith('[')) || (url.port !== '' && Number(url.port) < 1)) throw invalidProof();
  return value;
}

export function assertMlsTarget(method: unknown, target: unknown): void {
  if (typeof method !== 'string' || !METHODS.has(method) || typeof target !== 'string'
      || target.length > 8192 || !target.startsWith('/') || target.startsWith('//')
      || /[^\x21-\x7e]|[#\\]/.test(target) || /%(?![0-9a-fA-F]{2})/.test(target)) throw invalidProof();
}

/** 严格字段集合阻断旧协议、别名和多余签名参数。 */
export function assertExactFields(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidProof();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, i) => field !== expected[i])) throw invalidProof();
}

export function validateMlsProof(value: unknown): MlsAuthenticationProof {
  assertExactFields(value, PROOF_FIELDS);
  try { assertCidNumber(value.user_id); assertAccountId(value.account_id); } catch { throw invalidProof(); }
  const publicKey = assertMlsPublicKey(value.public_key);
  if (value.device_id !== publicKey.slice(2) || !positiveInteger(value.binding_revision)
      || !positiveInteger(value.expires_at_millis) || typeof value.signature !== 'string'
      || !/^0x[0-9a-f]{128}$/.test(value.signature)) throw invalidProof();
  assertMlsPublicKey(value.challenge);
  assertMlsPublicKey(value.body_sha256);
  assertMlsOrigin(value.service_origin);
  assertMlsTarget(value.method, value.request_target);
  return value as unknown as MlsAuthenticationProof;
}

/** 唯一传输为规范base64url紧凑JSON；重复字段、填充、非法UTF-8均拒绝。 */
export function readMlsProof(request: Request<unknown, unknown>): MlsAuthenticationProof {
  const encoded = request.headers.get(MLS_PROOF_HEADER);
  const maxBytes = resourceLimit('mls_authentication_proof').max_bytes;
  if (!encoded || encoded.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalidProof();
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (bytes.length > maxBytes || base64Url(bytes) !== encoded) throw invalidProof();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (JSON.stringify(parsed) !== text) throw invalidProof();
    return validateMlsProof(parsed);
  } catch { throw invalidProof(); }
}

/** RFC9420 SignContent：固定标签与最短TLS变长编码，逐字对齐SDK。 */
export function mlsAuthenticationMessage(proof: MlsAuthenticationProof): Uint8Array<ArrayBuffer> {
  validateMlsProof(proof);
  const content = concatBytes(
    tlsVector(encoder.encode(proof.user_id)), hexToBytes(proof.device_id), hexToBytes(proof.account_id),
    u64Be(proof.binding_revision), tlsVector(encoder.encode(proof.service_origin)), hexToBytes(proof.challenge),
    u64Be(proof.expires_at_millis), tlsVector(encoder.encode(proof.method)),
    tlsVector(encoder.encode(proof.request_target)), hexToBytes(proof.body_sha256),
  );
  return new Uint8Array(concatBytes(tlsVector(encoder.encode('MLS 1.0 TataChatAuthentication')), tlsVector(content)));
}

export async function verifyMlsSignature(proof: MlsAuthenticationProof): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(proof.public_key), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(proof.signature), mlsAuthenticationMessage(proof));
  } catch { return false; }
}

/** 钱包只授权同一MLS公钥，登记载荷使用既有GMB钱包签名原语。 */
export function buildMlsDeviceBindingSigningMessage(input: {
  cid_number: string; binding_revision: number; account_id: string; public_key: string; issued_at: number;
}): Uint8Array {
  assertCidNumber(input.cid_number);
  assertAccountId(input.account_id);
  assertMlsPublicKey(input.public_key);
  if (!positiveInteger(input.binding_revision) || !positiveInteger(input.issued_at)) throw invalidProof();
  return signingMessage(OP_SIGN_MLS_DEVICE_BIND, concatBytes(
    scaleString(input.cid_number), u64Le(input.binding_revision), scaleString(input.account_id),
    scaleString(input.public_key), u64Le(input.issued_at),
  ));
}

export async function readMlsDevice(env: Env, cidNumber: string, deviceId: string): Promise<MlsDeviceRow | null> {
  return env.DB.prepare('SELECT * FROM mls_devices WHERE cid_number = ? AND device_id = ?')
    .bind(cidNumber, deviceId).first<MlsDeviceRow>();
}

/** 先验签再原子消费，任何失败不执行业务；登记模式只能由验证钱包授权后的handler调用。 */
export async function consumeMlsAuthentication(
  request: Request<unknown, unknown>, env: Env, purpose: MlsAuthenticationPurpose, session?: SessionState,
): Promise<MlsAuthenticationProof> {
  const proof = readMlsProof(request);
  const current = Date.now();
  const ttl = resourceLimit('mls_authentication_challenge').ttl_seconds! * 1000;
  if (proof.expires_at_millis <= current || proof.expires_at_millis > current + ttl) throw invalidChallenge();
  const url = new URL(request.url);
  const digest = '0x' + await sha256Hex(await readLimitedBytes(request.clone(), 'mls_authentication_body'));
  if (proof.service_origin !== assertMlsOrigin(url.origin) || proof.method !== request.method
      || proof.request_target !== url.pathname + url.search || proof.body_sha256 !== digest) throw invalidProof();
  const identity = await readUserByAccountId(env, proof.account_id);
  if (!identity || identity.cid_number !== proof.user_id || identity.binding_revision !== proof.binding_revision) {
    throw new HttpError(401, 'cid_binding_changed', '当前身份绑定已变更，请重新登录');
  }
  if (purpose === 'request' && (!session || session.cid_number !== proof.user_id
      || session.account_id !== proof.account_id || session.binding_revision !== proof.binding_revision
      || session.device_id !== proof.device_id)) throw invalidProof();
  if (purpose !== 'registration') {
    const device = await readMlsDevice(env, proof.user_id, proof.device_id);
    if (!device || device.public_key !== proof.public_key || device.account_id !== proof.account_id
        || device.binding_revision !== proof.binding_revision) {
      throw new HttpError(401, 'device_not_registered', '当前MLS设备尚未登记');
    }
  }
  const challenge = await env.DB.prepare('SELECT * FROM mls_authentication_challenges WHERE challenge = ?')
    .bind(proof.challenge).first<MlsAuthenticationChallengeRow>();
  const sessionHash = purpose === 'request' ? await requestSessionHash(request) : null;
  if (!challenge || challenge.purpose !== purpose
      || challenge.session_token_hash !== sessionHash || challenge.cid_number !== proof.user_id
      || challenge.device_id !== proof.device_id || challenge.account_id !== proof.account_id
      || challenge.binding_revision !== proof.binding_revision || challenge.service_origin !== proof.service_origin
      || challenge.method !== proof.method || challenge.request_target !== proof.request_target
      || challenge.body_sha256 !== proof.body_sha256 || challenge.expires_at_millis !== proof.expires_at_millis) throw invalidChallenge();
  if (!await verifyMlsSignature(proof)) throw new HttpError(401, 'invalid_mls_signature', 'MLS认证签名无效');
  // D1条件删除同时复查当前finalized投影和登记；删除即一次性消费，业务失败须申请新挑战。
  const deviceCheck = purpose === 'registration' ? '' :
    ' AND EXISTS (SELECT 1 FROM mls_devices WHERE cid_number = ? AND device_id = ? AND binding_revision = ? AND account_id = ? AND public_key = ?)';
  const statement = env.DB.prepare(
    'DELETE FROM mls_authentication_challenges WHERE challenge = ? AND purpose = ?'
    + ' AND cid_number = ? AND device_id = ? AND binding_revision = ? AND account_id = ?'
    + ' AND session_token_hash IS ? AND service_origin = ? AND method = ? AND request_target = ? AND body_sha256 = ?'
    + ' AND expires_at_millis = ? AND expires_at_millis > ?'
    + ' AND EXISTS (SELECT 1 FROM users WHERE cid_number = ? AND binding_revision = ? AND account_id = ?'
    + ' AND (registration_finalized_block_number <> 0 OR (identity_finalized_block_number > 0 AND identity_finalized_block_number >= (SELECT finalized_block_number FROM user_projection_cursor WHERE cursor_id = 1))))'
    + deviceCheck,
  );
  const now = Date.now();
  const values: (string | number | null)[] = [proof.challenge, purpose, proof.user_id, proof.device_id,
    proof.binding_revision, proof.account_id, sessionHash, proof.service_origin, proof.method, proof.request_target,
    proof.body_sha256, proof.expires_at_millis, now, proof.user_id, proof.binding_revision, proof.account_id];
  if (purpose !== 'registration') values.push(proof.user_id, proof.device_id, proof.binding_revision, proof.account_id, proof.public_key);
  const claimed = await statement.bind(...values).run();
  if (claimed.meta.changes !== 1) throw invalidChallenge();
  return proof;
}

export async function requestSessionHash(request: Request<unknown, unknown>): Promise<string> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim()) throw invalidProof();
  return sha256Hex(authorization.slice(7).trim());
}

export function randomMlsChallenge(): string {
  return '0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function tlsVector(value: Uint8Array): Uint8Array {
  const length = value.length;
  if (length < 64) return concatBytes(new Uint8Array([length]), value);
  if (length < 16384) return concatBytes(new Uint8Array([0x40 | (length >>> 8), length & 255]), value);
  if (length < 1073741824) return concatBytes(new Uint8Array([0x80 | (length >>> 24), (length >>> 16) & 255, (length >>> 8) & 255, length & 255]), value);
  throw invalidProof();
}

function u64Be(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function invalidProof(): HttpError { return new HttpError(401, 'invalid_mls_proof', 'MLS认证证明格式或请求绑定无效'); }
function invalidChallenge(): HttpError { return new HttpError(401, 'invalid_mls_challenge', 'MLS认证挑战已使用、过期或不匹配'); }
