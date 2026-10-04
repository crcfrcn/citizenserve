import { describe, expect, it } from 'vitest';
import { routeRequest } from '../src/routes';
import { sha256Hex } from '../src/shared/hash';
import {
  OP_SIGN_SQUARE_LOGIN,
  scaleString,
  signingMessage
} from '../src/shared/signing_message';
import type { ContactCiphertextRow, Env, SessionState, UserRow } from '../src/types';

const ACCOUNT_ID_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const ACCOUNT_ID_B = '0x2222222222222222222222222222222222222222222222222222222222222222';
// 身份主键 = D1 finalized 用户投影的 cid_number；A/B 各绑不同 CID 保证隔离。
const CID_A = 'CN220-CTZN2-100000001-2026';
const CID_B = 'CN220-CTZN2-100000002-2026';

function projectedUser(cidNumber: string, accountId: string): UserRow {
  return {
    cid_number: cidNumber,
    account_id: accountId,
    binding_revision: 1,
    identity_level: 'visitor',
    registration_finalized_block_number: 1,
    registration_finalized_block_hash: `0x${'1'.repeat(64)}`,
    binding_finalized_block_number: 1,
    binding_finalized_block_hash: `0x${'1'.repeat(64)}`,
    identity_finalized_block_number: 1,
    identity_finalized_block_hash: `0x${'1'.repeat(64)}`,
    registered_at: 1,
    binding_updated_at: 1,
    identity_updated_at: 1,
  };
}
const CONTACT_A = '01'.repeat(32);
const CONTACT_B = '02'.repeat(32);
const CONTACT_C = '03'.repeat(32);

