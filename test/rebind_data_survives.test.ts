import { describe, expect, it } from 'vitest';
import {
  deleteContactRoute,
  listContactsRoute,
  putContactRoute
} from '../src/contacts';
import { getMembership } from '../src/membership/service';
import type { Env, MembershipRow, SessionState } from '../src/types';

// R6 门禁核心：有当前钱包签名时，换绑前后同一身份主键 cid_number 的云端私有数据不丢。
// 模型:cid = 稳定身份主键(用户不可改);account_id = 控制该身份的钱包账户(可换绑)。
// Worker 只保存绑定版本隔离的密文；端侧在换绑前用当前账户解密、用新账户重加密。
const CID_X = 'CN220-CTZN2-198805200-2026';
const GENESIS_HASH = `0x${'12'.repeat(32)}`;
const ACCOUNT_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const ACCOUNT_B = '0x2222222222222222222222222222222222222222222222222222222222222222';
const CONTACT_ID_A = 'ab'.repeat(32); // 换绑前当前账户索引钥派生的不透明 ID
const CONTACT_ID_B = 'cd'.repeat(32); // 新账户索引钥派生的不透明 ID
const ACCOUNT_SECRET_A = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ACCOUNT_SECRET_B = Uint8Array.from({ length: 32 }, (_, index) => index + 65);
const CONTACT_PLAINTEXT = new TextEncoder().encode(
  JSON.stringify({ owner_cid_number: CID_X, cid_number: 'CN220-CTZN2-198805201-2026' })
);

/// 会话缓存:token → 会话身份态。两会话身份主键同为 CID_X,仅当前绑定账户不同(模拟换绑)。
function sessionKv(): KVNamespace {
  const sessionA: SessionState = {
    cid_number: CID_X,
    binding_revision: 1,
    account_id: ACCOUNT_A,
    device_key_hash: 'a'.repeat(64),
    created_at: 0,
    expires_at: Date.now() + 60_000
  };
  const sessionB: SessionState = {
    cid_number: CID_X,
    binding_revision: 2,
    account_id: ACCOUNT_B,
    device_key_hash: 'b'.repeat(64),
    created_at: 0,
    expires_at: Date.now() + 60_000
  };
  const store = new Map<string, unknown>([
    [
      'square_session:4f66a4283f8bc9768c3cb97fd06d267b79315aee941c9c1727b9354509242ffe',
      sessionA
    ],
    [
      'square_session:efa1cd32d437a4dd30463a379503cadfb2b13481660f6345110f3bde01f2e773',
      sessionB
    ]
  ]);
  return {
    get: async (key: string) => (store.get(key) as unknown) ?? null
  } as unknown as KVNamespace;
}

interface ContactRow {
  cid_number: string;
  binding_revision: number;
  account_id: string;
  contact_id: string;
  ciphertext: string;
  nonce: string;
  mac: string;
  updated_at: number;
}

/// 通讯录密文表 mock,按 CID + 绑定版本 + 当前账户隔离(对齐真实 schema)。
class ContactsDb {
  readonly rows = new Map<string, ContactRow>();
  prepare(sql: string): ContactsStmt {
    return new ContactsStmt(this, sql);
  }
}

class ContactsStmt {
  private binds: unknown[] = [];
  constructor(private readonly db: ContactsDb, private readonly sql: string) {}
  bind(...args: unknown[]): ContactsStmt {
    this.binds = args;
    return this;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes('INSERT INTO square_contacts')) {
      const row: ContactRow = {
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
      this.db.rows.set(key, row);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes('DELETE FROM square_contacts')) {
      const key = `${this.binds[0] as string}:${this.binds[1] as number}:` +
        `${this.binds[2] as string}:${this.binds[3] as string}`;
      return { meta: { changes: this.db.rows.delete(key) ? 1 : 0 } };
    }
    return { meta: { changes: 0 } };
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM square_contacts')) {
      const cidNumber = this.binds[0] as string;
      const bindingRevision = this.binds[1] as number;
      const accountId = this.binds[2] as string;
      const limit = this.binds[this.binds.length - 1] as number;
      const rows = [...this.db.rows.values()]
        .filter((row) =>
          row.cid_number === cidNumber &&
          row.binding_revision === bindingRevision &&
          row.account_id === accountId)
        .slice(0, limit);
      return { results: rows as T[] };
    }
    return { results: [] };
  }
}

