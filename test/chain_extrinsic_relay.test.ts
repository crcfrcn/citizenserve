import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeRequest } from '../src/routes';
import type { Env } from '../src/types';

const signedExtrinsicHex = '0x01020304';
const txHash = `0x${'22'.repeat(32)}`;

describe('chain signed extrinsic relay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits a signed extrinsic through author_submitExtrinsic without exposing RPC', async () => {
    const db = new FakeDb();
    const env = fakeEnv({ db });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          id: string;
          method: string;
          params: string[];
        };
        const headers = new Headers(init.headers);
        expect(url).toBe('https://rpc.internal.example/');
        expect(body.method).toBe('author_submitExtrinsic');
        expect(body.params).toEqual([signedExtrinsicHex]);
        expect(headers.get('CF-Access-Client-Id')).toBe('worker-rpc.access');
        expect(headers.get('CF-Access-Client-Secret')).toBe('test-access-secret');
        expect(init.redirect).toBe('manual');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ jsonrpc: '2.0', id: body.id, result: txHash });
      })
    );

    const response = await routeRequest(relayRequest({ signed_extrinsic_hex: signedExtrinsicHex }), env);
    const body = (await response.json()) as {
      ok: boolean;
      schema: string;
      relay_status: string;
      tx_hash: string;
    };

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      ok: true,
      schema: 'citizenapp.chain.extrinsic_relay',
      relay_status: 'broadcast',
      tx_hash: txHash
    });
    expect(JSON.stringify(body)).not.toContain('rpc.internal.example');
    expect(db.relays[0]).toMatchObject({
      relay_status: 'broadcast',
      tx_hash: txHash
    });
  });

  it('deduplicates a recent successful relay instead of calling RPC again', async () => {
    const db = new FakeDb();
    const env = fakeEnv({ db });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: txHash });
    });
    vi.stubGlobal('fetch', fetchMock);

    await routeRequest(relayRequest({ signed_extrinsic_hex: signedExtrinsicHex }), env);
    const second = await routeRequest(relayRequest({ signed_extrinsic_hex: signedExtrinsicHex }), env);
    const body = (await second.json()) as { deduplicated: boolean; tx_hash: string };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      deduplicated: true,
      tx_hash: txHash
    });
  });

  it('rejects disabled relay before reading the RPC secret', async () => {
    await expect(
      routeRequest(
        relayRequest({ signed_extrinsic_hex: signedExtrinsicHex }),
        fakeEnv({ enabled: false })
      )
    ).rejects.toMatchObject({ code: 'chain_extrinsic_relay_disabled' });
  });

  it('rejects invalid hex and private material fields', async () => {
    const env = fakeEnv();

    await expect(
      routeRequest(relayRequest({ signed_extrinsic_hex: 'not-hex' }), env)
    ).rejects.toMatchObject({ code: 'chain_extrinsic_relay_invalid_hex' });

    await expect(
      routeRequest(
        relayRequest({
          signed_extrinsic_hex: signedExtrinsicHex,
          private_key: '0xdeadbeef'
        }),
        env
      )
    ).rejects.toMatchObject({
      code: 'chain_extrinsic_relay_private_material_rejected'
    });
  });

  it('rate limits by request IP hash before calling RPC', async () => {
    const db = new FakeDb();
    const env = fakeEnv({
      db,
      maxPerMinute: '1'
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: string };
        return Response.json({ jsonrpc: '2.0', id: body.id, result: txHash });
      })
    );

    await routeRequest(relayRequest({ signed_extrinsic_hex: signedExtrinsicHex }), env);
    await expect(
      routeRequest(relayRequest({ signed_extrinsic_hex: '0x05060708' }), env)
    ).rejects.toMatchObject({ code: 'chain_extrinsic_relay_rate_limited' });
  });

  it('records timeout and transport failures with distinct audit codes', async () => {
    const timeoutDb = new FakeDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('timed out', 'TimeoutError');
      })
    );
    await expect(
      routeRequest(
        relayRequest({ signed_extrinsic_hex: signedExtrinsicHex }),
        fakeEnv({ db: timeoutDb })
      )
    ).rejects.toMatchObject({ code: 'chain_rpc_timeout' });
    expect(timeoutDb.relays[0]?.error_code).toBe('chain_rpc_timeout');

    const transportDb = new FakeDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      })
    );
    await expect(
      routeRequest(
        relayRequest({ signed_extrinsic_hex: '0x05060708' }),
        fakeEnv({ db: transportDb })
      )
    ).rejects.toMatchObject({ code: 'chain_rpc_transport_failed' });
    expect(transportDb.relays[0]?.error_code).toBe('chain_rpc_transport_failed');
  });

  it('records JSON-RPC semantic rejection without retrying', async () => {
    const db = new FakeDb();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { id: string };
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: 1010, message: 'Invalid Transaction' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      routeRequest(relayRequest({ signed_extrinsic_hex: signedExtrinsicHex }), fakeEnv({ db }))
    ).rejects.toMatchObject({ code: 'chain_rpc_rejected' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.relays[0]?.error_code).toBe('chain_rpc_rejected');
  });
});

