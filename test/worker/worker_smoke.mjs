// 实际worker-build ESM/WASM + 本地workerd/D1/R2。所有出站请求均由闭合白名单测试服务处理。
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {testKeys,verifyJwt} from './push_crypto.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
// 本机测试只加载本仓固定test资源视图；正式/既有入口继续按原模块解析。
const require=createRequire(process.env.CITIZENSERVE_TEST_WORKER_DIR===join(root,'target/test/worker')?join(root,'target/test/npm/package.json'):import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
// 临时宿主仅接受本次源码快照内target/test/worker准确目录，禁止链接或外部产物。
const testWorker=process.env.CITIZENSERVE_TEST_WORKER_DIR;
const workerRoot=testWorker??join(root,'target/build/cloudflare/worker');
if(testWorker!==undefined){
 if(testWorker!==join(root,'target/test/worker')||await realpath(testWorker)!==testWorker)throw Error('临时Worker宿主目录越界');
 for(const name of ['index.js','index_bg.wasm']){
  const file=join(testWorker,name),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||await realpath(file)!==file)throw Error('临时Worker宿主文件无效');
 }
}
const fixture=JSON.parse(await readFile(new URL('../contract/maintenance.json',import.meta.url)));
const registration=JSON.parse(await readFile(new URL('../contract/activation.json',import.meta.url)));
const networkRequests=JSON.parse(await readFile(new URL('../contract/ethereum_rpc.json',import.meta.url))).requests;
const networkMethods=new Set(networkRequests.map(request=>request.method));
const receivedRpc=[];
// 静态上游为闭合合成夹具，只证明Rust Worker传输合同，不冒充正式安装页或TLS验收。
const networkHTML='<html><body>MetaMask 静态交付夹具</body></html>';
const networkPNG=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
let networkAssetMode='normal',runtimeTargetMode='normal';
const keys=testKeys();const mls=generateKeyPairSync('ed25519');const publicKey='0x'+mls.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');const device=publicKey.slice(2);
const token='sqs_'+'12'.repeat(16);const digest=b=>createHash('sha256').update(b).digest('hex');const tokenHash=digest(token);
let mf,db,worker,privateBucket,publicBucket,chatDB,chatBucket;
let anchorTime;
let slowChain=0,firstLeaseExpiry=0,renewedLeaseExpiry=0;
const seen=[];let pushStatus=200,pushReason='BadDeviceToken',purgeFailure=false,rotateDuringPush=false,unknownChain=false;
const h=n=>'0x'+n.toString(16).padStart(2,'0').repeat(32);
const id=(kind,parts)=>({fanout:'nj_',delivery:'nd_',maintenance:'mt_'}[kind]+digest(JSON.stringify(parts)));
if(!process.env.PYTHON?.startsWith('/'))throw Error('必须交付已验真的Python绝对入口');
const seed=JSON.parse(execFileSync(process.env.PYTHON,['-c',String.raw`
import sys,sqlite3,json
sys.path.insert(0,sys.argv[1]+'/test')
from community_storage_contract import ready
from auth_storage_contract import SCHEMA
b=sqlite3.connect(':memory:');ready(b)
statements=[];part=''
for line in SCHEMA.splitlines(True):
 part+=line
 if sqlite3.complete_statement(part):
  if part.strip():statements.append({'sql':part,'args':[]})
  part=''
for table in ['users','registration_enrollments','mls_devices','square_sessions','cid_admissions','user_identity_checks','user_profiles','square_memberships','scheduler_leases','user_projection_cursor','membership_projection_cursor']:
 for row in b.execute('SELECT * FROM '+table):statements.append({'sql':'INSERT OR IGNORE INTO '+table+' VALUES('+','.join('?' for _ in row)+')','args':list(row)})
print(json.dumps(statements))
`,root],{encoding:'utf8'}));
async function sql(query,...params){return db.prepare(query).bind(...params).run();}
async function first(query,...params){return db.prepare(query).bind(...params).first();}
async function outbound(req){
 const url=new URL(req.url);seen.push({url:req.url,method:req.method});
 if(url.origin==='https://chain.example.test'){
  if(req.method==='GET'){
   const mode=networkAssetMode;
   assert.ok(url.pathname==='/'||url.pathname==='/icons/gmb.png');
   assert.equal(url.search,'');
   assert.equal(req.headers.get('CF-Access-Client-Id'),'offline-test.access');
   assert.equal(req.headers.get('CF-Access-Client-Secret'),'offline-test');
   assert.equal(req.headers.get('authorization'),null);assert.equal(req.headers.get('cookie'),null);
   const type=url.pathname==='/'?'text/html; charset=utf-8':'image/png';
   const headers={'content-type':type,'set-cookie':'synthetic-upstream-cookie','x-upstream-only':'synthetic',
    'CF-Access-Client-Id':'synthetic-upstream-id','CF-Access-Client-Secret':'synthetic-upstream-secret'};
   if(mode==='redirect')return new Response(null,{status:302,headers:{...headers,location:'https://forbidden.example/resource'}});
   if(mode==='missing')return new Response('synthetic-upstream-error',{status:404,headers});
   if(mode==='type')headers['content-type']='application/json';
   if(mode==='no-type'){delete headers['content-type'];return new Response(Uint8Array.of(60,62),{headers});}
   if(mode==='utf8')return new Response(Uint8Array.of(255),{headers});
   if(mode==='headers-timeout')await new Promise(resolve=>setTimeout(resolve,5000));
   if(mode==='body-timeout'){
    let timer;return new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(60));timer=setTimeout(()=>controller.close(),5000);},cancel(){clearTimeout(timer);}}),{headers});
   }
   if(mode==='oversize'){
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(65536).fill(32));controller.enqueue(new Uint8Array(65536).fill(32));controller.enqueue(Uint8Array.of(32));controller.close();}}),{headers});
   }
   if(mode==='limit')return new Response(new Uint8Array(128*1024).fill(32),{headers});
   return new Response(url.pathname==='/'?networkHTML:networkPNG,{headers});
  }
  if(unknownChain)return new Response('{}',{status:503});
  if(slowChain>0){const round=slowChain--;if(round===4)firstLeaseExpiry=(await first("SELECT lease_expires_at FROM maintenance_jobs WHERE state='leased' AND artifact_owner IS NULL ORDER BY updated_at DESC LIMIT 1")).lease_expires_at;await new Promise(resolve=>setTimeout(resolve,8000));if(round===1)renewedLeaseExpiry=(await first("SELECT lease_expires_at FROM maintenance_jobs WHERE state='leased' AND artifact_owner IS NULL ORDER BY updated_at DESC LIMIT 1")).lease_expires_at;}
  const {method,params,id:rid}=await req.json();receivedRpc.push(method);let result;
  if(method==='chain_getFinalizedHead')result=fixture.head;
  else if(method==='chain_getBlockHash')result=params[0]===0?fixture.genesis:h(Number(params[0]));
  else if(method==='chain_getHeader'){const n=parseInt(params[0]?.slice(2,4)||'09',16);result={number:'0x'+n.toString(16),parentHash:h(Math.max(0,n-1)),stateRoot:h(1),extrinsicsRoot:h(2),digest:{logs:[]}};}
  else if(method==='state_getRuntimeVersion'){
   assert.deepEqual(params,[fixture.head]);
   result=runtimeTargetMode==='wrong-name'?{specVersion:7,specName:'other'}:runtimeTargetMode==='overflow'?{specVersion:2**32,specName:'citizenchain'}:{specVersion:7,specName:'citizenchain'};
  }
  else if(method==='state_getMetadata')result=fixture.metadata;
  else if(method==='state_getStorage'){
   result=fixture.storage[params[0]]??null;
   if(params[0]===fixture.timestamp_key){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(anchorTime));result='0x'+b.toString('hex');}

  }else if(networkMethods.has(method))result=method==='eth_chainId'?'0x7eb':method==='net_version'?'2027':null;
  else throw new Error('unexpected RPC '+method);
  return Response.json({jsonrpc:'2.0',id:rid,result});
 }
 if(url.hostname==='api.sandbox.push.apple.com'||url.hostname==='api.push.apple.com'){
  assert.match(url.pathname,/^\/3\/device\/[0-9a-f]{64}$/);const jwt=verifyJwt(req.headers.get('authorization').split(' ')[1],keys.ec.publicKey,'ES256');assert.equal(jwt.claims.iss,'TEAM123456');assert.equal(jwt.header.kid,'KEY1234567');assert.equal(req.headers.get('apns-topic'),'com.test.citizen');assert.equal(req.headers.get('apns-collapse-id').length,64);const body=await req.text();assert.ok(Buffer.byteLength(body)<=4096);const payload=JSON.parse(body);if(payload.event==='chat_wake'){assert.deepEqual(Object.keys(payload).sort(),['aps','event']);assert.equal(payload.aps.alert.body,'New message');}else assert.equal(payload.citizen.kind,'square_post');
  if(rotateDuringPush){rotateDuringPush=false;await sql('UPDATE push_endpoints SET endpoint_revision=endpoint_revision+1,push_token=?','cd'.repeat(32));}
  return pushStatus===200?new Response(null,{status:200}):Response.json({reason:pushReason},{status:pushStatus,headers:{'retry-after':'1'}});
 }
 if(req.url==='https://oauth2.googleapis.com/token'){
  const form=new URLSearchParams(await req.text());assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');const jwt=verifyJwt(form.get('assertion'),keys.rsa.publicKey,'RS256');assert.equal(jwt.claims.scope,'https://www.googleapis.com/auth/firebase.messaging');assert.equal(jwt.claims.aud,req.url);assert.equal(jwt.claims.exp-jwt.claims.iat,3600);return Response.json({access_token:'offline-test-token',token_type:'Bearer',expires_in:3600});
 }
 if(req.url==='https://fcm.googleapis.com/v1/projects/test-project/messages:send'){
  assert.equal(req.headers.get('authorization'),'Bearer offline-test-token');const payload=await req.json();if(payload.message.data.event==='chat_wake')assert.deepEqual(payload.message.data,{event:'chat_wake'});else assert.equal(payload.message.data.citizen.includes('square_post'),true);return pushStatus===200?Response.json({name:'projects/test-project/messages/test-1'}):Response.json({error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:pushReason}]}},{status:pushStatus});
 }
 if(req.url==='https://api.cloudflare.com/client/v4/zones/'+'11'.repeat(16)+'/purge_cache'){
  const {files}=await req.json();assert.ok(files.every(u=>u.startsWith('https://media.example.test/square/')));if(purgeFailure){purgeFailure=false;return Response.json({success:false},{status:503});}return Response.json({success:true});
 }
 throw new Error('Forbidden external request '+req.url);
}
// 只在本地夹具入口计数，真实Worker ESM/WASM保持原样；不增加产品路由。
const instrumentedEntry=String.raw`
import Actual,{TataChatDevice as Device} from './index.js';
import {WorkerEntrypoint} from 'cloudflare:workers';
const counters={do_window_reads:0,do_window_writes:0,contexts:0,statements:0,batches:0,r2_head:0,r2_get:0,r2_put:0,r2_delete:0,queue_sends:0,body_reads:0};let queueMessages=[],failDeletionReceipt=0;const queues=new WeakMap();const databases=new WeakMap(),buckets=new WeakMap(),requests=new WeakMap();let failReceipt=false;
function database(db){if(databases.has(db))return databases.get(db);const proxy=new Proxy(db,{get(target,key){
 if(key==='constructor')return target.constructor;
 if(key==='prepare')return sql=>{counters.statements++;if(sql.includes("CASE WHEN d.device_id IS NOT NULL THEN json_object"))counters.contexts++;if(failReceipt&&sql.startsWith("UPDATE attachment_uploads SET state='written',object_version=?3")){failReceipt=false;return target.prepare("UPDATE synthetic_unavailable SET first=?1,second=?2 WHERE third=?3");}if(failDeletionReceipt>0&&sql.startsWith("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='written'")){failDeletionReceipt--;return target.prepare("UPDATE synthetic_unavailable SET first=?1,second=?2 WHERE third=?3");}return target.prepare(sql);};
 if(key==='batch')return async statements=>{counters.batches++;return target.batch(statements);};
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});databases.set(db,proxy);return proxy;}
function bucket(value){if(buckets.has(value))return buckets.get(value);const proxy=new Proxy(value,{get(target,key){
 if(key==='constructor')return target.constructor;
 const member=Reflect.get(target,key,target);if(['head','get','put','delete'].includes(key))return (...args)=>{counters['r2_'+key]++;return member.apply(target,args);};return typeof member==='function'?member.bind(target):member;
}});buckets.set(value,proxy);return proxy;}
// 升级向原生DO转交真实Request；普通HTTP的正文计数仍覆盖真实流读取。
function input(request){if(requests.has(request))return requests.get(request);const proxy=new Proxy(request,{get(target,key){
 if(key==='constructor')return target.constructor;if(key==='clone')return ()=>input(target.clone());
 if(key==='body'){counters.body_reads++;return target.body;}
 const value=Reflect.get(target,key,target);if(['arrayBuffer','text','json','formData'].includes(key))return (...args)=>{counters.body_reads++;return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;
}});requests.set(request,proxy);return proxy;}
function queue(value){if(queues.has(value))return queues.get(value);const proxy=new Proxy(value,{get(target,key){if(key==='constructor')return target.constructor;const member=Reflect.get(target,key,target);if(key==='send')return (body,options)=>{counters.queue_sends++;queueMessages.push({body:typeof body==='string'?JSON.parse(body):body,delay:options?.delaySeconds??0});return member.call(target,body,options);};return typeof member==='function'?member.bind(target):member;}});queues.set(value,proxy);return proxy;}
function environment(env){return new Proxy(env,{get(target,key){const value=Reflect.get(target,key,target);return key==='TATACHAT_PUSH'?queue(value):key==='DB'||key==='TATACHAT_DB'?database(value):['SQUARE_PRIVATE','SQUARE_PUBLIC_MEDIA','TATACHAT_ATTACHMENTS'].includes(key)?bucket(value):value;}});}
export default class extends WorkerEntrypoint {
 async fetch(request){if(new URL(request.url).hostname==='fixture.internal'){if(new URL(request.url).pathname==='/fail-deletion-receipt'){failDeletionReceipt=Number(await request.text());return new Response(null,{status:204});}if(new URL(request.url).pathname==='/fail-receipt'){failReceipt=true;return new Response(null,{status:204});}const result={...counters,queue_messages:queueMessages};if(request.method==='DELETE'){for(const key in counters)counters[key]=0;queueMessages=[];}return Response.json(result);}return new Actual(this.ctx,environment(this.env)).fetch(new URL(request.url).pathname==='/api/tatachat/realtime'?request:input(request));}
 queue(batch){return new Actual(this.ctx,environment(this.env)).queue(batch);}
 scheduled(event){return new Actual(this.ctx,environment(this.env)).scheduled(event);}
}
// 仅夹具记录真实固定窗I/O并可重建Rust实例；不改变发布ESM/WASM或生产时间。
function deviceState(state){
 const storage=new Proxy(state.storage,{get(target,key){
  if(key==='get'||key==='put')return (...args)=>{if(args[0]==='resource:minute')counters[key==='get'?'do_window_reads':'do_window_writes']++;return target[key](...args);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 return new Proxy(state,{get(target,key){if(key==='storage')return storage;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
}
export class TataChatDevice extends Device {
 constructor(state,env){super(deviceState(state),environment(env));this.fixtureState=state;this.fixtureEnv=env;this.recreated=null;}
 async fetch(request){if(request.url==='https://fixture.internal/window'){
  if(request.method==='PUT'){
   const value=await request.json();
   if('frames' in value||'bytes' in value||'pings' in value||'minute' in value){
    const window={minute:value.minute??Math.floor(Date.now()/60000),frames:value.frames??0,bytes:value.bytes??0};
    if('pings' in value)window.pings=value.pings;
    await this.fixtureState.storage.put('resource:minute',window);
   }
   if(value.recreate)this.recreated=new Device(deviceState(this.fixtureState),environment(this.fixtureEnv));
  }
  return Response.json((await this.fixtureState.storage.get('resource:minute'))??null);
 }return this.recreated?this.recreated.fetch(request):super.fetch(request);}
 async webSocketMessage(...args){return this.recreated?this.recreated.webSocketMessage(...args):super.webSocketMessage(...args);}
 async webSocketClose(...args){return this.recreated?this.recreated.webSocketClose(...args):super.webSocketClose(...args);}
 async webSocketError(...args){return this.recreated?this.recreated.webSocketError(...args):super.webSocketError(...args);}
 async alarm(...args){return this.recreated?this.recreated.alarm(...args):super.alarm(...args);}
}

`;
export async function queryCounts(reset=false){return (await worker.fetch('https://fixture.internal/counts',{method:reset?'DELETE':'GET'})).json();}
export async function startWorker(extraBindings={},readLimit=1000){
 anchorTime=Date.now();
 mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:"citizenserve",modules:[{type:'ESModule',path:join(workerRoot,'_test_entry.mjs'),contents:instrumentedEntry},{type:'ESModule',path:join(workerRoot,'index.js')},{type:'CompiledWasm',path:join(workerRoot,'index_bg.wasm')}],modulesRoot:workerRoot,compatibilityDate:'2026-10-07',compatibilityFlags:['no_nodejs_global_timers'],
 bindings:{TATACHAT_QUEUE_NAME:'citizenserve-tatachat-test',WEB_ORIGIN:registration.service_origin,REGISTRATION_SCOPE:registration.registration_scope,TURNSTILE_SITEKEY:'0x4AAAAAAD0GQRiB2O3a0DYJ',CHAIN_GENESIS_HASH:fixture.genesis,CHAIN_URL:'https://chain.example.test',CF_ACCESS_CLIENT_ID:'offline-test.access',CHAIN_SECRET:'offline-test',HASH_KEY:'synthetic-rate-key-for-worker-fixture',APNS_KEY:keys.apns,APNS_KID:'KEY1234567',APNS_TEAM:'TEAM123456',APNS_TOPIC:'com.test.citizen',FCM_KEY:keys.fcm,FCM_EMAIL:'test@test-project.iam.gserviceaccount.com',FCM_PROJECT:'test-project',CF_ACCOUNT_ID:'11'.repeat(16),R2_KEY:'test',R2_SECRET:'test',ZONE_ID:'11'.repeat(16),PURGE:'test',SQUARE_PUBLIC_MEDIA_BASE_URL:'https://media.example.test',...extraBindings},
 d1Databases:['DB','TATACHAT_DB'],r2Buckets:['SQUARE_PRIVATE','SQUARE_PUBLIC_MEDIA','TATACHAT_ATTACHMENTS'],durableObjects:{TATACHAT_DEVICES:{className:'TataChatDevice',useSQLite:true}},kvNamespaces:['SQUARE_CACHE'],queueProducers:{NOTIFY:'citizenserve',TATACHAT_PUSH:'citizenserve-tatachat-test'},ratelimits:Object.fromEntries(['RATE_AUTH','RATE_READ','RATE_WRITE'].map((n,i)=>[n,{namespace_id:String(i+1),simple:{limit:n==='RATE_READ'?readLimit:1000,period:60}}])),outboundService:outbound}]}));
 db=await mf.getD1Database('DB');worker=await mf.getWorker();privateBucket=await mf.getR2Bucket('SQUARE_PRIVATE');publicBucket=await mf.getR2Bucket('SQUARE_PUBLIC_MEDIA');
 chatBucket=await mf.getR2Bucket('TATACHAT_ATTACHMENTS');chatDB=await mf.getD1Database('TATACHAT_DB');const chatSchema=JSON.parse(execFileSync(process.env.PYTHON,['-c',String.raw`
import sys,sqlite3,json
parts=[];part=''
for line in open(sys.argv[1]):
 part+=line
 if sqlite3.complete_statement(part):
  if part.strip():parts.append(part)
  part=''
if part.strip():raise ValueError('schema末尾不完整')
print(json.dumps(parts))
`,root+'/server/cloudflare/tatachat/schema.sql'],{encoding:'utf8'}));for(const statement of chatSchema)await chatDB.prepare(statement).run();
 for(const stmt of seed)await sql(stmt.sql,...stmt.args);
 await sql('DELETE FROM mls_devices');await sql('DELETE FROM square_sessions');await sql('INSERT INTO mls_devices VALUES(?,?,1,?,?,1,?,?,?)',fixture.cid,device,fixture.account,publicKey,Date.now(),Date.now(),Date.now());await sql('INSERT INTO square_sessions VALUES(?,?,1,?,?,?,?)',tokenHash,fixture.cid,fixture.account,device,Date.now(),Date.now()+86400000);
 const i=JSON.parse(await readFile(new URL('../contract/finalized_identity.json',import.meta.url)));i.checked_at_millis=Date.now();i.verification_deadline_millis=i.checked_at_millis+60000;i.chain_scope=fixture.genesis;i.registered_block_number=0;i.registered_block_hash=fixture.genesis;i.registered_at_millis=0;i.finalized_timestamp_millis=anchorTime;
 await sql('UPDATE user_identity_checks SET checked_at_millis=?,verification_deadline_millis=?,row_json=?',i.checked_at_millis,i.verification_deadline_millis,JSON.stringify(i));
 for(const kind of ['identity','membership'])await sql('UPDATE scheduler_leases SET last_slot=9,updated_at=? WHERE lease_key=?',Date.now(),'sync:'+kind+':'+fixture.genesis);
 await sql('UPDATE user_projection_cursor SET finalized_block_number=9,finalized_block_hash=?',fixture.head);await sql('UPDATE membership_projection_cursor SET finalized_block_number=9,finalized_block_hash=?',fixture.head);
 const cache=await mf.getKVNamespace('SQUARE_CACHE'),now=Date.now();await cache.put('membership:prices:'+fixture.genesis,JSON.stringify({created:now,deadline:now+600000,value:JSON.parse(await readFile(new URL('../contract/subscription.json',import.meta.url))).prices}));
 await setMembership();
}
export async function stopWorker(){await mf?.dispose();}
async function fetch(path,method='GET',body='',headers={}){return mf.dispatchFetch(registration.service_origin+path,{method,headers:{'cf-connecting-ip':'192.0.2.1','content-length':String(Buffer.byteLength(body)),...headers},...(method==='GET'||method==='DELETE'?{}:{body})});}
function vector(data){data=Buffer.from(data);const n=data.length;return Buffer.concat([Buffer.from(n<64?[n]:[0x40|(n>>8),n&255]),data]);}
function u64(n){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;}
async function proof(method,path,body='',identity={publicKey,token,key:mls}){
 const request={account_id:fixture.account,public_key:identity.publicKey,purpose:'request',method,request_target:path,body_sha256:'0x'+digest(body)};
 const r=await fetch('/api/user/challenges','POST',JSON.stringify(request),{authorization:'Bearer '+identity.token});assert.equal(r.status,200,await r.clone().text());const p=await r.json();delete p.ok;
 return signMlsProof(p,identity.key.privateKey);
}
function signMlsProof(p,key){
 const content=Buffer.concat([vector(p.user_id),Buffer.from(p.device_id,'hex'),Buffer.from(p.account_id.slice(2),'hex'),u64(p.binding_revision),vector(p.service_origin),Buffer.from(p.challenge.slice(2),'hex'),u64(p.expires_at_millis),vector(p.method),vector(p.request_target),Buffer.from(p.body_sha256.slice(2),'hex')]);p.signature='0x'+sign(null,Buffer.concat([vector('MLS 1.0 TataChatAuthentication'),vector(content)]),key).toString('hex');return Buffer.from(JSON.stringify(p)).toString('base64url');
}
export async function chatIdentity(extra=false){
 const key=extra?generateKeyPairSync('ed25519'):mls;const pub='0x'+key.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');const session=extra?'sqs_'+randomBytes(16).toString('hex'):token;const who={publicKey:pub,token:session,key};
 if(extra){const now=Date.now();await sql('INSERT INTO mls_devices VALUES(?,?,1,?,?,1,?,?,?)',fixture.cid,pub.slice(2),fixture.account,pub,now,now,now);await sql('INSERT INTO square_sessions VALUES(?,?,1,?,?,?,?)',digest(session),fixture.cid,fixture.account,pub.slice(2),now,now+86400000);}
 return {device:pub.slice(2),async credential(){const path='/api/tatachat/access',body='{}',p=await proof('POST',path,body,who);const r=await fetch(path,'POST',body,{authorization:'Bearer '+session,'x-mls-proof':p});assert.equal(r.status,200,await r.clone().text());return r.json();}};
}
export async function chatSQL(query,...args){return chatDB.prepare(query).bind(...args).run();}
export async function chatFirst(query,...args){return chatDB.prepare(query).bind(...args).first();}
export async function chatObject(key,body){return body===undefined?chatBucket.head(key):chatBucket.put(key,body);}
export async function chatUpgrade(credential,protocol='tatachat'){return mf.dispatchFetch(registration.service_origin+'/api/tatachat/realtime',{headers:{'cf-connecting-ip':'192.0.2.1',upgrade:'websocket',authorization:'Bearer '+credential.access_token,'sec-websocket-protocol':protocol}});}
export async function setChatDeletionReceiptFailure(count=1){const response=await worker.fetch('https://fixture.internal/fail-deletion-receipt',{method:'POST',body:String(count)});assert.equal(response.status,204);}
export async function setChatReceiptFailure(){const response=await worker.fetch('https://fixture.internal/fail-receipt',{method:'POST'});assert.equal(response.status,204);}
export async function chatWindow(device,value){const ns=await mf.getDurableObjectNamespace('TATACHAT_DEVICES');const stub=ns.get(ns.idFromName(JSON.stringify([fixture.cid,device])));const response=await stub.fetch('https://fixture.internal/window',value?{method:'PUT',body:JSON.stringify(value)}:{});return response.json();}
export async function chatQueue(body){return worker.queue('citizenserve-tatachat-test',[{id:'chat-fixture-'+randomBytes(8).toString('hex'),timestamp:new Date(),body,attempts:1}]);}
async function register(provider='apns'){
 const input={push_provider:provider,push_token:provider==='apns'?'ab'.repeat(32):'offline-fcm-token-123456',apns_environment:provider==='apns'?'sandbox':null,expires_at:Date.now()+86400000};const body=JSON.stringify(input);const p=await proof('PUT','/api/notifications/endpoint',body);const r=await fetch('/api/notifications/endpoint','PUT',body,{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,200,await r.clone().text());return r.json();
}
async function enqueue(kind,id){return worker.queue('citizenserve',[{id:'msg-'+id,timestamp:new Date(),body:{version:1,kind,id},attempts:1}]);}
async function notification(n=1){
 const j=id('fanout',['worker',String(n)]),tx='0x'+n.toString(16).padStart(64,'0');const now=Date.now();
 await sql("INSERT OR IGNORE INTO square_posts VALUES(?,?,?,'normal','document',NULL,'公开摘要','hash','receipt',9,?,?,?,'published')",'sqp_'+n,fixture.cid,fixture.account,fixture.head,tx,now);
 await sql('INSERT OR REPLACE INTO square_follows VALUES(?,?,?,1)',fixture.cid,fixture.cid,now-1);
 await sql("INSERT INTO notification_jobs(job_id,source_kind,source_key,cid_number,post_id,tx_hash,created_at,expires_at,updated_at) VALUES(?,'post',?,?,?,?,?,?,?)",j,'worker-post:'+n,fixture.cid,'sqp_'+n,tx,now,now+86400000,now);
 const result=await enqueue('fanout',j);assert.equal((await first('SELECT state FROM notification_jobs WHERE job_id=?',j)).state,'done',JSON.stringify(result));const d=await first('SELECT delivery_id FROM notification_deliveries WHERE job_id=?',j);assert.ok(d);return d.delivery_id;
}
// 被其他功能smoke导入时只复用夹具，不再次登记本文件的测试。
if(import.meta.url===pathToFileURL(process.argv[1]).href){
before(()=>startWorker());after(()=>stopWorker());
// 直接调用真实ESM/WASM入口；上游只允许受保护的两个固定资源及现有RPC。
const networkFetch=(path='/',method='GET',body,headers={})=>mf.dispatchFetch('https://nrcrpc.crcfrcn.com'+path,
 {method,headers:{'cf-connecting-ip':'192.0.2.123',...(body===undefined?{}:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}),...(method==='OPTIONS'?{'access-control-request-method':'POST'}:{}),...headers},...(body===undefined?{}:{body})});
const runtimeTargetFetch=(path='/api/chain/runtime-target',method='GET')=>mf.dispatchFetch(registration.service_origin+path,
 {method,headers:{'cf-connecting-ip':'192.0.2.124'}});
test('WASM只读目标绑定块0、finalized版本及固定响应字段',async()=>{
 const before=receivedRpc.length,response=await runtimeTargetFetch();
 assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{genesis_hash:fixture.genesis,finalized_head:fixture.head,spec_version:7,spec_name:'citizenchain'});
 assert.deepEqual(receivedRpc.slice(before),['chain_getBlockHash','chain_getFinalizedHead','chain_getHeader','chain_getBlockHash','state_getRuntimeVersion']);
});
test('WASM只读目标拒绝其它路径、方法、查询和错误链状态',async t=>{
 t.after(()=>{runtimeTargetMode='normal';unknownChain=false;});
 for(const [path,method,status] of [['/api/chain/runtime-target/','GET',404],['/api/chain/runtime-target','POST',404],['/api/chain/runtime-target','PUT',404],['/api/chain/runtime-target?scope=other','GET',400]]){
  const before=receivedRpc.length,response=await runtimeTargetFetch(path,method);
  assert.equal(response.status,status);await response.arrayBuffer();assert.equal(receivedRpc.length,before);
 }
 for(const mode of ['wrong-name','overflow']){
  runtimeTargetMode=mode;
  const response=await runtimeTargetFetch();assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/other|4294967296/);
 }
 runtimeTargetMode='normal';unknownChain=true;
 const response=await runtimeTargetFetch();assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/chain\.example\.test/);
});
test('WASM只读目标在真实块0不等于配置创世时失败关闭',async()=>{
 await stopWorker();
 try{
  await startWorker({CHAIN_GENESIS_HASH:h(99)});
  const response=await runtimeTargetFetch();assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/chain\.example\.test|offline-test/);
 }finally{await stopWorker();await startWorker();}
});
test('公共网络交付HTML和PNG字节，HEAD核验相同资源且不透传上游头',async()=>{
 for(const [path,expected,type] of [['/',Buffer.from(networkHTML),'text/html; charset=utf-8'],['/icons/gmb.png',networkPNG,'image/png']]){
  for(const method of ['GET','HEAD']){
   const before=seen.length,r=await networkFetch(path,method,undefined,{authorization:'synthetic-client-auth',cookie:'synthetic-client-cookie'});
   assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),type);assert.equal(r.headers.get('cache-control'),'no-store');
   assert.equal(r.headers.get('access-control-allow-origin'),'*');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
   for(const name of ['set-cookie','x-upstream-only','CF-Access-Client-Id','CF-Access-Client-Secret'])assert.equal(r.headers.get(name),null);
   assert.deepEqual(Buffer.from(await r.arrayBuffer()),method==='HEAD'?Buffer.alloc(0):expected);
   assert.deepEqual(seen.slice(before),[{url:'https://chain.example.test'+path,method:'GET'}]);
  }
 }
});
test('静态源取CHAIN_URL的origin，不继承RPC路径或查询',async()=>{
 await stopWorker();try{await startWorker({CHAIN_URL:'https://chain.example.test/protected/rpc?scope=fixture'});
  const before=seen.length,r=await networkFetch('/icons/gmb.png');assert.equal(r.status,200);await r.arrayBuffer();
  assert.deepEqual(seen.slice(before),[{url:'https://chain.example.test/icons/gmb.png',method:'GET'}]);
 }finally{await stopWorker();await startWorker();}
});
test('公共网络拒绝旧图标路径、未知路径、查询和错误方法且不访问上游',async()=>{
 for(const [path,method,status] of [['/crates/icons/gmb.png','GET',404],['/install.html','GET',404],['/icons/other.png','GET',404],
  ['/?url=https://forbidden.example/','GET',404],['/icons/gmb.png?v=1','GET',404],['/icons/gmb.png','POST',405],['/icons/gmb.png','OPTIONS',405],['/','PUT',405]]){
  const before=seen.length,r=await networkFetch(path,method);assert.equal(r.status,status);await r.arrayBuffer();assert.equal(seen.length,before);
 }
 const before=seen.length,r=await mf.dispatchFetch('http://nrcrpc.crcfrcn.com/');assert.equal(r.status,404);await r.arrayBuffer();assert.equal(seen.length,before);
});
test('静态错误媒体类型、缺媒体类型、非法UTF8、缺资源和重定向均封闭拒绝，HEAD失败无正文',async t=>{
 t.after(()=>{networkAssetMode='normal';});
 for(const mode of ['type','no-type','utf8','missing','redirect'])for(const method of ['GET','HEAD']){
  networkAssetMode=mode;const r=await networkFetch('/',method);assert.equal(r.status,503);
  const body=await r.text();if(method==='HEAD')assert.equal(body,'');else assert.doesNotMatch(body,/synthetic-upstream|forbidden\.example/);
  for(const name of ['set-cookie','location','CF-Access-Client-Secret'])assert.equal(r.headers.get(name),null);
 }
});
test('静态正文128KiB边界按真实流字节核验，超限的GET和HEAD均拒绝',async t=>{
 t.after(()=>{networkAssetMode='normal';});networkAssetMode='limit';
 const accepted=await networkFetch('/');assert.equal(accepted.status,200);assert.equal((await accepted.arrayBuffer()).byteLength,128*1024);
 networkAssetMode='oversize';for(const method of ['GET','HEAD']){const r=await networkFetch('/',method);assert.equal(r.status,503);if(method==='HEAD')assert.equal(await r.text(),'');else await r.text();}
});
test('静态3秒总超时覆盖响应头和正文读取', {timeout:20000},async t=>{
 t.after(()=>{networkAssetMode='normal';});
 for(const mode of ['headers-timeout','body-timeout']){
  networkAssetMode=mode;const start=performance.now(),r=await networkFetch('/');assert.equal(r.status,503);await r.text();
  const elapsed=performance.now()-start;assert.ok(elapsed>=2500&&elapsed<4500,'静态读取必须受同一3秒总截止时间限制');
 }
});
test('静态缺少Access配置失败，不向上游发请求',async()=>{
 for(const bindings of [{CHAIN_URL:''},{CF_ACCESS_CLIENT_ID:''},{CHAIN_SECRET:''}]){
  await stopWorker();try{await startWorker(bindings);const before=seen.length,r=await networkFetch('/');assert.equal(r.status,503);await r.text();assert.equal(seen.length,before);
  }finally{await stopWorker();await startWorker();}
 }
});
test('静态GET和HEAD共用现有RATE_READ，拒绝后不访问上游',async()=>{
 await stopWorker();try{await startWorker({},1);const first=await networkFetch('/');assert.equal(first.status,200);await first.text();
  const before=seen.length,r=await networkFetch('/icons/gmb.png','HEAD');assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');assert.equal(await r.text(),'');assert.equal(seen.length,before);
 }finally{await stopWorker();await startWorker();}
});
test('新增静态分流保留公共26方法RPC、批量拒绝和原App独立CORS',async()=>{
 assert.equal(networkRequests.length,26);
 for(const request of networkRequests){const r=await networkFetch('/','POST',JSON.stringify(request),{origin:registration.service_origin});
  assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'*');const v=await r.json();assert.equal(v.id,request.id);assert.ok(Object.hasOwn(v,'result'));
 }
 const callsBefore=receivedRpc.length;
 const denied=await networkFetch('/','POST',JSON.stringify({jsonrpc:'2.0',id:1,method:'author_submitExtrinsic',params:['0x00']}));
 assert.equal(denied.status,200);assert.equal((await denied.json()).error.code,-32601);
 assert.ok(!receivedRpc.slice(callsBefore).includes('author_submitExtrinsic'));
 for(const value of [
  [{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]},{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}],
  {jsonrpc:'2.0',method:'eth_chainId',params:[]}]){
  const before=seen.length,r=await networkFetch('/','POST',JSON.stringify(value));assert.equal(r.status,200);const reply=await r.json();assert.ok(reply.error||reply[0]?.error);assert.equal(seen.length,before);
 }
 const options=await networkFetch('/','OPTIONS');assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-methods'),'POST,OPTIONS');assert.equal(await options.text(),'');
 const app=await fetch('/api/health','GET','',{origin:registration.service_origin});assert.equal(app.headers.get('access-control-allow-origin'),registration.service_origin);await app.text();
 const other=await fetch('/api/health','GET','',{origin:'https://other.example'});assert.equal(other.headers.get('access-control-allow-origin'),null);await other.text();
});
// 缺失或未登记的预检方法必须在任何上游访问前拒绝；正常夹具明确声明POST。
test('公共网络预检必须声明已登记方法，缺失或非法方法不访问上游',async()=>{
 for(const headers of [{},{'access-control-request-method':'TRACE'},{'access-control-request-method':'POST','access-control-request-headers':'x-tatachat-internal'}]){
  const before=seen.length,r=await mf.dispatchFetch('https://nrcrpc.crcfrcn.com/',{method:'OPTIONS',headers});
  assert.ok([400,405].includes(r.status));await r.text();assert.equal(seen.length,before);
 }
});
test('actual Worker fetch and exact endpoint MLS guard',async()=>{
 const r=await fetch('/api/health');assert.equal(r.status,200);assert.equal((await r.json()).account_services_ready,false);
 const input=JSON.stringify({push_provider:'apns',push_token:'ab'.repeat(32),apns_environment:'sandbox',expires_at:Date.now()+86400000});const noSession=await fetch('/api/notifications/endpoint','PUT',input);assert.equal(noSession.status,401,await noSession.text());const noProof=await fetch('/api/notifications/endpoint','PUT',input,{authorization:'Bearer '+token});assert.equal(noProof.status,401);
 await register();const p=await proof('DELETE','/api/notifications/endpoint');const r2=await fetch('/api/notifications/endpoint','DELETE','',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r2.status,200,await r2.text());assert.equal((await first('SELECT COUNT(*) n FROM push_endpoints')).n,0);await register();
});
test('APNs实际WebCrypto签名、服务端授权零RPC、终态CAS与重复队列',async()=>{
 const d=await notification(1);const prior=seen.filter(x=>x.url.includes('push.apple.com')).length;await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'accepted');await enqueue('delivery',d);assert.equal(seen.filter(x=>x.url.includes('push.apple.com')).length,prior+1);
});
test('late old-token invalidation preserves rotated generation; topic error preserves endpoint',async()=>{
 const d=await notification(2);pushStatus=400;rotateDuringPush=true;await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'cancelled');assert.equal((await first('SELECT push_token FROM push_endpoints')).push_token,'cd'.repeat(32));await register();pushReason='DeviceTokenNotForTopic';const d2=await notification(3);await enqueue('delivery',d2);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d2)).state,'blocked');assert.equal((await first('SELECT COUNT(*) n FROM push_endpoints')).n,1);pushStatus=200;pushReason='BadDeviceToken';
});
test('FCM actual RS256 OAuth JWT and accepted name; invalid registration removed',async()=>{
 await register('fcm');let d=await notification(4);await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'accepted');pushStatus=404;pushReason='UNREGISTERED';d=await notification(5);await enqueue('delivery',d);assert.equal((await first('SELECT COUNT(*) n FROM push_endpoints')).n,0);pushStatus=200;pushReason='BadDeviceToken';await register();
});
test('通知链不可达仍按服务端授权投递，提供方429四次后阻断',async()=>{
 let d=await notification(6);unknownChain=true;const before=chainCalls();await enqueue('delivery',d);assert.equal(chainCalls(),before);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'accepted');unknownChain=false;
 d=await notification(7);pushStatus=429;for(let n=0;n<4;n++){await sql('UPDATE notification_deliveries SET next_attempt_at=0 WHERE delivery_id=?',d);await enqueue('delivery',d);}assert.deepEqual(await first('SELECT state,attempts FROM notification_deliveries WHERE delivery_id=?',d),{state:'blocked',attempts:4});pushStatus=200;
});
test('scheduled persists one slot, queue consumes auth and audit; no financial TTL delete',async()=>{
 const time=Date.now();await worker.scheduled({scheduledTime:new Date(time),cron:'*/5 * * * *'});const count=(await first('SELECT COUNT(*) n FROM maintenance_jobs WHERE artifact_owner IS NULL')).n;assert.equal(count,6);await worker.scheduled({scheduledTime:new Date(time),cron:'*/5 * * * *'});assert.equal((await first('SELECT COUNT(*) n FROM maintenance_jobs WHERE artifact_owner IS NULL')).n,count);
 const auth=await first("SELECT job_id FROM maintenance_jobs WHERE work_kind='authentication'");await enqueue('maintenance',auth.job_id);assert.equal((await first('SELECT state FROM maintenance_jobs WHERE job_id=?',auth.job_id)).state,'done');await privateBucket.put('square/unproven/posts/a/manifest.json','retained');const audit=await first("SELECT job_id FROM maintenance_jobs WHERE work_kind='audit'");for(let n=0;n<3;n++){await sql('UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=?',audit.job_id);await enqueue('maintenance',audit.job_id);}assert.ok(await privateBucket.head('square/unproven/posts/a/manifest.json'));const progress=JSON.parse((await first('SELECT progress_json FROM maintenance_jobs WHERE job_id=?',audit.job_id)).progress_json);assert.equal(progress.findings[0].action,'retained');
 assert.ok(seen.every(x=>['chain.example.test','api.sandbox.push.apple.com','api.push.apple.com','oauth2.googleapis.com','fcm.googleapis.com','api.cloudflare.com'].includes(new URL(x.url).hostname)));
});
async function insert(table,row){const columns=Object.keys(row);await sql(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,...Object.values(row));}
test('identity then membership project complete canonical blocks with independent CAS cursors',async()=>{
 await sql('INSERT OR REPLACE INTO user_projection_cursor VALUES(1,8,?,?)',h(8),Date.now());await sql('INSERT OR REPLACE INTO membership_projection_cursor VALUES(1,8,?,?)',h(8),Date.now());
 for(const work of ['identity','membership']){const row=await first('SELECT job_id FROM maintenance_jobs WHERE work_kind=? AND artifact_owner IS NULL',work);await sql('UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=?',row.job_id);await enqueue('maintenance',row.job_id);assert.equal((await first(`SELECT finalized_block_number FROM ${work==='identity'?'user':'membership'}_projection_cursor`)).finalized_block_number,9,JSON.stringify(await first('SELECT * FROM maintenance_jobs WHERE job_id=?',row.job_id)));for(let n=0;n<4&&(await first('SELECT state FROM maintenance_jobs WHERE job_id=?',row.job_id)).state==='pending';n++){await sql('UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=?',row.job_id);await enqueue('maintenance',row.job_id);}assert.equal((await first('SELECT state FROM maintenance_jobs WHERE job_id=?',row.job_id)).state,'done');}
});
test('R2/CDN interruption retains locator and storage; resume releases once, keeps monthly usage',async()=>{
 const now=Date.now(),upload='squ_100',post='sqp_100',prefix=`square/${fixture.cid}/posts/${post}`;
 await insert('square_uploads',{upload_id:upload,post_id:post,cid_number:fixture.cid,account_id:fixture.account,post_type:'document',manifest_hash:'aa'.repeat(32),manifest_byte_size:100,storage_receipt_id:'sqr_100',content_hash:'bb'.repeat(32),estimated_bytes:250,status:'completed',created_at:now-86400000,expires_at:now-80000000,completed_at:now-81000000});
 await insert('square_media_assets',{upload_id:upload,post_id:post,cid_number:fixture.cid,account_id:fixture.account,media_index:0,media_kind:'image',object_key:prefix+'/media/0/source.webp',upload_method:'r2_put',resource_key:'square_image_freedom',content_type:'image/webp',byte_size:100,sha256:'bb'.repeat(32),derivative_kind:'thumbnail',derivative_object_key:prefix+'/media/0/thumbnail.webp',derivative_content_type:'image/webp',derivative_byte_size:50,derivative_sha256:'cc'.repeat(32),asset_state:'ready',created_at:now-86400000,updated_at:now-86400000});
 await insert('resource_reservations',{reservation_id:upload,cid_number:fixture.cid,resource_key:'square_upload',period_start:now-86400000,period_end:now+86400000,byte_size:250,image_count:1,video_seconds:0,expires_at:now-80000000,reservation_state:'used',created_at:now-86400000,used_at:now-81000000});await sql("INSERT OR REPLACE INTO resource_totals VALUES(?,'square_storage',250,3,0,?)",fixture.cid,now);await sql("INSERT OR REPLACE INTO resource_usage VALUES(?,'square_upload',?,?,250,1,0,?)",fixture.cid,now-86400000,now+86400000,now);
 await privateBucket.put(prefix+'/manifest.json','manifest');await publicBucket.put(prefix+'/media/0/source.webp','source');await publicBucket.put(prefix+'/media/0/thumbnail.webp','thumbnail');
 const row=await first("SELECT job_id FROM maintenance_jobs WHERE work_kind='uploads' AND artifact_owner IS NULL");purgeFailure=true;await enqueue('maintenance',row.job_id);
 let progress=JSON.parse((await first('SELECT progress_json FROM maintenance_jobs WHERE job_id=?',row.job_id)).progress_json);assert.equal(progress.locator.private_done,true);assert.equal(progress.locator.public_done,true);assert.equal(progress.locator.purge_done,false);assert.equal((await first("SELECT byte_size FROM resource_totals WHERE resource_key='square_storage' AND cid_number=?",fixture.cid)).byte_size,250);
 await sql('UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=?',row.job_id);await enqueue('maintenance',row.job_id);assert.equal((await first("SELECT byte_size FROM resource_totals WHERE resource_key='square_storage' AND cid_number=?",fixture.cid)).byte_size,0);assert.equal((await first('SELECT reservation_state FROM resource_reservations WHERE reservation_id=?',upload)).reservation_state,'released_consumed');assert.equal((await first('SELECT image_count FROM resource_usage WHERE cid_number=?',fixture.cid)).image_count,1);assert.equal(await privateBucket.head(prefix+'/manifest.json'),null);
 await sql('UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=?',row.job_id);await enqueue('maintenance',row.job_id);assert.equal((await first("SELECT byte_size FROM resource_totals WHERE resource_key='square_storage' AND cid_number=?",fixture.cid)).byte_size,0);
});
test('source muted/deleted or device revoked cancels delivery without calling provider',async()=>{
 for(const change of ['mute','delete','revoke']){const n={mute:10,delete:11,revoke:12}[change];const d=await notification(n);const before=seen.filter(x=>x.url.includes('push.apple.com')).length;
  if(change==='mute')await sql('UPDATE square_follows SET notify_enabled=0');else if(change==='delete')await sql("UPDATE square_posts SET post_state='deleting' WHERE post_id=?",'sqp_'+n);else await sql('UPDATE mls_devices SET active=0 WHERE device_id=?',device);
  await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'cancelled');assert.equal(seen.filter(x=>x.url.includes('push.apple.com')).length,before);await sql('UPDATE square_follows SET notify_enabled=1');await sql('UPDATE mls_devices SET active=1 WHERE device_id=?',device);
 }
});
test('后台长链同步在45秒内续租同一CAS租约',async()=>{
 let row=await first("SELECT job_id FROM maintenance_jobs WHERE work_kind='identity' AND artifact_owner IS NULL AND state='pending' LIMIT 1");
 if(!row){row={job_id:id('maintenance',['long-identity',String(Date.now())])};await sql("INSERT INTO maintenance_jobs(job_id,work_kind,scheduled_at,updated_at) VALUES(?,'identity',?,?)",row.job_id,Date.now(),Date.now());}
 await sql('UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=?',row.job_id);slowChain=4;await enqueue('maintenance',row.job_id);
 assert.ok(renewedLeaseExpiry>firstLeaseExpiry+20000);assert.equal((await first('SELECT lease_token FROM maintenance_jobs WHERE job_id=?',row.job_id)).lease_token,null);
});
test('fanout persists 40 recipients per page, resumes stable cursor and never sends in fanout',async()=>{
 const base=await first('SELECT * FROM users WHERE cid_number=?',fixture.cid);const now=Date.now(),author='CN777';await insert('users',{...base,cid_number:author,account_id:'0x'+777..toString(16).padStart(64,'0')});
 for(let n=780;n<786;n++){const cid='CN'+n,account='0x'+n.toString(16).padStart(64,'0');await insert('users',{...base,cid_number:cid,account_id:account});await sql('INSERT INTO square_follows VALUES(?,?,?,1)',cid,author,now-5000);for(let i=0;i<8;i++){const key=(n*10+i).toString(16).padStart(64,'0');await sql('INSERT INTO mls_devices VALUES(?,?,1,?,?,1,?,?,?)',cid,key,account,'0x'+key,now,now,now);await insert('push_endpoints',{cid_number:cid,device_id:key,binding_revision:1,account_id:account,push_provider:'apns',push_token:key,apns_environment:'sandbox',expires_at:now+86400000,updated_at:now,endpoint_revision:n*10+i});}}
 const j=id('fanout',['40-page']),tx='0x'+'99'.repeat(32);await sql("INSERT INTO notification_jobs(job_id,source_kind,source_key,cid_number,post_id,tx_hash,created_at,expires_at,updated_at) VALUES(?,'post','40-page',?,'sqp_40',?,?,?,?)",j,author,tx,now,now+86400000,now);const before=seen.filter(x=>x.url.includes('push.apple.com')).length;
 await Promise.all([enqueue('fanout',j),enqueue('fanout',j)]);assert.equal((await first('SELECT COUNT(*) n FROM notification_deliveries WHERE job_id=?',j)).n,40);assert.equal((await first('SELECT state FROM notification_jobs WHERE job_id=?',j)).state,'pending');await sql('UPDATE notification_jobs SET next_attempt_at=0 WHERE job_id=?',j);await enqueue('fanout',j);assert.equal((await first('SELECT COUNT(*) n FROM notification_deliveries WHERE job_id=?',j)).n,48);assert.equal((await first('SELECT state FROM notification_jobs WHERE job_id=?',j)).state,'done');await enqueue('fanout',j);assert.equal((await first('SELECT COUNT(*) n FROM notification_deliveries WHERE job_id=?',j)).n,48);assert.equal(seen.filter(x=>x.url.includes('push.apple.com')).length,before);
});


