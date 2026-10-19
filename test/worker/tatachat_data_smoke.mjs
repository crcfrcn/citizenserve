// 装载真实Rust ESM/WASM、D1、R2和SQLite DO；本地夹具不代表云端休眠验收。
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {startWorker,stopWorker,chatIdentity,chatUpgrade,chatSQL,chatFirst,chatQueue,chatObject,fetch,sql,first,fixture,seen,chainCalls,queryCounts,setMembership,setUnknownChain,setChatPushOutcome,setChatReceiptFailure,setChatDeletionReceiptFailure,chatWindow} from './worker_smoke.mjs';
const signing=generateKeyPairSync('ed25519');let sender,receiver,a,b,opened=[],rpcBefore=0;
beforeEach(async()=>{
 await startWorker({TATACHAT_AUTH_KEY:signing.privateKey.export({format:'pem',type:'pkcs8'}),TATACHAT_AUTH_KID:'data-test-1'});await setMembership();
 sender=await chatIdentity();receiver=await chatIdentity(true);a=await sender.credential();b=await receiver.credential();opened=[];setChatPushOutcome(200);rpcBefore=chainCalls();
});
afterEach(async()=>{for(const socket of opened)socket.close();setUnknownChain(false);assert.equal(chainCalls(),rpcBefore,"聊天全部路径直接及间接RPC=0");await stopWorker();});
// 夹具只编码固定SDK字段；生产编解码仍由同一protoc/prost生成类型完成。
function varint(value){let n=BigInt(value),out=[];do{out.push(Number(n&127n)|(n>127n?128:0));n>>=7n;}while(n);return Buffer.from(out);}
const uint=(field,value)=>Buffer.concat([varint(field*8),varint(value)]);
const bytes=(field,value)=>{const b=Buffer.from(value);return Buffer.concat([varint(field*8+2),varint(b.length),b]);};
const message=(...parts)=>Buffer.concat(parts);
function fields(input){const b=Buffer.from(input),out=new Map();let at=0;function read(){let n=0n,shift=0n;for(let i=0;i<10;i++){assert.ok(at<b.length,'完整varint');const c=b[at++];n|=BigInt(c&127)<<shift;if(!(c&128))return Number(n);shift+=7n;}throw Error('varint超限');}while(at<b.length){const tag=read(),f=tag>>3,type=tag&7;let v;if(type===0)v=read();else{assert.equal(type,2);const size=read();assert.ok(size<=b.length-at);v=b.subarray(at,at+size);at+=size;}out.set(f,[...(out.get(f)??[]),v]);}return out;}
const text=(value,field)=>fields(value).get(field)?.[0]?.toString();
class Connection{
 constructor(ws){this.ws=ws;this.frames=[];this.pending=null;this.closed=new Promise(resolve=>ws.addEventListener('close',resolve,{once:true}));ws.addEventListener('message',event=>{const value=fields(event.data);this.frames.push(value);this.deliver();});ws.accept();opened.push(ws);}
 deliver(){if(!this.pending)return;const i=this.frames.findIndex(f=>this.pending.tags.some(t=>f.has(t)));if(i>=0){const value=this.frames.splice(i,1)[0],p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(value);}}
 next(...tags){assert.equal(this.pending,null);return new Promise((resolve,reject)=>{this.pending={tags,resolve,timer:setTimeout(()=>{this.pending=null;reject(Error('真实Worker帧超时'));},15000)};this.deliver();});}
 async command(tag,body,expected){const result=this.next(expected,2);this.ws.send(bytes(tag,body));const frame=await result;assert.ok(frame.has(expected),frame.has(2)?text(frame.get(2)[0],1):'响应类型不符');return frame.get(expected)[0];}
 async failure(tag,body,code){const result=this.next(2);this.ws.send(bytes(tag,body));assert.equal(text((await result).get(2)[0],1),code);}
}
async function closed(c){let timer;try{return await Promise.race([c.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('真实连接关闭超时')),15000);})]);}finally{clearTimeout(timer);}}
async function connect(credential=a){const response=await chatUpgrade(credential);assert.equal(response.status,101,response.status===101?undefined:await response.text());assert.equal(response.headers.get('sec-websocket-protocol'),'tatachat');assert.ok(response.webSocket);const c=new Connection(response.webSocket);await c.next(1);return c;}
function envelope(id='message-1',cipher=Buffer.from('opaque MLS ciphertext'),targets=[sender.device,receiver.device],created=Date.now()){
 return message(bytes(1,id),bytes(2,'conversation-1'),bytes(3,fixture.cid),bytes(4,sender.device),...targets.map(device=>bytes(5,message(bytes(1,message(bytes(1,fixture.cid),bytes(2,device))),bytes(2,cipher)))),uint(6,created));
}
function attachment(id,body){const hash=createHash('sha256').update(body).digest('hex');return message(bytes(1,id),bytes(2,fixture.cid),bytes(3,fixture.cid),bytes(4,message(uint(1,0),uint(2,body.length),bytes(3,hash))),uint(5,body.length),bytes(6,hash),uint(7,Date.now()));}
async function chunk(credential,id,method='GET',body='',index=0){return fetch(`/api/tatachat/attachments/${id}/chunks/${index}`,method,body,{authorization:'Bearer '+credential.access_token,'content-type':'application/octet-stream'});}
test('真实升级、Ping/Pong与错误凭证/旧子协议/内部头边界',async()=>{
 assert.equal((await chatUpgrade(a,'tatachatserver')).status,400);
 const pieces=a.access_token.split('.');pieces[2]=(pieces[2][0]==='A'?'B':'A')+pieces[2].slice(1);const invalid=await chatUpgrade({...a,access_token:pieces.join('.')});assert.equal(invalid.status,403,await invalid.text());
 assert.equal((await fetch('/api/tatachat/realtime','GET','',{upgrade:'websocket',authorization:'Bearer '+a.access_token,'sec-websocket-protocol':'tatachat','x-tatachat-internal':'notify'})).status,400);
 assert.equal((await fetch('/api/tatachat/realtime','GET','',{upgrade:'websocket','sec-websocket-protocol':'tatachat'})).status,403);
 assert.equal((await fetch('/api/tatachat/realtime','GET','',{authorization:'Bearer '+a.access_token,'sec-websocket-protocol':'tatachat'})).status,400);
 const c=await connect(),reply=await c.command(4,uint(1,123),5);assert.equal(fields(reply).get(1)[0],123);
 assert.equal((await fetch('/api/health')).status,200);
});
test('LastResort包实际发布、重复解析不消费及伪造归属失败',async()=>{
 const c=await connect(),peer=await connect(b),now=Date.now();
 const packageBytes=message(bytes(1,fixture.cid),bytes(2,sender.device),bytes(3,'aa'.repeat(32)),bytes(4,'opaque KeyPackage'),bytes(5,'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'),uint(6,now-1000),uint(7,now+600000),uint(8,1));
 await c.command(10,bytes(1,packageBytes),3);
 const resolve=message(bytes(1,fixture.cid),bytes(2,sender.device),uint(3,32));
 const first=await peer.command(11,resolve,12),second=await peer.command(11,resolve,12);assert.deepEqual(first,second);assert.deepEqual(fields(first).get(1),[packageBytes]);
 await peer.failure(10,bytes(1,packageBytes),'invalid_request');assert.equal((await chatFirst('SELECT count(*) AS n FROM key_packages')).n,1);
});
test('实际投递和outbox原子建立；ACK后同ID重试不复活，冲突不写入',async()=>{
 const c=await connect(),peer=await connect(b),body=envelope();await c.command(20,bytes(1,body),3);
 assert.equal((await chatFirst('SELECT count(*) AS n FROM messages')).n,2);assert.equal((await chatFirst('SELECT count(*) AS n FROM push_jobs')).n,2);
 const records=fields(await peer.command(21,uint(1,100),22)).get(1);assert.equal(records.length,1);const received=fields(records[0]);assert.equal(text(records[0],1),'message-1');assert.deepEqual(fields(received.get(5)[0]).get(2)[0],Buffer.from('opaque MLS ciphertext'));
 await peer.command(23,bytes(1,'message-1'),3);await c.command(20,bytes(1,body),3);assert.equal((await chatFirst('SELECT count(*) AS n FROM messages')).n,1);assert.equal((await chatFirst('SELECT count(*) AS n FROM push_jobs')).n,1);
 await c.failure(20,bytes(1,envelope('message-1',Buffer.from('changed'),undefined,fields(body).get(6)[0])),'conflict');assert.equal((await chatFirst('SELECT count(*) AS n FROM message_receipts')).n,1);
});
test('接收设备ACK只作用本设备；过期数据不返回，ACK后的回执期限不变',async()=>{
 const c=await connect(),peer=await connect(b),third=await chatIdentity(true),other=await connect(await third.credential());const body=envelope('device-only');await c.command(20,bytes(1,body),3);
 await other.command(23,bytes(1,'device-only'),3);assert.equal((await chatFirst('SELECT count(*) AS n FROM messages')).n,2);
 const expiry=(await chatFirst("SELECT expires_at FROM message_receipts WHERE message_id='device-only'")).expires_at;
 await peer.command(23,bytes(1,'device-only'),3);await c.command(20,bytes(1,body),3);assert.equal((await chatFirst("SELECT expires_at FROM message_receipts WHERE message_id='device-only'")).expires_at,expiry);
 await chatSQL('UPDATE messages SET expires_at=?',Date.now()-1);assert.equal(fields(await c.command(21,uint(1,100),22)).get(1),undefined);
});
// 非创建设备按既有合同隐藏附件存在性；拒绝时核对整件元数据与全部上传记录无变化。
async function attachmentSnapshot(id){
 const attachment=await chatFirst('SELECT * FROM attachments WHERE attachment_id=?',id);
 const uploads=await chatFirst("SELECT json_group_array(json_object('attempt_id',attempt_id,'attachment_id',attachment_id,'generation',generation,'object_key',object_key,'upload',upload,'state',state,'object_version',object_version,'cleanup_after',cleanup_after)) AS records FROM (SELECT * FROM attachment_uploads WHERE attachment_id=? ORDER BY attempt_id)",id);
 return {attachment,uploads:JSON.parse(uploads.records)};
}
test('密文分块摘要、创建设备、完成下载及ACK补偿真实执行',async()=>{
 const c=await connect(),peer=await connect(b),body=Buffer.from('encrypted attachment fixture');await c.command(30,bytes(1,attachment('attachment-1',body)),3);
 const pending=await attachmentSnapshot('attachment-1');
 assert.equal((await chunk(b,'attachment-1','PUT',body)).status,404);assert.deepEqual(await attachmentSnapshot('attachment-1'),pending);
 assert.equal((await chunk(a,'attachment-1','PUT',Buffer.from('bad'))).status,400);
 assert.equal((await chunk(a,'attachment-1','PUT',body)).status,204);
 const uploaded=await attachmentSnapshot('attachment-1');
 await peer.failure(31,bytes(1,'attachment-1'),'not_found');assert.deepEqual(await attachmentSnapshot('attachment-1'),uploaded);
 await c.command(31,bytes(1,'attachment-1'),32);
 const downloaded=await chunk(b,'attachment-1');assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),body);
 await peer.command(33,bytes(1,'attachment-1'),3);await peer.command(33,bytes(1,'attachment-1'),3);assert.equal((await chatFirst('SELECT count(*) AS n FROM attachments')).n,0);assert.equal((await chunk(a,'attachment-1')).status,404);
});
test('附件中止只允许创建设备，清理后保留幂等回执和原属主',async()=>{
 const c=await connect(),peer=await connect(b),body=Buffer.from('encrypted abort fixture');await c.command(30,bytes(1,attachment('attachment-abort',body)),3);
 const pending=await attachmentSnapshot('attachment-abort');
 await peer.failure(34,bytes(1,'attachment-abort'),'not_found');assert.deepEqual(await attachmentSnapshot('attachment-abort'),pending);
 await c.command(34,bytes(1,'attachment-abort'),3);await c.command(34,bytes(1,'attachment-abort'),3);assert.equal((await chatFirst("SELECT aborted FROM attachment_receipts WHERE attachment_id='attachment-abort'")).aborted,1);assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads')).n,0);
});
test('未知R2写入保留定位；观测到实际对象后清理，不能按超时假定已删除',async()=>{
 const c=await connect(),body=Buffer.from('unknown encrypted attempt');await c.command(30,bytes(1,attachment('attachment-unknown',body)),3);
 // 错误摘要先真实产生一件reserved定位，再注入崩溃后的未知writing状态。
 assert.equal((await chunk(a,'attachment-unknown','PUT',Buffer.from('bad'))).status,400);await chatSQL("UPDATE attachment_uploads SET state='writing'");const locator=await chatFirst('SELECT object_key FROM attachment_uploads');
 await c.command(34,bytes(1,'attachment-unknown'),3);assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads')).n,1);assert.equal(await chatObject(locator.object_key),null);
 await queryCounts(true);await c.command(34,bytes(1,'attachment-unknown'),3);assert.equal((await queryCounts()).r2_head,0);
 // 真实晚到对象已存在，再推进原300秒待查定位的本地due，不伪造写入成功。
 await chatObject(locator.object_key,body);await chatSQL("UPDATE attachment_uploads SET cleanup_after=0 WHERE state='writing'");await chatSQL('UPDATE attachments SET cleanup_after=0');const slot=Math.floor(Date.now()/300000)*300000;await chatSQL("INSERT INTO maintenance(slot,state) VALUES(?,'pending') ON CONFLICT(slot) DO UPDATE SET state='pending',lease_until=0",slot);await chatQueue({version:1,kind:'maintenance',id:String(slot)});
 assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads')).n,0);assert.equal(await chatObject(locator.object_key),null);assert.equal((await chatFirst('SELECT state FROM maintenance WHERE slot=?',slot)).state,'completed');
});
test('超限二进制关闭连接，畸形Protobuf不能产生任何业务写入',async()=>{
 const c=await connect();await c.failure(20,Buffer.from([0xff]),'invalid_request');assert.equal((await chatFirst('SELECT count(*) AS n FROM messages')).n,0);c.ws.send(Buffer.alloc(2*1024*1024+1));assert.equal((await closed(c)).code,1008);
});
test('聊天队列实际租约投递APNS/FCM，仅发送唤醒；普通通知表保持隔离',async()=>{
 const c=await connect(),peer=await connect(b);await peer.command(40,message(bytes(1,'ios'),bytes(2,'ab'.repeat(32))),3);await peer.command(40,message(bytes(1,'android'),bytes(2,'offline-fcm-chat-token')),3);await c.command(20,bytes(1,envelope('push-message',undefined,[receiver.device])),3);
 await chatQueue({version:1,kind:'wake',id:'fixture-wake'});assert.equal((await chatFirst("SELECT state FROM push_jobs WHERE message_id='push-message'")).state,'completed');assert.ok(seen.some(x=>x.url.startsWith('https://api.push.apple.com/3/device/')));assert.ok(seen.some(x=>x.url.includes('fcm.googleapis.com')));
 await peer.command(41,bytes(1,'ios'),3);assert.equal((await chatFirst("SELECT count(*) AS n FROM push_endpoints WHERE platform='ios'")).n,0);
});
test('提供方暂时失败持久重试，明确无效端点只删除当前代际',async()=>{
 const c=await connect(),peer=await connect(b);await peer.command(40,message(bytes(1,'ios'),bytes(2,'ab'.repeat(32))),3);await c.command(20,bytes(1,envelope('retry-message',undefined,[receiver.device])),3);
 setChatPushOutcome(503,'ServiceUnavailable');await chatQueue({version:1,kind:'wake',id:'retry-wake'});let job=await chatFirst("SELECT state,attempts,due_at FROM push_jobs WHERE message_id='retry-message'");assert.equal(job.state,'pending');assert.equal(job.attempts,1);assert.ok(job.due_at>Date.now());assert.equal((await chatFirst('SELECT count(*) AS n FROM push_endpoints')).n,1);
 await chatSQL('UPDATE push_jobs SET due_at=0,dispatch_until=0');setChatPushOutcome(410,'Unregistered');await chatQueue({version:1,kind:'wake',id:'invalid-wake'});assert.equal((await chatFirst('SELECT count(*) AS n FROM push_endpoints')).n,0);assert.equal((await chatFirst('SELECT generation FROM push_generations')).generation,1);
});
test('连接上限、文本帧、设备撤销和未知链状态均关闭或拒绝',async()=>{
 const connections=[];for(let i=0;i<4;i++)connections.push(await connect());assert.equal((await chatUpgrade(a)).status,429);
 const peer=await connect(b);peer.ws.send('not binary');assert.equal((await closed(peer)).code,1008);
 await sql('UPDATE mls_devices SET active=0 WHERE device_id=?',sender.device);connections[0].ws.send(bytes(4,uint(1,1)));assert.equal((await closed(connections[0])).code,1008);
 await sql('UPDATE mls_devices SET active=1 WHERE device_id=?',sender.device);setUnknownChain(true);await connections[1].command(4,uint(1,2),5);
 await sql('UPDATE scheduler_leases SET updated_at=? WHERE lease_key=?',Date.now()-600000,'sync:identity:'+fixture.genesis);connections[1].ws.send(bytes(4,uint(1,3)));assert.equal((await closed(connections[1])).code,1008);
});