describe('端到端加密通讯录 API', () => {
  it('要求 Session 和 P-256 设备请求证明', async () => {
    const context = await buildContext();

    await expect(
      routeRequest(new Request('https://worker.test/square/contacts'), context.env)
    ).rejects.toMatchObject({ code: 'missing_session' });

    await expect(
      routeRequest(new Request('https://worker.test/square/contacts', {
        headers: { authorization: `Bearer ${context.accountA.token}` }
      }), context.env)
    ).rejects.toMatchObject({ code: 'device_time_invalid' });
  });

  // 设备证明必须只读完成验签；任何 nonce D1 SQL 都会重新引入按请求写入放大。
  it('有效设备证明只验签且不为请求 nonce 写 D1', async () => {
    const context = await buildContext();

    const response = await call(
      context,
      context.accountA,
      'GET',
      '/square/contacts',
    );

    expect(response.status).toBe(200);
    expect(
      context.db.preparedSql.some((sql) => sql.includes('square_request_nonces')),
    ).toBe(false);
  });

  it('按 Session CID 隔离 CRUD，且 D1 不出现联系人账户或私人备注明文', async () => {
    const context = await buildContext();
    const secretContactAccount = '5ContactAccountMustNeverEnterCloudflare';
    const secretContactRemark = '绝不能进入 Cloudflare 的私人备注';
    const aPayload = cipherPayload('accountId-a', 300, 1, ACCOUNT_ID_A);
    const bPayload = cipherPayload('accountId-b', 400, 1, ACCOUNT_ID_B);

    await expect(
      call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_A}`, {
        ...aPayload,
        contact_account_id: secretContactAccount,
        contact_remark: secretContactRemark
      })
    ).rejects.toMatchObject({ code: 'invalid_contact_request' });

    expect((await json(await call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_A}`, aPayload))).ok)
      .toBe(true);
    expect((await json(await call(context, context.accountB, 'PUT', `/square/contacts/${CONTACT_A}`, bPayload))).ok)
      .toBe(true);

    const aPage = await json(await call(context, context.accountA, 'GET', '/square/contacts'));
    const bPage = await json(await call(context, context.accountB, 'GET', '/square/contacts'));
    expect(aPage.items).toEqual([{ contact_id: CONTACT_A, ...aPayload }]);
    expect(bPage.items).toEqual([{ contact_id: CONTACT_A, ...bPayload }]);

    const stored = [...context.db.contacts.values()];
    expect(stored).toHaveLength(2);
    expect(Object.keys(stored[0]).sort()).toEqual([
      'account_id', 'binding_revision', 'cid_number', 'ciphertext', 'contact_id', 'mac',
      'nonce', 'updated_at'
    ]);
    expect(JSON.stringify(stored)).not.toContain(secretContactAccount);
    expect(JSON.stringify(stored)).not.toContain(secretContactRemark);

    const deleted = await json(
      await call(
        context,
        context.accountA,
        'DELETE',
        `/square/contacts/${CONTACT_A}?binding_revision=1&account_id=${ACCOUNT_ID_A}`
      )
    );
    expect(deleted.deleted).toBe(true);
    const aAfter = await json(await call(context, context.accountA, 'GET', '/square/contacts'));
    const bAfter = await json(await call(context, context.accountB, 'GET', '/square/contacts'));
    expect(aAfter.items).toEqual([]);
    expect(bAfter.items).toHaveLength(1);
  });

  it('使用 updated_at + contact_id 的稳定游标分页', async () => {
    const context = await buildContext();
    await call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_A}`, cipherPayload('a', 300));
    await call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_B}`, cipherPayload('b', 200));
    await call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_C}`, cipherPayload('c', 100));

    const first = await json(
      await call(context, context.accountA, 'GET', '/square/contacts?limit=2')
    );
    expect((first.items as Array<{ contact_id: string }>).map((item) => item.contact_id))
      .toEqual([CONTACT_A, CONTACT_B]);
    expect(first.next_cursor).toBe(`200.${CONTACT_B}`);

    const second = await json(
      await call(
        context,
        context.accountA,
        'GET',
        `/square/contacts?limit=2&cursor=${first.next_cursor as string}`
      )
    );
    expect((second.items as Array<{ contact_id: string }>).map((item) => item.contact_id))
      .toEqual([CONTACT_C]);
    expect(second.next_cursor).toBeNull();
  });

  it('旧设备的过期版本不能覆盖云端新密文', async () => {
    const context = await buildContext();
    const current = cipherPayload('current', 500);
    const stale = cipherPayload('stale', 400);
    await call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_A}`, current);
    const response = await json(
      await call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_A}`, stale)
    );
    expect(response.applied).toBe(false);

    const page = await json(await call(context, context.accountA, 'GET', '/square/contacts'));
    expect(page.items).toEqual([{ contact_id: CONTACT_A, ...current }]);
  });

  it('当前会话不能在换绑 finalized 前预写下一绑定版本', async () => {
    const context = await buildContext();
    await expect(
      call(
        context,
        context.accountA,
        'PUT',
        `/square/contacts/${CONTACT_A}`,
        cipherPayload('next', 600, 2, ACCOUNT_ID_B),
      ),
    ).rejects.toMatchObject({ code: 'contact_binding_not_allowed' });
    expect(context.db.contacts.size).toBe(0);
  });

  it('拒绝非法密文元数据、超限请求体和超过通讯录独立限流的请求', async () => {
    const context = await buildContext();
    await expect(
      call(context, context.accountA, 'PUT', `/square/contacts/${CONTACT_A}`, {
        ...cipherPayload('bad', 1),
        nonce: encodeBytes(new Uint8Array(11))
      })
    ).rejects.toMatchObject({ code: 'invalid_contact_nonce' });

    const oversized = new Request(`https://worker.test/square/contacts/${CONTACT_A}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${context.accountA.token}`,
        'content-length': String(16 * 1024 + 1)
      }
    });
    await expect(routeRequest(oversized, context.env)).rejects.toMatchObject({
      code: 'request_too_large'
    });

    // 默认拒绝:无会话访问受保护路由,先于限流被 401 拦下(不再退化成按 IP 限流)。
    await expect(
      routeRequest(new Request('https://worker.test/square/contacts'), context.env)
    ).rejects.toMatchObject({ code: 'missing_session' });

    // 携带有效会话方能触达限流层;超过通讯录独立读限流仍抛 request_rate_exceeded。
    context.db.rateAllowed = false;
    await expect(
      routeRequest(
        new Request('https://worker.test/square/contacts', {
          headers: { authorization: `Bearer ${context.accountA.token}` }
        }),
        context.env
      )
    ).rejects.toMatchObject({ code: 'request_rate_exceeded' });
  });
});