// 三路门禁必须先拒绝未知类型和无效持钥，再访问上游或业务对象。
test('统一门禁拒绝未知请求、伪造内部类型和无效签名且不调用上游',async()=>{
 let before=receivedRpc.length;
 for(const [path,headers] of [['/api/unregistered',{}],['/api/health',{'x-tatachat-internal':'1'}]]){
  const r=await fetch(path,'GET','',headers);assert.ok([400,403,404].includes(r.status));await r.text();
 }
 const denied=await networkFetch('/','POST',JSON.stringify({jsonrpc:'2.0',id:1,method:'unregistered',params:[]}));
 assert.equal((await denied.json()).error.code,-32601);assert.equal(receivedRpc.length,before);
 const path='/api/membership';const good=await proof('GET',path);const bad=JSON.parse(Buffer.from(good,'base64url'));
 bad.signature='0x'+'00'.repeat(64);before=receivedRpc.length;
 const rejected=await fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':Buffer.from(JSON.stringify(bad)).toString('base64url')});
 assert.equal(rejected.status,401);await rejected.text();assert.equal(receivedRpc.length,before);
});
test('业务媒体GET和HEAD及Range先校验CID与当前会话，旧裸地址不匿名交付',async t=>{
 const restoreMembership=await setMembership();t.after(restoreMembership);
 const post='sqp_gate_media',key=`square/${fixture.cid}/posts/${post}/media/0/source.webp`,bytes=Uint8Array.of(1,2,3,4,5,6,7,8);
 t.after(async()=>{await publicBucket.delete(key);await sql('DELETE FROM square_posts WHERE post_id=?',post);});
 await insert('square_posts',{post_id:post,cid_number:fixture.cid,account_id:fixture.account,post_category:'normal',post_type:'document',title:null,excerpt:'门禁媒体夹具',content_hash:'aa'.repeat(32),storage_receipt_id:'sqr_gate_media',chain_block:9,chain_block_hash:fixture.head,tx_hash:h(5),created_at:Date.now(),post_state:'published'});
 await publicBucket.put(key,bytes,{httpMetadata:{contentType:'image/webp'}});
 const url='https://media.example.test/'+key;
 const media=(method,headers={})=>mf.dispatchFetch(url,{method,headers:{'cf-connecting-ip':'192.0.2.44',...headers}});
 let before=receivedRpc.length;const anonymous=await media('GET');assert.equal(anonymous.status,401);await anonymous.text();assert.equal(receivedRpc.length,before);
 const headers={authorization:'Bearer '+token};const full=await media('GET',headers);assert.equal(full.status,200,await full.clone().text());assert.deepEqual(new Uint8Array(await full.arrayBuffer()),bytes);assert.equal(full.headers.get('cache-control'),'private, no-store');
 const part=await media('GET',{...headers,range:'bytes=2-4'});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 2-4/8');assert.deepEqual(new Uint8Array(await part.arrayBuffer()),bytes.slice(2,5));
 const head=await media('HEAD',headers);assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'8');assert.equal((await head.arrayBuffer()).byteLength,0);
 await sql("UPDATE square_posts SET post_state='deleted' WHERE post_id=?",post);const gone=await media('GET',headers);assert.equal(gone.status,404);await gone.text();
});
test('account deletion has exact MLS submit routes and wallet-only readonly recovery challenges',async()=>{
 await stopWorker();await startWorker();
 for(const path of ['/api/square/account/delete','/api/square/account/delete/challenge']){
  const r=await fetch(path,'POST','{}');assert.equal(r.status,404);
 }
 const denied=await fetch('/api/user/deletion','POST','{}');assert.equal(denied.status,401);
 const subject=JSON.stringify({cid_number:fixture.cid,account_id:fixture.account});
 const challenge=await fetch('/api/user/deletion/status/challenges','POST',subject);
 assert.equal(challenge.status,200,await challenge.clone().text());
 const c=await challenge.json();assert.equal(c.purpose,'status');assert.equal(c.cid_number,fixture.cid);
 assert.equal(c.chain_scope,fixture.genesis);assert.equal(c.service_origin,registration.service_origin);
 assert.equal((await first('SELECT COUNT(*) n FROM account_deletions')).n,0);
 const bad=await fetch('/api/user/deletion/status','POST',JSON.stringify({challenge_id:c.challenge_id,signature:'0x'+'00'.repeat(64)}));
 assert.equal(bad.status,401);
 assert.equal((await first('SELECT COUNT(*) n FROM account_deletions')).n,0);
 assert.equal((await first('SELECT COUNT(*) n FROM square_sessions')).n,1);
});
test('durable deletion removes cloud content in bounded batches, holds unknown chat writes and preserves other mail',async()=>{
 await stopWorker();await startWorker();
 const operation='44'.repeat(32),now=Date.now(),cid=fixture.cid;
 const meterOther='CN220-CTZN2-100000099-2026';
 for(const owner of [cid,meterOther]){
  await insert('membership_operations',{cid_number:owner,operation_id:'synthetic-deletion-meter',metric:'detail',resource_key:'synthetic-post',amount:1,state:'committed',period_start:0,created_at:now});
  await insert('membership_usage',{cid_number:owner,metric:'detail',period_start:0,amount:1,updated_at:now});
 }
 const quotaMetrics=['chat_connections','chat_commands','chat_frame_bytes','chat_deliveries','attachment_begins','chat_chunk_operations','upload_bytes','delivery_bytes','media_requests','profile_requests','profile_read_bytes'],quotaDay=Math.floor(now/86400000)*86400000;
 for(const metric of quotaMetrics)await insert('membership_usage',{cid_number:cid,metric,period_start:quotaDay,amount:1,updated_at:now});
 await insert('membership_usage',{cid_number:cid,metric:'chat_commands',period_start:quotaDay-86400000,amount:99,updated_at:now});
 const admission=await first('SELECT enrollment_id FROM cid_admissions WHERE cid_number=?',cid);
 await sql("INSERT INTO account_deletions(deletion_id,cid_number,account_id,binding_revision,chain_scope,enrollment_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?)",operation,cid,fixture.account,fixture.genesis,admission.enrollment_id,now,now);
 await sql('UPDATE mls_devices SET active=0 WHERE cid_number=?',cid);
 await sql('DELETE FROM square_sessions WHERE cid_number=?',cid);
 const privateKey='square/'+cid+'/posts/old/manifest.json';
 const profileKey='profile/'+cid+'/avatar';
 await privateBucket.put(privateKey,'synthetic-private');await privateBucket.put(profileKey,'synthetic-profile');
 const publicKeys=Array.from({length:19},(_,n)=>'square/'+cid+'/posts/old/media/'+String(n).padStart(2,'0')+'/source.webp');
 for(const key of publicKeys)await publicBucket.put(key,'synthetic-public');
 await chatDB.prepare('INSERT INTO message_receipts VALUES(?,?,?,?)').bind('owned-mail','fp','operation',now+60000).run();
 for(const user of [cid,'other'])await chatDB.prepare('INSERT INTO messages VALUES(?,?,?,?,64,?,?)').bind('owned-mail',user,'device','{}',now,now+60000).run();
 await chatDB.prepare("INSERT INTO attachments(attachment_id,generation,fingerprint,metadata,creator_user,creator_device,state,expires_at) VALUES('owned-asset','gen','fp','{}',?,'device','pending',?)").bind(cid,now+60000).run();
 await chatDB.prepare("INSERT INTO attachment_uploads(attempt_id,attachment_id,generation,object_key,upload,state) VALUES('unknown','owned-asset','gen','synthetic-chat-key','{}','writing')").run();
 let sequence=0;
 async function advance(){
  // 合成时钟推进通过已知未开始对象IO的租约到期，不解除未知IO屏障。
  await sql("UPDATE account_deletions SET lease_until=0 WHERE state='pending' AND io_started=0");
  // 同类维护只允许一个活动任务；续用已提交的进度，只推进pending任务的重试时钟。
  const pending=await first("SELECT job_id,state FROM maintenance_jobs WHERE work_kind='storage' AND artifact_owner IS NULL AND state IN ('pending','leased')");
  let task;
  if(pending){assert.equal(pending.state,'pending');task=pending.job_id;await sql("UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=? AND state='pending'",task);}
  else{task=id('maintenance',['deletion',String(sequence++)]);await sql("INSERT INTO maintenance_jobs(job_id,work_kind,scheduled_at,updated_at) VALUES(?,'storage',?,?)",task,Date.now(),Date.now());}
  await enqueue('maintenance',task);
 }
 for(let n=0;n<10;n++){await advance();if((await first('SELECT phase FROM account_deletions')).phase===2)break;}
 purgeFailure=true;await advance();
 const held=await first('SELECT state,io_started,keys_json FROM account_deletions');
 assert.equal(held.state,'pending');assert.equal(held.io_started,0);assert.ok(JSON.parse(held.keys_json).length>0);
 purgeFailure=false;
 for(let n=0;n<20;n++){await advance();if((await first('SELECT phase FROM account_deletions')).phase===3)break;}
 await advance();
 assert.equal((await first('SELECT state FROM account_deletions')).state,'pending');
 assert.equal((await chatDB.prepare("SELECT state FROM attachment_uploads WHERE attempt_id='unknown'").first()).state,'writing');
 assert.equal((await chatDB.prepare("SELECT COUNT(*) n FROM messages WHERE user_id='other'").first()).n,1);
 // 模拟原one-shot写入明确提交，其对象键仍由持久账本持有。
 await chatBucket.put('synthetic-chat-key','synthetic-ciphertext');
 // 真实晚到对象已经提交，再推进原300秒待查时间；不伪造版本/成功状态。
 await chatDB.prepare("UPDATE attachment_uploads SET cleanup_after=0 WHERE attempt_id='unknown' AND state='writing'").run();
 for(let n=0;n<40;n++){await advance();if((await first('SELECT state FROM account_deletions')).state==='complete')break;}
 assert.equal((await first('SELECT state FROM account_deletions')).state,'complete');
 assert.equal(await privateBucket.head(privateKey),null);assert.equal(await privateBucket.head(profileKey),null);
 for(const key of publicKeys){
  const object=await publicBucket.get(key);assert.ok(object);assert.equal((await object.arrayBuffer()).byteLength,0);
  assert.equal(await publicBucket.put(key,'late-upload',{onlyIf:{etagDoesNotMatch:'*'}}),null);
 }
 assert.equal(await chatBucket.head('synthetic-chat-key'),null);
 assert.equal((await chatDB.prepare('SELECT COUNT(*) n FROM attachments').first()).n,0);
 assert.equal((await chatDB.prepare("SELECT COUNT(*) n FROM messages WHERE user_id=?").bind(cid).first()).n,0);
 assert.equal((await chatDB.prepare("SELECT COUNT(*) n FROM messages WHERE user_id='other'").first()).n,1);
 assert.equal((await first('SELECT cid_status FROM users WHERE cid_number=?',cid)).cid_status,'active');
 assert.equal((await first('SELECT COUNT(*) n FROM cid_admissions WHERE cid_number=?',cid)).n,0);
 for(const table of ['membership_operations','membership_usage']){
  assert.equal((await first(`SELECT COUNT(*) n FROM ${table} WHERE cid_number=?`,cid)).n,table==='membership_usage'?quotaMetrics.length:0);
  assert.equal((await first(`SELECT COUNT(*) n FROM ${table} WHERE cid_number=?`,meterOther)).n,1);
 }

});

