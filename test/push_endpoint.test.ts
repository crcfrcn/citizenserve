import { describe, expect, it } from 'vitest';

import { cleanupExpiredPushEndpoints, registerPushEndpoint } from '../src/auth/push_endpoint';
import type { Env, SessionState } from '../src/types';

const SESSION_TOKEN = 'test-session';
const CID_NUMBER = 'CN220-CTZN2-198805200-2026';
const ACCOUNT_ID = `0x${'1'.repeat(64)}`;
const DEVICE_KEY_HASH = 'a'.repeat(64);

interface ExistingEndpoint {
  binding_revision: number;
  account_id: string;
  push_provider: string;
  push_token: string;
  apns_environment: string | null;
  expires_at: number;
}

class PushDb {
  readonly sql: string[] = [];
  readonly writes: Array<{ sql: string; values: unknown[] }> = [];

  constructor(
    readonly existing: ExistingEndpoint | null = null,
    readonly activeCount = 0,
  ) {}

  prepare(sql: string): PushStatement {
    this.sql.push(sql);
    return new PushStatement(this, sql);
  }
}

class PushStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: PushDb,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): PushStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('SELECT binding_revision')) return this.db.existing as T | null;
    if (this.sql.includes('SELECT COUNT(*)')) return { n: this.db.activeCount } as T;
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.db.writes.push({ sql: this.sql, values: [...this.values] });
    return { meta: { changes: 1 } };
  }
}

class SessionCache {
  async get<T>(key: string): Promise<T | null> {
    if (key !== 'square_session:4943e43bc034c8bf90e1c2895796b954d3c34dc90afe838448dee6678fa765f8') {
      return null;
    }
    return {
      cid_number: CID_NUMBER,
      binding_revision: 3,
      account_id: ACCOUNT_ID,
      device_key_hash: DEVICE_KEY_HASH,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    } as SessionState as T;
  }
}

function env(db: PushDb): Env {
  return {
    DB: db as unknown as D1Database,
    SQUARE_CACHE: new SessionCache() as unknown as KVNamespace,
  } as Env;
}

function request(
  body: Record<string, unknown> = {},
): Request {
  return new Request('https://worker.test/square/push-endpoint', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${SESSION_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      push_provider: 'fcm',
      push_token: 'fcm-token-1234567890',
      apns_environment: null,
      expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
      ...body,
    }),
  });
}

describe('ordinary application push endpoint', () => {
  it('binds the token to the authenticated session device without chat fields', async () => {
    const db = new PushDb();
    const response = await registerPushEndpoint(request(), env(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.sql.join('\n')).toContain('FROM push_endpoints');
    expect(db.sql.join('\n')).not.toContain('chat_');
    const insert = db.writes.find(({ sql }) => sql.includes('INSERT INTO push_endpoints'));
    expect(insert?.values.slice(0, 4)).toEqual([
      CID_NUMBER,
      3,
      ACCOUNT_ID,
      DEVICE_KEY_HASH,
    ]);
  });

  it('returns the still-fresh identical endpoint without a database write', async () => {
    const expiresAt = Date.now() + 80 * 24 * 60 * 60 * 1000;
    const db = new PushDb({
      binding_revision: 3,
      account_id: ACCOUNT_ID,
      push_provider: 'fcm',
      push_token: 'fcm-token-1234567890',
      apns_environment: null,
      expires_at: expiresAt,
    });
    const response = await registerPushEndpoint(request(), env(db));
    await expect(response.json()).resolves.toEqual({ ok: true, expires_at: expiresAt });
    expect(db.writes).toHaveLength(0);
  });

  it('rejects extra fields, invalid APNs state, excessive lifetime and device overflow', async () => {
    await expect(registerPushEndpoint(request({ unexpected: true }), env(new PushDb())))
      .rejects.toMatchObject({ code: 'invalid_push_endpoint_fields' });
    await expect(registerPushEndpoint(request({
      push_provider: 'apns',
      apns_environment: null,
    }), env(new PushDb()))).rejects.toMatchObject({ code: 'invalid_apns_environment' });
    await expect(registerPushEndpoint(request({
      expires_at: Date.now() + 91 * 24 * 60 * 60 * 1000,
    }), env(new PushDb()))).rejects.toMatchObject({ code: 'push_endpoint_ttl_exceeded' });
    await expect(registerPushEndpoint(request(), env(new PushDb(null, 8))))
      .rejects.toMatchObject({ code: 'push_endpoint_limit_reached' });
  });

  it('cleans only expired ordinary application endpoints', async () => {
    const db = new PushDb();
    await cleanupExpiredPushEndpoints(env(db), 1234);
    expect(db.writes).toEqual([{
      sql: 'DELETE FROM push_endpoints WHERE expires_at <= ?',
      values: [1234],
    }]);
  });
});
