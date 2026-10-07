import assert from 'node:assert/strict';
import test from 'node:test';
import {chainSourceSHA,chainSourcePaths,readChainSource} from './chain_source.mjs';

// 正常路径真实读取准确公开提交；错误路径不联网，断言故障不得变成跳过或兄弟仓回退。
test('Serve四份链真源来自同一准确提交且保留二进制字节',async()=>{
  assert.match(chainSourceSHA,/^[a-f0-9]{40}$/u);
  assert.equal(chainSourcePaths.length,4);
  const values=await Promise.all(chainSourcePaths.map(path=>readChainSource(path)));
  assert.ok(values.every(value=>Buffer.isBuffer(value)&&value.length>0));
  assert.equal(JSON.parse(values[2].toString('utf8')).domain,'GMB');
  assert.ok(values[3].toString('utf8').includes('pub type AccountIdByCid'));
});
test('Serve链真源未知坐标在网络前拒绝',async()=>{
  for(const path of ['../citizenchain/runtime/src/lib.rs','runtime/src/lib.rs','toString','']) {
    let called=false;
    await assert.rejects(readChainSource(path,async()=>{called=true;throw Error('不应联网');}),/坐标/u);
    assert.equal(called,false);
  }
});
test('Serve链真源拒绝网络故障、状态、空正文、大小和摘要漂移',async()=>{
  const path=chainSourcePaths[1];
  const invoke=body=>readChainSource(path,async(url,options)=>{
    assert.equal(url,'https://raw.githubusercontent.com/crcfrcn/citizenchain/'+chainSourceSHA+'/'+path);
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.ok(options.signal instanceof AbortSignal);
    return body;
  });
  await assert.rejects(readChainSource(path,async()=>{throw Error('网络失败');}),/网络失败/u);
  await assert.rejects(invoke(new Response('missing',{status:404})),/读取/u);
  await assert.rejects(invoke({ok:true,body:null}),/读取/u);
  await assert.rejects(invoke(new Response('')),/摘要/u);
  await assert.rejects(invoke(new Response(new Uint8Array(2550))),/大小/u);
  await assert.rejects(invoke(new Response(new Uint8Array(2549))),/摘要/u);
});
