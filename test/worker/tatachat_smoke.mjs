// 真实Rust ESM/WASM的宿主许可接口；本文件不替代B的WSS/DO/附件数据面验收。
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {startWorker,stopWorker,sql,first,fetch,proof,fixture,registration,token,tokenHash,device,seen,setMembership,setUnknownChain} from './worker_smoke.mjs';
const keys=generateKeyPairSync('ed25519');
const kid='local-test-1';
const path='/api/tatachat/access';
before(async()=>{
 await startWorker({TATACHAT_AUTH_KEY:keys.privateKey.export({format:'pem',type:'pkcs8'}),TATACHAT_AUTH_KID:kid});
 setMembership();
});
after(()=>stopWorker());
async function access(body='{}',extra={}){
 const p=await proof('POST',path,body);
 return fetch(path,'POST',body,{authorization:'Bearer '+token,'x-mls-proof':p,...extra});
}
function claims(raw){
 const [h,p,s]=raw.split('.');assert.ok(verify(null,Buffer.from(h+'.'+p),keys.publicKey,Buffer.from(s,'base64url')));
 const header=JSON.parse(Buffer.from(h,'base64url'));assert.deepEqual(header,{alg:'EdDSA',typ:'JWT',kid});
 return JSON.parse(Buffer.from(p,'base64url'));
}
test('actual /api access requires both ordinary session and exact MLS proof',async()=>{
 assert.equal((await fetch(path,'POST','{}')).status,401);
 assert.equal((await fetch(path,'POST','{}',{authorization:'Bearer '+token})).status,401);
 const p=await proof('POST',path,'{}');
 let r=await fetch(path,'POST','{}',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,200,await r.clone().text());
 r=await fetch(path,'POST','{}',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,401,await r.text());
});
test('Worker WebCrypto Ed25519 signs actual origin and neutral subject within deadlines',async()=>{
 const r=await access('{}',{'x-current-user':'forged','x-current-device':'forged'});assert.equal(r.status,200,await r.clone().text());
 const result=await r.json();const c=claims(result.access_token);
 assert.equal(c.sub,fixture.cid);assert.equal(c.device_id,device);assert.equal(c.session_hash,tokenHash);
 assert.equal(c.iss,registration.service_origin);assert.equal(c.aud,'citizenserve.tatachat');assert.equal(c.purpose,'tatachat_access');assert.equal(c.version,1);
 assert.equal(c.max_attachment_bytes,10*1024*1024);assert.equal(c.chat_enabled,true);
 assert.ok(c.expires_at_millis-c.issued_at_millis<=900000);assert.ok(c.recheck_at_millis-c.issued_at_millis<=60000);
 assert.equal(result.expires_at,c.expires_at_millis);assert.equal(result.recheck_at,c.recheck_at_millis);
 assert.equal(result.realtime_url,registration.service_origin.replace('https://','wss://')+'/api/tatachat/realtime');
 assert.ok(c.expires_at_millis<=(await first('SELECT expires_at FROM square_sessions')).expires_at);
 assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
 assert.ok(!seen.some(x=>x.url.includes('siteverify')),'existing admission must not trigger a second Turnstile');
});
test('device reactivation changes opaque revision; revoked device cannot get access',async()=>{
 let r=await access();assert.equal(r.status,200,await r.clone().text());const original=claims((await r.json()).access_token);
 await sql('UPDATE mls_devices SET issued_at=issued_at+1 WHERE device_id=?',device);
 r=await access();assert.equal(r.status,200,await r.clone().text());const renewed=claims((await r.json()).access_token);
 assert.notEqual(original.authorization_revision,renewed.authorization_revision);
 const p=await proof('POST',path,'{}');await sql('UPDATE mls_devices SET active=0 WHERE device_id=?',device);
 r=await fetch(path,'POST','{}',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,401,await r.text());
 await sql('UPDATE mls_devices SET active=1 WHERE device_id=?',device);
});
test('expired membership and unknown chain cannot issue credentials',async()=>{
 setMembership(0,0,Date.now()-1000);let r=await access();assert.equal(r.status,403,await r.text());setMembership();
 const p=await proof('POST',path,'{}');setUnknownChain(true);
 r=await fetch(path,'POST','{}',{authorization:'Bearer '+token,'x-mls-proof':p});assert.equal(r.status,503,await r.text());setUnknownChain(false);
});
test('scope or user parameters are rejected and realtime requires an actual upgrade',async()=>{
 for(const body of ['[]','null','{"cid_number":"forged"}','{"device_id":"forged"}']){
  const r=await access(body);assert.equal(r.status,400,await r.text());
 }
 assert.equal((await fetch('/api/tatachat/access?cid=forged','POST','{}')).status,400);
 assert.equal((await fetch('/api/tatachat/realtime')).status,400);
 assert.equal((await fetch('/api/health')).status,200);
});
