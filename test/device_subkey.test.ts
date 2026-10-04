import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/auth/wallet_signature', () => ({
  verifyWalletSignature: vi.fn()
}));
vi.mock('../src/security/turnstile', () => ({
  verifyTurnstile: vi.fn()
}));
// 身份主键 = D1 finalized 用户投影中的 cid_number；P-256 设备子钥登记不直接读链。
const TEST_CID = 'CN220-CTZN2-198805200-2026';

import {
  assertP256PublicKeyHex,
  buildDeviceBindingSigningMessage,
  DEVICE_SKEW_MS,
  normalizeP256SignatureHex,
  verifyP256Signature
} from '../src/auth/device_subkey';
import { registerDeviceSubkey } from '../src/auth/service';
import { verifyWalletSignature } from '../src/auth/wallet_signature';
import type { Env, UserRow } from '../src/types';
import {
  OP_SIGN_SQUARE_DEVICE_BIND,
  bytesToHex,
  concatBytes,
  scaleString,
  signingMessage,
  u64Le
} from '../src/shared/signing_message';

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 设备绑定是唯一「客户端 + Worker 双侧各自 SCALE 编码」的流，须逐字节对齐。
// 该 golden hex 必须与 App 端 test/signer/device_binding_golden_test.dart 完全一致。
const DEVICE_BIND_INPUT = {
  cid_number: TEST_CID,
  binding_revision: 1,
  account_id: '0x1111111111111111111111111111111111111111111111111111111111111111',
  p256_public_key: '04' + 'ab'.repeat(64),
  issued_at: 1_700_000_000_000
};
const DEVICE_BIND_GOLDEN_HEX =
  'a12230133532467b7757ae9597b36255ba0228aaa2fe595b8975283d5efe148e';
const mockVerify = verifyWalletSignature as unknown as ReturnType<typeof vi.fn>;

function projectedUser(): UserRow {
  return {
    cid_number: TEST_CID,
    account_id: DEVICE_BIND_INPUT.account_id,
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

interface StoredSubkey {
  cid_number: string;
  device_id: string;
  binding_revision: number;
  account_id: string;
  p256_public_key: string;
  issued_at: number;
  created_at: number;
  updated_at: number;
}

interface StoredBindingCredential {
  cid_number: string;
  binding_revision: number;
  account_id: string;
}

// 主键 (cid_number, device_id);绑定序对齐 service.ts 的 upsert:
// (cid_number, device_id, binding_revision, account_id, p256_public_key, issued_at,
// created_at, updated_at)。
class DeviceStmt {
  private binds: unknown[] = [];
  constructor(
    private readonly db: DeviceDb,
    private readonly sql: string,
  ) {}
  bind(...args: unknown[]): DeviceStmt {
    this.binds = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM users') && this.sql.includes('WHERE account_id = ?')) {
      return this.db.user.account_id === this.binds[0]
        ? this.db.user as T
        : null;
    }
    return null;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const rows = this.db.rows;
    if (this.sql.startsWith('DELETE FROM')) this.db.deletes.push(this.sql);
    if (this.sql.includes('DELETE FROM square_sessions')) {
      return { meta: { changes: this.db.purgeStale(this.db.sessions, this.binds) } };
    }
    if (this.sql.includes('DELETE FROM square_login_challenges')) {
      return { meta: { changes: this.db.purgeStale(this.db.loginChallenges, this.binds) } };
    }
    if (this.sql.includes('DELETE FROM push_endpoints')) {
      return { meta: { changes: this.db.purgeStale(this.db.pushEndpoints, this.binds) } };
    }
    if (this.sql.includes('DELETE FROM square_device_subkeys')) {
      const cidNumber = this.binds[0] as string;
      const bindingRevision = this.binds[1] as number;
      const accountId = this.binds[2] as string;
      let changes = 0;
      for (const [key, row] of rows) {
        if (
          row.cid_number === cidNumber &&
          (row.binding_revision !== bindingRevision || row.account_id !== accountId)
        ) {
          rows.delete(key);
          changes++;
        }
      }
      return { meta: { changes } };
    }
    if (this.sql.startsWith('DELETE FROM')) {
      return { meta: { changes: 0 } };
    }
    const cidNumber = this.binds[0] as string;
    const deviceId = this.binds[1] as string;
    const key = `${cidNumber}:${deviceId}`;
    const bindingRevision = this.binds[2] as number;
    const issuedAt = this.binds[5] as number;
    const current = rows.get(key);
    if (
      current
      && bindingRevision <= current.binding_revision
      && issuedAt <= current.issued_at
    ) {
      return { meta: { changes: 0 } };
    }
    rows.set(key, {
      cid_number: cidNumber,
      device_id: deviceId,
      binding_revision: bindingRevision,
      account_id: this.binds[3] as string,
      p256_public_key: this.binds[4] as string,
      issued_at: issuedAt,
      created_at: current?.created_at ?? (this.binds[6] as number),
      updated_at: this.binds[7] as number
    });
    return { meta: { changes: 1 } };
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('SELECT session_token_hash') && this.sql.includes('FROM square_sessions')) {
      const [cidNumber, bindingRevision, accountId] = this.binds as [string, number, string];
      const results = [...this.db.sessions.entries()]
        .filter(([, row]) =>
          row.cid_number === cidNumber
          && (row.binding_revision !== bindingRevision || row.account_id !== accountId)
        )
        .map(([sessionTokenHash]) => ({ session_token_hash: sessionTokenHash })) as T[];
      return { results };
    }
    return { results: [] };
  }
}

