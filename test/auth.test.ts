import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoginChallenge, createSession } from '../src/auth/service';
import { cleanupExpiredSessionIndexes } from '../src/auth/session_index';
import { guardRequest } from '../src/security/request_guard';
import { hexToBytes, signingMessage } from '../src/shared/signing_message';
import { sha256Hex } from '../src/shared/hash';
import type { Env, UserRow } from '../src/types';

const ACCOUNT_ID = '0x1111111111111111111111111111111111111111111111111111111111111111';
// 身份主键 = D1 finalized 用户投影中的 cid_number；普通登录不直接读链。
const TEST_CID = 'CN220-CTZN2-198805200-2026';

function projectedUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    cid_number: TEST_CID,
    account_id: ACCOUNT_ID,
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
    ...overrides,
  };
}

interface ChallengeRow {
  challenge_id: string;
  cid_number: string;
  binding_revision: number;
  account_id: string;
  signing_payload: string;
  expires_at: number;
  used_at: number | null;
}

interface SessionIndexRow {
  session_token_hash: string;
  cid_number: string;
  binding_revision: number;
  account_id: string;
  created_at: number;
  expires_at: number;
}

class AuthStmt {
  private binds: unknown[] = [];
  constructor(private readonly db: AuthDb, private readonly sql: string) {}
  bind(...args: unknown[]): AuthStmt {
    this.binds = args;
    return this;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes('INSERT INTO square_login_challenges')) {
      this.db.challenges.set(this.binds[0] as string, {
        challenge_id: this.binds[0] as string,
        cid_number: this.binds[1] as string,
        binding_revision: this.binds[2] as number,
        account_id: this.binds[3] as string,
        signing_payload: this.binds[4] as string,
        expires_at: this.binds[5] as number,
        used_at: null
      });
      return { meta: { changes: 1 } };
    } else if (this.sql.includes('UPDATE square_login_challenges')) {
      const row = this.db.challenges.get(this.binds[1] as string);
      const cidNumber = this.binds[2] as string;
      const bindingRevision = this.binds[3] as number;
      const accountId = this.binds[4] as string;
      const claimedAt = this.binds[5] as number;
      if (
        row &&
        row.cid_number === cidNumber &&
        row.binding_revision === bindingRevision &&
        row.account_id === accountId &&
        row.used_at === null &&
        row.expires_at > claimedAt
      ) {
        row.used_at = this.binds[0] as number;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    } else if (this.sql.includes('INSERT INTO square_sessions')) {
      if (this.db.failNextSessionInsert) {
        this.db.failNextSessionInsert = false;
        throw new Error('session_index_write_failed');
      }
      this.db.sessions.set(this.binds[0] as string, {
        session_token_hash: this.binds[0] as string,
        cid_number: this.binds[1] as string,
        binding_revision: this.binds[2] as number,
        account_id: this.binds[3] as string,
        created_at: this.binds[4] as number,
        expires_at: this.binds[5] as number
      });
      return { meta: { changes: 1 } };
    } else if (this.sql.includes('DELETE FROM square_sessions WHERE session_token_hash')) {
      const deleted = this.db.sessions.delete(this.binds[0] as string);
      return { meta: { changes: deleted ? 1 : 0 } };
    } else if (this.sql.includes('DELETE FROM square_sessions WHERE expires_at')) {
      const expiresAt = this.binds[0] as number;
      let deleted = 0;
      for (const [hash, row] of this.db.sessions) {
        if (row.expires_at <= expiresAt) {
          this.db.sessions.delete(hash);
          deleted += 1;
        }
      }
      return { meta: { changes: deleted } };
    }
    return { meta: { changes: 0 } };
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM users') && this.sql.includes('WHERE account_id = ?')) {
      return ([...this.db.users.values()].find(
        (row) => row.account_id === this.binds[0],
      ) as T | undefined) ?? null;
    }
    if (this.sql.includes('FROM users') && this.sql.includes('WHERE cid_number = ?')) {
      return (this.db.users.get(this.binds[0] as string) as T | undefined) ?? null;
    }
    if (this.sql.includes('FROM square_login_challenges')) {
      return (this.db.challenges.get(this.binds[0] as string) as T) ?? null;
    }
    return null;
  }
  // 登录按当前 (cid_number, binding_revision, account_id) 取全部设备子钥（可多设备）。
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM square_device_subkeys')) {
      const cid = this.binds[0] as string;
      const bindingRevision = this.binds[1] as number;
      const accountId = this.binds[2] as string;
      const results = [...this.db.subkeys.values()]
        .filter((row) =>
          row.cid_number === cid
          && row.binding_revision === bindingRevision
          && row.account_id === accountId
        )
        .map((row) => ({ p256_public_key: row.p256_public_key }));
      return { results: results as T[] };
    }
    if (this.sql.includes('FROM square_sessions')) {
      const cidNumber = this.binds[0] as string;
      const currentHash = this.binds[1] as string;
      const results = [...this.db.sessions.values()]
        .filter((row) => row.cid_number === cidNumber)
        .sort((left, right) => {
          if (left.session_token_hash === currentHash) return -1;
          if (right.session_token_hash === currentHash) return 1;
          return right.created_at - left.created_at
            || right.session_token_hash.localeCompare(left.session_token_hash);
        })
        .map((row) => ({ session_token_hash: row.session_token_hash }));
      return { results: results as T[] };
    }
    return { results: [] };
  }
}

