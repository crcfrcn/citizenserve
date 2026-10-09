// 装载真实Rust ESM/WASM、D1、R2和SQLite DO；本地夹具不代表云端休眠验收。
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {startWorker,stopWorker,chatIdentity,chatUpgrade,chatSQL,chatFirst,chatQueue,chatObject,fetch,sql,fixture,seen,setMembership,setUnknownChain,setChatPushOutcome} from './worker_smoke.mjs';
const signing=generateKeyPairSync('ed25519');let sender,receiver,a,b,opened=[];
beforeEach(async()=>{
 await startWorker({TATACHAT_AUTH_KEY:signing.privateKey.export({format:'pem',type:'pkcs8'}),TATACHAT_AUTH_KID:'data-test-1'});setMembership();
 sender=await chatIdentity();receiver=await chatIdentity(true);a=await sender.credential();b=await receiver.credential();opened=[];setChatPushOutcome(200);
});
afterEach(async()=>{for(const socket of opened)socket.close();setUnknownChain(false);await stopWorker();});
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
async function connect(credential=a){const response=await chatUpgrade(credential);assert.equal(response.status,101);assert.equal(response.headers.get('sec-websocket-protocol'),'tatachat');assert.ok(response.webSocket);const c=new Connection(response.webSocket);await c.next(1);return c;}
function envelope(id='message-1',cipher=Buffer.from('opaque MLS ciphertext'),targets=[sender.device,receiver.device],created=Date.now()){
 return message(bytes(1,id),bytes(2,'conversation-1'),bytes(3,fixture.cid),bytes(4,sender.device),...targets.map(device=>bytes(5,message(bytes(1,message(bytes(1,fixture.cid),bytes(2,device))),bytes(2,cipher)))),uint(6,created));
}
function attachment(id,body){const hash=createHash('sha256').update(body).digest('hex');return message(bytes(1,id),bytes(2,fixture.cid),bytes(3,fixture.cid),bytes(4,message(uint(1,0),uint(2,body.length),bytes(3,hash))),uint(5,body.length),bytes(6,hash),uint(7,Date.now()));}
async function chunk(credential,id,method='GET',body=''){return fetch(`/api/tatachat/attachments/${id}/chunks/0`,method,body,{authorization:'Bearer '+credential.access_token,'content-type':'application/octet-stream'});}
test('真实升级、Ping/Pong与错误凭证/旧子协议/内部头边界',async()=>{
 assert.equal((await chatUpgrade(a,'tatachatserver')).status,400);
 const pieces=a.access_token.split('.');pieces[2]=(pieces[2][0]==='A'?'B':'A')+pieces[2].slice(1);assert.equal((await chatUpgrade({...a,access_token:pieces.join('.')})).status,403);
 assert.equal((await fetch('/api/tatachat/realtime','GET','',{upgrade:'websocket',authorization:'Bearer '+a.access_token,'sec-websocket-protocol':'tatachat','x-tatachat-internal':'notify'})).status,400);
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
test('密文分块摘要、创建设备、完成下载及ACK补偿真实执行',async()=>{
 const c=await connect(),peer=await connect(b),body=Buffer.from('encrypted attachment fixture');await c.command(30,bytes(1,attachment('attachment-1',body)),3);
 assert.equal((await chunk(b,'attachment-1','PUT',body)).status,403);assert.equal((await chunk(a,'attachment-1','PUT',Buffer.from('bad'))).status,400);
 assert.equal((await chunk(a,'attachment-1','PUT',body)).status,204);
 await peer.failure(31,bytes(1,'attachment-1'),'forbidden');await c.command(31,bytes(1,'attachment-1'),32);
 const downloaded=await chunk(b,'attachment-1');assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),body);
 await peer.command(33,bytes(1,'attachment-1'),3);await peer.command(33,bytes(1,'attachment-1'),3);assert.equal((await chatFirst('SELECT count(*) AS n FROM attachments')).n,0);assert.equal((await chunk(a,'attachment-1')).status,404);
});
test('附件中止只允许创建设备，清理后保留幂等回执和原属主',async()=>{
 const c=await connect(),peer=await connect(b),body=Buffer.from('encrypted abort fixture');await c.command(30,bytes(1,attachment('attachment-abort',body)),3);await peer.failure(34,bytes(1,'attachment-abort'),'forbidden');await c.command(34,bytes(1,'attachment-abort'),3);await c.command(34,bytes(1,'attachment-abort'),3);assert.equal((await chatFirst("SELECT aborted FROM attachment_receipts WHERE attachment_id='attachment-abort'")).aborted,1);assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads')).n,0);
});
test('未知R2写入保留定位；观测到实际对象后清理，不能按超时假定已删除',async()=>{
 const c=await connect(),body=Buffer.from('unknown encrypted attempt');await c.command(30,bytes(1,attachment('attachment-unknown',body)),3);
 // 错误摘要先真实产生一件reserved定位，再注入崩溃后的未知writing状态。
 assert.equal((await chunk(a,'attachment-unknown','PUT',Buffer.from('bad'))).status,400);await chatSQL("UPDATE attachment_uploads SET state='writing'");const locator=await chatFirst('SELECT object_key FROM attachment_uploads');
 await c.failure(34,bytes(1,'attachment-unknown'),'storage_unavailable');assert.equal((await chatFirst('SELECT count(*) AS n FROM attachment_uploads')).n,1);assert.equal(await chatObject(locator.object_key),null);
 await chatObject(locator.object_key,body);await chatSQL('UPDATE attachments SET cleanup_after=0');const slot=Math.floor(Date.now()/300000)*300000;await chatSQL("INSERT INTO maintenance(slot,state) VALUES(?,'pending')",slot);await chatQueue({version:1,kind:'maintenance',id:String(slot)});
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
 await sql('UPDATE mls_devices SET active=1 WHERE device_id=?',sender.device);setUnknownChain(true);connections[1].ws.send(bytes(4,uint(1,2)));assert.equal((await closed(connections[1])).code,1008);
});