class DeviceDb {
  readonly user = projectedUser();
  readonly rows = new Map<string, StoredSubkey>();
  readonly sessions = new Map<string, StoredBindingCredential>();
  readonly loginChallenges = new Map<string, StoredBindingCredential>();
  readonly pushEndpoints = new Map<string, StoredBindingCredential>();
  readonly deletes: string[] = [];

  purgeStale(
    rows: Map<string, StoredBindingCredential>,
    binds: unknown[],
  ): number {
    const [cidNumber, bindingRevision, accountId] = binds as [string, number, string];
    let changes = 0;
    for (const [key, row] of rows) {
      if (
        row.cid_number === cidNumber
        && (row.binding_revision !== bindingRevision || row.account_id !== accountId)
      ) {
        rows.delete(key);
        changes++;
      }
    }
    return changes;
  }

  prepare(sql: string): DeviceStmt {
    return new DeviceStmt(this, sql);
  }
  async batch(statements: DeviceStmt[]): Promise<Array<{ meta: { changes: number } }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class DeviceCache {
  readonly keys = new Set<string>();
  readonly deleted: string[] = [];

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.keys.delete(key);
  }
}

function deviceEnv(db = new DeviceDb(), options: { cache?: DeviceCache } = {}): Env {
  const cache = options.cache ?? new DeviceCache();
  return {
    DB: db,
    SQUARE_CACHE: cache,
  } as unknown as Env;
}

function registerRequest(issuedAt: number, publicKey = `0x04${'a'.repeat(128)}`): Request {
  return new Request('https://worker.test/square/auth/device/register', {
    method: 'POST',
    body: JSON.stringify({
      account_id: DEVICE_BIND_INPUT.account_id,
      p256_public_key: publicKey,
      issued_at: issuedAt,
      binding_signature: `0x${'1'.repeat(128)}`
    })
  });
}

describe('buildDeviceBindingSigningMessage', () => {
  it('is signing_message(OP_SIGN_SQUARE_DEVICE_BIND, CID ‖ revision ‖ account ‖ pubkey ‖ issued_at)', () => {
    const message = buildDeviceBindingSigningMessage(DEVICE_BIND_INPUT);
    expect(message.length).toBe(32);
    // 字段顺序锁：cid_number → binding_revision → account_id → p256_public_key → issued_at。
    const expected = signingMessage(
      OP_SIGN_SQUARE_DEVICE_BIND,
      concatBytes(
        scaleString(DEVICE_BIND_INPUT.cid_number),
        u64Le(DEVICE_BIND_INPUT.binding_revision),
        scaleString(DEVICE_BIND_INPUT.account_id),
        scaleString(DEVICE_BIND_INPUT.p256_public_key),
        u64Le(DEVICE_BIND_INPUT.issued_at)
      )
    );
    expect(bytesToHex(message)).toBe(bytesToHex(expected));
  });

  it('matches the cross-language golden hex (App ⇔ Worker)', () => {
    expect(bytesToHex(buildDeviceBindingSigningMessage(DEVICE_BIND_INPUT))).toBe(
      DEVICE_BIND_GOLDEN_HEX
    );
  });
});