test('非会员保持Ping及消息交付，附件控制面和数据面统一拒绝',async()=>{
 await setMembership(0,0,Date.now()-1);
 const c=await connect();await c.command(4,uint(1,9),5);
 await c.command(20,bytes(1,envelope('citizen-basic-message')),3);
 assert.equal((await chatFirst("SELECT count(*) AS n FROM messages WHERE message_id='citizen-basic-message'")).n,2);
 await c.failure(30,bytes(1,attachment('nonmember-attachment',Buffer.from('opaque'))),'forbidden');
 assert.equal((await chunk(a,'nonmember-attachment','PUT','opaque')).status,403);
 assert.equal((await chatFirst('SELECT count(*) AS n FROM attachments')).n,0);
});

test('升级、消息事件、附件声明与分块各复用一个服务端上下文',async()=>{
 const counts={};await queryCounts(true);const c=await connect();counts.upgrade=await queryCounts();assert.equal(counts.upgrade.contexts,1);
 await queryCounts(true);await c.command(4,uint(1,9),5);counts.ping=await queryCounts();assert.equal(counts.ping.contexts,1);
 const body=Buffer.from('single snapshot ciphertext');await queryCounts(true);await c.command(30,bytes(1,attachment('shared-context',body)),3);counts.declare=await queryCounts();assert.equal(counts.declare.contexts,1);
 await queryCounts(true);const uploaded=await chunk(a,'shared-context','PUT',body);assert.equal(uploaded.status,204,await uploaded.clone().text());await uploaded.arrayBuffer();counts.chunk=await queryCounts();assert.equal(counts.chunk.contexts,1);
});
test('仅会员同步健康过期时基础聊天继续、附件拒绝',async()=>{
 const c=await connect();await sql('UPDATE scheduler_leases SET updated_at=? WHERE lease_key=?',Date.now()-600000,'sync:membership:'+fixture.genesis);
 await c.command(4,uint(1,7),5);await c.failure(30,bytes(1,attachment('stale-membership',Buffer.from('opaque'))),'storage_unavailable');
 assert.equal((await chunk(a,'stale-membership','PUT','opaque')).status,503);
});


