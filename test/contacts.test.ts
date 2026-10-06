import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { contactMlsRoute } from '../src/contacts';
import { createTestMiniflare } from './miniflare';
import type { Env, SessionState } from '../src/types';

const actor = vi.hoisted(() => ({ current: null as SessionState | null }));
vi.mock('../src/shared/http', async (original) => {
  const actual = await original<typeof import('../src/shared/http')>();
  return { ...actual, requireSession: async () => {
    if (!actor.current) throw new actual.HttpError(401, 'missing_session', '未认证');
    return actor.current;
  }};
});
const account = '0x' + '11'.repeat(32);
const a = 'aa'.repeat(32), b = 'bb'.repeat(32), c = 'cc'.repeat(32);
let runtime: ReturnType<typeof createTestMiniflare>;
let env: Env;
function session(cid: string, device: string, revision = 1): SessionState {
  return { cid_number: cid, device_id: device, account_id: account,
    binding_revision: revision, created_at: 1, expires_at: 4102444800000 };
}
async function call(cid: string, device: string, body: Record<string, unknown>) {
  actor.current = session(cid, device);
  const response = await contactMlsRoute(new Request('https://worker.test/square/contacts/mls', {
    method: 'POST', body: JSON.stringify(body)
  }), env);
  return response.json() as Promise<Record<string, any>>;
}
async function register(cid: string, device: string, revision = 1) {
  await env.DB.prepare('INSERT INTO mls_devices(cid_number,device_id,binding_revision,account_id,public_key,issued_at,created_at,updated_at) VALUES (?,?,?,?,?,1,1,1)')
    .bind(cid, device, revision, account, '0x' + device).run();
}
async function create(cid = 'CID-A', device = a) {
  await call(cid, device, { action: 'publish', key_package: '0102' });
  const reserved = await call(cid, device, { action: 'reserve', group_revision: 0,
    operation_kind: 'create', target_device_ids: [] });
  await call(cid, device, { action: 'commit', operation_id: reserved.operation_id,
    member_device_ids: [device], messages: [] });
}
beforeEach(async () => {
  runtime = createTestMiniflare({ d1Bindings: ['DB'] });
  const DB = await runtime.getD1Database('DB');
  // 执行实际schema前去除行注释，避免注释中的分号被误认为SQL语句。
  const schema = readFileSync(new URL('../schema/citizenserve.sql', import.meta.url), 'utf8')
    .split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
  for (const statement of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await DB.prepare(statement).run();
  env = { DB } as Env;
  await register('CID-A', a); await register('CID-A', b); await register('CID-B', c);
  actor.current = null;
});
afterEach(async () => { actor.current = null; await runtime.dispose(); });

describe('同CID MLS通讯录设备传递', () => {
  it('未认证、客户端自报属主、联系人明文和旧路由体均失败', async () => {
    await expect(contactMlsRoute(new Request('https://worker.test/square/contacts/mls', {
      method: 'POST', body: JSON.stringify({ action: 'state' })
    }), env)).rejects.toMatchObject({ code: 'missing_session' });
    await create();
    await expect(call('CID-A', a, { action: 'state', cid_number: 'CID-B' }))
      .rejects.toMatchObject({ code: 'invalid_contact_mls' });
    await expect(call('CID-A', a, { action: 'publish', key_package: '0102', contact_remark: '私人备注' }))
      .rejects.toMatchObject({ code: 'invalid_contact_mls' });
    await expect(call('CID-A', c, { action: 'state' }))
      .rejects.toMatchObject({ code: 'contact_mls_device' });
  });
  it('CID隔离，Welcome只到新设备，同CID其他设备不会被用户级去重', async () => {
    await create();
    await call('CID-A', b, { action: 'publish', key_package: '0304' });
    const pending = await call('CID-A', a, { action: 'reserve', group_revision: 1,
      operation_kind: 'add', target_device_ids: [b] });
    const body = { action: 'commit', operation_id: pending.operation_id,
      member_device_ids: [a,b], messages: [
        { message_type: 'commit', device_ids: [], mls_message: '0506' },
        { message_type: 'welcome', device_ids: [b], mls_message: '0708' }
      ] };
    await call('CID-A', a, body);
    await call('CID-A', a, body);
    expect((await call('CID-A', b, { action: 'state' })).messages).toHaveLength(1);
    expect((await call('CID-A', a, { action: 'state' })).messages).toHaveLength(0);
    await create('CID-B', c);
    expect((await call('CID-B', c, { action: 'state' })).member_device_ids).toEqual([c]);
    await expect(call('CID-A', a, { action: 'reserve', group_revision: 1,
      operation_kind: 'application', target_device_ids: [] })).rejects.toMatchObject({ code: 'contact_mls_conflict' });
    await expect(call('CID-A', a, { ...body, messages: [] })).rejects.toMatchObject({ code: 'contact_mls_conflict' });
  });
  it('并发预留只有一个设备获操作权；确认顺序和每设备ACK独立', async () => {
    await create();
    await call('CID-A', b, { action: 'publish', key_package: '0304' });
    const join = await call('CID-A', a, { action: 'reserve', group_revision: 1, operation_kind: 'add', target_device_ids: [b] });
    await call('CID-A', a, { action: 'commit', operation_id: join.operation_id, member_device_ids: [a,b], messages: [
      { message_type: 'commit', device_ids: [], mls_message: '0506' },
      { message_type: 'welcome', device_ids: [b], mls_message: '0708' }
    ] });
    const result = await Promise.allSettled([
      call('CID-A', a, { action: 'reserve', group_revision: 2, operation_kind: 'application', target_device_ids: [] }),
      call('CID-A', b, { action: 'reserve', group_revision: 2, operation_kind: 'application', target_device_ids: [] })
    ]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const winner = result[0].status === 'fulfilled' ? a : b;
    const pending = await call('CID-A', winner, { action: 'state' });
    expect(pending.pending.operation_kind).toBe('application');
    await expect(call('CID-A', winner, { action: 'commit', operation_id: pending.pending.operation_id,
      member_device_ids: [a,b], messages: [{ message_type: 'application', device_ids: [c], mls_message: '0102' }] }))
      .rejects.toMatchObject({ code: 'invalid_contact_mls' });
  });
  it('已撤销设备拒绝提交，群移除只能指向失效精确设备', async () => {
    await create();
    await expect(call('CID-A', a, { action: 'reserve', group_revision: 1,
      operation_kind: 'remove', target_device_ids: [b] })).rejects.toMatchObject({ code: 'invalid_contact_mls' });
    await env.DB.prepare('DELETE FROM mls_devices WHERE cid_number=? AND device_id=?').bind('CID-A', b).run();
    await expect(call('CID-A', b, { action: 'state' })).rejects.toMatchObject({ code: 'contact_mls_device' });
  });
});