function relayRequest(body: Record<string, unknown>): Request {
  const encoded = JSON.stringify(body);
  return new Request('https://api.onchina.org/chain/extrinsics/relay', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(encoded).byteLength),
      'cf-connecting-ip': '203.0.113.10'
    },
    body: encoded
  });
}

function fakeEnv(input: {
  db?: FakeDb;
  enabled?: boolean;
  maxPerMinute?: string;
} = {}): Env {
  return {
    DB: (input.db ?? new FakeDb()) as unknown as D1Database,
    SQUARE_PRIVATE: {} as R2Bucket,
    SQUARE_PUBLIC_MEDIA: {} as R2Bucket,
    SQUARE_CACHE: {} as KVNamespace,
    CHAIN_URL: 'https://rpc.internal.example',
    CHAIN_ID: 'worker-rpc.access',
    CHAIN_SECRET: 'test-access-secret',
    HASH_KEY: 'test-relay-ip-hash-key',
    RATE_WRITE: {
      limit: async () => ({ success: true }),
    },
    RELAY_ENABLED: input.enabled === false ? '0' : '1',
    RELAY_PER_MINUTE: input.maxPerMinute
  };
}

interface RelayRow {
  relay_id: string;
  extrinsic_sha256: string;
  tx_hash: string | null;
  request_ip_hash: string;
  byte_size: number;
  relay_status: string;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

class FakeDb {
  readonly relays: RelayRow[] = [];

  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]): FakeStmt {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('COUNT(*) AS count')) {
      const requestIpHash = this.args[0] as string;
      const since = this.args[1] as number;
      return {
        count: this.db.relays.filter(
          (row) => row.request_ip_hash === requestIpHash && row.created_at >= since
        ).length
      } as T;
    }
    if (this.sql.includes('FROM chain_extrinsic_relays') && this.sql.includes('relay_status')) {
      const extrinsicSha256 = this.args[0] as string;
      const since = this.args[1] as number;
      const found = [...this.db.relays]
        .filter(
          (row) =>
            row.extrinsic_sha256 === extrinsicSha256 &&
            row.relay_status === 'broadcast' &&
            row.tx_hash !== null &&
            row.created_at >= since
        )
        .sort((a, b) => b.created_at - a.created_at)[0];
      return (found
        ? {
            relay_id: found.relay_id,
            tx_hash: found.tx_hash,
            created_at: found.created_at
          }
        : null) as T | null;
    }
    return null;
  }

  async run(): Promise<{ success: boolean }> {
    if (this.sql.includes('INSERT INTO chain_extrinsic_relays')) {
      this.db.relays.push({
        relay_id: this.args[0] as string,
        extrinsic_sha256: this.args[1] as string,
        tx_hash: null,
        request_ip_hash: this.args[2] as string,
        byte_size: this.args[3] as number,
        relay_status: 'received',
        error_code: null,
        created_at: this.args[4] as number,
        updated_at: this.args[5] as number
      });
    }
    if (this.sql.includes("SET relay_status = 'broadcast'")) {
      const txHashArg = this.args[0] as string;
      const updatedAt = this.args[1] as number;
      const relayId = this.args[2] as string;
      const row = this.db.relays.find((item) => item.relay_id === relayId);
      if (row) {
        row.relay_status = 'broadcast';
        row.tx_hash = txHashArg;
        row.error_code = null;
        row.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("SET relay_status = 'failed'")) {
      const errorCode = this.args[0] as string;
      const updatedAt = this.args[1] as number;
      const relayId = this.args[2] as string;
      const row = this.db.relays.find((item) => item.relay_id === relayId);
      if (row) {
        row.relay_status = 'failed';
        row.error_code = errorCode;
        row.updated_at = updatedAt;
      }
    }
    return { success: true };
  }
}