test('附件待上传硬顶在元数据写入前拒绝且不影响基础消息',async()=>{
 const c=await connect(),body=Buffer.from('opaque budget');await c.command(30,bytes(1,attachment('pending-one',body)),3);
 await c.failure(30,bytes(1,attachment('pending-two',body)),'resource_limit');
 assert.equal((await chatFirst('SELECT count(*) AS n FROM attachments')).n,1);
 await c.command(20,bytes(1,envelope('still-basic')),3);assert.equal((await chatFirst('SELECT count(*) AS n FROM messages')).n,2);
});

test('成功分块重试和错误设备均零正文零R2操作',async()=>{
 const c=await connect(),body=Buffer.from('one physical write');await c.command(30,bytes(1,attachment('dedup-chunk',body)),3);
 await queryCounts(true);const first=await chunk(a,'dedup-chunk','PUT',body);assert.equal(first.status,204,await first.text());
 const positive=await queryCounts();assert.equal(positive.r2_put,1);assert.ok(positive.body_reads>0,'真实正文读取的正向计数必须可观测');
 await queryCounts(true);const duplicate=await chunk(a,'dedup-chunk','PUT',Buffer.from('different retry body'));assert.equal(duplicate.status,204,await duplicate.text());
 const repeated=await queryCounts();assert.equal(repeated.r2_put,0);assert.equal(repeated.r2_head,0);assert.equal(repeated.body_reads,0);
 await queryCounts(true);const foreign=await chunk(b,'dedup-chunk','PUT',body);assert.equal(foreign.status,404,await foreign.text());
 const denied=await queryCounts();assert.equal(denied.body_reads,0);assert.equal(denied.r2_put,0);assert.equal(denied.r2_head,0);
 assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads')).n,1);
});

