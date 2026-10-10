// 实际worker-build ESM/WASM + 本地workerd/D1/R2。所有出站请求均由闭合白名单测试服务处理。
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {testKeys,verifyJwt} from './push_crypto.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const fixture=JSON.parse(await readFile(new URL('../contract/maintenance.json',import.meta.url)));
const registration=JSON.parse(await readFile(new URL('../contract/activation.json',import.meta.url)));
const networkRequests=JSON.parse(await readFile(new URL('../contract/ethereum_rpc.json',import.meta.url))).requests;
const networkMethods=new Set(networkRequests.map(request=>request.method));
const receivedRpc=[];
// 静态上游为闭合合成夹具，只证明Rust Worker传输合同，不冒充正式安装页或TLS验收。
const networkHTML='<html><body>MetaMask 静态交付夹具</body></html>';
const networkPNG=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
let networkAssetMode='normal';
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
for table in ['users','registration_enrollments','mls_devices','square_sessions','cid_admissions','user_identity_checks','user_profiles']:
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
   assert.equal(req.headers.get('CF-Access-Client-Id'),'offline-test');
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
  if(slowChain>0){const round=slowChain--;if(round===4)firstLeaseExpiry=(await first("SELECT lease_expires_at FROM notification_deliveries WHERE state='leased' ORDER BY updated_at DESC LIMIT 1")).lease_expires_at;await new Promise(resolve=>setTimeout(resolve,8000));if(round===1)renewedLeaseExpiry=(await first("SELECT lease_expires_at FROM notification_deliveries WHERE state='leased' ORDER BY updated_at DESC LIMIT 1")).lease_expires_at;}
  const {method,params,id:rid}=await req.json();receivedRpc.push(method);let result;
  if(method==='chain_getFinalizedHead')result=fixture.head;
  else if(method==='chain_getBlockHash')result=params[0]===0?fixture.genesis:h(Number(params[0]));
  else if(method==='chain_getHeader'){const n=parseInt(params[0]?.slice(2,4)||'09',16);result={number:'0x'+n.toString(16),parentHash:h(Math.max(0,n-1)),stateRoot:h(1),extrinsicsRoot:h(2),digest:{logs:[]}};}
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
export async function startWorker(extraBindings={},readLimit=1000){
 anchorTime=Date.now();
 mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:"citizenserve",modules:[{type:'ESModule',path:root+'/target/build/cloudflare/worker/index.js'},{type:'CompiledWasm',path:root+'/target/build/cloudflare/worker/index_bg.wasm'}],modulesRoot:root+'/target/build/worker',compatibilityDate:'2026-10-07',
 bindings:{TATACHAT_QUEUE_NAME:'citizenserve-tatachat-test',WEB_ORIGIN:registration.service_origin,REGISTRATION_SCOPE:registration.registration_scope,TURNSTILE_SITEKEY:'0x4AAAAAAD0GQRiB2O3a0DYJ',CHAIN_GENESIS_HASH:fixture.genesis,CHAIN_URL:'https://chain.example.test',CHAIN_ID:'offline-test',CHAIN_SECRET:'offline-test',HASH_KEY:'synthetic-rate-key-for-worker-fixture',APNS_KEY:keys.apns,APNS_KID:'KEY1234567',APNS_TEAM:'TEAM123456',APNS_TOPIC:'com.test.citizen',FCM_KEY:keys.fcm,FCM_EMAIL:'test@test-project.iam.gserviceaccount.com',FCM_PROJECT:'test-project',CF_ACCOUNT_ID:'11'.repeat(16),R2_KEY:'test',R2_SECRET:'test',ZONE_ID:'11'.repeat(16),PURGE:'test',SQUARE_PUBLIC_MEDIA_BASE_URL:'https://media.example.test',...extraBindings},
 d1Databases:['DB','CITIZENCHAIN_DOWNLOAD_DB','TATACHAT_DB'],r2Buckets:['SQUARE_PRIVATE','SQUARE_PUBLIC_MEDIA','TATACHAT_ATTACHMENTS'],durableObjects:{TATACHAT_DEVICES:{className:'TataChatDevice',useSQLite:true}},kvNamespaces:['SQUARE_CACHE'],queueProducers:{NOTIFY:'citizenserve',TATACHAT_PUSH:'citizenserve-tatachat-test'},ratelimits:Object.fromEntries(['RATE_AUTH','RATE_READ','RATE_WRITE'].map((n,i)=>[n,{namespace_id:String(i+1),simple:{limit:n==='RATE_READ'?readLimit:1000,period:60}}])),outboundService:outbound}]}));
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
}
export async function stopWorker(){await mf?.dispose();}
async function fetch(path,method='GET',body='',headers={}){return mf.dispatchFetch(registration.service_origin+path,{method,headers:{'cf-connecting-ip':'192.0.2.1','content-length':String(Buffer.byteLength(body)),...headers},...(method==='GET'||method==='DELETE'?{}:{body})});}
function vector(data){data=Buffer.from(data);const n=data.length;return Buffer.concat([Buffer.from(n<64?[n]:[0x40|(n>>8),n&255]),data]);}
function u64(n){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;}
async function proof(method,path,body='',identity={publicKey,token,key:mls}){
 const request={account_id:fixture.account,public_key:identity.publicKey,purpose:'request',method,request_target:path,body_sha256:'0x'+digest(body)};
 const r=await fetch('/api/user/challenges','POST',JSON.stringify(request),{authorization:'Bearer '+identity.token});assert.equal(r.status,200,await r.clone().text());const p=await r.json();delete p.ok;
 const content=Buffer.concat([vector(p.user_id),Buffer.from(p.device_id,'hex'),Buffer.from(p.account_id.slice(2),'hex'),u64(p.binding_revision),vector(p.service_origin),Buffer.from(p.challenge.slice(2),'hex'),u64(p.expires_at_millis),vector(p.method),vector(p.request_target),Buffer.from(p.body_sha256.slice(2),'hex')]);p.signature='0x'+sign(null,Buffer.concat([vector('MLS 1.0 TataChatAuthentication'),vector(content)]),identity.key.privateKey).toString('hex');return Buffer.from(JSON.stringify(p)).toString('base64url');
}
export async function chatIdentity(extra=false){
 const key=extra?generateKeyPairSync('ed25519'):mls;const pub='0x'+key.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');const session=extra?'sqs_'+randomBytes(16).toString('hex'):token;const who={publicKey:pub,token:session,key};
 if(extra){const now=Date.now();await sql('INSERT INTO mls_devices VALUES(?,?,1,?,?,1,?,?,?)',fixture.cid,pub.slice(2),fixture.account,pub,now,now,now);await sql('INSERT INTO square_sessions VALUES(?,?,1,?,?,?,?)',digest(session),fixture.cid,fixture.account,pub.slice(2),now,now+86400000);}
 return {device:pub.slice(2),async credential(){const path='/api/tatachat/access',body='{}',p=await proof('POST',path,body,who);const r=await fetch(path,'POST',body,{authorization:'Bearer '+session,'x-mls-proof':p});assert.equal(r.status,200,await r.clone().text());return r.json();}};
}
export async function chatSQL(query,...args){return chatDB.prepare(query).bind(...args).run();}
export async function chatFirst(query,...args){return chatDB.prepare(query).bind(...args).first();}
export async function chatObject(key,body){return body===undefined?chatBucket.head(key):chatBucket.put(key,body);}
export async function chatUpgrade(credential,protocol='tatachat'){return mf.dispatchFetch(registration.service_origin+'/api/tatachat/realtime',{headers:{upgrade:'websocket',authorization:'Bearer '+credential.access_token,'sec-websocket-protocol':protocol}});}
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
 {method,headers:{'cf-connecting-ip':'192.0.2.123',...(body===undefined?{}:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}),...headers},...(body===undefined?{}:{body})});
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
 for(const bindings of [{CHAIN_URL:''},{CHAIN_ID:''},{CHAIN_SECRET:''}]){
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
test('actual Worker fetch and exact endpoint MLS guard',async()=>{
 const r=await fetch('/api/health');assert.equal(r.status,200);assert.equal((await r.json()).account_services_ready,false);
 const input=JSON.stringify({push_provider:'apns',push_token:'ab'.repeat(32),apns_environment:'sandbox',expires_at:Date.now()+86400000});const noSession=await fetch('/api/notifications/endpoint','PUT',input);assert.equal(noSession.status,401,await noSession.text());const noProof=await fetch('/api/notifications/endpoint','PUT',input,{authorization:'Bearer '+token});assert.equal(noProof.status,401);
 await register();const p=await proof('DELETE','/api/notifications/endpoint');const r2=await fetch('/api/notifications/endpoint','DELETE','',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r2.status,200,await r2.text());assert.equal((await first('SELECT COUNT(*) n FROM push_endpoints')).n,0);await register();
});
test('APNs actual WebCrypto signature, fresh RPC, terminal CAS and duplicate queue',async()=>{
 const d=await notification(1);const prior=seen.filter(x=>x.url.includes('push.apple.com')).length;await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'accepted');await enqueue('delivery',d);assert.equal(seen.filter(x=>x.url.includes('push.apple.com')).length,prior+1);
});
test('late old-token invalidation preserves rotated generation; topic error preserves endpoint',async()=>{
 const d=await notification(2);pushStatus=400;rotateDuringPush=true;await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'cancelled');assert.equal((await first('SELECT push_token FROM push_endpoints')).push_token,'cd'.repeat(32));await register();pushReason='DeviceTokenNotForTopic';const d2=await notification(3);await enqueue('delivery',d2);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d2)).state,'blocked');assert.equal((await first('SELECT COUNT(*) n FROM push_endpoints')).n,1);pushStatus=200;pushReason='BadDeviceToken';
});
test('FCM actual RS256 OAuth JWT and accepted name; invalid registration removed',async()=>{
 await register('fcm');let d=await notification(4);await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'accepted');pushStatus=404;pushReason='UNREGISTERED';d=await notification(5);await enqueue('delivery',d);assert.equal((await first('SELECT COUNT(*) n FROM push_endpoints')).n,0);pushStatus=200;pushReason='BadDeviceToken';await register();
});
test('unknown chain prevents sending, four durable 429 attempts block',async()=>{
 let d=await notification(6);unknownChain=true;const before=seen.filter(x=>x.url.includes('push.apple.com')).length;await enqueue('delivery',d);assert.equal(seen.filter(x=>x.url.includes('push.apple.com')).length,before);unknownChain=false;await sql('UPDATE notification_deliveries SET lease_expires_at=0,state=\'pending\',lease_token=NULL WHERE delivery_id=?',d);await enqueue('delivery',d);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'accepted');
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
 for(const work of ['identity','membership']){const row=await first('SELECT job_id FROM maintenance_jobs WHERE work_kind=? AND artifact_owner IS NULL',work);await sql('UPDATE maintenance_jobs SET next_attempt_at=0 WHERE job_id=?',row.job_id);await enqueue('maintenance',row.job_id);assert.equal((await first(`SELECT finalized_block_number FROM ${work==='identity'?'user':'membership'}_projection_cursor`)).finalized_block_number,9,JSON.stringify(await first('SELECT * FROM maintenance_jobs WHERE job_id=?',row.job_id)));assert.equal((await first('SELECT state FROM maintenance_jobs WHERE job_id=?',row.job_id)).state,'done');}
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
test('long chain verification renews the same CAS lease within 45 seconds',async()=>{
 const d=await notification(13);slowChain=4;await enqueue('delivery',d);assert.ok(renewedLeaseExpiry>firstLeaseExpiry+20000);assert.equal((await first('SELECT state FROM notification_deliveries WHERE delivery_id=?',d)).state,'accepted');
});
test('fanout persists 40 recipients per page, resumes stable cursor and never sends in fanout',async()=>{
 const base=await first('SELECT * FROM users WHERE cid_number=?',fixture.cid);const now=Date.now(),author='CN777';await insert('users',{...base,cid_number:author,account_id:'0x'+777..toString(16).padStart(64,'0')});
 for(let n=780;n<786;n++){const cid='CN'+n,account='0x'+n.toString(16).padStart(64,'0');await insert('users',{...base,cid_number:cid,account_id:account});await sql('INSERT INTO square_follows VALUES(?,?,?,1)',cid,author,now-5000);for(let i=0;i<8;i++){const key=(n*10+i).toString(16).padStart(64,'0');await sql('INSERT INTO mls_devices VALUES(?,?,1,?,?,1,?,?,?)',cid,key,account,'0x'+key,now,now,now);await insert('push_endpoints',{cid_number:cid,device_id:key,binding_revision:1,account_id:account,push_provider:'apns',push_token:key,apns_environment:'sandbox',expires_at:now+86400000,updated_at:now,endpoint_revision:n*10+i});}}
 const j=id('fanout',['40-page']),tx='0x'+'99'.repeat(32);await sql("INSERT INTO notification_jobs(job_id,source_kind,source_key,cid_number,post_id,tx_hash,created_at,expires_at,updated_at) VALUES(?,'post','40-page',?,'sqp_40',?,?,?,?)",j,author,tx,now,now+86400000,now);const before=seen.filter(x=>x.url.includes('push.apple.com')).length;
 await Promise.all([enqueue('fanout',j),enqueue('fanout',j)]);assert.equal((await first('SELECT COUNT(*) n FROM notification_deliveries WHERE job_id=?',j)).n,40);assert.equal((await first('SELECT state FROM notification_jobs WHERE job_id=?',j)).state,'pending');await sql('UPDATE notification_jobs SET next_attempt_at=0 WHERE job_id=?',j);await enqueue('fanout',j);assert.equal((await first('SELECT COUNT(*) n FROM notification_deliveries WHERE job_id=?',j)).n,48);assert.equal((await first('SELECT state FROM notification_jobs WHERE job_id=?',j)).state,'done');await enqueue('fanout',j);assert.equal((await first('SELECT COUNT(*) n FROM notification_deliveries WHERE job_id=?',j)).n,48);assert.equal(seen.filter(x=>x.url.includes('push.apple.com')).length,before);
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
});

}

// 所有修改只作用于本地公开合成runtime和本地D1。
export function setMembership(level=0,status=0,paidUntil=Date.now()+86400000){
 const key=Object.keys(fixture.storage).find(k=>fixture.storage[k]?.length===122);
 const value=Buffer.from(fixture.storage[key].slice(2),"hex");
 value[1]=level;value[42]=status;value.writeBigUInt64LE(BigInt(paidUntil),34);fixture.storage[key]="0x"+value.toString("hex");
}
export function setUnknownChain(value){unknownChain=value;}
export function setChatPushOutcome(status,reason='BadDeviceToken'){pushStatus=status;pushReason=reason;}
export {sql,first,fetch,proof,fixture,registration,token,tokenHash,device,seen};
