import type { ContactCiphertextRow, Env } from './types';
import { resourceLimit } from './limits/catalog';
import { HttpError, jsonResponse, parsePositiveInt, readJson, requireSession } from './shared/http';

const CONTACT_ID_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = resourceLimit('contact_ciphertext').max_items ?? 100;
const MAX_CIPHERTEXT_BYTES = 8 * 1024;
const NONCE_BYTES = 12;
const MAC_BYTES = 16;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ACCOUNT_ID_PATTERN = /^0x[a-f0-9]{64}$/;
const CONTACT_BODY_FIELDS = new Set([
  'binding_revision',
  'account_id',
  'ciphertext',
  'nonce',
  'mac',
  'updated_at'
]);

interface ContactCiphertextRequest {
  binding_revision?: unknown;
  account_id?: unknown;
  ciphertext?: unknown;
  nonce?: unknown;
  mac?: unknown;
  updated_at?: unknown;
}

interface ContactCursor {
  updatedAt: number;
  contactId: string;
}

/// GET /square/contacts —— 属主 cid_number 只从 Session 派生，按更新时间和不透明 ID 稳定分页。
export async function listContactsRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const limit = Math.min(
    parsePositiveInt(url.searchParams.get('limit') ?? undefined, DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const cursor = parseCursor(url.searchParams.get('cursor'));
  const binds: Array<string | number> = [
    session.cid_number,
    session.binding_revision,
    session.account_id
  ];
  let cursorClause = '';
  if (cursor) {
    cursorClause = ' AND (updated_at < ? OR (updated_at = ? AND contact_id < ?))';
    binds.push(cursor.updatedAt, cursor.updatedAt, cursor.contactId);
  }
  // 多取一条只用于判断是否还有下一页，不向客户端泄露额外记录。
  binds.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT cid_number, binding_revision, account_id, contact_id, ciphertext, nonce, mac, updated_at
      FROM square_contacts
      WHERE cid_number = ? AND binding_revision = ? AND account_id = ?${cursorClause}
      ORDER BY updated_at DESC, contact_id DESC
      LIMIT ?`
  ).bind(...binds).all<ContactCiphertextRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(publicContactRow);
  const tail = items[items.length - 1];

  return jsonResponse({
    ok: true,
    items,
    next_cursor: hasMore && tail ? formatCursor(tail.updated_at, tail.contact_id) : null
  });
}

/// PUT /square/contacts/:contact_id —— 幂等写入端侧生成的密文，较早更新不得覆盖较新更新。
export async function putContactRoute(
  request: Request,
  env: Env,
  contactIdRaw: string
): Promise<Response> {
  const session = await requireSession(request, env);
  const contactId = parseContactId(contactIdRaw);
  const body = assertContactRequest(await readJson<unknown>(request));
  const target = parseCipherBinding(
    body.binding_revision,
    body.account_id,
    session.binding_revision,
    session.account_id,
    'write'
  );
  const ciphertext = parseBase64Url(
    body.ciphertext,
    'invalid_contact_ciphertext',
    '通讯录密文格式不合法',
    1,
    MAX_CIPHERTEXT_BYTES
  );
  const nonce = parseBase64Url(
    body.nonce,
    'invalid_contact_nonce',
    '通讯录 nonce 格式不合法',
    NONCE_BYTES,
    NONCE_BYTES
  );
  const mac = parseBase64Url(
    body.mac,
    'invalid_contact_mac',
    '通讯录认证码格式不合法',
    MAC_BYTES,
    MAC_BYTES
  );
  const updatedAt = parseUpdatedAt(body.updated_at);

  const result = await env.DB.prepare(
    `INSERT INTO square_contacts
      (cid_number, binding_revision, account_id, contact_id, ciphertext, nonce, mac, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cid_number, binding_revision, account_id, contact_id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        nonce = excluded.nonce,
        mac = excluded.mac,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= square_contacts.updated_at`
  ).bind(
    session.cid_number,
    target.bindingRevision,
    target.accountId,
    contactId,
    ciphertext,
    nonce,
    mac,
    updatedAt
  ).run();

  return jsonResponse({
    ok: true,
    contact_id: contactId,
    updated_at: updatedAt,
    applied: (result.meta?.changes ?? 0) > 0
  });
}

/// DELETE /square/contacts/:contact_id —— 只能删除当前 Session 所属身份(cid)的记录。
export async function deleteContactRoute(
  request: Request,
  env: Env,
  contactIdRaw: string
): Promise<Response> {
  const session = await requireSession(request, env);
  const contactId = parseContactId(contactIdRaw);
  const url = new URL(request.url);
  const target = parseCipherBinding(
    url.searchParams.get('binding_revision'),
    url.searchParams.get('account_id'),
    session.binding_revision,
    session.account_id,
    'delete'
  );
  const result = await env.DB.prepare(
    `DELETE FROM square_contacts
      WHERE cid_number = ? AND binding_revision = ? AND account_id = ? AND contact_id = ?`
  ).bind(
    session.cid_number,
    target.bindingRevision,
    target.accountId,
    contactId
  ).run();

  return jsonResponse({
    ok: true,
    contact_id: contactId,
    deleted: (result.meta?.changes ?? 0) > 0
  });
}

function parseContactId(value: string): string {
  let contactId: string;
  try {
    contactId = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'invalid_contact_id', '联系人不透明 ID 编码不合法');
  }
  if (!CONTACT_ID_PATTERN.test(contactId)) {
    throw new HttpError(400, 'invalid_contact_id', '联系人不透明 ID 必须是 64 位小写十六进制');
  }
  return contactId;
}

function assertContactRequest(value: unknown): ContactCiphertextRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_contact_request', '通讯录密文请求格式不合法');
  }
  const fields = Object.keys(value);
  if (fields.some((field) => !CONTACT_BODY_FIELDS.has(field))) {
    // 联系人 CID、账户、SS58、私人备注及客户端自报属主键一律拒绝，
    // 避免任何关系明文进入 Worker 业务处理链。
    throw new HttpError(400, 'invalid_contact_request', '通讯录接口只接受密文字段');
  }
  return value as ContactCiphertextRequest;
}

/// 当前 CID 控制者只能写当前绑定密文；finalized 后的新控制者可删除当前或紧邻的此前
/// 版本。目标版本在换绑生效前只允许保存在客户端，Worker 不接受未生效账户预写。
function parseCipherBinding(
  revisionValue: unknown,
  accountValue: unknown,
  currentRevision: number,
  currentAccountId: string,
  operation: 'write' | 'delete'
): { bindingRevision: number; accountId: string } {
  const bindingRevision = typeof revisionValue === 'string'
    ? Number(revisionValue)
    : revisionValue;
  if (
    typeof bindingRevision !== 'number' ||
    !Number.isSafeInteger(bindingRevision) ||
    bindingRevision <= 0
  ) {
    throw new HttpError(400, 'invalid_contact_binding', '通讯录密文绑定版本不合法');
  }
  if (typeof accountValue !== 'string' || !ACCOUNT_ID_PATTERN.test(accountValue)) {
    throw new HttpError(400, 'invalid_contact_binding', '通讯录密文 account_id 不合法');
  }
  const isCurrent =
    bindingRevision === currentRevision && accountValue === currentAccountId;
  const isPreviousDelete =
    operation === 'delete' &&
    bindingRevision + 1 === currentRevision &&
    accountValue !== currentAccountId;
  if (!isCurrent && !isPreviousDelete) {
    throw new HttpError(403, 'contact_binding_not_allowed', '无权读写该通讯录密文版本');
  }
  return { bindingRevision, accountId: accountValue };
}

function parseBase64Url(
  value: unknown,
  code: string,
  message: string,
  minBytes: number,
  maxBytes: number
): string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw new HttpError(400, code, message);
  }
  try {
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength < minBytes || bytes.byteLength > maxBytes) {
      throw new HttpError(400, code, message);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, code, message);
  }
  return value;
}

function parseUpdatedAt(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Date.now() + MAX_FUTURE_SKEW_MS
  ) {
    throw new HttpError(400, 'invalid_contact_updated_at', '联系人更新时间不合法');
  }
  return value;
}

function parseCursor(value: string | null): ContactCursor | null {
  if (!value) return null;
  const match = /^(\d+)\.([a-f0-9]{64})$/.exec(value);
  const updatedAt = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
    throw new HttpError(400, 'invalid_contact_cursor', '通讯录分页游标不合法');
  }
  return { updatedAt, contactId: match[2] };
}

function formatCursor(updatedAt: number, contactId: string): string {
  return `${updatedAt}.${contactId}`;
}

function publicContactRow(row: ContactCiphertextRow): Omit<ContactCiphertextRow, 'cid_number'> {
  // 属主键 cid_number 只用于服务端隔离，响应不重复下发，降低客户端误信自报属主的风险。
  return {
    binding_revision: row.binding_revision,
    account_id: row.account_id,
    contact_id: row.contact_id,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    mac: row.mac,
    updated_at: row.updated_at
  };
}
