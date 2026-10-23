#!/usr/bin/env node
// 只执行测试、Worker编译和完整部署目录装配；GitHub与正式版本归工作流。
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,copyFileSync,cpSync,rmSync,realpathSync,rmdirSync,readdirSync,lstatSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tools,releaseMembers} from './config.mjs';
export const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export function claimCache(work){
 const base=join(root,'target/cache'),lock=join(base,'lock');let owned=false;
 try{mkdirSync(base,{recursive:true});if(realpathSync(base)!==base)throw Error('缓存经过链接');mkdirSync(lock);owned=true;
  const cargo=join(base,'rust');mkdirSync(cargo,{recursive:true});if(realpathSync(cargo)!==cargo)throw Error('缓存经过链接');
  return {cargo,project:join(base,'project'),release(){rmdirSync(lock);}};
 }catch{if(owned)rmdirSync(lock);return {cargo:join(work,'rust'),release(){}};}
}
const controller=new AbortController();
async function run(command,args,{cwd=root,env={}}={}){
 controller.signal.throwIfAborted();
 const environment={...process.env,...env};delete environment.GH_TOKEN;delete environment.GITHUB_TOKEN;
 await new Promise((ok,fail)=>{
  const child=spawn(command,args,{cwd,env:environment,detached:process.platform!=='win32',stdio:['ignore',process.stderr,process.stderr]});let error,timer;
  const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);};
  controller.signal.addEventListener('abort',stop,{once:true});child.once('error',value=>{error=value;});
  child.once('close',async(code,signal)=>{
   controller.signal.removeEventListener('abort',stop);
   if(controller.signal.aborted){await new Promise(resolve=>setTimeout(resolve,2100));try{process.kill(-child.pid,0);const failure=Error('子进程退出尚未确认，保留现场');failure.keepWork=true;return fail(failure);}catch(value){if(value.code!=='ESRCH')return fail(value);}}
   clearTimeout(timer);if(child.pid){try{process.kill(-child.pid,0);const failure=Error('工具后代尚未退出，保留现场');failure.keepWork=true;return fail(failure);}catch(value){if(value.code!=='ESRCH')return fail(value);}}
   error||code!==0||signal||controller.signal.aborted?fail(error||Error(basename(command)+'执行失败')):ok();
  });
 });
}
// 所有依赖解析和生成内容留在独占任务工程，正式源码与原锁不变。
export function sourceView(source,output){
 if(realpathSync(source)!==source||resolve(output)!==output||output===source||output.startsWith(source+'/')&&!output.startsWith(join(source,'target')+'/'))throw Error('工程输入输出边界无效');
 if(lstatSync(output,{throwIfNoEntry:false}))throw Error('工程目标已存在');mkdirSync(output);
 for(const name of readdirSync(source))if(!['.git','target','node_modules','.wrangler'].includes(name))cpSync(join(source,name),join(output,name),{recursive:true,preserveTimestamps:true,filter:path=>!['target','node_modules','.wrangler'].includes(basename(path))});return output;
}
export function verifyWorker(directory){
 const js=readFileSync(join(directory,'index.js')),wasm=readFileSync(join(directory,'index_bg.wasm'));
 if(!js.length||!wasm.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])))throw Error('Worker JS或WASM真实产物缺失');
}
export async function build({test=false}={}){
 if(process.versions.node!==tools.node)throw Error('Node版本与本产品声明不一致');
 const parent=join(root,'target',test?'test':'build');mkdirSync(parent,{recursive:true});if(realpathSync(parent)!==parent)throw Error('任务目录经过链接');
 const work=mkdtempSync(join(parent,'cloudflare-')),cache=claimCache(work);let complete=false,safe=true;
 try{
  if(cache.project)rmSync(cache.project,{recursive:true,force:true});
  const project=sourceView(root,cache.project||join(work,'project')),worker=join(work,'worker'),output=join(work,'output');mkdirSync(worker);mkdirSync(output);
  const protocol=process.env.TATACHATSDK_PROTOCOL_DIR,protoc=process.env.PROTOC;
  if(!protocol?.startsWith('/')||!protoc?.startsWith('/'))throw Error('须交付锁定SDK协议目录和官方protoc绝对路径');
  const env={RUSTUP_TOOLCHAIN:tools.rust,CARGO_TARGET_DIR:cache.cargo,CARGO_INCREMENTAL:'1',TATACHATSDK_PROTOCOL_DIR:protocol,PROTOC:protoc};
  if(test){
   await run('cargo',['test','--workspace','--locked'],{cwd:project,env});
   await run(process.execPath,['--test','scripts/publish.mjs','test/build.test.mjs'],{cwd:project,env});
  }
  await run('worker-build',['--out-dir',worker,'--release','--','--locked'],{cwd:join(project,'cloudflare'),env});verifyWorker(worker);
  if(test){
   await run('npm',['ci','--prefer-offline','--no-audit','--no-fund'],{cwd:join(project,'test/worker'),env});
   await run(process.execPath,['--test','test/worker/worker_smoke.mjs','test/worker/tatachat_smoke.mjs','test/worker/tatachat_data_smoke.mjs'],{cwd:project,env:{...env,CITIZENSERVE_TEST_WORKER_DIR:worker,CITIZENSERVE_TEST_WORK_DIR:work,CITIZENSERVE_TEST_PROJECT_DIR:project}});
  }
  for(const name of releaseMembers){const path=join(output,name);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(name.startsWith('index')?worker:root,name),path);}
  for(const name of readdirSync(work))if(name!=='output')rmSync(join(work,name),{recursive:true,force:true});complete=true;return {work,output};
 }catch(error){safe=!error.keepWork;throw error;}finally{if(safe){cache.release();if(!complete)rmSync(work,{recursive:true,force:true});}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&!process.env.NODE_TEST_CONTEXT){
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
 try{if(process.argv.length>3||process.argv[2]&&!['test'].includes(process.argv[2]))throw Error('用法：node scripts/build.mjs [test]');console.log(JSON.stringify(await build({test:process.argv[2]==='test'})));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
