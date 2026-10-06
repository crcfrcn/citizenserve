import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { contactMlsRoute } from '../src/contacts';
import { createTestMiniflare } from './miniflare';
import type { Env, SessionState } from '../src/types';
const actor = vi.hoisted(() => ({ session: null as SessionState | null }));
vi.mock('../src/shared/http', async (original) => {
  const actual = await original<typeof import('../src/shared/http')>();
  return { ...actual, requireSession: async () => actor.session! };
});
let runtime: ReturnType<typeof createTestMiniflare> | undefined;
afterEach(async () => { await runtime?.dispose(); actor.session = null; });
it('同CID换绑保留同MLS组和不透明消息，旧登记代次拒绝', async () => {
  runtime = createTestMiniflare({ d1Bindings: ['DB'] });
  const DB = await runtime.getD1Database('DB');
  // 执行实际schema前去除行注释，避免注释中的分号被误认为SQL语句。
  const schema = readFileSync(new URL('../schema/citizenserve.sql', import.meta.url), 'utf8')
    .split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
  for (const statement of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await DB.prepare(statement).run();
  const device = 'aa'.repeat(32), cid = 'CID-A';
  const first = '0x' + '11'.repeat(32), next = '0x' + '22'.repeat(32);
  await DB.prepare('INSERT INTO mls_devices VALUES (?,?,?,?,?,1,1,1)').bind(cid,device,1,first,'0x'+device).run();
  actor.session = { cid_number: cid,device_id: device,binding_revision: 1,account_id: first,created_at: 1,expires_at: 4102444800000 };
  const env = { DB } as Env;
  async function call(body: Record<string, unknown>) {
    return (await contactMlsRoute(new Request('https://worker.test/square/contacts/mls', {
      method:'POST',body:JSON.stringify(body)
    }), env)).json() as Promise<Record<string, any>>;
  }
  await call({action:'publish',key_package:'0102'});
  const initial = await call({action:'reserve',group_revision:0,operation_kind:'create',target_device_ids:[]});
  await call({action:'commit',operation_id:initial.operation_id,member_device_ids:[device],messages:[]});
  const queuedId = '11'.repeat(16);
  await DB.prepare('INSERT INTO contact_mls_messages VALUES (?,?,?,?,?,?,?)')
    .bind(cid,device,queuedId,1,'application','01020304',device).run();
  const before = await call({action:'state'});
  await DB.prepare('UPDATE mls_devices SET binding_revision=2,account_id=? WHERE cid_number=?').bind(next,cid).run();
  await expect(call({action:'state'})).rejects.toMatchObject({code:'contact_mls_device'});
  actor.session = {...actor.session!,binding_revision:2,account_id:next};
  const after = await call({action:'state'});
  expect(after.group_id).toBe(before.group_id);
  expect(after.group_revision).toBe(before.group_revision);
  expect(after.creator_device_id).toBe(device);
  expect(after.key_packages).toEqual(before.key_packages);
  expect(after.messages).toEqual(before.messages);
  expect(after.messages).toHaveLength(1);
});