interface TestAccount {
  accountId: string;
  token: string;
  keyPair: CryptoKeyPair;
}

interface TestContext {
  env: Env;
  db: ContactDb;
  accountA: TestAccount;
  accountB: TestAccount;
  nonceCounter: number;
}

async function buildContext(): Promise<TestContext> {
  const db = new ContactDb();
  const kv = new FakeKv();
  const accountA = await registerAccount(db, kv, ACCOUNT_ID_A, 'token-a');
  const accountB = await registerAccount(db, kv, ACCOUNT_ID_B, 'token-b');
  return {
    env: {
      DB: db,
      SQUARE_CACHE: kv,
      RATE_AUTH: new ContactRate(db),
      RATE_WRITE: new ContactRate(db),
      RATE_READ: new ContactRate(db),
      HASH_KEY: 'contacts-test-rate-key'
    } as unknown as Env,
    db,
    accountA,
    accountB,
    nonceCounter: 0
  };
}

async function registerAccount(
  db: ContactDb,
  kv: FakeKv,
  accountId: string,
  token: string
): Promise<TestAccount> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pubkey = toHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const cid = accountId === ACCOUNT_ID_A ? CID_A : CID_B;
  // device_id == 会话 device_key_hash == sha256(p256):子钥挂在 (cid, device_id) 下。
  const deviceId = await sha256Hex(pubkey);
  db.subkeys.set(`${cid}:${deviceId}`, {
    p256_public_key: pubkey,
    binding_revision: 1,
    account_id: accountId
  });
  kv.store.set(`square_session:${await sha256Hex(token)}`, {
    cid_number: cid,
    binding_revision: 1,
    account_id: accountId,
    device_key_hash: deviceId,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  } satisfies SessionState);
  return { accountId, token, keyPair };
}

async function call(
  context: TestContext,
  account: TestAccount,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<Response> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const requestTime = Date.now();
  const nonce = (++context.nonceCounter).toString(16).padStart(32, '0');
  const bodyHash = await sha256Hex(method === 'PUT' ? bodyText : '');
  const canonical = [
    'square_request',
    method,
    path,
    bodyHash,
    String(requestTime),
    nonce,
    await sha256Hex(account.token)
  ].join('\n');
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    account.keyPair.privateKey,
    signingMessage(OP_SIGN_SQUARE_LOGIN, scaleString(canonical))
  );
  const headers = new Headers({
    authorization: `Bearer ${account.token}`,
    'x-device-time': String(requestTime),
    'x-device-nonce': nonce,
    'x-device-signature': `0x${toHex(signature)}`
  });
  if (method === 'PUT') {
    headers.set('content-type', 'application/json');
    headers.set('content-length', String(new TextEncoder().encode(bodyText).byteLength));
  }
  return routeRequest(new Request(`https://worker.test${path}`, {
    method,
    headers,
    body: method === 'PUT' ? bodyText : undefined
  }), context.env);
}

function cipherPayload(
  label: string,
  updatedAt: number,
  bindingRevision = 1,
  accountId = ACCOUNT_ID_A
): {
  binding_revision: number;
  account_id: string;
  ciphertext: string;
  nonce: string;
  mac: string;
  updated_at: number;
} {
  return {
    binding_revision: bindingRevision,
    account_id: accountId,
    ciphertext: encodeBytes(new TextEncoder().encode(`cipher-${label}`)),
    nonce: encodeBytes(new Uint8Array(12).fill(label.length)),
    mac: encodeBytes(new Uint8Array(16).fill(label.length + 1)),
    updated_at: updatedAt
  };
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

class FakeKv {
  readonly store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null;
  }
}