test('真实总入口先CID再会员：本人和名片可用，他人主页广场详情媒体拒绝',async(t)=>{
 await stopWorker();await startWorker();
 const restore=await setMembership(0,0,Date.now()-1);t.after(restore);
 async function get(path){return fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':await proof('GET',path)});}
 for(const path of [`/api/user/profiles/${fixture.cid}`,`/api/user/cards/${fixture.cid}`]){
  const r=await get(path);assert.equal(r.status,200,await r.clone().text());
  const value=await r.json();assert.equal(value.ok,true);
  if(value.card){assert.equal(value.card.cid_number,fixture.cid);for(const field of ['bio','counts','banner_object_key'])assert.equal(Object.hasOwn(value.card,field),false);}
 }
 for(const [path,code] of [[`/api/user/profiles/CN220-CTZN2-100000002-2026`,'profile_membership_required'],['/api/8964/feed/recommended','square_membership_required'],['/api/8964/posts/sqp_missing','square_membership_required']]){
  const r=await get(path);assert.equal(r.status,403,await r.clone().text());assert.equal((await r.json()).error,code);
 }
 const media=await mf.dispatchFetch(`https://media.example.test/square/${fixture.cid}/posts/sqp_missing/media/0/source.webp`,{headers:{authorization:'Bearer '+token,'cf-connecting-ip':'192.0.2.45'}});
 assert.equal(media.status,403,await media.clone().text());
 assert.equal((await first('SELECT COUNT(*) n FROM membership_operations')).n,0);
});

// 当前文件主入口内的公开合成资料，不在生产建立调试路由或新权限。
async function profileAsset(kind='avatar',cid=fixture.cid){
 const data=Buffer.from('5249464612000000574542505650384c060000002f0000000000','hex'),hash=digest(data),key='profile/'+cid+'/'+kind,now=Date.now();
 await privateBucket.put(key,data,{sha256:hash,httpMetadata:{contentType:'image/webp'}});
 await insert('profile_asset_uploads',{upload_id:'profile-quota-'+kind+'-'+cid,cid_number:cid,kind,object_key:key,content_type:'image/webp',byte_size:data.length,sha256:hash,generation:1,state:'completed',created_at:now,expires_at:now+900000,completed_at:now});
 await sql('INSERT INTO user_profiles(cid_number,'+kind+'_object_key,'+kind+'_content_hash) VALUES(?,?,?) ON CONFLICT(cid_number) DO UPDATE SET '+kind+'_object_key=excluded.'+kind+'_object_key,'+kind+'_content_hash=excluded.'+kind+'_content_hash',cid,key,hash);
 return {data,hash,key};
}
test('资料媒体普通/Range/304/404及失败按Kind最大值预扣，基础读取不依赖会员',async()=>{
 await stopWorker();await startWorker();const avatar=await profileAsset(),banner=await profileAsset('banner'),calls=chainCalls();await setMembership(0,0,Date.now()-1);
 const card='/api/user/cards/'+fixture.cid+'/avatar';
 let r=await fetch(card,'GET','',{authorization:'Bearer '+token});assert.equal(r.status,200);await r.arrayBuffer();
 r=await fetch(card,'GET','',{authorization:'Bearer '+token,range:'bytes=1-2'});assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),avatar.data.subarray(1,3));
 r=await fetch(card,'GET','',{authorization:'Bearer '+token,'if-none-match':'*'});assert.equal(r.status,304);await r.arrayBuffer();
 const full='/api/user/profiles/'+fixture.cid+'/assets/banner';r=await fetch(full,'GET','',{authorization:'Bearer '+token,'x-mls-proof':await proof('GET',full)});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),banner.data);
 await privateBucket.delete(avatar.key);r=await fetch(card,'GET','',{authorization:'Bearer '+token});assert.equal(r.status,404);await r.arrayBuffer();
 // 对象自身校验和必须真实，数据库仍保留原内容摘要，验证原哈希围栏。
 await privateBucket.put(avatar.key,Buffer.from('bad'),{sha256:digest(Buffer.from('bad')),httpMetadata:{contentType:'image/webp'}});
 r=await fetch(card,'GET','',{authorization:'Bearer '+token});assert.equal(r.status,409);await r.arrayBuffer();
 assert.equal((await first("SELECT amount FROM membership_usage WHERE cid_number=? AND metric='profile_requests'",fixture.cid)).amount,6);
 assert.equal((await first("SELECT amount FROM membership_usage WHERE cid_number=? AND metric='profile_read_bytes'",fixture.cid)).amount,5*512*1024+1536*1024);
 assert.equal((await first('SELECT COUNT(*) n FROM membership_operations')).n,0);assert.equal(chainCalls(),calls);
});
test('资料媒体CID/全站请求或字节任一超额均在引用/R2前拒绝，不退款或借换IP重置',async()=>{
 await stopWorker();await startWorker();await profileAsset();const calls=chainCalls(),day=Math.floor(Date.now()/86400000)*86400000,dayNumber=day/86400000;
 for(const [side,metric,amount] of [['cid','profile_requests',1000],['cid','profile_read_bytes',64*1024*1024],['global','profile_requests',100000],['global','profile_read_bytes',10*1024**3]]){
  await sql("DELETE FROM membership_usage WHERE metric IN ('profile_requests','profile_read_bytes')");
  await sql('DELETE FROM rate_windows WHERE rate_key IN (?,?)','quota:global:'+dayNumber+':profile_requests','quota:global:'+dayNumber+':profile_read_bytes');
  if(side==='cid')await insert('membership_usage',{cid_number:fixture.cid,metric,period_start:day,amount,updated_at:Date.now()});
  else await insert('rate_windows',{rate_key:'quota:global:'+dayNumber+':'+metric,request_count:amount,expires_at:day+86400000});
  const before=await first('SELECT COUNT(*) n,COALESCE(SUM(amount),0) amount FROM membership_usage');
  await queryCounts(true);const r=await fetch('/api/user/cards/'+fixture.cid+'/avatar','GET','',{authorization:'Bearer '+token,'cf-connecting-ip':'198.51.100.7'});
  assert.equal(r.status,429,await r.clone().text());assert.equal((await r.json()).error,'resource_limit');
  const cost=await queryCounts();assert.equal(cost.contexts,1);assert.equal(cost.batches,1);assert.equal(cost.r2_head,0);assert.equal(cost.r2_get,0);
  assert.deepEqual(await first('SELECT COUNT(*) n,COALESCE(SUM(amount),0) amount FROM membership_usage'),before);
 }
 assert.equal(chainCalls(),calls);
});
test('资料媒体CID/IP独立限流且会员/撤销拒绝先于预扣或对象读取',async()=>{
 await stopWorker();await startWorker({},1);await profileAsset();const card='/api/user/cards/'+fixture.cid+'/avatar';
 let r=await fetch(card,'GET','',{authorization:'Bearer '+token});assert.equal(r.status,200);await r.arrayBuffer();
 await queryCounts(true);r=await fetch(card,'GET','',{authorization:'Bearer '+token,'cf-connecting-ip':'198.51.100.1'});assert.equal(r.status,429);await r.arrayBuffer();
 assert.equal((await queryCounts()).r2_head,0);assert.equal((await queryCounts()).batches,0);
 const invalid=token.slice(0,-1)+(token.endsWith('a')?'b':'a');
 r=await fetch(card,'GET','',{authorization:'Bearer '+invalid,'cf-connecting-ip':'198.51.100.2'});assert.equal(r.status,401);await r.arrayBuffer();
 await queryCounts(true);r=await fetch(card,'GET','',{authorization:'Bearer '+token,'cf-connecting-ip':'198.51.100.2'});assert.equal(r.status,429);await r.arrayBuffer();assert.equal((await queryCounts()).contexts,0);
 await stopWorker();await startWorker();await profileAsset();const owner=await first('SELECT * FROM users WHERE cid_number=?',fixture.cid),other='PROFILE-OTHER';
 await insert('users',{...owner,cid_number:other,account_id:h(97)});await profileAsset('banner',other);
 const path='/api/user/profiles/'+other+'/assets/banner',p=await proof('GET',path);await setMembership(0,0,Date.now()-1);await queryCounts(true);
 r=await fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,403);await r.arrayBuffer();assert.equal((await queryCounts()).batches,0);assert.equal((await queryCounts()).r2_head,0);
 const self='/api/user/profiles/'+fixture.cid+'/assets/avatar',ownProof=await proof('GET',self);await sql('UPDATE mls_devices SET active=0 WHERE cid_number=?',fixture.cid);await queryCounts(true);
 r=await fetch(self,'GET','',{authorization:'Bearer '+token,'x-mls-proof':ownProof});assert.equal(r.status,401);await r.arrayBuffer();assert.equal((await queryCounts()).batches,0);assert.equal((await queryCounts()).r2_head,0);
});

