// 模块资源唯一配方读取所属产品声明；这里只访问固定Cloudflare API，不触碰普通业务资源。
import {createHash,randomUUID} from 'node:crypto';
import {readFile,lstat,realpath,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const fail=message=>{throw Error('聊天云资源：'+message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
async function regular(path){for(let p=path;;p=dirname(p)){const value=await lstat(p);if(value.isSymbolicLink()||await realpath(p)!==p||p===path&&(!value.isFile()||value.nlink!==1||value.size>2*1024*1024)||p!==path&&!value.isDirectory())fail('来源路径不规范');if(dirname(p)===p)break;}return readFile(path);}
export async function declaration(){
  const flows=JSON.parse(await regular(join(root,'scripts/flows.json'))),value=flows.tatachat?.cloudflare;
  if(flows.schema!==1||flows.product_id!=='citizenserve'||value?.schema?.version!==1||value.schema.path!=='server/cloudflare/tatachat/schema.sql'||!Array.isArray(value.resources)||value.resources.length!==4)fail('模块声明缺失');
  const source=(await regular(join(root,value.schema.path))).toString('utf8');if(sha(source)!==value.schema.sha256)fail('schema来源漂移');
  const types=['d1','r2','durable_object','queue'];
  for(const kind of types){const matches=value.resources.filter(x=>x.kind===kind);if(matches.length!==1)fail('资源类型重复或缺失');const item=matches[0];if(!/^TATACHAT_[A-Z_]+$/u.test(item.binding)||!['production','test'].every(env=>/^[a-z][a-z0-9-]{2,62}$/u.test(item[env])))fail('资源命名无效');}
  if(value.resources.find(x=>x.kind==='durable_object').class_name!=='TataChatDevice'||value.migration_tag!=='tatachat-1'||!['production','test'].every(env=>/^[a-z][a-z0-9-]{2,62}$/u.test(value.workers?.[env])))fail('DO装配声明无效');
  return {value,source,sha256:value.schema.sha256};
}
// 产品只传公开请求到已获准的安全执行器；认证和网络发送属于执行器，不接收发布密钥。
export function cloudClient({account_id,request,signal}){
  if(!id(account_id)||typeof request!=='function')fail('授权能力无效');
  const base=`https://api.cloudflare.com/client/v4/accounts/${account_id}`;
  return async(method,path,body)=>{
    if(!['GET','POST','PUT','PATCH'].includes(method)||!/^\/(?:d1\/database|r2\/buckets|queues|workers\/(?:scripts|durable_objects\/namespaces))(?:[/?]|$)/u.test(path)||path.includes('..')||path.includes('#')||path.includes('\\')||path.split('?')[0].includes('%'))fail('API目标越界');
    // Worker设置与DO目录只读；不存在部署、删除资源或修改其它产品的动作。
    if(path.startsWith('/workers/')&&method!=='GET')fail('Worker目标只读');
    signal?.throwIfAborted();let data;
    try{data=await request({method,url:base+path,body,signal});}catch{fail('请求失败或取消');}
    if(!data||data.success!==true||Buffer.byteLength(JSON.stringify(data))>1024*1024)fail('API回执无效或超限');
    return data;
  };
}
async function pages(call,path,field){const items=[],seen=new Set();let cursor='';for(let page=1;page<=1000;page++){const query=field?`per_page=100${cursor?'&cursor='+encodeURIComponent(cursor):''}`:`page=${page}&per_page=100`;const data=await call('GET',path+(path.includes('?')?'&':'?')+query);const rows=field?data.result?.[field]:data.result;if(!Array.isArray(rows))fail('列表回执无效');items.push(...rows);if(field){const next=data.result_info?.cursor;if(!next)return items;if(typeof next!=='string'||next.length>2048||seen.has(next))fail('分页游标无效');seen.add(next);cursor=next;}else if(data.result_info?.total_pages!==undefined){if(page>=data.result_info.total_pages)return items;}else if(rows.length<100)return items;}fail('列表分页超限');}
const once=(rows,name,key)=>{const matches=rows.filter(x=>x[key]===name);if(matches.length>1)fail('同名资源不唯一');return matches[0]??null;};
async function inventory(call,decl,environment){
  const resources=Object.fromEntries(decl.value.resources.map(x=>[x.kind,{...x,name:x[environment]}]));
  const d1=await pages(call,'/d1/database'),r2=await pages(call,'/r2/buckets','buckets'),queues=await pages(call,'/queues');
  const found={d1:once(d1,resources.d1.name,'name'),r2:once(r2,resources.r2.name,'name'),queue:once(queues,resources.queue.name,'queue_name')};
  if(found.d1&&!uuid(found.d1.uuid)||found.queue&&!id(found.queue.queue_id))fail('资源ID无效');
  return {resources,found};
}
async function query(call,database,sql,params=[]){const data=await call('POST',`/d1/database/${database}/query`,{sql,params});if(!Array.isArray(data.result)||data.result.some(r=>r.success!==true))fail('D1操作失败');return data.result.flatMap(r=>r.results??[]);}
function normalized(sql){return sql.replace(/ IF NOT EXISTS /gu,' ').replace(/;\s*$/u,'').replace(/\s+/gu,' ').trim();}
function schemaObjects(source){const pattern=/CREATE\s+(TABLE|INDEX|TRIGGER)\s+([a-z_]+)/gu;return [...source.matchAll(pattern)].map(m=>{const end=m[1]==='TRIGGER'?source.indexOf(' END;',m.index)+5:source.indexOf(';',m.index)+1;if(end<=m.index)fail('schema语句边界无效');return {type:m[1].toLowerCase(),name:m[2],sql:normalized(source.slice(m.index,end))};});}
function reusableSchema(source){return source.replace(/CREATE (TABLE|INDEX|TRIGGER) /gu,'CREATE $1 IF NOT EXISTS ');}
async function verifySchema(call,database,decl,initializing=false){
  const actual=(await query(call,database,"SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name<>'_cf_KV' ORDER BY name")).map(r=>({type:r.type,name:r.name,sql:normalized(r.sql)}));
  // D1官方保留表_cf_KV不属于产品DDL；不宽泛忽略未知表。
  const expected=schemaObjects(decl.source).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('数据库包含缺失或非本模块对象');
  const module=await query(call,database,'SELECT version,product,frozen,schema_sha256 FROM tatachat_module');
  if(module.length!==1||module[0].version!==1||module[0].product!=='citizenserve'||module[0].schema_sha256!==decl.sha256&&!(initializing&&module[0].schema_sha256===''))fail('模块归属或schema版本不符');
  if(module[0].schema_sha256===''){const n=await counts(call,database,durableTables(decl));if(module[0].frozen!==0||Object.values(n).some(x=>x!==0))fail('未完成初始化的数据库已有业务数据');}
  // 比对真实DDL；仅靠对象名和版本不能证明结构正确。
  return module[0];
}
async function privateBucket(call,name){
  const managed=await call('GET',`/r2/buckets/${name}/domains/managed`),custom=await call('GET',`/r2/buckets/${name}/domains/custom`);
  if(managed.result?.enabled!==false||!Array.isArray(custom.result?.domains)||custom.result.domains.some(d=>d.enabled!==false))fail('附件桶存在公开访问');
}
const durableTables=decl=>schemaObjects(decl.source).filter(x=>x.type==='table'&&!['tatachat_module','tatachat_assert','tatachat_backup_sets','tatachat_backups'].includes(x.name)).map(x=>x.name);
async function counts(call,database,tables){const result={};for(const name of tables){const rows=await query(call,database,`SELECT count(*) AS n FROM ${name}`);if(!Number.isSafeInteger(rows[0]?.n))fail('数据数量回执无效');result[name]=rows[0].n;}return result;}
export async function plan({environment,account_id,call,operation='create',backup_id=null}){
  if(!['production','test'].includes(environment)||!id(account_id)||!['create','maintain','rebuild','verify'].includes(operation))fail('环境或操作无效');
  const decl=await declaration(),state=await inventory(call,decl,environment),tables=durableTables(decl);
  let row_counts=null;
  if(backup_id!==null){if(operation!=='rebuild'||!uuid(backup_id)||!state.found.d1)fail('恢复快照范围无效');const rows=await query(call,state.found.d1.uuid,"SELECT b.schema_sha256,b.state,m.frozen,m.backup_id AS active_backup FROM tatachat_backup_sets b,tatachat_module m WHERE b.backup_id=?1 AND m.product='citizenserve'",[backup_id]);if(rows.length!==1||rows[0].schema_sha256!==decl.sha256||rows[0].state!=='verified'||rows[0].frozen!==1||rows[0].active_backup!==backup_id)fail('快照未验真或冻结状态不符');row_counts={};for(const table of tables){const n=await query(call,state.found.d1.uuid,'SELECT count(*) AS n FROM tatachat_backups WHERE backup_id=?1 AND table_name=?2',[backup_id,table]);row_counts[table]=n[0]?.n;}}
  else if(state.found.d1){await verifySchema(call,state.found.d1.uuid,decl,operation==='create');row_counts=await counts(call,state.found.d1.uuid,tables);}
  const result={schema:1,product_id:'citizenserve',platform:'cloudflare',environment,account_id,operation,backup_id,schema_sha256:decl.sha256,worker:decl.value.workers[environment],resources:Object.values(state.resources).map(x=>({kind:x.kind,binding:x.binding,name:x.name,id:x.kind==='d1'?state.found.d1?.uuid??null:x.kind==='queue'?state.found.queue?.queue_id??null:null,exists:x.kind==='durable_object'?null:Boolean(state.found[x.kind])})),row_counts};
  return {...result,approval_sha256:sha(JSON.stringify(result))};
}
async function bindings(call,state,decl,environment){
  const namespaces=await pages(call,'/workers/durable_objects/namespaces');
  const matching=namespaces.filter(x=>x.script===decl.value.workers[environment]&&x.class===state.resources.durable_object.class_name);
  if(matching.length!==1||matching[0].use_sqlite!==true||!id(matching[0].id))fail('DO类及SQLite命名空间尚未部署验真');
  const settings=(await call('GET',`/workers/scripts/${decl.value.workers[environment]}/settings`)).result;
  if(!Array.isArray(settings?.bindings))fail('Worker绑定回执无效');
  const expected=[['d1',state.resources.d1.binding,'id',state.found.d1.uuid],['r2_bucket',state.resources.r2.binding,'bucket_name',state.resources.r2.name],['queue',state.resources.queue.binding,'queue_name',state.resources.queue.name],['durable_object_namespace',state.resources.durable_object.binding,'namespace_id',matching[0].id]];
  for(const[type,name,key,value]of expected){const rows=settings.bindings.filter(x=>x.type===type&&x.name===name);if(rows.length!==1||rows[0][key]!==value)fail('Worker实际绑定不符');}
  const consumer=(await call('GET',`/queues/${state.found.queue.queue_id}`)).result?.consumers;
  if(!Array.isArray(consumer)||consumer.length!==1||consumer[0].type!=='worker'||consumer[0].script_name!==decl.value.workers[environment])fail('聊天队列消费者归属不符');
  return matching[0].id;
}
async function rebuild(call,state,decl,approved){
  const database=state.found.d1.uuid,tables=durableTables(decl),backup_id=approved.backup_id??randomUUID();
  if(!approved.backup_id){const rows=await query(call,database,'UPDATE tatachat_module SET frozen=1,backup_id=?1 WHERE version=1 AND frozen=0 RETURNING version',[backup_id]);if(rows.length!==1)fail('数据库已冻结，必须使用已验证快照恢复');}
  let destructive=Boolean(approved.backup_id);
  try{
    let definitions,current;
    if(approved.backup_id){const saved=await query(call,database,'SELECT columns FROM tatachat_backup_sets WHERE backup_id=?1',[backup_id]);definitions=JSON.parse(saved[0].columns);current=approved.row_counts;if(!Array.isArray(definitions)||definitions.length!==tables.length||definitions.some((x,i)=>x.table!==tables[i]||!Array.isArray(x.cols)||!x.cols.length||x.cols.some(c=>!/^\w+$/u.test(c))))fail('快照列定义无效');}
    else{
    const unknown=await query(call,database,"SELECT count(*) AS n FROM attachment_uploads WHERE state='writing'");
    if(unknown[0]?.n!==0)fail('存在未知上传，不能开始重建');
    current=await counts(call,database,tables);if(JSON.stringify(current)!==JSON.stringify(approved.row_counts))fail('数据数量已变化，需重新规划');
    definitions=[];for(const table of tables){const cols=await query(call,database,`PRAGMA table_info(${table})`);if(!cols.length||cols.length>16||cols.some(x=>!/^\w+$/u.test(x.name)))fail('表结构不支持安全快照');definitions.push({table,cols:cols.map(x=>x.name)});}
    await query(call,database,"INSERT INTO tatachat_backup_sets VALUES(?1,?2,?3,'preparing',?4)",[backup_id,decl.sha256,Date.now(),JSON.stringify(definitions)]);
    const select=definitions.map(({table,cols})=>`SELECT ?1,'${table}',rowid,json_object(${cols.flatMap(col=>[`'${col}'`,col]).join(',')}) FROM ${table}`).join(' UNION ALL ');
    await query(call,database,'INSERT INTO tatachat_backups '+select,[backup_id]);
    for(const {table,cols}of definitions){const expr=`json_object(${cols.flatMap(col=>[`'${col}'`,col]).join(',')})`;const diff=await query(call,database,`SELECT count(*) AS n FROM (SELECT ${expr} AS record FROM ${table} EXCEPT SELECT record FROM tatachat_backups WHERE backup_id=?1 AND table_name=?2)`,[backup_id,table]);const n=await query(call,database,'SELECT count(*) AS n FROM tatachat_backups WHERE backup_id=?1 AND table_name=?2',[backup_id,table]);if(diff[0]?.n!==0||n[0]?.n!==current[table])fail('云内快照验真失败');}
    await query(call,database,"UPDATE tatachat_backup_sets SET state='verified' WHERE backup_id=?1",[backup_id]);
    }
    destructive=true;
    // 只重建本模块业务表，保留资源ID、对象桶、DO、队列和已验证快照。
    for(const table of [...tables].reverse())await query(call,database,`DROP TABLE IF EXISTS ${table}`);
    await query(call,database,reusableSchema(decl.source));
    for(const{table,cols}of definitions){await query(call,database,`INSERT INTO ${table}(${cols.join(',')}) SELECT ${cols.map(c=>`json_extract(record,'$.${c}')`).join(',')} FROM tatachat_backups WHERE backup_id=?1 AND table_name=?2 ORDER BY row_id`,[backup_id,table]);}
    for(const{table,cols}of definitions){const expr=`json_object(${cols.flatMap(c=>[`'${c}'`,c]).join(',')})`;const result=await query(call,database,`SELECT count(*) AS n FROM (SELECT record FROM tatachat_backups WHERE backup_id=?1 AND table_name=?2 EXCEPT SELECT ${expr} AS record FROM ${table})`,[backup_id,table]);if(result[0]?.n!==0)fail('重建回读不一致');}
    if(JSON.stringify(await counts(call,database,tables))!==JSON.stringify(current))fail('重建数量不一致');
    await verifySchema(call,database,decl);const released=await query(call,database,'UPDATE tatachat_module SET frozen=0,backup_id=NULL WHERE version=1 AND backup_id=?1 RETURNING frozen',[backup_id]);if(released.length!==1||released[0].frozen!==0)fail('冻结属主已经变化');return {backup_id,data_preserved:true};
  }catch(error){if(!destructive){await query(call,database,'UPDATE tatachat_module SET frozen=0,backup_id=NULL WHERE version=1 AND backup_id=?1',[backup_id]).catch(()=>{});}fail(destructive?'重建失败，已保留云内快照；须回读冻结状态及活动备份后恢复，备份编号 '+backup_id:typeof error.message==='string'&&error.message.startsWith('聊天云资源：')?error.message:'重建准备失败，业务表尚未重建');}
}
export async function manage({environment,account_id,operation,approval_sha256,call,work,backup_id=null}){
  if(operation==='create'){
    if(typeof work!=='string'||resolve(work)!==work||!work.startsWith(join(root,'target')+'/')||!['test','build'].includes(work.slice((join(root,'target')+'/').length).split('/')[0]))fail('回执目录越界');
    for(let p=work;;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory()||await realpath(p)!==p)fail('回执目录不规范');if(p===root)break;}
  }
  const approved=await plan({environment,account_id,operation,call,backup_id});
  if(operation==='verify'){const decl=await declaration(),state=await inventory(call,decl,environment);if(!state.found.d1||!state.found.r2||!state.found.queue)fail('资源缺失');await verifySchema(call,state.found.d1.uuid,decl);await privateBucket(call,state.resources.r2.name);const namespace_id=await bindings(call,state,decl,environment);return {schema:1,product_id:'citizenserve',environment,verified:true,namespace_id};}
  if(approval_sha256!==approved.approval_sha256)fail('准确操作未获确认或现状变化');
  const decl=await declaration(),state=await inventory(call,decl,environment);
  if(operation==='create'){
    if(state.found.r2||state.found.queue){
      let proof;try{proof=JSON.parse((await regular(join(work,'tatachat-cloudflare-bindings.json'))).toString('utf8'));}catch{proof=null;}
      const ownReceipt=proof?.account_id===account_id&&proof.environment===environment&&proof.schema_sha256===decl.sha256&&proof.worker===decl.value.workers[environment];
      if(!ownReceipt){const settings=(await call('GET',`/workers/scripts/${decl.value.workers[environment]}/settings`)).result?.bindings;if(!Array.isArray(settings))fail('既有资源归属无法确认');if(state.found.r2&&!settings.some(b=>b.type==='r2_bucket'&&b.name===state.resources.r2.binding&&b.bucket_name===state.resources.r2.name)||state.found.queue&&!settings.some(b=>b.type==='queue'&&b.name===state.resources.queue.binding&&b.queue_name===state.resources.queue.name))fail('禁止接管未绑定到本模块的同名资源');}
      else if(proof.database_id!==state.found.d1?.uuid||proof.bucket!==state.resources.r2.name||proof.queue_id!==state.found.queue?.queue_id)fail('既有资源与本任务回执不符');
    }

    if(!state.found.d1){const result=await call('POST','/d1/database',{name:state.resources.d1.name});if(!uuid(result.result?.uuid))fail('新D1回执无效');state.found.d1=result.result;await query(call,result.result.uuid,decl.source);await query(call,result.result.uuid,'UPDATE tatachat_module SET schema_sha256=?1 WHERE version=1',[decl.sha256]);}
    else{const module=await verifySchema(call,state.found.d1.uuid,decl,true);if(module.schema_sha256==='')await query(call,state.found.d1.uuid,'UPDATE tatachat_module SET schema_sha256=?1 WHERE version=1 AND schema_sha256=\'\'',[decl.sha256]);}
    if(!state.found.r2){const n=await counts(call,state.found.d1.uuid,['attachment_uploads']);if(n.attachment_uploads!==0)fail('已有附件对象定位但桶缺失，不能创建空桶冒充恢复');await call('POST','/r2/buckets',{name:state.resources.r2.name});state.found.r2={name:state.resources.r2.name};}
    await privateBucket(call,state.resources.r2.name);
    if(!state.found.queue){const result=await call('POST','/queues',{queue_name:state.resources.queue.name});if(!id(result.result?.queue_id))fail('新Queue回执无效');state.found.queue=result.result;}
    await verifySchema(call,state.found.d1.uuid,decl);
    const receipt={schema:1,product_id:'citizenserve',platform:'cloudflare',environment,account_id,schema_sha256:decl.sha256,database_id:state.found.d1.uuid,bucket:state.resources.r2.name,queue:state.resources.queue.name,queue_id:state.found.queue.queue_id,durable_object_class:state.resources.durable_object.class_name,migration_tag:decl.value.migration_tag,worker:decl.value.workers[environment],binding_verification_pending:true};
    const snippets=`# 真实资源回执生成的候选；只含聊天绑定，不包含普通宿主或公开测试路由。
[[d1_databases]]
binding = "TATACHAT_DB"
database_name = "${state.resources.d1.name}"
database_id = "${receipt.database_id}"

[[r2_buckets]]
binding = "TATACHAT_ATTACHMENTS"
bucket_name = "${receipt.bucket}"

[durable_objects]
bindings = [{ name = "TATACHAT_DEVICES", class_name = "TataChatDevice" }]

[[migrations]]
tag = "tatachat-1"
new_sqlite_classes = ["TataChatDevice"]

[[queues.producers]]
binding = "TATACHAT_PUSH"
queue = "${receipt.queue}"

[[queues.consumers]]
queue = "${receipt.queue}"
max_batch_size = 1
max_retries = 5

# [vars] 内 TATACHAT_QUEUE_NAME 必须为 "${receipt.queue}"；Worker必须为 "${receipt.worker}"。
`;
    const candidate=join(work,'tatachat-wrangler-bindings.toml');try{await writeFile(candidate,snippets,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||(await regular(candidate)).toString('utf8')!==snippets)fail('配置候选已存在且不匹配');}
    const file=join(work,'tatachat-cloudflare-bindings.json'),body=JSON.stringify(receipt,null,2)+'\n';try{await writeFile(file,body,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||(await regular(file)).toString('utf8')!==body)fail('绑定回执已存在且不匹配');}return receipt;
  }
  if(!state.found.d1||!state.found.r2||!state.found.queue)fail('维护或重建前资源必须齐备');
  await privateBucket(call,state.resources.r2.name);
  await bindings(call,state,decl,environment);
  if(operation==='maintain'){const slot=Math.floor(Date.now()/300000)*300000;await query(call,state.found.d1.uuid,"INSERT INTO maintenance(slot,state) VALUES(?1,'pending') ON CONFLICT(slot) DO NOTHING",[slot]);await call('POST',`/queues/${state.found.queue.queue_id}/messages`,{body:{version:1,kind:'maintenance',id:String(slot)},content_type:'json'});return {schema:1,product_id:'citizenserve',environment,scheduled_slot:slot};}
  if(operation==='rebuild')return rebuild(call,state,decl,approved);
  fail('操作无效');
}
// CLI需双向能力FD。控制台目前没有该公开能力，必须明确失败；不能读取其Keychain或私有发布通道。
export async function runtimeCLI(args,{signal}={}){
  if(args.length!==3||!['plan','create','maintain','rebuild','verify'].includes(args[0])||!/^\d+$/u.test(args[2])||Number(args[2])<3||resolve(args[1])!==args[1])fail('runtime入口参数无效');
  let input;try{input=JSON.parse((await regular(args[1])).toString('utf8'));}catch{fail('runtime输入无效');}
  if(input.mode!=='independent')fail('必须显式独立能力模式；控制台公开云资源能力尚未提供');
  const {createReadStream,writeSync}=await import('node:fs');const {createInterface}=await import('node:readline');
  const fd=Number(args[2]),stream=createReadStream(null,{fd,autoClose:false,highWaterMark:16384});
  const lines=createInterface({input:stream,crlfDelay:Infinity});const replies=lines[Symbol.asyncIterator]();let serial=0;
  const request=async({method,url,body})=>{
    signal?.throwIfAborted();const id=++serial;
    const bytes=Buffer.from(JSON.stringify({schema:1,id,product_id:'citizenserve',platform:'cloudflare',environment:input.environment,account_id:input.account_id,operation:args[0],approval_sha256:input.approval_sha256??null,method,url,body})+'\n');
    let offset=0;while(offset<bytes.length){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(!written)fail('能力发送失败');offset+=written;}
    let timer,abort,reply;try{reply=await Promise.race([replies.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('能力回执超时')),30000);abort=()=>reject(Error('能力取消'));signal?.addEventListener('abort',abort,{once:true});})]);}finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
    if(reply.done||Buffer.byteLength(reply.value)>1024*1024)fail('能力回执缺失或超限');
    const value=JSON.parse(reply.value);if(value.schema!==1||value.id!==id||value.product_id!=='citizenserve'||value.platform!=='cloudflare'||value.account_id!==input.account_id||value.environment!==input.environment)fail('能力回执身份不符');return value.result;
  };
  try{const call=cloudClient({account_id:input.account_id,request,signal});if(args[0]==='plan')return await plan({...input,call});return await manage({...input,operation:args[0],call});}
  finally{lines.close();stream.destroy();}
}