class ContactStmt {
  private binds: unknown[] = [];

  constructor(
    private readonly db: ContactDb,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): ContactStmt {
    this.binds = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM users') && this.sql.includes('WHERE cid_number = ?')) {
      return (this.db.users.get(this.binds[0] as string) as T | undefined) ?? null;
    }
    if (this.sql.includes('FROM square_device_subkeys')) {
      // 子钥按 (cid_number, device_id) 查:binds = [cid, device_id]。
      const cid = this.binds[0] as string;
      const deviceId = this.binds[1] as string;
      const row = this.db.subkeys.get(`${cid}:${deviceId}`);
      return row
        ? ({
            p256_public_key: row.p256_public_key,
            binding_revision: row.binding_revision,
            account_id: row.account_id
          } as T)
        : null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes('FROM square_contacts')) return { results: [] };
    const cidNumber = this.binds[0] as string;
    const bindingRevision = this.binds[1] as number;
    const accountId = this.binds[2] as string;
    const limit = this.binds[this.binds.length - 1] as number;
    let rows = [...this.db.contacts.values()]
      .filter((row) =>
        row.cid_number === cidNumber &&
        row.binding_revision === bindingRevision &&
        row.account_id === accountId)
      .sort((left, right) =>
        right.updated_at - left.updated_at || right.contact_id.localeCompare(left.contact_id));
    if (this.sql.includes('updated_at < ?')) {
      const cursorTime = this.binds[3] as number;
      const cursorId = this.binds[5] as string;
      rows = rows.filter((row) =>
        row.updated_at < cursorTime ||
        (row.updated_at === cursorTime && row.contact_id < cursorId));
    }
    return { results: rows.slice(0, limit) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes('INSERT INTO square_contacts')) {
      const row: ContactCiphertextRow = {
        cid_number: this.binds[0] as string,
        binding_revision: this.binds[1] as number,
        account_id: this.binds[2] as string,
        contact_id: this.binds[3] as string,
        ciphertext: this.binds[4] as string,
        nonce: this.binds[5] as string,
        mac: this.binds[6] as string,
        updated_at: this.binds[7] as number
      };
      const key = `${row.cid_number}:${row.binding_revision}:${row.account_id}:${row.contact_id}`;
      const existing = this.db.contacts.get(key);
      if (!existing || row.updated_at >= existing.updated_at) {
        this.db.contacts.set(key, row);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.sql.includes('DELETE FROM square_contacts')) {
      const key = `${this.binds[0] as string}:${this.binds[1] as number}:` +
        `${this.binds[2] as string}:${this.binds[3] as string}`;
      return { meta: { changes: this.db.contacts.delete(key) ? 1 : 0 } };
    }
    return { meta: { changes: 1 } };
  }
}

class ContactDb {
  readonly users = new Map<string, UserRow>([
    [CID_A, projectedUser(CID_A, ACCOUNT_ID_A)],
    [CID_B, projectedUser(CID_B, ACCOUNT_ID_B)],
  ]);
  readonly contacts = new Map<string, ContactCiphertextRow>();
  readonly subkeys = new Map<string, {
    p256_public_key: string;
    binding_revision: number;
    account_id: string;
  }>();
  readonly preparedSql: string[] = [];
  rateAllowed = true;

  prepare(sql: string): ContactStmt {
    this.preparedSql.push(sql);
    return new ContactStmt(this, sql);
  }
}

class ContactRate {
  constructor(private readonly db: ContactDb) {}

  async limit(): Promise<RateLimitOutcome> {
    return { success: this.db.rateAllowed };
  }
}
