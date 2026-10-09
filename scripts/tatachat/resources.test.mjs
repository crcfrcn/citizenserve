// SQL使用Node自带SQLite真实执行；仅Cloudflare网络回执采用可控夹具，第5步统一运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {declaration,plan,manage,cloudClient} from './resources.mjs';
const account_id='11'.repeat(16),database_id='11111111-1111-1111-1111-111111111111',queue_id='22'.repeat(16);
async function fixture(existing=true){
  const decl=await declaration(),db=new DatabaseSync(':memory:'),writes=[];let publiclyAccessible=false,failRestore=false,owned=true;
  if(existing){db.exec(decl.source);db.prepare('UPDATE tatachat_module SET schema_sha256=?').run(decl.sha256);}
  const state={database:existing,bucket:existing,queue:existing};
  async function call(method,path,body){
    if(method!=='GET')writes.push({method,path});
    const ok=result=>({success:true,result});
    if(method==='GET'&&path.startsWith('/d1/database?'))return ok(state.database?[{name:'citizenserve-tatachat-test',uuid:database_id}]:[]);
    if(method==='GET'&&path.startsWith('/r2/buckets?'))return ok({buckets:state.bucket?[{name:'citizenserve-tatachat-test'}]:[]});
    if(method==='GET'&&path.startsWith('/queues?'))return ok(state.queue?[{queue_name:'citizenserve-tatachat-test',queue_id}]:[]);
    if(method==='POST'&&path==='/d1/database'){state.database=true;return ok({name:body.name,uuid:database_id});}
    if(method==='POST'&&path==='/r2/buckets'){state.bucket=true;return ok({name:body.name});}
    if(method==='POST'&&path==='/queues'){state.queue=true;return ok({queue_name:body.queue_name,queue_id});}
    if(path.endsWith('/domains/managed'))return ok({enabled:publiclyAccessible});
    if(path.endsWith('/domains/custom'))return ok({domains:[]});
    if(method==='POST'&&path===`/d1/database/${database_id}/query`){
      if(failRestore&&body.sql.startsWith('INSERT INTO messages(')){failRestore=false;throw Error('合成恢复失败');}
      let rows=[];if(!body.params?.length&&body.sql.includes(';'))db.exec(body.sql);else{const stmt=db.prepare(body.sql);if(stmt.columns().length)rows=stmt.all(...body.params);else stmt.run(...body.params);}
      return ok([{success:true,results:rows}]);
    }
    if(path.startsWith('/workers/durable_objects/namespaces?'))return ok([{id:'33'.repeat(16),class:'TataChatDevice',script:'citizenserve-tatachat-test',use_sqlite:true}]);
    if(path==='/workers/scripts/citizenserve-tatachat-test/settings')return ok({bindings:owned?[{type:'d1',name:'TATACHAT_DB',id:database_id},{type:'r2_bucket',name:'TATACHAT_ATTACHMENTS',bucket_name:'citizenserve-tatachat-test'},{type:'queue',name:'TATACHAT_PUSH',queue_name:'citizenserve-tatachat-test'},{type:'durable_object_namespace',name:'TATACHAT_DEVICES',namespace_id:'33'.repeat(16)}]:[]});
    if(path===`/queues/${queue_id}`)return ok({consumers:[{type:'worker',script_name:'citizenserve-tatachat-test'}]});
    if(path===`/queues/${queue_id}/messages`)return ok({});
    throw Error('夹具未声明API');
  }
  return {decl,db,call,writes,state,setPublic:()=>publiclyAccessible=true,failRestore:()=>failRestore=true,unowned:()=>owned=false,close:()=>db.close()};
}
test('资源计划不执行DDL，准确名称及归属由同一声明取得',async()=>{const f=await fixture(false);try{const p=await plan({environment:'test',account_id,call:f.call});assert.equal(p.resources.find(x=>x.kind==='d1').exists,false);assert.equal(p.resources.find(x=>x.kind==='durable_object').exists,null);assert.equal(f.writes.length,0);}finally{f.close();}});
test('错误环境、错误准确批准和生产同名资源不被自动接管',async()=>{const f=await fixture();try{await assert.rejects(plan({environment:'dev',account_id,call:f.call}));await assert.rejects(manage({environment:'test',account_id,operation:'rebuild',approval_sha256:'00'.repeat(32),call:f.call}));assert.ok(!f.writes.some(x=>x.path==='/d1/database'));}finally{f.close();}});
test('实际DDL被修改时验真失败，即使版本与摘要字段未变',async()=>{const f=await fixture();try{f.db.exec('ALTER TABLE messages ADD COLUMN unexpected TEXT');await assert.rejects(plan({environment:'test',account_id,call:f.call}),/非本模块|结构|数据库/u);}finally{f.close();}});
test('公开附件桶拒绝验真；正确实际绑定可验真',async()=>{const f=await fixture();try{const value=await manage({environment:'test',account_id,operation:'verify',call:f.call});assert.equal(value.verified,true);f.setPublic();await assert.rejects(manage({environment:'test',account_id,operation:'verify',call:f.call}),/公开访问/u);}finally{f.close();}});
test('新建只创建缺失三资源，回执明确DO部署验真仍待执行',async()=>{
  const f=await fixture(false);assert.ok(process.env.PRODUCT_WORK_DIR,'必须由所属产品真实任务提供工作根');await mkdir(process.env.PRODUCT_WORK_DIR,{recursive:true});const work=await mkdtemp(join(process.env.PRODUCT_WORK_DIR,'cloud-resource-'));
  try{const p=await plan({environment:'test',account_id,call:f.call});const input={environment:'test',account_id,operation:'create',approval_sha256:p.approval_sha256,call:f.call,work};const r=await manage(input);assert.equal(r.binding_verification_pending,true);assert.equal(JSON.parse(await readFile(join(work,'tatachat-cloudflare-bindings.json'))).database_id,database_id);const next=await plan({environment:'test',account_id,call:f.call});await manage({...input,approval_sha256:next.approval_sha256});assert.equal(f.writes.filter(x=>['/d1/database','/r2/buckets','/queues'].includes(x.path)).length,3);}finally{f.close();await rm(work,{recursive:true,force:true});}
});
function data(f){f.db.prepare('INSERT INTO message_receipts VALUES(?,?,?,?)').run('fixture-message','opaque-fingerprint','unique-operation',Date.now()+60000);f.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('fixture-message','fixture-user','fixture-device','{"opaque":"synthetic ciphertext"}',40,Date.now(),Date.now()+60000);f.db.exec("INSERT INTO push_generations VALUES('fixture-user','fixture-device','android',8)");}
test('云内重建逐字保留密文记录、推送代际和原资源身份',async()=>{const f=await fixture();try{data(f);const before=f.db.prepare('SELECT * FROM messages').all(),p=await plan({environment:'test',account_id,operation:'rebuild',call:f.call});const r=await manage({environment:'test',account_id,operation:'rebuild',approval_sha256:p.approval_sha256,call:f.call});assert.equal(r.data_preserved,true);assert.deepEqual(f.db.prepare('SELECT * FROM messages').all(),before);assert.equal(f.db.prepare('SELECT generation FROM push_generations').get().generation,8);assert.equal(f.db.prepare('SELECT frozen FROM tatachat_module').get().frozen,0);assert.ok(!f.writes.some(x=>x.method==='DELETE'));}finally{f.close();}});
test('恢复失败保持冻结和已验证快照，同一重建入口可以继续恢复',async()=>{const f=await fixture();try{data(f);const before=f.db.prepare('SELECT * FROM messages').all(),p=await plan({environment:'test',account_id,operation:'rebuild',call:f.call});f.failRestore();await assert.rejects(manage({environment:'test',account_id,operation:'rebuild',approval_sha256:p.approval_sha256,call:f.call}),/已保留云内快照/u);assert.equal(f.db.prepare('SELECT frozen FROM tatachat_module').get().frozen,1);const backup_id=f.db.prepare("SELECT backup_id FROM tatachat_backup_sets WHERE state='verified'").get().backup_id;const resume=await plan({environment:'test',account_id,operation:'rebuild',backup_id,call:f.call});await manage({environment:'test',account_id,operation:'rebuild',backup_id,approval_sha256:resume.approval_sha256,call:f.call});assert.deepEqual(f.db.prepare('SELECT * FROM messages').all(),before);}finally{f.close();}});
test('官方HTTPS范围和能力错误不输出执行器合成机密',async()=>{let called=false;const secret='synthetic-credential-for-testing';const call=cloudClient({account_id,request:async({url,method})=>{called=true;assert.equal(method,'GET');assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+account_id+'/'));throw Error(secret);}});await assert.rejects(call('GET','https://foreign.example.test'),/越界/u);assert.equal(called,false);await assert.rejects(call('PUT','/workers/scripts/citizenserve-tatachat-test/settings'),/只读/u);assert.equal(called,false);await assert.rejects(call('GET','/queues'),e=>!e.message.includes(secret)&&e.message.includes('失败'));});
test('D1保留表_cf_KV可存在，未知表不能被宽泛忽略',async()=>{const f=await fixture();try{f.db.exec('CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID');await plan({environment:'test',account_id,call:f.call});f.db.exec('CREATE TABLE _cf_unowned(value TEXT)');await assert.rejects(plan({environment:'test',account_id,call:f.call}),/非本模块/u);}finally{f.close();}});
test('未知上传禁止重建，冻结回滚且业务数据未被删除',async()=>{const f=await fixture();try{f.db.exec("INSERT INTO attachments(attachment_id,generation,fingerprint,metadata,creator_user,creator_device,state,expires_at) VALUES('a','g','f','{}','u','d','pending',9999999999999);INSERT INTO attachment_uploads(attempt_id,attachment_id,generation,object_key,upload,state) VALUES('attempt','a','g','unique-key','{}','writing')");const p=await plan({environment:'test',account_id,operation:'rebuild',call:f.call});await assert.rejects(manage({environment:'test',account_id,operation:'rebuild',approval_sha256:p.approval_sha256,call:f.call}),/未知上传/u);assert.equal(f.db.prepare('SELECT frozen,backup_id FROM tatachat_module').get().frozen,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM attachment_uploads').get().n,1);}finally{f.close();}});
test('绑定到其它模块的同名R2/Queue不能凭正确计划摘要接管',async()=>{const f=await fixture();assert.ok(process.env.PRODUCT_WORK_DIR);const work=await mkdtemp(join(process.env.PRODUCT_WORK_DIR,'cloud-owner-'));try{f.unowned();const p=await plan({environment:'test',account_id,call:f.call});await assert.rejects(manage({environment:'test',account_id,operation:'create',approval_sha256:p.approval_sha256,call:f.call,work}),/接管/u);assert.ok(!f.writes.some(x=>['/d1/database','/r2/buckets','/queues'].includes(x.path)));}finally{f.close();await rm(work,{recursive:true,force:true});}});
test('R2游标继续清点而不把首页缺失当作资源不存在',async()=>{const f=await fixture();try{let pages=0;const call=async(method,path,body)=>{if(path.startsWith('/r2/buckets?')){pages++;if(pages===1)return {success:true,result:{buckets:[]},result_info:{cursor:'next+page'}};assert.ok(path.includes('cursor=next%2Bpage'));return {success:true,result:{buckets:[{name:'citizenserve-tatachat-test'}]}};}return f.call(method,path,body);};const p=await plan({environment:'test',account_id,call});assert.equal(p.resources.find(x=>x.kind==='r2').exists,true);assert.equal(pages,2);}finally{f.close();}});