describe('assertP256PublicKeyHex', () => {
  it('accepts only the canonical lowercase 0x-prefixed 65-byte point and returns bare (ADR-041)', () => {
    const bare = '04' + 'a'.repeat(128);
    // 跨端文本须带 0x；返回值 strip 为裸供内部 SCALE/存储/hash 使用。
    expect(assertP256PublicKeyHex('0x' + bare)).toBe(bare);
    expect(() => assertP256PublicKeyHex(bare)).toThrow(); // 裸 → 拒
    expect(() => assertP256PublicKeyHex('0x' + bare.toUpperCase())).toThrow(); // 大写 → 拒
  });

  it('rejects wrong length or prefix', () => {
    expect(() => assertP256PublicKeyHex('0x05' + 'a'.repeat(128))).toThrow();
    expect(() => assertP256PublicKeyHex('0x04' + 'a'.repeat(120))).toThrow();
    expect(() => assertP256PublicKeyHex(123)).toThrow();
  });
});

describe('normalizeP256SignatureHex', () => {
  it('accepts only the canonical 0x-prefixed 64-byte signature and returns bare (ADR-041)', () => {
    const bare = 'a'.repeat(128);
    expect(normalizeP256SignatureHex('0x' + bare)).toBe(bare);
    expect(normalizeP256SignatureHex(bare)).toBeNull(); // 裸 → null
    expect(normalizeP256SignatureHex('0x' + bare.toUpperCase())).toBeNull(); // 大写 → null
    expect(normalizeP256SignatureHex('0x' + 'a'.repeat(120))).toBeNull(); // 错长 → null
    expect(normalizeP256SignatureHex(123)).toBeNull();
  });
});

describe('verifyP256Signature', () => {
  it('accepts a valid ES256 signature over the message digest and rejects tampering', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const pubHex = toHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const message = signingMessage(0x1b, scaleString('login-challenge'));
    const sigHex = toHex(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        message
      )
    );

    expect(await verifyP256Signature(message, sigHex, pubHex)).toBe(true);
    // verifyP256Signature 是内部裸函数：0x 前缀须由边界（normalizeP256SignatureHex /
    // assertP256PublicKeyHex）先 strip；函数本身拒绝任何带 0x 的输入（ADR-041）。
    expect(await verifyP256Signature(message, '0x' + sigHex, '0x' + pubHex)).toBe(false);
    // 篡改 message → 拒
    const tampered = signingMessage(0x1b, scaleString('login-challenge-x'));
    expect(await verifyP256Signature(tampered, sigHex, pubHex)).toBe(false);
  });

  it('rejects malformed signature or pubkey', async () => {
    const message = new Uint8Array(32).fill(7);
    expect(await verifyP256Signature(message, 'zz', '04' + '0'.repeat(128))).toBe(false);
    expect(
      await verifyP256Signature(message, '0'.repeat(128), '05' + '0'.repeat(128))
    ).toBe(false);
  });
});