test('R2已写但回执保存故障只恢复原键，不再读取重试正文或PUT',async()=>{
 const c=await connect(),body=Buffer.from('unknown put result');await c.command(30,bytes(1,attachment('recover-old-key',body)),3);
 await setChatReceiptFailure();await queryCounts(true);
 const failed=await chunk(a,'recover-old-key','PUT',body);assert.equal(failed.status,503,await failed.text());
 const upload=await chatFirst('SELECT attempt_id,object_key,state FROM attachment_uploads');assert.equal(upload.state,'writing');
 assert.equal((await queryCounts()).r2_put,1);assert.ok(await chatObject(upload.object_key),'原生R2确有对象，不能以无对象假故障替代');
 await queryCounts(true);const retry=await chunk(a,'recover-old-key','PUT','untrusted replacement');assert.equal(retry.status,204,await retry.text());
 const counts=await queryCounts();assert.equal(counts.body_reads,0);assert.equal(counts.r2_put,0);assert.equal(counts.r2_head,1);
 assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads')).n,1);assert.equal((await chatFirst('SELECT object_key FROM attachment_uploads')).object_key,upload.object_key);
});

test('日上传和下载额度在正文及对象I/O前拒绝并由同CID多设备共享',async()=>{
 const c=await connect(),body=Buffer.from('quota guarded object');await c.command(30,bytes(1,attachment('day-byte-cap',body)),3);
 const day=Math.floor(Date.now()/86400000)*86400000;
 await sql("INSERT INTO membership_usage(cid_number,metric,period_start,amount,updated_at) VALUES(?,'upload_bytes',?,?,?) ON CONFLICT(cid_number,metric,period_start) DO UPDATE SET amount=excluded.amount",fixture.cid,day,64*1024*1024,Date.now());
 await queryCounts(true);const denied=await chunk(a,'day-byte-cap','PUT',body);assert.equal(denied.status,429,await denied.text());
 let counts=await queryCounts();assert.equal(counts.body_reads,0);assert.equal(counts.r2_put,0);assert.equal(counts.r2_head,0);
 assert.equal((await chatFirst('SELECT state FROM attachment_uploads')).state,'reserved','未开始PUT的预留可复用');
 await sql("UPDATE membership_usage SET amount=0 WHERE cid_number=? AND metric='upload_bytes'",fixture.cid);
 assert.equal((await chunk(a,'day-byte-cap','PUT',body)).status,204);await c.command(31,bytes(1,'day-byte-cap'),32);
 await sql("INSERT INTO membership_usage(cid_number,metric,period_start,amount,updated_at) VALUES(?,'delivery_bytes',?,?,?) ON CONFLICT(cid_number,metric,period_start) DO UPDATE SET amount=excluded.amount",fixture.cid,day,128*1024*1024,Date.now());
 await queryCounts(true);const download=await chunk(b,'day-byte-cap');assert.equal(download.status,429,await download.text());
 counts=await queryCounts();assert.equal(counts.r2_get,0);assert.equal(counts.r2_head,0);assert.equal(counts.body_reads,0);
});