test('名片头像普通会话读取仍核验公民设备准入，完整资料媒体不豁免MLS',async(t)=>{
 await stopWorker();await startWorker();const restore=await setMembership(0,0,Date.now()-1);t.after(restore);
 // 沿用媒体合同的最小完整WebP容器，仅作格式/摘要/传输夹具。
 const bytes=Buffer.from('5249464612000000574542505650384c060000002f0000000000','hex'),hash=digest(bytes),key=`profile/${fixture.cid}/avatar`,now=Date.now();
 await privateBucket.put(key,bytes,{sha256:hash,httpMetadata:{contentType:'image/webp'}});
 await insert('profile_asset_uploads',{upload_id:'avatar-membership-fixture',cid_number:fixture.cid,kind:'avatar',object_key:key,content_type:'image/webp',byte_size:bytes.length,sha256:hash,generation:1,state:'completed',created_at:now,expires_at:now+900000,completed_at:now});
 await sql("INSERT INTO user_profiles(cid_number,display_name,avatar_object_key,avatar_content_hash) VALUES(?,'synthetic-avatar',?,?) ON CONFLICT(cid_number) DO UPDATE SET avatar_object_key=excluded.avatar_object_key,avatar_content_hash=excluded.avatar_content_hash",fixture.cid,key,hash);
 const path=`/api/user/cards/${fixture.cid}/avatar`,headers={authorization:'Bearer '+token};
 assert.equal((await fetch(path)).status,401);
 const read=await fetch(path,'GET','',headers);assert.equal(read.status,200,await read.clone().text());assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);assert.equal(read.headers.get('cache-control'),'private, no-store');
 assert.equal((await fetch(`/api/user/profiles/${fixture.cid}/assets/avatar`,'GET','',headers)).status,401);
 await sql('UPDATE mls_devices SET active=0 WHERE device_id=?',device);assert.equal((await fetch(path,'GET','',headers)).status,401);
 await sql('UPDATE mls_devices SET active=1 WHERE device_id=?',device);await sql('DELETE FROM cid_admissions WHERE cid_number=?',fixture.cid);assert.equal((await fetch(path,'GET','',headers)).status,403);
 assert.equal((await first('SELECT COUNT(*) n FROM membership_operations')).n,0);
});


