#!/usr/bin/env node
// 本仓塔塔门禁只读核对仓库、目录、声明和流程边界；产品测试由所属流程执行。
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const repository="crcfrcn/citizenserve";
const scripts=Object.freeze(["build.mjs", "publish.mjs", "tatachat.mjs"]);
const required=Object.freeze(["CitizenServe.md", "Cargo.lock"]);
const fail=message=>{throw Error('本仓只读门禁：'+message);};
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:1024*1024}).trim();
function file(relative){
 if(typeof relative!=='string'||!relative||isAbsolute(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))fail('登记路径无效');
 const path=join(root,relative),info=lstatSync(path);
 if(!info.isFile()||info.isSymbolicLink()||!info.size||realpathSync(path)!==path)fail('登记文件缺失或经过链接：'+relative);
 return readFileSync(path,'utf8');
}
function exact(relative,names){
 const path=join(root,relative),info=lstatSync(path);
 if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(path)!==path)fail('目录身份无效：'+relative);
 if(JSON.stringify(readdirSync(path).sort())!==JSON.stringify([...names].sort()))fail('目录闭集无效：'+relative);
}
function syntax(relative){
 const result=spawnSync(process.execPath,['--check',join(root,relative)],{encoding:'utf8',maxBuffer:1024*1024});
 if(result.error||result.signal||result.status!==0)fail('Node语法无效：'+relative);
}
function sourceInventory(contract){
 if(!Array.isArray(contract.node_tests)||!Array.isArray(contract.functions))fail('门禁登记不是完整列表');
 for(const name of contract.node_tests){file(name);if(name.endsWith('.mjs'))syntax(name);}
 for(const entry of contract.functions){if(!entry||typeof entry.path!=='string')fail('功能登记无路径');file(entry.path);}
}
function checkPublicSource(){
 const forbidden=Buffer.from('f09f87a8f09f87b3','hex');
 const names=git('ls-files','-z','--cached','--others','--exclude-standard').split('\0').filter(Boolean);
 for(const name of names){
  if(name.split('/').some(part=>!part||part==='.'||part==='..'))fail('受检文件路径越界');
  const path=join(root,name);if(!existsSync(path))continue;
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail('受检文件类型无效：'+name);
  const bytes=readFileSync(path);if(bytes.includes(forbidden))fail('文件含禁用字符：'+name);
  if(bytes.includes(0))continue;
  const source=bytes.toString('utf8');
  if(/AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]{16,}/u.test(source)
   ||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]{32,})/u.test(source))fail('文件疑似含机密：'+name);
  if(/\.(?:mjs|js|rs|py|sh|ts|tsx)$/u.test(name)&&!/(?:^|\/)(?:test|tests|vendor)\//u.test(name)
   &&name!=='.github/tatagate/tatagate.mjs'&&/(?:http|ws):\/\//u.test(source))fail('第一方源码含明文网络地址：'+name);
 }
}
export function checkRepository(){
 if(realpathSync(root)!==root||git('rev-parse','--show-toplevel')!==root||git('branch','--show-current')!=='main'
  ||git('remote','get-url','origin')!=='https://github.com/'+repository+'.git')fail('正式主检出或HTTPS来源不符');
 const contract=JSON.parse(file('.github/tatagate/tatagate.json'));
 if(contract.schema!==1||contract.repository!==repository.split('/')[1]
  ||contract.github_repository&&contract.github_repository!==repository
  ||JSON.stringify(contract.checks)!==JSON.stringify(['repository-contracts','flow-isolation','syntax'])
  ||!Array.isArray(contract.workflows)||!contract.workflows.length||new Set(contract.workflows).size!==contract.workflows.length)fail('本仓门禁声明无效');
 exact('scripts',scripts);
 exact('.github/tatagate',['tatagate.json','tatagate.mjs']);
 exact('.github/workflows',contract.workflows.flatMap(name=>[name,name.replace(/\.yml$/u,'.mjs')]));
 for(const name of required)file(name);
 const build=file('scripts/build.mjs'),publish=file('scripts/publish.mjs');
 if(/\.github\/tatagate\//u.test(build)||/(?:from|import\()\s*['"][^'"]*(?:publish\.mjs|\.github\/workflows)/u.test(build))fail('Build读取其它流程');
 if(/(?:from|import\()\s*['"][^'"]*(?:build\.mjs|\.github\/tatagate)/u.test(publish))fail('Publish调用其它流程');
 for(const name of contract.workflows){
  if(typeof name!=='string'||!/^release-[a-z0-9-]+\.yml$/u.test(name))fail('Workflow身份无效');
  const yaml=file('.github/workflows/'+name),entry='.github/workflows/'+name.replace(/\.yml$/u,'.mjs'),workflow=file(entry);
  if(!yaml.includes('workflow_dispatch:')||/^\s*push\s*:/mu.test(yaml))fail('自动化不得随推送派发');
  if(/scripts\/(?:build|publish)\.mjs|\.github\/tatagate\//u.test(workflow))fail('自动化调用其它流程');
  syntax(entry);
 }
 sourceInventory(contract);
 checkPublicSource();
 const cargo=file('Cargo.toml');
 if(!/^\[package\.metadata\.citizenserve_automation\]$/mu.test(cargo)
  ||!/^release_members = '''[^']+'''$/mu.test(cargo)
  ||!/^linux_tool_sources = '''[^']+'''$/mu.test(cargo))fail('产品自动化声明缺失');
 syntax('scripts/build.mjs');syntax('scripts/publish.mjs');syntax('.github/tatagate/tatagate.mjs');
 return {schema:1,product_id:contract.repository,checks:contract.checks,status:'passed'};
}
function main(args){
 const mode=args[0];
 if(mode==='physical'&&args.length===2){if(resolve(args[1])!==root)fail('门禁物理根无效');return checkRepository();}
 if(mode==='local'&&args.length===5){
  const [_,source,base,head,work]=args;
  if(source!==root||!isAbsolute(work)||resolve(work)!==work||!work.startsWith(join(root,'target')+sep)
   ||!/^[a-f0-9]{40}$/u.test(base)||!/^[a-f0-9]{40}$/u.test(head)||git('rev-parse','HEAD')!==head)fail('只读门禁任务坐标无效');
  const ancestor=spawnSync('git',['-C',root,'merge-base','--is-ancestor',base,head]);
  if(ancestor.error||ancestor.status!==0)fail('受检提交范围无效');
  return checkRepository();
 }
 if(mode==='check'&&args.length===1)return checkRepository();
 fail('只读门禁命令无效');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(JSON.stringify(main(process.argv.slice(2)))+'\n');}
 catch(error){process.stderr.write(String(error?.message||error)+'\n');process.exitCode=1;}
}