function env(db: ContactsDb): Env {
  return { DB: db as unknown as D1Database, SQUARE_CACHE: sessionKv() } as unknown as Env;
}

function putRequest(
  token: string,
  contactId: string,
  encrypted: {
    binding_revision: number;
    account_id: string;
    ciphertext: string;
    nonce: string;
    mac: string;
  }
): Request {
  return new Request(`https://worker.test/square/contacts/${contactId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...encrypted, updated_at: 1_000 })
  });
}

function deleteRequest(
  token: string,
  contactId: string,
  bindingRevision: number,
  accountId: string
): Request {
  return new Request(
    `https://worker.test/square/contacts/${contactId}` +
      `?binding_revision=${bindingRevision}&account_id=${accountId}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }
  );
}

function listRequest(token: string): Request {
  return new Request('https://worker.test/square/contacts', {
    headers: { authorization: `Bearer ${token}` }
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '='
  );
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

async function contactCloudKey(
  accountSecret: Uint8Array,
  accountId: string,
  bindingRevision: number
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    arrayBuffer(accountSecret),
    'HKDF',
    false,
    ['deriveKey']
  );
  const saltMaterial = new TextEncoder().encode(
    `citizenapp.account-data/binding|${GENESIS_HASH}|${CID_X}|${bindingRevision}|${accountId}`
  );
  const salt = await crypto.subtle.digest('SHA-256', arrayBuffer(saltMaterial));
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('citizenapp.account-data/contacts-cloud')
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptContact(
  plaintext: Uint8Array,
  accountSecret: Uint8Array,
  accountId: string,
  bindingRevision: number,
  nonceOffset: number
): Promise<{
  binding_revision: number;
  account_id: string;
  ciphertext: string;
  nonce: string;
  mac: string;
}> {
  const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + nonceOffset);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: arrayBuffer(nonce), tagLength: 128 },
    await contactCloudKey(accountSecret, accountId, bindingRevision),
    arrayBuffer(plaintext)
  ));
  return {
    binding_revision: bindingRevision,
    account_id: accountId,
    ciphertext: bytesToBase64Url(sealed.slice(0, -16)),
    nonce: bytesToBase64Url(nonce),
    mac: bytesToBase64Url(sealed.slice(-16))
  };
}

async function decryptContactWithCurrentAccount(
  encrypted: {
  ciphertext: string;
  nonce: string;
  mac: string;
  },
  accountSecret: Uint8Array,
  accountId: string,
  bindingRevision: number
): Promise<Uint8Array> {
  const ciphertext = base64UrlToBytes(encrypted.ciphertext);
  const mac = base64UrlToBytes(encrypted.mac);
  const sealed = new Uint8Array(ciphertext.length + mac.length);
  sealed.set(ciphertext);
  sealed.set(mac, ciphertext.length);
  return new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(base64UrlToBytes(encrypted.nonce)),
      tagLength: 128
    },
    await contactCloudKey(accountSecret, accountId, bindingRevision),
    arrayBuffer(sealed)
  ));
}

describe('换绑不丢:同一 cid_number 的社交数据跨账户存续', () => {
  it('当前钱包签名时端侧重加密，新钱包接管后可解密且此前版本被清理', async () => {
    const db = new ContactsDb();
    const encryptedA = await encryptContact(
      CONTACT_PLAINTEXT,
      ACCOUNT_SECRET_A,
      ACCOUNT_A,
      1,
      17
    );

    // 账户 A 直接派生 contacts-cloud 子钥并写入真实 AES-GCM 密文。
    const putResponse = await putContactRoute(
      putRequest('tok-a', CONTACT_ID_A, encryptedA),
      env(db),
      CONTACT_ID_A
    );
    expect(((await putResponse.json()) as { applied: boolean }).applied).toBe(true);
    expect(db.rows.has(`${CID_X}:1:${ACCOUNT_A}:${CONTACT_ID_A}`)).toBe(true);

    // 同一个换绑确认流程内：当前账户先解密，新账户立即重加密并只在客户端暂存。
    const plaintext = await decryptContactWithCurrentAccount(
      encryptedA,
      ACCOUNT_SECRET_A,
      ACCOUNT_A,
      1
    );
    const encryptedB = await encryptContact(
      plaintext,
      ACCOUNT_SECRET_B,
      ACCOUNT_B,
      2,
      41
    );
    await expect(putContactRoute(
      putRequest('tok-a', CONTACT_ID_B, encryptedB),
      env(db),
      CONTACT_ID_B
    )).rejects.toMatchObject({ code: 'contact_binding_not_allowed' });
    expect(db.rows.has(`${CID_X}:2:${ACCOUNT_B}:${CONTACT_ID_B}`)).toBe(false);

    // 链上换绑 finalized 后，账户 B 的当前会话上传暂存密文，再回读并成功解密。
    const uploaded = await putContactRoute(
      putRequest('tok-b', CONTACT_ID_B, encryptedB),
      env(db),
      CONTACT_ID_B
    );
    expect(((await uploaded.json()) as { applied: boolean }).applied).toBe(true);
    const listResponse = await listContactsRoute(listRequest('tok-b'), env(db));
    const body = (await listResponse.json()) as {
      items: Array<{
        contact_id: string;
        ciphertext: string;
        nonce: string;
        mac: string;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].contact_id).toBe(CONTACT_ID_B);
    expect(body.items[0].ciphertext).toBe(encryptedB.ciphertext);
    expect(Array.from(await decryptContactWithCurrentAccount(
      body.items[0],
      ACCOUNT_SECRET_B,
      ACCOUNT_B,
      2
    ))).toEqual(Array.from(CONTACT_PLAINTEXT));
    await expect(decryptContactWithCurrentAccount(
      body.items[0],
      ACCOUNT_SECRET_A,
      ACCOUNT_A,
      1
    )).rejects.toThrow();

    // 新账户确认接管后清理此前绑定版本；源密文只在新版本可用之后删除。
    const deleted = await deleteContactRoute(
      deleteRequest('tok-b', CONTACT_ID_A, 1, ACCOUNT_A),
      env(db),
      CONTACT_ID_A
    );
    expect(((await deleted.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(db.rows.has(`${CID_X}:1:${ACCOUNT_A}:${CONTACT_ID_A}`)).toBe(false);
    expect(db.rows.has(`${CID_X}:2:${ACCOUNT_B}:${CONTACT_ID_B}`)).toBe(true);
    expect(((await (await listContactsRoute(listRequest('tok-a'), env(db))).json()) as {
      items: unknown[];
    }).items).toEqual([]);

    // 响应不下发属主 CID；账户和 revision 是解密所需的公开绑定上下文。
    expect(Object.keys(body.items[0]).sort()).toEqual([
      'account_id', 'binding_revision', 'ciphertext', 'contact_id', 'mac', 'nonce', 'updated_at'
    ]);
  });

  it('会员镜像按 cid_number 读取:换绑账户后同一 cid 的会员权益不丢', async () => {
    const membershipRow: MembershipRow = {
      cid_number: CID_X,
      account_id: ACCOUNT_A, // 发放时的付款账户(换绑后仍是历史事实)
      membership_level: 'democracy',
      started_at: 1,
      last_charged_at: 1,
      last_charged_price_fen: 999,
      paid_until: 9_999_999_999_999,
      subscription_status: 'active',
      finalized_block_number: 1,
      finalized_block_hash: '0x',
      verified_at: 1,
      entitlement_lapsed_at: null,
      last_tx_hash: null,
    };
    // getMembership 现按 cid_number 查(R3);换绑后新账户会话仍持有同一 cid,取回同一会员镜像。
    const membershipDb = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          first: async () =>
            sql.includes('FROM square_memberships') && binds[0] === CID_X ? membershipRow : null
        })
      })
    } as unknown as D1Database;
    const membership = await getMembership({ DB: membershipDb } as unknown as Env, CID_X);
    expect(membership?.cid_number).toBe(CID_X);
    expect(membership?.membership_level).toBe('democracy');
  });
});