test('完整资料媒体每次GET与Range使用新鲜MLS，失败重试不可复用旧证明',async(t)=>{
 await stopWorker();await startWorker();const restore=await setMembership(0,0,Date.now()-1);t.after(restore);
 const bytes=Buffer.from('5249464612000000574542505650384c060000002f0000000000','hex'),hash=digest(bytes),key=`profile/${fixture.cid}/avatar`,now=Date.now();
 await privateBucket.put(key,bytes,{sha256:hash,httpMetadata:{contentType:'image/webp'}});
 await insert('profile_asset_uploads',{upload_id:'avatar-proof-fixture',cid_number:fixture.cid,kind:'avatar',object_key:key,content_type:'image/webp',byte_size:bytes.length,sha256:hash,generation:1,state:'completed',created_at:now,expires_at:now+900000,completed_at:now});
 await sql("INSERT INTO user_profiles(cid_number,display_name,avatar_object_key,avatar_content_hash) VALUES(?,'synthetic-avatar',?,?) ON CONFLICT(cid_number) DO UPDATE SET avatar_object_key=excluded.avatar_object_key,avatar_content_hash=excluded.avatar_content_hash",fixture.cid,key,hash);
 const path=`/api/user/profiles/${fixture.cid}/assets/avatar`,get=(p,extra={})=>fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':p,...extra});
 assert.equal((await fetch(path,'GET','',{authorization:'Bearer '+token})).status,401);
 const original=await proof('GET',path),full=await get(original);assert.equal(full.status,200,await full.clone().text());assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
 assert.equal((await get(original)).status,401);
 const ranged=await proof('GET',path);assert.notEqual(ranged,original);
 const part=await get(ranged,{range:'bytes=2-4'});assert.equal(part.status,206,await part.clone().text());assert.equal(part.headers.get('content-range'),`bytes 2-4/${bytes.length}`);assert.deepEqual(Buffer.from(await part.arrayBuffer()),bytes.subarray(2,5));
 assert.equal((await get(ranged,{range:'bytes=5-7'})).status,401);
 const failed=await proof('GET',path);assert.equal((await get(failed,{range:'bytes=1000-'})).status,416);
 assert.equal((await get(failed,{range:'bytes=0-1'})).status,401);
 const retry=await get(await proof('GET',path),{range:'bytes=0-1'});assert.equal(retry.status,206);assert.deepEqual(Buffer.from(await retry.arrayBuffer()),bytes.subarray(0,2));
 const conditional=await proof('GET',path),unchanged=await get(conditional,{'if-none-match':'*'});assert.equal(unchanged.status,304);assert.equal((await unchanged.arrayBuffer()).byteLength,0);assert.equal((await get(conditional)).status,401);
 // 撤销前取得尚未消费的新证明，确保最后断言实际覆盖设备撤销而非重复证明。
 const revoked=await proof('GET',path);
 await sql('UPDATE mls_devices SET active=0 WHERE device_id=?',device);
 assert.equal((await get(revoked)).status,401);
});

