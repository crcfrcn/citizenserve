import type { Env, ContactMlsGroupRow, ContactMlsOperationRow } from './types';
import { resourceLimit } from './limits/catalog';
import { HttpError, jsonResponse, readJson, requireSession } from './shared/http';

const DEVICE = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const kinds = new Set(['create', 'add', 'remove', 'application']);
const maximumDevices = 32;
const maximumWireBytes = 48 * 1024;

function invalid(): never { throw new HttpError(400, 'invalid_contact_mls', '通讯录 MLS 请求无效'); }
function conflict(): never { throw new HttpError(409, 'contact_mls_conflict', '通讯录组状态已变化，请重试'); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== keys.length || keys.some(key => !(key in body))) invalid();
  return body;
}
function devices(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maximumDevices ||
      value.some(item => typeof item !== 'string' || !DEVICE.test(item)) ||
      new Set(value).size !== value.length) invalid();
  return (value as string[]).slice().sort();
}
function wire(value: unknown): string {
  if (typeof value !== 'string' || !HEX.test(value) || value.length > maximumWireBytes * 2) invalid();
  return value;
}
function positive(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) invalid();
  return value;
}
function same(a: string[], b: string[]): boolean {
  return JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
}

/** 单一 MLS 传递接口；永久属主和当前设备只能来自已验证会话。 */
export async function contactMlsRoute(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const raw = await readJson<unknown>(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const action = (raw as Record<string, unknown>).action;
  const cid = session.cid_number;
  const device = session.device_id;
  const active = await env.DB.prepare(
    'SELECT device_id FROM mls_devices WHERE cid_number = ? AND binding_revision = ? AND account_id = ?'
  ).bind(cid, session.binding_revision, session.account_id).all<{ device_id: string }>();
  const eligible = (active.results ?? []).map(row => row.device_id).sort();
  if (eligible.length > maximumDevices) throw new HttpError(429, 'contact_mls_devices_full', '通讯录设备数量超限');
  if (!eligible.includes(device)) throw new HttpError(403, 'contact_mls_device', '当前 MLS 设备未获授权');

  if (action === 'publish') {
    const body = exact(raw, ['action', 'key_package']);
    const packageHex = wire(body.key_package);
    if (packageHex.length > 32 * 1024) invalid();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO contact_mls_packages(cid_number,device_id,key_package,updated_at) VALUES (?,?,?,?) ' +
        'ON CONFLICT(cid_number,device_id) DO UPDATE SET key_package=excluded.key_package,updated_at=excluded.updated_at'
      ).bind(cid, device, packageHex, Date.now()),
      env.DB.prepare(
        'INSERT INTO contact_mls_groups(cid_number,group_id,creator_device_id,group_revision,member_device_ids) ' +
        'VALUES (?,?,?,0,?) ON CONFLICT(cid_number) DO NOTHING'
      ).bind(cid, crypto.randomUUID().replaceAll('-', ''), device, '[]')
    ]);
    return jsonResponse({ ok: true });
  }

  const group = await env.DB.prepare('SELECT * FROM contact_mls_groups WHERE cid_number = ?')
    .bind(cid).first<ContactMlsGroupRow>();
  if (!group) conflict();
  const members = devices(JSON.parse(group.member_device_ids));
  if (action === 'state') {
    exact(raw, ['action']);
    const packages = await env.DB.prepare(
      'SELECT p.device_id,p.key_package FROM contact_mls_packages p JOIN mls_devices d ' +
      'ON d.cid_number=p.cid_number AND d.device_id=p.device_id ' +
      'WHERE p.cid_number=? AND d.binding_revision=? AND d.account_id=? ORDER BY p.device_id'
    ).bind(cid, session.binding_revision, session.account_id).all<{ device_id: string; key_package: string }>();
    const messages = await env.DB.prepare(
      'SELECT operation_id,sequence,message_type,mls_message,sender_device_id FROM contact_mls_messages ' +
      'WHERE cid_number=? AND device_id=? ORDER BY sequence LIMIT 100'
    ).bind(cid, device).all();
    const pending = group.pending_operation_id
      ? await env.DB.prepare('SELECT * FROM contact_mls_operations WHERE cid_number=? AND operation_id=?')
          .bind(cid, group.pending_operation_id).first<ContactMlsOperationRow>()
      : null;
    return jsonResponse({
      ok: true, group_id: group.group_id, group_revision: group.group_revision,
      creator_device_id: group.creator_device_id, member_device_ids: members,
      eligible_device_ids: eligible, key_packages: packages.results ?? [], messages: messages.results ?? [],
      pending: pending?.device_id === device ? {
        operation_id: pending.operation_id, operation_kind: pending.operation_kind,
        target_device_ids: JSON.parse(pending.target_device_ids), group_revision: pending.group_revision
      } : null,
      busy: !!pending && pending.device_id !== device
    });
  }

  if (action === 'reserve') {
    const body = exact(raw, ['action', 'group_revision', 'operation_kind', 'target_device_ids']);
    const revision = positive(body.group_revision, true);
    const kind = body.operation_kind;
    const targets = devices(body.target_device_ids);
    if (typeof kind !== 'string' || !kinds.has(kind)) invalid();
    if (group.pending_operation_id) {
      const previous = await env.DB.prepare('SELECT * FROM contact_mls_operations WHERE cid_number=? AND operation_id=?')
        .bind(cid, group.pending_operation_id).first<ContactMlsOperationRow>();
      if (previous?.device_id !== device) conflict();
      return jsonResponse({ ok: true, operation_id: previous.operation_id,
        operation_kind: previous.operation_kind, target_device_ids: JSON.parse(previous.target_device_ids),
        group_revision: previous.group_revision });
    }
    if (group.group_revision !== revision) conflict();
    if (kind === 'create') {
      if (revision !== 0 || device !== group.creator_device_id || targets.length !== 0) conflict();
    } else {
      if (!members.includes(device)) conflict();
      if (kind === 'add' && (!targets.length || targets.some(id => members.includes(id) || !eligible.includes(id)) ||
          members.length + targets.length > maximumDevices)) invalid();
      if (kind === 'remove' && (!targets.length || targets.includes(device) ||
          targets.some(id => !members.includes(id) || eligible.includes(id)))) invalid();
      if (kind === 'application' && targets.length !== 0) invalid();
    }
    const id = crypto.randomUUID().replaceAll('-', '');
    await env.DB.prepare('DELETE FROM contact_mls_operations WHERE cid_number=? AND committed_at IS NOT NULL AND committed_at<?')
      .bind(cid, Date.now() - 7 * 86400000).run();
    const count = await env.DB.prepare('SELECT count(*) AS count FROM contact_mls_operations WHERE cid_number=?')
      .bind(cid).first<{ count: number }>();
    if ((count?.count ?? 0) >= 1024) throw new HttpError(429, 'contact_mls_queue_full', '通讯录操作队列已满');
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO contact_mls_operations(cid_number,operation_id,device_id,group_revision,operation_kind,target_device_ids) ' +
        'SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM contact_mls_groups WHERE cid_number=? AND group_revision=? AND pending_operation_id IS NULL)'
      ).bind(cid, id, device, revision, kind, JSON.stringify(targets), cid, revision),
      env.DB.prepare(
        'UPDATE contact_mls_groups SET pending_operation_id=? WHERE cid_number=? AND group_revision=? AND pending_operation_id IS NULL ' +
        'AND EXISTS (SELECT 1 FROM contact_mls_operations WHERE cid_number=? AND operation_id=?)'
      ).bind(id, cid, revision, cid, id)
    ]);
    const claimed = await env.DB.prepare('SELECT pending_operation_id FROM contact_mls_groups WHERE cid_number=?')
      .bind(cid).first<{ pending_operation_id: string | null }>();
    if (claimed?.pending_operation_id !== id) conflict();
    return jsonResponse({ ok: true, operation_id: id, operation_kind: kind,
      target_device_ids: targets, group_revision: revision });
  }

  if (action === 'commit') {
    const body = exact(raw, ['action', 'operation_id', 'member_device_ids', 'messages']);
    if (typeof body.operation_id !== 'string' || !ID.test(body.operation_id)) invalid();
    const id = body.operation_id;
    const operation = await env.DB.prepare('SELECT * FROM contact_mls_operations WHERE cid_number=? AND operation_id=?')
      .bind(cid, id).first<ContactMlsOperationRow>();
    if (!operation || operation.device_id !== device) conflict();
    const nextMembers = devices(body.member_device_ids);
    if (!Array.isArray(body.messages) || body.messages.length > 2) invalid();
    const messages = body.messages.map(value => {
      const message = exact(value, ['message_type', 'device_ids', 'mls_message']);
      if (!['welcome', 'commit', 'application'].includes(message.message_type as string)) invalid();
      return { message_type: message.message_type as string, device_ids: devices(message.device_ids), mls_message: wire(message.mls_message) };
    });
    const canonical = JSON.stringify({ member_device_ids: nextMembers, messages });
    if (operation.committed_at !== null) {
      if (operation.result_json !== canonical) conflict();
      return jsonResponse({ ok: true, group_revision: operation.group_revision + 1 });
    }
    if (group.pending_operation_id !== id || group.group_revision !== operation.group_revision) conflict();
    const targets = devices(JSON.parse(operation.target_device_ids));
    const kind = operation.operation_kind;
    const expected = kind === 'create' ? [device]
      : kind === 'add' ? [...members, ...targets]
      : kind === 'remove' ? members.filter(member => !targets.includes(member)) : members;
    if (!same(nextMembers, expected)) invalid();
    const recipients = members.filter(member => member !== device && (kind !== 'remove' || !targets.includes(member)));
    const expectedMessages = kind === 'create' ? []
      : kind === 'add' ? [{ type: 'commit', recipients }, { type: 'welcome', recipients: targets }]
      : [{ type: kind === 'remove' ? 'commit' : 'application', recipients }];
    if (messages.length !== expectedMessages.length || messages.some((message, index) =>
        message.message_type !== expectedMessages[index].type || !same(message.device_ids, expectedMessages[index].recipients))) invalid();
    const maximum = resourceLimit('contact_mls').max_items ?? 1024;
    for (const recipient of new Set(messages.flatMap(message => message.device_ids))) {
      const count = await env.DB.prepare('SELECT count(*) AS count FROM contact_mls_messages WHERE cid_number=? AND device_id=?')
        .bind(cid, recipient).first<{ count: number }>();
      if ((count?.count ?? 0) + messages.length > maximum) throw new HttpError(429, 'contact_mls_queue_full', '通讯录设备队列已满');
    }
    const queued = await env.DB.prepare('SELECT coalesce(sum(length(mls_message)/2),0) AS bytes FROM contact_mls_messages WHERE cid_number=?')
      .bind(cid).first<{ bytes: number }>();
    const addedBytes = messages.reduce((sum, message) => sum + message.device_ids.length * message.mls_message.length / 2, 0);
    if ((queued?.bytes ?? 0) + addedBytes > 32 * 1024 * 1024) throw new HttpError(429, 'contact_mls_queue_full', '通讯录密文队列容量已满');
    const statements = [
      env.DB.prepare(
        'UPDATE contact_mls_operations SET result_json=?,committed_at=? WHERE cid_number=? AND operation_id=? AND committed_at IS NULL ' +
        'AND EXISTS (SELECT 1 FROM contact_mls_groups WHERE cid_number=? AND pending_operation_id=? AND group_revision=?)'
      ).bind(canonical, Date.now(), cid, id, cid, id, operation.group_revision)
    ];
    messages.forEach((message, index) => message.device_ids.forEach(recipient => statements.push(
      env.DB.prepare(
        'INSERT INTO contact_mls_messages(cid_number,device_id,operation_id,sequence,message_type,mls_message,sender_device_id) ' +
        'SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM contact_mls_operations WHERE cid_number=? AND operation_id=? AND result_json=?) ' +
        'ON CONFLICT(cid_number,device_id,operation_id,message_type) DO NOTHING'
      ).bind(cid, recipient, id, (operation.group_revision + 1) * 2 + index, message.message_type, message.mls_message, device, cid, id, canonical)
    )));
    if (kind === 'remove') for (const removed of targets) {
      for (const table of ['contact_mls_messages', 'contact_mls_packages']) {
        statements.push(env.DB.prepare('DELETE FROM ' + table + ' WHERE cid_number=? AND device_id=? ' +
          'AND EXISTS (SELECT 1 FROM contact_mls_operations WHERE cid_number=? AND operation_id=? AND result_json=?)')
          .bind(cid, removed, cid, id, canonical));
      }
    }
    statements.push(env.DB.prepare(
      'UPDATE contact_mls_groups SET group_revision=group_revision+1,member_device_ids=?,pending_operation_id=NULL ' +
      'WHERE cid_number=? AND pending_operation_id=? AND group_revision=? ' +
      'AND EXISTS (SELECT 1 FROM contact_mls_operations WHERE cid_number=? AND operation_id=? AND result_json=?)'
    ).bind(JSON.stringify(nextMembers), cid, id, operation.group_revision, cid, id, canonical));
    await env.DB.batch(statements);
    const completed = await env.DB.prepare('SELECT result_json FROM contact_mls_operations WHERE cid_number=? AND operation_id=?')
      .bind(cid, id).first<{ result_json: string | null }>();
    if (completed?.result_json !== canonical) conflict();
    return jsonResponse({ ok: true, group_revision: operation.group_revision + 1 });
  }

  if (action === 'ack') {
    const body = exact(raw, ['action', 'operation_id', 'message_type']);
    if (typeof body.operation_id !== 'string' || !ID.test(body.operation_id) ||
        !['welcome', 'commit', 'application'].includes(body.message_type as string)) invalid();
    await env.DB.prepare('DELETE FROM contact_mls_messages WHERE cid_number=? AND device_id=? AND operation_id=? AND message_type=?')
      .bind(cid, device, body.operation_id, body.message_type).run();
    return jsonResponse({ ok: true });
  }
  invalid();
}