test('四连接共用16次Ping，超额先于主库且窗口每帧仍仅读写一次',async()=>{
 const connections=[];for(let i=0;i<4;i++)connections.push(await connect());
 for(let attempt=0;attempt<2;attempt++){
  const seeded=await chatWindow(sender.device,{frames:0,bytes:0,pings:0});await queryCounts(true);
  for(let i=0;i<16;i++)await connections[i%4].command(4,uint(1,i+1),5);
  const current=await chatWindow(sender.device);
  if(current.minute!==seeded.minute){assert.equal(attempt,0);continue;}
  assert.equal(current.pings,16);assert.equal(current.frames,16);
  const costs=await queryCounts();assert.equal(costs.contexts,16);assert.equal(costs.do_window_reads,16);assert.equal(costs.do_window_writes,16);assert.equal(costs.batches,32);
  // 正常Ping保留原完整鉴权的两批D1；只禁止新增日额度及随机流水写入。
  assert.equal((await first("SELECT COUNT(*) n FROM membership_usage WHERE metric IN ('chat_commands','chat_frame_bytes')")).n,0);
  break;
 }
 await queryCounts(true);connections[0].ws.send(bytes(4,uint(1,17)));await closed(connections[0]);
 let cost=await queryCounts();assert.equal(cost.contexts,0);assert.equal(cost.do_window_reads,1);assert.equal(cost.do_window_writes,1);assert.equal(cost.batches,0);
 // 只关闭触发连接，其余连接仍可执行原非Ping命令及全部授权检查。
 await connections[1].command(21,uint(1,1),22);
 assert.equal((await first("SELECT amount FROM membership_usage WHERE metric='chat_commands'")).amount,1);
});
test('Ping原始64字节允许而65字节在恢复前拒绝，保持原未知帧拒绝',async()=>{
 const c=await connect(),other=await connect();
 const frame=n=>message(bytes(4,uint(1,7)),bytes(100,Buffer.alloc(n-7)));
 const valid=frame(64),large=frame(65);assert.equal(valid.length,64);assert.equal(large.length,65);
 await queryCounts(true);const reply=c.next(5,2);c.ws.send(valid);assert.ok((await reply).has(5));
 let cost=await queryCounts();assert.equal(cost.contexts,1);assert.equal(cost.do_window_reads,1);assert.equal(cost.do_window_writes,1);
 await queryCounts(true);other.ws.send(large);await closed(other);cost=await queryCounts();assert.equal(cost.contexts,0);assert.equal(cost.do_window_reads,1);assert.equal(cost.do_window_writes,1);
 await queryCounts(true);await c.failure(250,Buffer.from('unknown'),'invalid_request');cost=await queryCounts();assert.equal(cost.contexts,0);assert.equal(cost.do_window_reads,1);assert.equal(cost.do_window_writes,1);
});
test('原固定窗跨Rust实例重建和重连保留Ping子量，未写主库日额',async()=>{
 const c=await connect();
 for(let attempt=0;attempt<2;attempt++){
  const seeded=await chatWindow(sender.device,{frames:10,bytes:100,pings:15});
  assert.deepEqual(await chatWindow(sender.device,{recreate:true}),seeded);
  await queryCounts(true);await c.command(4,uint(1,1),5);const stored=await chatWindow(sender.device);
  if(stored.minute!==seeded.minute){assert.equal(attempt,0);continue;}
  assert.equal(stored.pings,16);const cost=await queryCounts();assert.equal(cost.contexts,1);assert.equal(cost.batches,2);assert.equal(cost.do_window_reads,1);assert.equal(cost.do_window_writes,1);break;
 }
 await chatWindow(sender.device,{recreate:true});await queryCounts(true);c.ws.send(bytes(4,uint(1,2)));await closed(c);assert.equal((await queryCounts()).contexts,0);
 const reconnect=await connect();await queryCounts(true);reconnect.ws.send(bytes(4,uint(1,3)));await closed(reconnect);assert.equal((await queryCounts()).contexts,0);
 assert.equal((await first("SELECT COUNT(*) n FROM membership_usage WHERE metric IN ('chat_commands','chat_frame_bytes')")).n,0);
});
test('旧窗缺pings补零、分钟切换重置，时钟回退拒绝且不写窗口',async()=>{
 const c=await connect();await chatWindow(sender.device,{frames:0,bytes:0});await c.command(4,uint(1,1),5);assert.equal((await chatWindow(sender.device)).pings,1);
 const previous=Math.floor(Date.now()/60000)-1;await chatWindow(sender.device,{minute:previous,frames:240,bytes:8*1024*1024,pings:16});
 await c.command(4,uint(1,2),5);let stored=await chatWindow(sender.device);assert.equal(stored.pings,1);assert.equal(stored.frames,1);assert.ok(stored.minute>previous);
 const future=Math.floor(Date.now()/60000)+2,original=await chatWindow(sender.device,{minute:future,frames:8,bytes:64,pings:16});
 await queryCounts(true);c.ws.send(bytes(4,uint(1,3)));await closed(c);const cost=await queryCounts();assert.equal(cost.contexts,0);assert.equal(cost.do_window_reads,1);assert.equal(cost.do_window_writes,0);assert.deepEqual(await chatWindow(sender.device),original);
});