test('日常会员与本人资料上下文只加载一次，链不可达时RPC为0',async()=>{
 await stopWorker();await startWorker();setUnknownChain(true);
 try{
  for(const path of ['/api/membership',`/api/user/profiles/${fixture.cid}`,`/api/membership/creators/${fixture.cid}/plans`]){
   const p=await proof('GET',path),before=chainCalls();await queryCounts(true);
   const response=await fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(response.status,200,await response.clone().text());await response.arrayBuffer();
   const counts=await queryCounts();assert.equal(counts.contexts,1);assert.equal(chainCalls(),before);
  }
 }finally{setUnknownChain(false);}
});
test('会员同交易确认重试复用回执，异主体/区块/用途不复用且RPC为0',async()=>{
 const tx=h(44),input={tx_hash:tx,block_hash:fixture.head};
 await insert('chain_transaction_confirmations',{tx_hash:tx,cid_number:fixture.cid,account_id:fixture.account,block_hash:fixture.head,block_number:9,extrinsic_index:0,action_kind:'membership:platform:subscribe',request_hash:'aa'.repeat(32),chain_timestamp:Date.now(),confirmed_at:Date.now()});
 setUnknownChain(true);const before=chainCalls();
 try{
  for(const [path,body,status] of [['/api/membership/confirm',input,200],['/api/membership/confirm',{...input,block_hash:h(8)},409],['/api/membership/creators/plans',input,409]]){
   const bytes=JSON.stringify(body),p=await proof('POST',path,bytes),r=await fetch(path,'POST',bytes,{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,status,await r.clone().text());await r.arrayBuffer();
  }
  await sql("UPDATE chain_transaction_confirmations SET action_kind='subscribe' WHERE tx_hash=?",tx);
  await sql('UPDATE square_memberships SET last_tx_hash=? WHERE cid_number=?',tx,fixture.cid);
  for(const [known,status] of [[true,200],[false,409]]){
   if(!known)await sql('UPDATE square_memberships SET last_tx_hash=NULL WHERE cid_number=?',fixture.cid);
   const bytes=JSON.stringify(input),p=await proof('POST','/api/membership/confirm',bytes),r=await fetch('/api/membership/confirm','POST',bytes,{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,status,await r.clone().text());await r.arrayBuffer();
  }
  await sql('UPDATE chain_transaction_confirmations SET account_id=? WHERE tx_hash=?','0x'+'ee'.repeat(32),tx);
  const bytes=JSON.stringify(input),p=await proof('POST','/api/membership/confirm',bytes),r=await fetch('/api/membership/confirm','POST',bytes,{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,409);await r.arrayBuffer();assert.equal(chainCalls(),before);
 }finally{setUnknownChain(false);}
});

test('平台确认可选真实会员快照，旧版三字段兼容且新请求不再GET会员',async()=>{
 await stopWorker();await startWorker();
 const tx=h(46),input={tx_hash:tx,block_hash:fixture.head};
 await insert('chain_transaction_confirmations',{tx_hash:tx,cid_number:fixture.cid,account_id:fixture.account,block_hash:fixture.head,block_number:9,extrinsic_index:0,action_kind:'membership:platform:subscribe',request_hash:'bb'.repeat(32),chain_timestamp:Date.now(),confirmed_at:Date.now()});
 const path='/api/membership/confirm';
 async function confirm(extra={}){const body=JSON.stringify({...input,...extra}),p=await proof('POST',path,body);return fetch(path,'POST',body,{authorization:'Bearer '+token,'x-mls-proof':p});}
 setUnknownChain(true);const before=chainCalls();
 try{
  for(const options of [{},{include_state:false}]){const r=await confirm(options);assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),{ok:true,...input});}
  const r=await confirm({include_state:true});assert.equal(r.status,200,await r.clone().text());const result=await r.json();assert.deepEqual(Object.keys(result).sort(),['block_hash','membership_state','ok','tx_hash']);assert.equal(result.tx_hash,tx);assert.equal(result.block_hash,fixture.head);
  const p=await proof('GET','/api/membership'),ordinary=await fetch('/api/membership','GET','',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(ordinary.status,200);assert.deepEqual(result.membership_state,await ordinary.json());
  for(const value of ['true',1,null])assert.equal((await confirm({include_state:value})).status,400);
  assert.equal(chainCalls(),before);
  const cache=await mf.getKVNamespace('SQUARE_CACHE');await cache.delete('membership:prices:'+fixture.genesis);
  const unavailable=await confirm({include_state:true});assert.equal(unavailable.status,503);await unavailable.arrayBuffer();assert.ok(await first('SELECT tx_hash FROM chain_transaction_confirmations WHERE tx_hash=?',tx));
  const now=Date.now();await cache.put('membership:prices:'+fixture.genesis,JSON.stringify({created:now,deadline:now+600000,value:[199900,599900,5999900]}));
  const recovered=await confirm({include_state:true});assert.equal(recovered.status,200,await recovered.clone().text());await recovered.arrayBuffer();
  await sql('UPDATE scheduler_leases SET updated_at=? WHERE lease_key=?',Date.now()-600000,'sync:membership:'+fixture.genesis);
  const stale=await confirm({include_state:true});assert.equal(stale.status,503);await stale.arrayBuffer();assert.equal((await confirm()).status,200);
  await sql('UPDATE scheduler_leases SET updated_at=? WHERE lease_key=?',Date.now(),'sync:membership:'+fixture.genesis);assert.equal(chainCalls(),before);
 }finally{setUnknownChain(false);}
});

test('帖子确认重试先读既有结果，不预扣或消耗查链预算',async()=>{
 const now=Date.now(),post='sqp_confirmed',upload='squ_confirmed',tx=h(45),hash='aa'.repeat(32),receipt='sqr_confirmed';
 await insert('square_uploads',{upload_id:upload,post_id:post,cid_number:fixture.cid,account_id:fixture.account,post_type:'document',manifest_hash:hash,manifest_byte_size:100,storage_receipt_id:receipt,content_hash:hash,estimated_bytes:100,status:'published',created_at:now,expires_at:now+900000,completed_at:now});
 await insert('square_posts',{post_id:post,cid_number:fixture.cid,account_id:fixture.account,post_category:'normal',post_type:'document',title:null,excerpt:'已确认的公开摘要',content_hash:hash,storage_receipt_id:receipt,chain_block:9,chain_block_hash:fixture.head,tx_hash:tx,created_at:now,post_state:'published'});
 const key='rpc:'+fixture.genesis+':confirmation:day:'+Math.floor(now/86400000);
 await sql('INSERT OR REPLACE INTO rate_windows VALUES(?,100000,?)',key,(Math.floor(now/86400000)+1)*86400000);
 const path='/api/8964/posts/confirm',body=JSON.stringify({post_id:post,tx_hash:tx,block_hash:fixture.head}),p=await proof('POST',path,body),before=chainCalls();
 setUnknownChain(true);
 try{const r=await fetch(path,'POST',body,{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,200,await r.clone().text());await r.arrayBuffer();assert.equal(chainCalls(),before);assert.equal((await first('SELECT request_count FROM rate_windows WHERE rate_key=?',key)).request_count,100000);}finally{setUnknownChain(false);}
});


test('媒体硬顶在HEAD和GET前预扣，Range/HEAD/304口径一致且无随机读流水',async()=>{
 await stopWorker();await startWorker();await setMembership();
 const post='sqp_resource_media',key=`square/${fixture.cid}/posts/${post}/media/0/source.webp`,data=Uint8Array.of(1,2,3,4,5,6,7,8);
 await insert('square_posts',{post_id:post,cid_number:fixture.cid,account_id:fixture.account,post_category:'normal',post_type:'document',title:null,excerpt:'额度夹具',content_hash:'ab'.repeat(32),storage_receipt_id:'sqr_resource',chain_block:9,chain_block_hash:fixture.head,tx_hash:h(46),created_at:Date.now(),post_state:'published'});
 await publicBucket.put(key,data,{httpMetadata:{contentType:'image/webp'}});
 const media=(method='GET',headers={})=>mf.dispatchFetch('https://media.example.test/'+key,{method,headers:{'cf-connecting-ip':'198.51.100.9',authorization:'Bearer '+token,...headers}});
 const before=chainCalls(),day=Math.floor(Date.now()/86400000)*86400000;
 await queryCounts(true);const part=await media('GET',{range:'bytes=1-2'});assert.equal(part.status,206,await part.clone().text());assert.deepEqual(new Uint8Array(await part.arrayBuffer()),data.slice(1,3));
 let counts=await queryCounts();assert.equal(counts.r2_head,1);assert.equal(counts.r2_get,1);const etag=part.headers.get('etag');
 const usage=async metric=>(await first('SELECT amount FROM membership_usage WHERE cid_number=? AND metric=? AND period_start=?',fixture.cid,metric,day)).amount;
 assert.equal(await usage('delivery_bytes'),2);
 await queryCounts(true);const head=await media('HEAD');assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);counts=await queryCounts();assert.equal(counts.r2_head,1);assert.equal(counts.r2_get,0);
 await queryCounts(true);const unchanged=await media('GET',{'if-none-match':etag});assert.equal(unchanged.status,304);assert.equal((await unchanged.arrayBuffer()).byteLength,0);counts=await queryCounts();assert.equal(counts.r2_head,1);assert.equal(counts.r2_get,0);
 assert.equal(await usage('delivery_bytes'),2);assert.equal(await usage('media_requests'),3);assert.equal((await first('SELECT count(*) AS n FROM membership_operations')).n,0);
 await sql("UPDATE membership_usage SET amount=? WHERE cid_number=? AND metric='delivery_bytes' AND period_start=?",128*1024*1024,fixture.cid,day);
 await queryCounts(true);const bytesDenied=await media('GET',{range:'bytes=1-2'});assert.equal(bytesDenied.status,429,await bytesDenied.text());counts=await queryCounts();assert.equal(counts.r2_head,1);assert.equal(counts.r2_get,0);
 const global='quota:global:'+Math.floor(Date.now()/86400000)+':media_requests';await sql('UPDATE rate_windows SET request_count=200000 WHERE rate_key=?',global);
 await queryCounts(true);const globalDenied=await media('HEAD');assert.equal(globalDenied.status,429,await globalDenied.text());counts=await queryCounts();assert.equal(counts.r2_head,0);assert.equal(counts.r2_get,0);
 await sql('UPDATE rate_windows SET request_count=0 WHERE rate_key=?',global);await sql("UPDATE membership_usage SET amount=10000 WHERE cid_number=? AND metric='media_requests' AND period_start=?",fixture.cid,day);
 await queryCounts(true);const cidDenied=await media('HEAD');assert.equal(cidDenied.status,429,await cidDenied.text());counts=await queryCounts();assert.equal(counts.r2_head,0);assert.equal(counts.r2_get,0);assert.equal(chainCalls(),before);
});

test('媒体CID与IP分别快速限流，换IP不能重置CID且查找无效凭证前受IP挡板',async()=>{
 await stopWorker();await startWorker({},1);await setMembership();
 const post='sqp_rate_media',key=`square/${fixture.cid}/posts/${post}/media/0/source.webp`;
 await insert('square_posts',{post_id:post,cid_number:fixture.cid,account_id:fixture.account,post_category:'normal',post_type:'document',title:null,excerpt:'频率夹具',content_hash:'cd'.repeat(32),storage_receipt_id:'sqr_rate',chain_block:9,chain_block_hash:fixture.head,tx_hash:h(47),created_at:Date.now(),post_state:'published'});
 await publicBucket.put(key,Uint8Array.of(1),{httpMetadata:{contentType:'image/webp'}});
 const missing=token.slice(0,-1)+(token.endsWith('a')?'b':'a');
 const read=(ip,valid=true)=>mf.dispatchFetch('https://media.example.test/'+key,{method:'HEAD',headers:{'cf-connecting-ip':ip,authorization:'Bearer '+(valid?token:missing)}});
 assert.equal((await read('198.51.100.1')).status,200);
 await queryCounts(true);assert.equal((await read('198.51.100.2')).status,429);assert.equal((await queryCounts()).r2_head,0);
 await queryCounts(true);assert.equal((await read('203.0.113.77',false)).status,401);assert.equal((await queryCounts()).contexts,1);await queryCounts(true);assert.equal((await read('203.0.113.77',false)).status,429);assert.equal((await queryCounts()).contexts,0);assert.equal((await read('203.0.113.78',false)).status,401);
});


test('普通浏览和他人资料真实成功读取只写汇总，重复读取不新增随机流水且RPC为0',async()=>{
 await stopWorker();await startWorker();await setMembership();
 const other='CN220-CTZN2-100000002-2026',owner=await first('SELECT * FROM users WHERE cid_number=?',fixture.cid);
 await insert('users',{...owner,cid_number:other,account_id:h(57)});await insert('user_profiles',{cid_number:other,display_name:'合成公开资料'});
 await insert('square_posts',{post_id:'sqp_'+ '55'.repeat(16),cid_number:fixture.cid,account_id:fixture.account,post_category:'normal',post_type:'document',title:null,excerpt:'合成汇总读取',content_hash:'cd'.repeat(32),storage_receipt_id:'sqr_aggregate',chain_block:9,chain_block_hash:fixture.head,tx_hash:h(57),created_at:Date.now(),post_state:'published'});
 const before=chainCalls();
 for(let round=0;round<2;round++)for(const path of ['/api/8964/feed/recommended','/api/user/profiles/'+other]){
  const p=await proof('GET',path);await queryCounts(true);const response=await fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(response.status,200,await response.clone().text());await response.arrayBuffer();assert.equal((await queryCounts()).contexts,1);
 }
 assert.equal((await first('SELECT COUNT(*) n FROM membership_operations')).n,0);
 assert.equal((await first('SELECT SUM(browse_count) n FROM square_browse_days')).n,2);assert.equal((await first("SELECT SUM(amount) n FROM membership_usage WHERE metric='profile'")).n,2);assert.equal(chainCalls(),before);
});

test('原鉴权维护连续清理1001历史读取，保留发布reserved及当前日额度且RPC为0',async()=>{
 await stopWorker();await startWorker();const now=Date.now(),old=now-7*86400000,day=Math.floor(now/86400000)*86400000;
 await sql("WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO membership_operations SELECT ?,'history_'||x,'detail','',1,'committed',0,? FROM n",fixture.cid,old);
 for(const [operation,metric,state,created] of [['publish_keep','published','committed',old],['reserved_keep','detail','reserved',old],['recent_keep','detail','committed',old+60000]])await insert('membership_operations',{cid_number:fixture.cid,operation_id:operation,metric,resource_key:'',amount:1,state,period_start:0,created_at:created});
 for(const period of [day-7*86400000,day])await insert('membership_usage',{cid_number:fixture.cid,metric:'chat_commands',period_start:period,amount:1,updated_at:now});
 const task=id('maintenance',['history',String(now)]);await sql("INSERT INTO maintenance_jobs(job_id,work_kind,scheduled_at,updated_at) VALUES(?,'authentication',?,?)",task,now,now);
 const before=chainCalls();await enqueue('maintenance',task);
 let row=await first('SELECT state,progress_json FROM maintenance_jobs WHERE job_id=?',task);assert.equal(row.state,'pending');assert.ok(JSON.parse(row.progress_json).examined>=1000);
 assert.equal((await first("SELECT COUNT(*) n FROM membership_operations WHERE operation_id LIKE 'history_%'")).n,1);
 await sql("UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=? AND state='pending'",task);await enqueue('maintenance',task);
 assert.equal((await first('SELECT state FROM maintenance_jobs WHERE job_id=?',task)).state,'done');assert.equal((await first("SELECT COUNT(*) n FROM membership_operations WHERE operation_id LIKE 'history_%'")).n,0);
 assert.equal((await first('SELECT COUNT(*) n FROM membership_operations')).n,3);assert.equal((await first("SELECT amount FROM membership_usage WHERE metric='chat_commands' AND period_start=?",day)).amount,1);assert.equal((await first("SELECT COUNT(*) n FROM membership_usage WHERE metric='chat_commands'")).n,1);assert.equal(chainCalls(),before);
});

test('本地非法身份/广播输入既不预扣RPC预算也不访问上游',async()=>{
 await stopWorker();await startWorker({RELAY_ENABLED:'1'});
 try{
  const budget=()=>first("SELECT COUNT(*) n,COALESCE(SUM(request_count),0) amount FROM rate_windows WHERE rate_key LIKE 'rpc:%'");
  const before=await budget(),calls=chainCalls();
  const inputs=[
   ['/api/user/identity','{'],['/api/user/identity','{}'],['/api/user/identity',JSON.stringify({block_hash:'invalid'})],
   ['/api/user/identity',JSON.stringify({block_hash:'0x'+'AA'.repeat(32)})],
   ['/api/chain/extrinsics','{'],['/api/chain/extrinsics','{}'],
   ...['','0x','0x1','0xgg','11','0x'+'01'.repeat(65537)].map(value=>['/api/chain/extrinsics',JSON.stringify({signed_extrinsic_hex:value})]),
  ];
  for(const [path,body] of inputs){
   const response=await fetch(path,'POST',body);
   assert.equal(response.status,400,await response.clone().text());await response.arrayBuffer();
   assert.deepEqual(await budget(),before);assert.equal(chainCalls(),calls);
  }
  // 真实设备密钥签署准确坏正文，确保失败来自typed解析而非无效签名提前挡住。
  for(const body of ['{','{}']){
   const p={user_id:fixture.cid,device_id:device,public_key:publicKey,account_id:fixture.account,binding_revision:1,service_origin:registration.service_origin,challenge:h(75),expires_at_millis:Date.now()+60000,method:'POST',request_target:'/api/user/devices',body_sha256:'0x'+digest(body)};
   const response=await fetch('/api/user/devices','POST',body,{'x-mls-proof':signMlsProof(p,mls.privateKey)});
   assert.equal(response.status,400,await response.clone().text());await response.arrayBuffer();
   assert.deepEqual(await budget(),before);assert.equal(chainCalls(),calls);
  }
 }finally{await stopWorker();await startWorker();}
});

test('匿名身份/广播/充值意图共用公共池，耗尽不抢会员确认池',async()=>{
 await stopWorker();await startWorker({
  RELAY_ENABLED:'1',TOPUP_RECV_ADDRESS:'0x'+'11'.repeat(20),TOPUP_DISBURSE_ACCOUNT_ID:fixture.account,TOPUP_MIN_CONFIRMATIONS:'1',
  TOPUP_BASE_USDC:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',TOPUP_BASE_USDT:'0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
  TOPUP_INTENT_SECRET:'synthetic-payment-intent-key-with-32-bytes',
 });
 try{
  const now=Date.now(),day=Math.floor(now/86400000),dayKey='rpc:'+fixture.genesis+':public:day:'+day;
  await sql('INSERT INTO rate_windows VALUES(?,100000,?)',dayKey,(day+1)*86400000);
  await sql('INSERT INTO rate_windows VALUES(?,1000,?)','rpc:'+fixture.genesis+':public:minute:'+Math.floor(now/60000),(Math.floor(now/60000)+1)*60000);
  const confirmation=()=>first("SELECT COUNT(*) n,COALESCE(SUM(request_count),0) amount FROM rate_windows WHERE rate_key IN (?,?)",'rpc:'+fixture.genesis+':confirmation:day:'+day,'rpc:'+fixture.genesis+':confirmation:minute:'+Math.floor(now/60000));
  const before=await confirmation(),calls=chainCalls();
  for(const [path,body] of [
   ['/api/user/identity',{block_hash:fixture.head}],
   ['/api/chain/extrinsics',{signed_extrinsic_hex:'0x01'}],
   ['/api/topup/intent',{account_id:fixture.account,token:'USDC',package_id:'pkg_15',payer_address:'0x'+'22'.repeat(20)}],
  ]){
   const response=await fetch(path,'POST',JSON.stringify(body));
   assert.equal(response.status,429,await response.clone().text());await response.arrayBuffer();
   assert.deepEqual(await confirmation(),before);assert.equal(chainCalls(),calls);
  }
  // 新的已认证确认仍能预扣自己的池；上游失败是合成故障，不冒充交易确认成功。
  setUnknownChain(true);
  const path='/api/membership/confirm',input={tx_hash:h(77),block_hash:fixture.head},body=JSON.stringify(input),p=await proof('POST',path,body);
  const response=await fetch(path,'POST',body,{authorization:'Bearer '+token,'x-mls-proof':p});
  assert.equal(response.status,503,await response.clone().text());await response.arrayBuffer();
  const privateDay=await first('SELECT request_count FROM rate_windows WHERE rate_key=?','rpc:'+fixture.genesis+':confirmation:day:'+day);
  assert.equal(privateDay.request_count,64);assert.equal(chainCalls(),calls+1);
  assert.equal((await first('SELECT request_count FROM rate_windows WHERE rate_key=?',dayKey)).request_count,100000);
  // 已完成的同主体交易继续真实走D1回执，公共池耗尽也能返回原成功结果。
  const done={tx_hash:h(78),block_hash:fixture.head};
  await insert('chain_transaction_confirmations',{...done,cid_number:fixture.cid,account_id:fixture.account,block_number:9,extrinsic_index:0,action_kind:'membership:platform:subscribe',request_hash:'ab'.repeat(32),chain_timestamp:now,confirmed_at:now});
  const doneBody=JSON.stringify(done),doneProof=await proof('POST',path,doneBody);
  const repeated=await fetch(path,'POST',doneBody,{authorization:'Bearer '+token,'x-mls-proof':doneProof});
  assert.equal(repeated.status,200,await repeated.clone().text());assert.deepEqual(await repeated.json(),{ok:true,...done});
  assert.equal(chainCalls(),calls+1);
  assert.equal((await first('SELECT request_count FROM rate_windows WHERE rate_key=?','rpc:'+fixture.genesis+':confirmation:day:'+day)).request_count,64);
 }finally{setUnknownChain(false);await stopWorker();await startWorker();}
});

test('创作者概览只交付整数汇总，会员健康失效或身份撤销仍拒绝且RPC为0',async()=>{
 await stopWorker();await startWorker();
 try{
  const owner=await first('SELECT * FROM users WHERE cid_number=?',fixture.cid);
  for(const [n,billing,price] of [[70,'monthly',101],[71,'quarterly',8],[72,'yearly',25]]){
   const cid='OV'+n,account=h(n);await insert('users',{...owner,cid_number:cid,account_id:account});
   await insert('square_creator_subscriptions',{subscriber_cid_number:cid,creator_cid_number:fixture.cid,subscriber_account_id:account,creator_account_id:fixture.account,tier_id:'tier',billing_period:billing,started_at:1,last_charged_at:2,last_charged_price_fen:price,authorized_price_fen:price,paid_until:Date.now()+86400000,subscription_status:'active',finalized_block_number:9,finalized_block_hash:fixture.head,verified_at:Date.now()});
  }
  await insert('square_creator_tiers',{creator_cid_number:fixture.cid,creator_account_id:fixture.account,tier_id:'tier',tier_name:'合成档位',tier_order:0,monthly_price_fen:101,quarterly_price_fen:8,yearly_price_fen:25,finalized_block_number:9,finalized_block_hash:fixture.head,verified_at:Date.now()});
  const path='/api/membership/creator/overview',calls=chainCalls();
  async function read(){const p=await proof('GET',path);await queryCounts(true);return fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':p});}
  const response=await read();assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),{ok:true,overview:{subscriber_count:3,monthly_income_fen:105,tier_count:1}});
  let counts=await queryCounts();assert.equal(counts.contexts,1);assert.equal(counts.statements,3);assert.equal(counts.batches,0);
  const key='sync:membership:'+fixture.genesis,health=await first('SELECT * FROM scheduler_leases WHERE lease_key=?',key);
  for(const updated of [null,0,Date.now()+60000,Date.now()-600000]){
   await sql('DELETE FROM scheduler_leases WHERE lease_key=?',key);
   if(updated!==null)await insert('scheduler_leases',{...health,updated_at:updated});
   const denied=await read();assert.equal(denied.status,503,await denied.clone().text());await denied.arrayBuffer();
   counts=await queryCounts();assert.equal(counts.statements,2,'坏会员健康不能进入概览SQL');
  }
  await sql('DELETE FROM scheduler_leases WHERE lease_key=?',key);await insert('scheduler_leases',{...health,updated_at:Date.now()});
  await sql('UPDATE square_memberships SET paid_until=? WHERE cid_number=?',Date.now()-1,fixture.cid);
  const expired=await read();assert.equal(expired.status,403);assert.equal((await expired.json()).error,'membership_required');
  await setMembership();const restored=await read();assert.equal(restored.status,200);await restored.arrayBuffer();
  // 精确金额超过公开整数上限时必须失败，不能以浮点截断后交付收入。
  await sql('UPDATE square_creator_subscriptions SET last_charged_price_fen=9007199254740991 WHERE billing_period=?','monthly');
  const overflow=await read();assert.equal(overflow.status,503);await overflow.arrayBuffer();
  const p=await proof('GET',path);await sql('UPDATE mls_devices SET active=0 WHERE cid_number=?',fixture.cid);
  const revoked=await fetch(path,'GET','',{authorization:'Bearer '+token,'x-mls-proof':p});
  assert.equal(revoked.status,401);await revoked.arrayBuffer();assert.equal(chainCalls(),calls);
 }finally{await stopWorker();await startWorker();}
});

test('匿名重复Session挑战不增长或续期，真实持钥登录仍一次消费且不查链',async()=>{
 await stopWorker();await startWorker();
 try{
  const calls=chainCalls(),body=JSON.stringify({account_id:fixture.account});
  const input={account_id:fixture.account,public_key:publicKey,purpose:'session',method:'POST',request_target:'/api/user/sessions',body_sha256:'0x'+digest(body)};
  const issue=()=>fetch('/api/user/challenges','POST',JSON.stringify(input));
  await queryCounts(true);
  const initial=await issue();assert.equal(initial.status,200,await initial.clone().text());const original=await initial.json();
  let cost=await queryCounts();assert.equal(cost.contexts,1);assert.equal(cost.statements,3);assert.equal(cost.batches,1);
  const before=await first("SELECT COUNT(*) n FROM mls_authentication_challenges WHERE purpose='session'");
  for(let n=0;n<65;n++){
   await queryCounts(true);
   const response=await issue();assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),original);
   cost=await queryCounts();assert.equal(cost.contexts,1);assert.equal(cost.statements,3);assert.equal(cost.batches,1);
  }
  const parallel=await Promise.all(Array.from({length:8},issue));
  for(const response of parallel){assert.equal(response.status,200);assert.deepEqual(await response.json(),original);}
  assert.deepEqual(await first("SELECT COUNT(*) n FROM mls_authentication_challenges WHERE purpose='session'"),before);
  // 任意/空白正文摘要在上下文或batch前拒绝，不靠变化摘要占槽。
  for(const hash of ['0x'+'aa'.repeat(32),'0x'+digest(' '+body)]){
   await queryCounts(true);
   const denied=await fetch('/api/user/challenges','POST',JSON.stringify({...input,body_sha256:hash}));
   assert.equal(denied.status,400);assert.equal((await denied.json()).error,'invalid_mls_target');
   const counts=await queryCounts();assert.equal(counts.contexts,0);assert.equal(counts.batches,0);
  }
  const p={...original};delete p.ok;
  const bad=await fetch('/api/user/sessions','POST',body,{'x-mls-proof':signMlsProof({...p},generateKeyPairSync('ed25519').privateKey)});
  assert.equal(bad.status,401);await bad.arrayBuffer();
  assert.deepEqual(await first("SELECT COUNT(*) n FROM mls_authentication_challenges WHERE purpose='session'"),before);
  const signed=signMlsProof({...p},mls.privateKey);
  const login=await fetch('/api/user/sessions','POST',body,{'x-mls-proof':signed});
  assert.equal(login.status,200,await login.clone().text());const session=await login.json();
  assert.equal(session.device_id,device);assert.equal(session.account_id,fixture.account);
  const replay=await fetch('/api/user/sessions','POST',body,{'x-mls-proof':signed});assert.equal(replay.status,401);await replay.arrayBuffer();
  const next=await issue();assert.equal(next.status,200);assert.notEqual((await next.json()).challenge,original.challenge);
  await sql('UPDATE mls_devices SET active=0 WHERE device_id=?',device);
  const revoked=await issue();assert.equal(revoked.status,401);await revoked.arrayBuffer();
  const unknown=await fetch('/api/user/challenges','POST',JSON.stringify({...input,public_key:'0x'+'aa'.repeat(32)}));
  assert.equal(unknown.status,401);await unknown.arrayBuffer();
  assert.equal(chainCalls(),calls);
 }finally{await stopWorker();await startWorker();}
});

}