describe('registerDeviceSubkey 原子单调更新', () => {
  beforeEach(() => {
    mockVerify.mockReset();
    mockVerify.mockResolvedValue(true);
  });

  it('同设备严格单调更新,新设备独立成行', async () => {
    const db = new DeviceDb();
    const env = deviceEnv(db);
    const now = Date.now();
    const pubA = `04${'a'.repeat(128)}`;
    const pubB = `04${'b'.repeat(128)}`;
    const rowFor = (pub: string) =>
      [...db.rows.values()].find((row) => row.p256_public_key === pub);

    // 设备 a 首次注册：挂在 D1 finalized 用户投影的 cid_number 下。
    await expect(registerDeviceSubkey(registerRequest(now), env)).resolves.toBeInstanceOf(Response);
    expect(rowFor(pubA)?.issued_at).toBe(now);
    expect(rowFor(pubA)?.cid_number).toBe(TEST_CID);

    // 同设备:相同/更早 issued_at 一律 stale。
    await expect(registerDeviceSubkey(registerRequest(now), env))
      .rejects.toMatchObject({ code: 'stale_device_binding' });
    await expect(registerDeviceSubkey(registerRequest(now - 1), env))
      .rejects.toMatchObject({ code: 'stale_device_binding' });

    // 同设备:更晚 issued_at → 覆盖更新。
    await expect(registerDeviceSubkey(registerRequest(now + 1), env)).resolves.toBeInstanceOf(Response);
    expect(rowFor(pubA)?.issued_at).toBe(now + 1);

    // 新设备 b(不同 P-256 = 不同 device_id)→ 独立成行,不覆盖 a。
    await expect(registerDeviceSubkey(registerRequest(now + 1, `0x${pubB}`), env)).resolves.toBeInstanceOf(Response);
    expect(rowFor(pubB)?.p256_public_key).toBe(pubB);
    expect(db.rows.size).toBe(2);
    expect(rowFor(pubA)?.issued_at).toBe(now + 1);
  });

  it('拒绝非安全整数以及超出五分钟窗口的时间戳', async () => {
    const env = deviceEnv();
    await expect(
      registerDeviceSubkey(registerRequest(Date.now() - DEVICE_SKEW_MS - 1), env)
    ).rejects.toMatchObject({ code: 'invalid_issued_at' });
    await expect(
      registerDeviceSubkey(registerRequest(Date.now() + DEVICE_SKEW_MS + 1_000), env)
    ).rejects.toMatchObject({ code: 'invalid_issued_at' });
    await expect(
      registerDeviceSubkey(registerRequest(Number.MAX_SAFE_INTEGER + 1), env)
    ).rejects.toMatchObject({ code: 'invalid_issued_at' });
  });

  it('当前新设备上岗后才清理同一 CID 的此前 revision/此前账户子钥', async () => {
    const db = new DeviceDb();
    const cache = new DeviceCache();
    const previousAccountId = `0x${'2'.repeat(64)}`;
    const stale = {
      cid_number: TEST_CID,
      binding_revision: 0,
      account_id: previousAccountId,
    };
    const current = {
      cid_number: TEST_CID,
      binding_revision: 1,
      account_id: DEVICE_BIND_INPUT.account_id,
    };
    db.rows.set('old', {
      cid_number: TEST_CID,
      device_id: 'old',
      binding_revision: 0,
      account_id: previousAccountId,
      p256_public_key: `04${'c'.repeat(128)}`,
      issued_at: 1,
      created_at: 1,
      updated_at: 1,
    });
    db.sessions.set('stale-session', stale);
    db.sessions.set('current-session', current);
    db.loginChallenges.set('stale-challenge', stale);
    db.loginChallenges.set('current-challenge', current);
    db.pushEndpoints.set('stale-push-endpoint', stale);
    db.pushEndpoints.set('current-push-endpoint', current);
    cache.keys.add('square_session:stale-session');
    cache.keys.add('square_session:current-session');
    await registerDeviceSubkey(
      registerRequest(Date.now()),
      deviceEnv(db, { cache }),
    );
    expect([...db.rows.values()].some((row) => row.device_id === 'old')).toBe(false);
    expect([...db.rows.values()]).toHaveLength(1);
    expect([...db.rows.values()][0]?.account_id).toBe(DEVICE_BIND_INPUT.account_id);
    expect(db.sessions.has('stale-session')).toBe(false);
    expect(db.sessions.has('current-session')).toBe(true);
    expect(cache.keys.has('square_session:stale-session')).toBe(false);
    expect(cache.keys.has('square_session:current-session')).toBe(true);
    expect(db.loginChallenges.has('stale-challenge')).toBe(false);
    expect(db.loginChallenges.has('current-challenge')).toBe(true);
    expect(db.pushEndpoints.has('stale-push-endpoint')).toBe(false);
    expect(db.pushEndpoints.has('current-push-endpoint')).toBe(true);
    expect(db.deletes.join('\n')).toContain('DELETE FROM square_login_challenges');
  });
});
