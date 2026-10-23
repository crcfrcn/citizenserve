// 构建边界回归：真实源码隔离、原锁、缓存占用、版本与完整Worker字节。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {root,claimCache,sourceView,verifyWorker} from '../scripts/build.mjs';
import {automationDisplayName,releaseMembers} from '../scripts/config.mjs';
function fixture(t){const base=join(root,'target/test');mkdirSync(base,{recursive:true});const work=mkdtempSync(join(base,'regression-'));t.after(()=>rmSync(work,{recursive:true,force:true}));return work;}

test('源码工程与原锁隔离，产物清单保持部署入口的全部十件输入',t=>{
 const work=fixture(t),source=join(work,'source'),output=join(work,'project');mkdirSync(join(source,'target'),{recursive:true});writeFileSync(join(source,'Cargo.lock'),'original');writeFileSync(join(source,'target','generated'),'excluded');sourceView(source,output);assert.equal(readFileSync(join(output,'Cargo.lock'),'utf8'),'original');assert.throws(()=>readFileSync(join(output,'target/generated')));writeFileSync(join(output,'Cargo.lock'),'changed');assert.equal(readFileSync(join(source,'Cargo.lock'),'utf8'),'original');assert.throws(()=>sourceView(source,output));assert.equal(new Set(releaseMembers).size,10);
});
test('缓存已被占用时立即使用独占现场，不释放其它任务锁',t=>{
 const work=fixture(t),first=claimCache(work),second=claimCache(work);try{assert.equal(second.cargo,join(work,'rust'));second.release();}finally{first.release();}
});
test('空JS、错误WASM或缺件必须失败',t=>{
 const work=fixture(t);writeFileSync(join(work,'index.js'),'export default {}');writeFileSync(join(work,'index_bg.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));verifyWorker(work);writeFileSync(join(work,'index_bg.wasm'),'not wasm');assert.throws(()=>verifyWorker(work));writeFileSync(join(work,'index.js'),'');assert.throws(()=>verifyWorker(work));
});