test('每设备四连接共用持久分钟窗，拒绝和重连不再查询D1',async()=>{
 const first=await connect(),second=await connect();
 let window;
 for(let attempt=0;attempt<2;attempt++){
  const seeded=await chatWindow(sender.device,{frames:239,bytes:0});
  await queryCounts(true);await first.command(4,uint(1,1),5);window=await chatWindow(sender.device);
  if(window.minute===seeded.minute){assert.equal(window.frames,240);assert.equal((await queryCounts()).contexts,1);break;}
  assert.ok(window.minute>seeded.minute,'只允许真实分钟切换触发重新准备夹具');assert.equal(attempt,0);
 }
 // 在同一原生DO中写满当前窗，避免测试恰好跨分钟导致误把正常日切当漏洞。
 await chatWindow(sender.device,{frames:240,bytes:8*1024*1024});await queryCounts(true);
 second.ws.send(bytes(4,uint(1,2)));await closed(second);assert.equal((await queryCounts()).contexts,0);
 const reconnect=await connect();await queryCounts(true);reconnect.ws.send(bytes(4,uint(1,3)));await closed(reconnect);assert.equal((await queryCounts()).contexts,0);
 assert.equal((await chatFirst('SELECT count(*) AS n FROM message_receipts')).n,0);
});


test('整份附件降档及低档接收者在正文和对象IO前被拒绝，abort仍释放占用',async()=>{
 await setMembership(1);const c=await connect();
 // 只准备真实允许的高档元数据，不为限额测试写入11MiB对象。
 const id='whole_size_downgrade',hash='ab'.repeat(32),sizes=[4,4,3].map(n=>n*1024*1024);
 const metadata=message(bytes(1,id),bytes(2,fixture.cid),bytes(3,fixture.cid),...sizes.map((size,index)=>bytes(4,message(uint(1,index),uint(2,size),bytes(3,hash)))),uint(5,11*1024*1024),bytes(6,hash),uint(7,Date.now()));
 await c.command(30,bytes(1,metadata),3);await setMembership(0);
 await queryCounts(true);assert.equal((await chunk(a,id,'PUT',Buffer.from('unused'))).status,413);
 let counts=await queryCounts();assert.equal(counts.body_reads,0);assert.equal(counts.r2_put,0);assert.equal(counts.r2_head,0);
 await c.failure(31,bytes(1,id),'resource_limit');
 await queryCounts(true);assert.equal((await chunk(b,id)).status,413);counts=await queryCounts();assert.equal(counts.r2_get,0);assert.equal(counts.r2_head,0);
 assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads WHERE attachment_id=?',id)).n,0);
 await c.command(34,bytes(1,id),3);assert.equal((await chatFirst('SELECT count(*) AS n FROM attachments WHERE attachment_id=?',id)).n,0);
});