interface StoredSubkey {
  cid_number: string;
  device_id: string;
  binding_revision: number;
  account_id: string;
  p256_public_key: string;
}

class AuthDb {
  readonly users = new Map<string, UserRow>();
  readonly challenges = new Map<string, ChallengeRow>();
  readonly subkeys = new Map<string, StoredSubkey>();
  readonly sessions = new Map<string, SessionIndexRow>();
  failNextSessionInsert = false;
  prepare(sql: string): AuthStmt {
    return new AuthStmt(this, sql);
  }
}

class FakeKv {
  store = new Map<string, string>();
  failNextPut = false;
  async get<T>(key: string, type?: 'json'): Promise<T | string | null> {
    const value = this.store.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }
  async put(key: string, value: string): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('kv_write_failed');
    }
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function jsonBody(request: Response): Promise<Record<string, unknown>> {
  return (await request.json()) as Record<string, unknown>;
}

function req(path: string, body: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

describe('square login (op_tag OP_SIGN_SQUARE_LOGIN)', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const db = new AuthDb();
    const kv = new FakeKv();
    const env = {
      DB: db,
      SQUARE_CACHE: kv
    } as unknown as Env;
    db.users.set(TEST_CID, projectedUser());
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const pubHex = toHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const deviceId = await sha256Hex(pubHex);
    db.subkeys.set(`${TEST_CID}:${deviceId}`, {
      cid_number: TEST_CID,
      device_id: deviceId,
      binding_revision: 1,
      account_id: ACCOUNT_ID,
      p256_public_key: pubHex
    });
    return { db, kv, env, keyPair };
  }

  async function signChallenge(
    keyPair: CryptoKeyPair,
    opTag: number,
    payloadHex: string
  ): Promise<string> {
    const message = signingMessage(opTag, hexToBytes(payloadHex));
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      message
    );
    // 跨端签名文本统一带 `0x`（ADR-041）；后端入口 normalize 为裸后验签。
    return `0x${toHex(sig)}`;
  }

  // 中文注释：缺少链配置代表服务侧不可用，不构成账户确实未绑定的证据。
  it('用户投影不可用时不把 D1 缺失账户误报成未绑定', async () => {
    const db = new AuthDb();
    const env = {
      DB: db,
      SQUARE_CACHE: new FakeKv(),
    } as unknown as Env;

    await expect(
      createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env),
    ).rejects.toMatchObject({
      status: 503,
      code: 'identity_projection_unavailable',
    });
  });

  it('按 D1 finalized 用户投影归属挑战，未配置链 RPC 也能完成登录', async () => {
    const { env, db, kv, keyPair } = await setup();

    const challenge = await jsonBody(
      await createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env)
    );
    expect(challenge.op_tag).toBe(0x1b);
    expect(challenge.cid_number).toBe(TEST_CID);
    expect(typeof challenge.signing_payload_hex).toBe('string');
    // 只下发 32 字节摘要，不下发任何字符串域。
    expect(challenge.signing_payload_hex).not.toContain('GMB');

    const signature = await signChallenge(
      keyPair,
      challenge.op_tag as number,
      challenge.signing_payload_hex as string
    );
    const session = await jsonBody(
      await createSession(
        req('/square/auth/session', {
          account_id: ACCOUNT_ID,
          challenge_id: challenge.challenge_id,
          signature
        }),
        env
      )
    );
    expect(session.ok).toBe(true);
    expect(typeof session.session_token).toBe('string');
    const sessionToken = session.session_token as string;
    const sessionTokenHash = await sha256Hex(sessionToken);
    expect(kv.store.has(`square_session:${sessionTokenHash}`)).toBe(true);
    expect([...kv.store.keys()].join('\n')).not.toContain(sessionToken);
    expect(db.sessions.get(sessionTokenHash)).toMatchObject({
      cid_number: TEST_CID,
      binding_revision: 1,
      account_id: ACCOUNT_ID
    });
  });

  it('rejects a signature over the wrong message', async () => {
    const { env, keyPair } = await setup();
    const challenge = await jsonBody(
      await createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env)
    );
    // 对错误 payload 签名 → 摘要不符 → 拒。
    const badSignature = await signChallenge(keyPair, 0x1b, '00'.repeat(8));
    await expect(
      createSession(
        req('/square/auth/session', {
          account_id: ACCOUNT_ID,
          challenge_id: challenge.challenge_id,
          signature: badSignature
        }),
        env
      )
    ).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('挑战签发后 D1 finalized 用户投影发生换绑时拒绝创建 Session', async () => {
    const { env, db } = await setup();
    const challenge = await jsonBody(
      await createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env)
    );
    db.users.set(TEST_CID, projectedUser({
      account_id: `0x${'2'.repeat(64)}`,
      binding_revision: 2,
      binding_finalized_block_number: 2,
      binding_finalized_block_hash: `0x${'2'.repeat(64)}`,
      binding_updated_at: 2,
    }));

    await expect(
      createSession(
        req('/square/auth/session', {
          account_id: ACCOUNT_ID,
          challenge_id: challenge.challenge_id,
          signature: `0x${'00'.repeat(64)}`
        }),
        env
      )
    ).rejects.toMatchObject({ code: 'cid_binding_changed' });
  });

  it('并发提交同一挑战时只签发一个 Session', async () => {
    const { env, db, kv, keyPair } = await setup();
    const challenge = await jsonBody(
      await createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env)
    );
    const signature = await signChallenge(
      keyPair,
      challenge.op_tag as number,
      challenge.signing_payload_hex as string
    );
    const requestBody = {
      account_id: ACCOUNT_ID,
      challenge_id: challenge.challenge_id,
      signature
    };

    const results = await Promise.allSettled([
      createSession(req('/square/auth/session', requestBody), env),
      createSession(req('/square/auth/session', requestBody), env)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'used_challenge' } });
    expect(db.challenges.get(challenge.challenge_id as string)?.used_at).not.toBeNull();
    expect([...kv.store.keys()].filter((key) => key.startsWith('square_session:'))).toHaveLength(1);
    expect(db.sessions.size).toBe(1);
  });

  it('KV 写入失败后仍烧毁挑战且不留下孤立 Session', async () => {
    const { env, db, kv, keyPair } = await setup();
    const challenge = await jsonBody(
      await createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env)
    );
    const signature = await signChallenge(
      keyPair,
      challenge.op_tag as number,
      challenge.signing_payload_hex as string
    );
    kv.failNextPut = true;

    await expect(
      createSession(
        req('/square/auth/session', {
          account_id: ACCOUNT_ID,
          challenge_id: challenge.challenge_id,
          signature
        }),
        env
      )
    ).rejects.toThrow('kv_write_failed');
    expect(db.challenges.get(challenge.challenge_id as string)?.used_at).not.toBeNull();
    expect([...kv.store.keys()].filter((key) => key.startsWith('square_session:'))).toHaveLength(0);
    expect(db.sessions.size).toBe(0);
    await expect(
      createSession(
        req('/square/auth/session', {
          account_id: ACCOUNT_ID,
          challenge_id: challenge.challenge_id,
          signature
        }),
        env
      )
    ).rejects.toMatchObject({ code: 'used_challenge' });
  });

  it('D1 哈希索引写入失败时回滚 KV，且不保存明文 token', async () => {
    const { env, db, kv, keyPair } = await setup();
    const challenge = await jsonBody(
      await createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env)
    );
    const signature = await signChallenge(
      keyPair,
      challenge.op_tag as number,
      challenge.signing_payload_hex as string
    );
    db.failNextSessionInsert = true;

    await expect(
      createSession(
        req('/square/auth/session', {
          account_id: ACCOUNT_ID,
          challenge_id: challenge.challenge_id,
          signature
        }),
        env
      )
    ).rejects.toThrow('session_index_write_failed');

    expect(db.challenges.get(challenge.challenge_id as string)?.used_at).not.toBeNull();
    expect(kv.store.size).toBe(0);
    expect(db.sessions.size).toBe(0);
  });

  it('定时清理仅删除已经过期的 D1 会话哈希索引', async () => {
    const { env, db } = await setup();
    db.sessions.set('a'.repeat(64), {
      session_token_hash: 'a'.repeat(64),
      cid_number: TEST_CID,
      binding_revision: 1,
      account_id: ACCOUNT_ID,
      created_at: 1,
      expires_at: 999
    });
    db.sessions.set('b'.repeat(64), {
      session_token_hash: 'b'.repeat(64),
      cid_number: TEST_CID,
      binding_revision: 1,
      account_id: ACCOUNT_ID,
      created_at: 1,
      expires_at: 1001
    });

    await cleanupExpiredSessionIndexes(env, 1000);

    expect([...db.sessions.keys()]).toEqual(['b'.repeat(64)]);
  });

  it('签发新 Session 后只保留当前 CID 最新 8 个 KV 与 D1 索引', async () => {
    const { env, db, kv, keyPair } = await setup();
    for (let index = 0; index < 8; index += 1) {
      const hash = index.toString(16).padStart(64, '0');
      db.sessions.set(hash, {
        session_token_hash: hash,
        cid_number: TEST_CID,
        binding_revision: 1,
        account_id: ACCOUNT_ID,
        created_at: index + 1,
        expires_at: Date.now() + 60_000,
      });
      kv.store.set(`square_session:${hash}`, '{}');
    }
    const challenge = await jsonBody(
      await createLoginChallenge(req('/square/auth/challenge', { account_id: ACCOUNT_ID }), env),
    );
    const signature = await signChallenge(
      keyPair,
      challenge.op_tag as number,
      challenge.signing_payload_hex as string,
    );

    await createSession(req('/square/auth/session', {
      account_id: ACCOUNT_ID,
      challenge_id: challenge.challenge_id,
      signature,
    }), env);

    expect(db.sessions.size).toBe(8);
    expect(kv.store.has(`square_session:${'0'.repeat(64)}`)).toBe(false);
    expect([...kv.store.keys()].filter((key) => key.startsWith('square_session:'))).toHaveLength(8);
  });
});

describe('受保护请求 D1 finalized 绑定复查', () => {
  it('CID 已换绑时拒绝此前 binding_revision/account_id 的残留会话', async () => {
    const db = new AuthDb();
    const kv = new FakeKv();
    const env = { DB: db, SQUARE_CACHE: kv } as unknown as Env;
    const token = 'stale-session-token';
    kv.store.set(
      `square_session:${await sha256Hex(token)}`,
      JSON.stringify({
        cid_number: TEST_CID,
        binding_revision: 1,
        account_id: ACCOUNT_ID,
        device_key_hash: 'a'.repeat(64),
        created_at: Date.now(),
        expires_at: Date.now() + 60_000
      })
    );
    db.users.set(TEST_CID, projectedUser({
      account_id: `0x${'2'.repeat(64)}`,
      binding_revision: 2,
      binding_finalized_block_number: 2,
      binding_finalized_block_hash: `0x${'2'.repeat(64)}`,
      binding_updated_at: 2,
    }));
    const request = new Request('https://worker.test/square/feed/recommended', {
      headers: { authorization: `Bearer ${token}` }
    });

    await expect(guardRequest(request, env, '/square/feed/recommended'))
      .rejects.toMatchObject({ status: 401, code: 'cid_binding_changed' });
  });
});