// 所有修改只作用于本地公开合成runtime和本地D1。
export async function setMembership(level=0,status=0,paidUntil=Date.now()+86400000){
 const key=Object.keys(fixture.storage).find(k=>fixture.storage[k]?.length===122),previous=fixture.storage[key];
 const value=Buffer.from(previous.slice(2),"hex");
 value[1]=level;value[42]=status;value.writeBigUInt64LE(BigInt(paidUntil),34);fixture.storage[key]="0x"+value.toString("hex");
 const apply=async raw=>{const v=Buffer.from(raw.slice(2),'hex');await sql('UPDATE square_memberships SET membership_level=?,subscription_status=?,started_at=?,last_charged_at=?,last_charged_price_fen=?,authorized_price_fen=?,paid_until=?,finalized_block_number=9,finalized_block_hash=? WHERE cid_number=?',['freedom','democracy','spark'][v[1]],['active','cancelled','terminated','suspended','issuerPaused'][v[42]],Number(v.readBigUInt64LE(2)),Number(v.readBigUInt64LE(10)),Number(v.readBigUInt64LE(18)),Number(v.readBigUInt64LE(43)),Number(v.readBigUInt64LE(34)),fixture.head,fixture.cid);};
 await apply(fixture.storage[key]);
 return async()=>{fixture.storage[key]=previous;await apply(previous);};
}
export function chainCalls(){return seen.filter(x=>x.url.startsWith('https://chain.example.test')).length;}
export function setUnknownChain(value){unknownChain=value;}
export function setChatPushOutcome(status,reason='BadDeviceToken'){pushStatus=status;pushReason=reason;}
export {sql,first,fetch,proof,fixture,registration,token,tokenHash,device,seen};