function chunkedAttachment(id,bodies){
 const joined=Buffer.concat(bodies),hash=createHash('sha256').update(joined).digest('hex');
 return message(bytes(1,id),bytes(2,fixture.cid),bytes(3,fixture.cid),...bodies.map((body,index)=>bytes(4,message(uint(1,index),uint(2,body.length),bytes(3,createHash('sha256').update(body).digest('hex'))))),uint(5,joined.length),bytes(6,hash),uint(7,Date.now()));
}
async function seedCleanup(){const slot=Math.floor(Date.now()/300000)*300000;await chatSQL("INSERT INTO maintenance(slot,state) VALUES(?,'pending') ON CONFLICT(slot) DO UPDATE SET state='pending',lease_until=0,lease_id=NULL",slot);return slot;}
const cleanupMessage=slot=>({version:1,kind:'maintenance',id:String(slot)});
// 只推进已持久排定的本地1秒/60秒退避，不把未知对象伪装成已提交或已删除。
async function resumeCleanup(slot){await chatSQL("UPDATE maintenance SET lease_until=0 WHERE slot=? AND state='pending'",slot);await chatSQL("UPDATE attachments SET cleanup_after=0 WHERE state='deleting'");await chatQueue(cleanupMessage(slot));}

test('已确认附件ACK直接DELETE零HEAD，九块小批后同一任务继续清完',async()=>{
 const c=await connect(),peer=await connect(b),id='delete_nine',bodies=Array.from({length:9},(_,n)=>Buffer.from([n]));
 await c.command(30,bytes(1,chunkedAttachment(id,bodies)),3);
 for(let index=0;index<bodies.length;index++)assert.equal((await chunk(a,id,'PUT',bodies[index],index)).status,204);
 await c.command(31,bytes(1,id),32);await queryCounts(true);await peer.command(33,bytes(1,id),3);
 let counts=await queryCounts();assert.equal(counts.r2_head,0);assert.equal(counts.r2_delete,8);
 assert.equal((await chatFirst('SELECT state FROM attachments WHERE attachment_id=?',id)).state,'deleting');
 assert.equal((await chunk(b,id)).status,404);
 const queued=counts.queue_messages.find(item=>item.body.kind==='maintenance');assert.ok(queued);assert.equal(queued.delay,1);
 await queryCounts(true);await resumeCleanup(Number(queued.body.id));counts=await queryCounts();
 assert.equal(counts.r2_head,0);assert.equal(counts.r2_delete,1);assert.equal(counts.queue_sends,0);
 assert.ok(counts.batches+counts.r2_head+counts.r2_delete+counts.queue_sends<=50);
 assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM attachments WHERE attachment_id=?',id)).n,0);
 assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM maintenance')).n,1);assert.equal((await chatFirst('SELECT state FROM maintenance')).state,'completed');
 assert.equal((await first("SELECT request_count FROM rate_windows WHERE rate_key=?",'cleanup:day:'+Math.floor(Date.now()/86400000))).request_count,50);
});

test('聊天过期行每批1000，满批1秒续跑而空闲结束，未下文件到期直接禁读',async()=>{
 const c=await connect(),id='expired_unread',body=Buffer.from('expired opaque');await c.command(30,bytes(1,attachment(id,body)),3);
 assert.equal((await chunk(a,id,'PUT',body)).status,204);await c.command(31,bytes(1,id),32);
 await chatSQL('UPDATE attachments SET expires_at=?,cleanup_after=0 WHERE attachment_id=?',Date.now()-1,id);
 assert.equal((await chunk(b,id)).status,404);
 await chatSQL("WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO key_packages(user_id,device_id,record,wire_bytes,not_before,not_after) SELECT 'synthetic-expired',CAST(x AS TEXT),'{}',1,0,1 FROM n");
 const slot=await seedCleanup();await queryCounts(true);await chatQueue(cleanupMessage(slot));
 let counts=await queryCounts();assert.equal((await chatFirst("SELECT COUNT(*) AS n FROM key_packages WHERE user_id='synthetic-expired'")).n,1);
 assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM attachments WHERE attachment_id=?',id)).n,0);assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM attachment_receipts WHERE attachment_id=?',id)).n,0);
 assert.equal(counts.r2_head,0);assert.equal(counts.r2_delete,1);assert.ok(counts.queue_messages.some(item=>item.body.id===String(slot)&&item.delay===1));
 await queryCounts(true);await resumeCleanup(slot);counts=await queryCounts();assert.equal(counts.queue_sends,0);assert.equal((await chatFirst("SELECT COUNT(*) AS n FROM key_packages WHERE user_id='synthetic-expired'")).n,0);assert.equal((await chatFirst('SELECT state FROM maintenance WHERE slot=?',slot)).state,'completed');
});

test('后台清理日顶耗尽先拒绝对象IO，同一任务持久延期次日',async()=>{
 const c=await connect(),id='cleanup_daily',body=Buffer.from('daily opaque');await c.command(30,bytes(1,attachment(id,body)),3);assert.equal((await chunk(a,id,'PUT',body)).status,204);
 await chatSQL("UPDATE attachments SET state='deleting',cleanup_after=0 WHERE attachment_id=?",id);
 const slot=await seedCleanup(),day=Math.floor(Date.now()/86400000);await sql("INSERT INTO rate_windows VALUES(?,1000000,?)",'cleanup:day:'+day,(day+1)*86400000);
 await queryCounts(true);await chatQueue(cleanupMessage(slot));let counts=await queryCounts();assert.equal(counts.r2_head,0);assert.equal(counts.r2_delete,0);assert.equal(counts.queue_sends,0);
 const task=await chatFirst('SELECT state,lease_until FROM maintenance WHERE slot=?',slot);assert.equal(task.state,'pending');assert.equal(task.lease_until,(day+1)*86400000);
 assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM attachment_uploads WHERE attachment_id=?',id)).n,1);
 // 重复旧队列不能绕过已持久化的日顶延期，也不能再访问主库日池。
 await queryCounts(true);await chatQueue(cleanupMessage(slot));counts=await queryCounts();assert.equal(counts.batches,1);assert.equal(counts.r2_delete,0);assert.equal(counts.queue_sends,0);
});

test('删除后D1回执故障保留定位，连续四次60秒失败后停槽且不重复HEAD',async()=>{
 const c=await connect(),id='delete_receipt_failure',body=Buffer.from('deletion opaque');await c.command(30,bytes(1,attachment(id,body)),3);assert.equal((await chunk(a,id,'PUT',body)).status,204);
 await chatSQL("UPDATE attachments SET state='deleting',aborted=1,cleanup_after=0 WHERE attachment_id=?",id);const slot=await seedCleanup();await setChatDeletionReceiptFailure(4);
 for(let attempt=1;attempt<=4;attempt++){
  await queryCounts(true);await resumeCleanup(slot);const counts=await queryCounts();assert.equal(counts.r2_head,0);assert.equal(counts.r2_delete,1);
  assert.equal((await chatFirst('SELECT state FROM attachment_uploads WHERE attachment_id=?',id)).state,'written');
  assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM attachments WHERE attachment_id=?',id)).n,1);
  const task=await chatFirst('SELECT state,lease_id FROM maintenance WHERE slot=?',slot);
  if(attempt<4){assert.equal(task.state,'pending');assert.equal(JSON.parse(task.lease_id).failures,attempt);assert.ok(counts.queue_messages.some(item=>item.delay===60));}
  else {assert.equal(task.state,'failed');assert.equal(counts.queue_sends,0);}
 }
 // 下一Cron可领取的新槽继续原定位；测试不生成新对象键。
 await chatSQL("UPDATE maintenance SET state='pending',lease_id=NULL,lease_until=0 WHERE slot=?",slot);await queryCounts(true);await resumeCleanup(slot);const counts=await queryCounts();assert.equal(counts.r2_head,0);assert.equal(counts.r2_delete,1);assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM attachments WHERE attachment_id=?',id)).n,0);
});


test('八件多块附件触及整轮预算，所有已领取剩余定位1秒续跑且总I/O不超50',async()=>{
 await setMembership(2);const c=await connect(),bodies=Array.from({length:10},(_,n)=>Buffer.from([n]));
 for(let item=0;item<8;item++){
  const id='cleanup_budget_'+item;await c.command(30,bytes(1,chunkedAttachment(id,bodies)),3);
  for(let index=0;index<10;index++)assert.equal((await chunk(a,id,'PUT',bodies[index],index)).status,204);
  await c.command(31,bytes(1,id),32);
 }
 // 模拟原abort已持久提交、消费者尚未开始的可恢复现场；不伪造对象或版本。
 await chatSQL("UPDATE attachments SET state='deleting',aborted=1,cleanup_after=0");const slot=await seedCleanup();let deletes=0,rounds=0;
 while((await chatFirst('SELECT COUNT(*) AS n FROM attachments')).n>0){
  assert.ok(rounds++<16);await queryCounts(true);await resumeCleanup(slot);const counts=await queryCounts();
  assert.equal(counts.r2_head,0);assert.equal(counts.r2_put,0);
  assert.ok(counts.batches+counts.r2_delete+counts.queue_sends<=50,JSON.stringify(counts));deletes+=counts.r2_delete;
  const remaining=await chatFirst('SELECT COUNT(*) AS n,MAX(cleanup_after) AS due FROM attachments');
  if(remaining.n>0){assert.ok(remaining.due<=Date.now()+2000,'未处理定位不能遗留300秒领取退避');assert.ok(counts.queue_messages.some(item=>item.body.id===String(slot)&&item.delay===1));}
 }
 assert.ok(rounds>1);assert.equal(deletes,80);assert.equal((await chatFirst('SELECT COUNT(*) AS n FROM maintenance')).n,1);
 assert.equal((await first('SELECT request_count FROM rate_windows WHERE rate_key=?','cleanup:day:'+Math.floor(Date.now()/86400000))).request_count,rounds*50);
});
