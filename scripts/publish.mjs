#!/usr/bin/env node
// 公民服务发布独立消费成功自动化资产，执行既有Worker上传与部署回读；不创建Release或重建云资源。
import {createHash} from 'node:crypto';
import {automationDisplayName} from './config.mjs';
import {gunzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile,realpath,lstat,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

const repository='crcfrcn/citizenserve',workflow='.github/workflows/cloudflare.yml';
const assets=['citizenserve-cloudflare-release.tgz','release-manifest.json','SHA256SUMS'];
// 所属测试入口只交付本仓实际变更覆盖的Node回归，不要求先编译Worker产物。
// 发布包成员只读取本仓既有Cargo声明，不维护第二份清单。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dynamicPublicNames as runtimeVariables,workerSecretNames as requiredSecretNames,validateDynamicPublic,describeConfiguration} from './config.mjs';
const releaseDeclaration=readFileSync(fileURLToPath(new URL('../Cargo.toml',import.meta.url)),'utf8');
const releaseMembers=/^release_members = '''([^']+)'''/mu.exec(releaseDeclaration);
if(!releaseMembers)throw Error('CitizenServe发布成员声明缺失');
const packageFiles=Object.freeze(JSON.parse(releaseMembers[1]));
const fail=message=>{throw Error('CitizenServe发布：'+message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const allowedSections=new Set(['secrets','d1_databases','ratelimits','ratelimits.simple','triggers','vars','r2_buckets','kv_namespaces','queues.producers','queues.consumers','durable_objects','migrations']);

// 仅解析本产品发布配置使用的简单字段；完整TOML语义留给锁定Wrangler预演再验。
function sections(source){
 if(typeof source!=='string'||source.length>65536||source.includes('\r'))fail('Wrangler配置来源无效');
 const result=new Map();let current='root';result.set(current,['']);
 for(const line of source.split('\n')){
  const header=/^\s*(\[\[|\[)([a-z0-9_]+(?:\.[a-z0-9_]+)*)(\]\]|\])\s*$/u.exec(line);
  if(header){if((header[1]==='[[')!==(header[3]===']]')||!allowedSections.has(header[2]))fail('Wrangler分节无效');current=header[2];const blocks=result.get(current)??[];blocks.push('');result.set(current,blocks);continue;}
  if(line.trimStart().startsWith('['))fail('Wrangler分节语法无效');
  const blocks=result.get(current);blocks[blocks.length-1]+=line+'\n';
 }
 return result;
}
function one(block,key){
 const pattern=new RegExp('^'+key.replaceAll('.','\\.')+'\\s*=\\s*(.+?)\\s*$','gmu');
 const values=[...block.matchAll(pattern)].map(match=>match[1]);
 if(values.length!==1)fail('Wrangler字段缺失或重复：'+key);
 return values[0];
}
function string(block,key){const raw=one(block,key);if(!/^"[^"\n]*"$/u.test(raw))fail('Wrangler字符串字段无效：'+key);return JSON.parse(raw);}
function blocks(value,name,count){const rows=value.get(name)??[];if(rows.length!==count)fail('Wrangler分节数量无效：'+name);return rows;}
function exactKeys(value,expected,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...expected].sort().join('\0'))fail(label+'字段缺失或越界');}
function publicationConfiguration(source,publicValues){
 const value=sections(source),root=blocks(value,'root',1)[0],vars=blocks(value,'vars',1)[0];
 if(string(root,'name')!=='citizenserve'||string(root,'main')!=='../../target/build/cloudflare/worker/index.js'
  ||string(root,'compatibility_date')!=='2026-10-07'
  ||one(root,'compatibility_flags')!=='["no_nodejs_global_timers"]'
  ||one(root,'workers_dev')!=='false'||one(root,'preview_urls')!=='false')fail('Worker部署身份无效');
 if(one(root,'routes')!=='[{ pattern = "www.crcfrcn.com/api/*", zone_name = "crcfrcn.com" }, { pattern = "nrcrpc.crcfrcn.com", custom_domain = true }, { pattern = "media.crcfrcn.com/square/*", zone_name = "crcfrcn.com" }]')fail('Worker公开路由越界');
 const secretBlock=blocks(value,'secrets',1)[0];let secretNames;try{secretNames=JSON.parse(one(secretBlock,'required'));}catch{fail('必需Secret声明无效');}
 if(!Array.isArray(secretNames)||secretNames.length!==requiredSecretNames.length||new Set(secretNames).size!==secretNames.length
  ||secretNames.some(name=>typeof name!=='string'||!/^\w+$/u.test(name))
  ||secretNames.slice().sort().join('\0')!==requiredSecretNames.slice().sort().join('\0'))fail('必需Secret名称越界');
 for(const name of runtimeVariables)if(string(vars,name)!=='')fail('动态公开变量不得在正式资产中固化：'+name);
 if(string(vars,'WEB_ORIGIN')!=='https://www.crcfrcn.com'||string(vars,'REGISTRATION_SCOPE')!=='citizenserve:production'
  ||string(vars,'TATACHAT_QUEUE_NAME')!=='citizenserve-tatachat'||string(vars,'SQUARE_PUBLIC_MEDIA_BASE_URL')!=='https://media.crcfrcn.com'
  ||string(vars,'RELAY_ENABLED')!=='0')fail('静态生产变量越界');
 const variables=validateDynamicPublic(publicValues);
 const expectedD1={DB:'citizenserve',TATACHAT_DB:'citizenserve-tatachat'};
 const d1=Object.fromEntries(blocks(value,'d1_databases',Object.keys(expectedD1).length).map(block=>[string(block,'binding'),{name:string(block,'database_name'),id:string(block,'database_id')}]));
 exactKeys(d1,Object.keys(expectedD1),'D1绑定');
 for(const [binding,name] of Object.entries(expectedD1))if(d1[binding].name!==name||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(d1[binding].id))fail('D1绑定无效：'+binding);
 const expectedR2={SQUARE_PRIVATE:'citizenserve-private',SQUARE_PUBLIC_MEDIA:'citizenserve-media',TATACHAT_ATTACHMENTS:'citizenserve-tatachat'};
 const r2=Object.fromEntries(blocks(value,'r2_buckets',3).map(block=>[string(block,'binding'),string(block,'bucket_name')]));
 exactKeys(r2,Object.keys(expectedR2),'R2绑定');for(const [binding,name] of Object.entries(expectedR2))if(r2[binding]!==name)fail('R2绑定无效：'+binding);
 const kvBlock=blocks(value,'kv_namespaces',1)[0];if(string(kvBlock,'binding')!=='SQUARE_CACHE'||!/^[a-f0-9]{32}$/u.test(string(kvBlock,'id')))fail('KV绑定无效');
 const expectedQueues={NOTIFY:'citizenserve',TATACHAT_PUSH:'citizenserve-tatachat'};
 const producers=Object.fromEntries(blocks(value,'queues.producers',2).map(block=>[string(block,'binding'),string(block,'queue')]));
 exactKeys(producers,Object.keys(expectedQueues),'Queue生产者');for(const [binding,name] of Object.entries(expectedQueues))if(producers[binding]!==name)fail('Queue生产者无效：'+binding);
 const consumers=Object.fromEntries(blocks(value,'queues.consumers',2).map(block=>[string(block,'queue'),{batch:one(block,'max_batch_size'),retries:one(block,'max_retries')}]));
 exactKeys(consumers,Object.values(expectedQueues),'Queue消费者');
 if(consumers.citizenserve.batch!=='1'||consumers.citizenserve.retries!=='3'
  ||consumers['citizenserve-tatachat'].batch!=='1'||consumers['citizenserve-tatachat'].retries!=='5')fail('Queue消费者策略无效');
 const rates=blocks(value,'ratelimits',3),ratePolicies=blocks(value,'ratelimits.simple',3);
 const expectedRates={RATE_AUTH:10,RATE_READ:120,RATE_WRITE:30};
 const rateNames=rates.map(block=>string(block,'name')),rateIds=rates.map(block=>string(block,'namespace_id'));
 if(new Set(rateNames).size!==3||rateNames.some(name=>!(name in expectedRates))||new Set(rateIds).size!==3)fail('限速绑定无效');
 for(let i=0;i<rates.length;i++)if(!/^\d{1,8}$/u.test(string(rates[i],'namespace_id'))
  ||one(ratePolicies[i],'limit')!==String(expectedRates[rateNames[i]])||one(ratePolicies[i],'period')!=='60')fail('限速策略无效');
 if(one(blocks(value,'triggers',1)[0],'crons')!=='["*/5 * * * *", "4 3 * * *"]')fail('定时触发器无效');
 const durable=blocks(value,'durable_objects',1)[0],migration=blocks(value,'migrations',1)[0];
 if(one(durable,'bindings')!=='[{ name = "TATACHAT_DEVICES", class_name = "TataChatDevice" }]'
  ||string(migration,'tag')!=='tatachat-1'||one(migration,'new_sqlite_classes')!=='["TataChatDevice"]')fail('SQLite Durable Object声明无效');
 const account_id=string(vars,'CF_ACCOUNT_ID');if(!/^[a-f0-9]{32}$/u.test(account_id)||variables.ZONE_ID===account_id)fail('Cloudflare账户或Zone身份无效');
 return {worker:'citizenserve',account_id,zone_id:variables.ZONE_ID,routes:['www.crcfrcn.com/api/*','nrcrpc.crcfrcn.com','media.crcfrcn.com/square/*'],secret_names:secretNames,
  public_var_names:runtimeVariables,d1,r2,kv:{SQUARE_CACHE:string(kvBlock,'id')},queues:producers,durable_object:'TataChatDevice',migration:'tatachat-1'};
}
async function pages(path,field,request){
 const rows=[];
 for(let page=1;page<=10000;page++){
  const value=await request(path+'?per_page=100&page='+page),items=field?value?.[field]:value;
  if(!Array.isArray(items)||items.length>100)fail('公开分页无效');
  rows.push(...items);if(items.length<100)return rows;
 }
 fail('公开分页未结束');
}

// 归档只在内存中核对公开清单；不解包写文件，不接受链接、重复或越界条目。
function inspectArchive(bytes,records,retain=false){
 let tar;try{tar=gunzipSync(bytes,{maxOutputLength:256*1024**2});}catch{fail('正式Worker归档无效');}
 const expected=new Map(records.map(record=>[record.path,record])),seen=new Set(),contents=new Map();let at=0,ended=false;
 const text=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\0')[0];
 while(at+512<=tar.length){
  const header=tar.subarray(at,at+512);
  if(header.every(value=>value===0)){if(!tar.subarray(at).every(value=>value===0))fail('归档尾部无效');ended=true;break;}
  let name,size,checksum;
  try{name=text(header.subarray(0,100));const count=text(header.subarray(124,136)).trim(),sum=text(header.subarray(148,156)).trim();
   if(!/^[0-7]+$/u.test(count)||!/^[0-7]+$/u.test(sum))fail('归档数字无效');size=parseInt(count,8);checksum=parseInt(sum,8);
  }catch{fail('归档头无效');}
  if(header[156]!==48||text(header.subarray(257,263))!=='ustar'||header.subarray(345,500).some(value=>value!==0)
   ||!name||name.startsWith('/')||/[\\\x00-\x1f]/u.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')
   ||seen.has(name)||!expected.has(name))fail('归档条目越界、重复或未登记');
  const sum=[...header].reduce((total,value,index)=>total+(index>=148&&index<156?32:value),0);
  if(sum!==checksum||!Number.isSafeInteger(size)||size<1||at+512+size>tar.length)fail('归档头或长度不一致');
  const body=tar.subarray(at+512,at+512+size),record=expected.get(name);
  if(size!==record.bytes||hash(body)!==record.sha256)fail('归档内容与公开清单不一致');
  seen.add(name);if(retain)contents.set(name,Buffer.from(body));at+=512+Math.ceil(size/512)*512;
 }
 if(!ended||tar.length%512||seen.size!==expected.size)fail('归档内容不完整');
 return contents;
}

async function inspectCandidate({run,release,readTag,readAsset,includeContents=false}){
 if(run?.path!==workflow||run.repository?.full_name!==repository||run.head_branch!=='main'
  ||run.event!=='workflow_dispatch'||run.status!=='completed'||run.conclusion!=='success'
  ||!positive(run.id)||!positive(run.run_attempt)||!/^[a-f0-9]{40}$/u.test(run.head_sha||''))fail('成功自动化身份无效');
 const match=/^公民服务端·Cloudflare·v(\d+\.\d+\.\d+)$/u.exec(release?.tag_name||'');
 let automationProof;try{automationProof=JSON.parse(/^<!-- automation:(\{[^\n]*\}) -->$/m.exec(release?.body||'')?.[1]||'null');}catch{fail('正式版本证明无效');}
 if(!match||automationProof?.run_id!==run.id||automationProof?.run_attempt!==run.run_attempt||!positive(release.id)
  ||release.draft||release.prerelease||release.target_commitish!==run.head_sha||!Array.isArray(release.assets)
  ||release.assets.length!==assets.length)fail('正式Release身份无效');
 const tag=await readTag(release.tag_name);
 if(tag?.ref!=='refs/tags/'+release.tag_name||tag.object?.type!=='commit'||tag.object.sha!==run.head_sha)fail('正式Tag源码不一致');
 const loaded=new Map(),assetProof=[];
 for(const name of assets){
  const rows=release.assets.filter(asset=>asset?.name===name);if(rows.length!==1)fail('正式资产缺失或重复');
  const asset=rows[0];
  if(!positive(asset.id)||!positive(asset.size)||asset.state!=='uploaded'||!sha(asset.digest?.slice(7))
   ||asset.digest!=='sha256:'+asset.digest.slice(7)||asset.size>(name.endsWith('.tgz')?256*1024**2:1024*1024))fail('正式资产证明无效');
  if(asset.url!==`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`)fail('正式资产读取来源无效');
  const stream=await readAsset(asset),chunks=[];let size=0;
  if(!stream||typeof stream[Symbol.asyncIterator]!=='function')fail('正式资产读取通道无效');
  for await(const chunk of stream){if(!(chunk instanceof Uint8Array))fail('正式资产字节无效');size+=chunk.length;if(size>asset.size)fail('正式资产超限');chunks.push(Buffer.from(chunk));}
  const bytes=Buffer.concat(chunks);if(size!==asset.size||hash(bytes)!==asset.digest.slice(7))fail('正式资产回读不一致');
  loaded.set(name,bytes);assetProof.push({name,asset_id:asset.id,bytes:size,sha256:hash(bytes)});
 }
 let manifest;try{manifest=JSON.parse(loaded.get('release-manifest.json'));}catch{fail('正式清单不是JSON');}
 if(manifest.schema!==1||manifest.product_id!=='citizenserve'||manifest.platform!=='cloudflare'
  ||manifest.software_version!==match[1]||manifest.source_sha!==run.head_sha||manifest.producer_run_id!==run.id
  ||manifest.producer_run_attempt!==run.run_attempt||!Array.isArray(manifest.assets)||manifest.assets.length!==packageFiles.length)fail('正式Run清单身份无效');
 const seen=new Set();for(const record of manifest.assets){
  if(!packageFiles.includes(record?.path)||seen.has(record.path)||!positive(record.bytes)||!sha(record.sha256))fail('正式包内容登记无效');seen.add(record.path);
 }
 const sums=loaded.get('SHA256SUMS').toString('utf8');
 if(sums!==hash(loaded.get(assets[0]))+'  '+assets[0]+'\n'+hash(loaded.get(assets[1]))+'  '+assets[1]+'\n')fail('正式资产摘要表不一致');
 const contents=inspectArchive(loaded.get(assets[0]),manifest.assets,includeContents);
 const proof={schema:1,product_id:'citizenserve',platform:'cloudflare',version:match[1],source_sha:run.head_sha,
  run_id:run.id,run_attempt:run.run_attempt,release_id:release.id,tag:release.tag_name,assets:assetProof};
 return includeContents?{proof,contents}:proof;
}

async function selectedPublication(request,includeContents){
 const runs=await pages('actions/runs','workflow_runs',request),releases=await pages('releases',null,request);
 const success=runs.filter(run=>run?.path===workflow&&run.repository?.full_name===repository&&run.head_branch==='main'
  &&run.event==='workflow_dispatch'&&run.status==='completed'&&run.conclusion==='success');
 if(!success.length)fail('缺少成功自动化');
 success.sort((a,b)=>b.id-a.id);if(success.length>1&&success[0].id===success[1].id)fail('最新成功自动化不唯一：存在重复成功');
 const run=success[0],suffix='-r'+run.id+'-a'+run.run_attempt;
 const release=releases.filter(value=>{try{const proof=JSON.parse(/^<!-- automation:(\{[^\n]*\}) -->$/m.exec(value?.body||'')?.[1]||'null');return value?.tag_name===automationDisplayName('cloudflare',proof?.version||'')&&proof?.run_id===run.id&&proof?.run_attempt===run.run_attempt;}catch{return false;}});
 if(release.length!==1)fail('成功自动化缺少唯一Release');
 return inspectCandidate({run,release:release[0],readTag:tag=>request('git/ref/tags/'+encodeURIComponent(tag)),readAsset:async asset=>(await request(asset.url,{raw:true}))?.body,includeContents});
}
export async function preparePublication({request=publicRequest}={}){return selectedPublication(request,false);}

// 公开运行值由产品唯一声明解码；原生层只交付当前产品已保存的公开值。

function renderedDeploymentConfig(contents,publicValues){
 let config;try{config=new TextDecoder('utf-8',{fatal:true}).decode(contents.get('server/cloudflare/wrangler.toml'));}catch{fail('正式Wrangler配置编码无效');}
 const candidate=publicationConfiguration(config,publicValues);
 for(const name of runtimeVariables){const line=new RegExp('^'+name+' = ""$','gmu');
  if([...config.matchAll(line)].length!==1)fail('正式配置动态变量边界无效：'+name);
  config=config.replace(line,name+' = '+JSON.stringify(publicValues[name]));
 }
 return {candidate,bytes:Buffer.from(config,'utf8')};
}
// 候选只读核对正式资产与最终部署配置；不输出运行值或执行上传。
export async function prepareDeployment({request=publicRequest,publicValues}={}){
 if(publicValues===undefined)fail('缺少公开部署配置来源');
 const {proof,contents}=await selectedPublication(request,true);
 const {candidate,bytes}=renderedDeploymentConfig(contents,publicValues);
 const {zone_id:_verifiedZoneId,...publicCandidate}=candidate;
 return {schema:1,product_id:'citizenserve',platform:'cloudflare',operation:'deployment-candidate',publication:proof,
  config_sha256:hash(bytes),...publicCandidate};
}

// 正式包仍由本产品验真；任务现场只物化部署实际使用的Worker与锁定Wrangler。

// 产品拥有工具执行、云请求及失败回执；凭据只驻留本轮内存，不写入命令行或日志。
async function runTool(command,args,cwd,environment,signal,{input,protectedValues=[],timeout=300000}={}){
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env:environment,detached:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
  let output='',diagnostic='',failure,timer,forced;
  const stop=()=>{try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')failure??=error;}
   forced??=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},5000);forced.unref();};
  const abort=()=>{failure??=signal.reason??Error('发布已取消');stop();};
  child.stdout.on('data',chunk=>{if(!protectedValues.length)output=(output+chunk.toString('utf8')).slice(-65536);});
  child.stderr.on('data',chunk=>{if(!protectedValues.length)diagnostic=(diagnostic+chunk.toString('utf8')).slice(-4096);});
  child.once('error',error=>{failure??=error;});
  child.once('close',(code,termination)=>{
   clearTimeout(timer);clearTimeout(forced);signal?.removeEventListener('abort',abort);
   if(child.pid){try{process.kill(-child.pid,0);failure??=Error('发布工具后代未退出');process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')failure??=error;}}
   if(failure||code!==0||termination){
    const detail=protectedValues.length?'':diagnostic.replace(/[\x00-\x1f\x7f]/gu,' ').slice(-1024);
    const error=Error('发布工具失败：'+(failure?.code??code)+'，信号='+(termination||'无')+(failure?'；'+(failure.code||failure.message):'')+(detail?'；'+detail:''),{cause:failure});
    reject(error);
   }else resolve(output);
  });
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  timer=setTimeout(()=>{failure??=Error('发布工具超时');stop();},timeout);timer.unref();
  if(input!==undefined){child.stdin.on('error',error=>{failure??=error;stop();});child.stdin.end(input);}
 });
}
async function publicationFile(work,name,maximum=128*1024**2){
 const path=join(work,name),info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||await realpath(path)!==path||info.size<1||info.size>maximum)fail('发布现场成员无效：'+name);
 return readFile(path);
}
function deploymentCredentials(credentials,{secrets=false}={}){
 if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)
  ||Object.keys(credentials).sort().join('\0')!==(secrets?['account','secrets','token']:['account','token']).join('\0')
  ||!/^[a-f0-9]{32}$/u.test(credentials.account||'')||typeof credentials.token!=='string'||credentials.token.length<20
  ||/[\s\x00-\x1f\x7f]/u.test(credentials.token))fail('本轮部署凭据无效');
 return credentials;
}
async function cloudflareJSON(account,token,path,{request=fetch,signal}={}){
 const response=await request('https://api.cloudflare.com/client/v4/accounts/'+account+'/'+path,
  {method:'GET',redirect:'error',credentials:'omit',headers:{Authorization:'Bearer '+token},
   signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
 if(!response.ok)fail('Cloudflare公开回读失败（HTTP '+response.status+'）');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>4*1024**2)fail('Cloudflare回读超限');chunks.push(chunk);}
 let value;try{value=JSON.parse(Buffer.concat(chunks));}catch{fail('Cloudflare回读JSON无效');}
 if(value?.success!==true)fail('Cloudflare回读未确认成功');return value.result;
}

// 发布阶段的资源策略与验收归本产品，供应端不补来源或选择离线策略。
export async function publishTools(){
 const version='25.2.1';if(process.version!=='v'+version)fail('发布入口必须使用本产品锁定Node '+version);
 return {node:{version,path:process.execPath}};
}
function approvedArchiveDigest(proof,candidate){
 const name='citizenserve-cloudflare-release.tgz';
 const approved=proof.assets?.filter(value=>value.name===name),actual=candidate.assets?.filter(value=>value.name===name);
 if(approved?.length!==1||actual?.length!==1||!/^[a-f0-9]{64}$/u.test(approved[0].sha256||'')
   ||actual[0].sha256!==approved[0].sha256)fail('冷签批准的正式资产摘要在部署前改变');
 return approved[0].sha256;
}

// 产品独立拥有密钥装配、Worker上传和实际部署验收；外部调度只交付本轮凭据。
export async function deployCloudflare(payload,credentials,{signal,invoke=runTool,request=fetch,now=Date.now}={}){
 signal?.throwIfAborted();
 const keys=['schema','product_id','platform','run_id','release_tag','source_sha','config_sha256','work','node_path'];
 if(payload&&Object.hasOwn(payload,'archive_sha256'))keys.push('archive_sha256');exactKeys(payload,keys,'Worker执行身份');
 if(payload.schema!==1||payload.product_id!=='citizenserve'||payload.platform!=='cloudflare'||!/^[1-9][0-9]{8}$/u.test(payload.run_id||'')
  ||!/^公民服务端·Cloudflare·v\d+\.\d+\.\d+$/u.test(payload.release_tag||'')
  ||!/^[a-f0-9]{40}$/u.test(payload.source_sha||'')||!sha(payload.config_sha256)
  ||Object.hasOwn(payload,'archive_sha256')&&!sha(payload.archive_sha256))fail('Worker执行身份无效');
 const {work,node_path:node}=payload,base=fileURLToPath(new URL('../target/publish/cloudflare/',import.meta.url));
 if(typeof work!=='string'||!work.startsWith(base+payload.run_id+'-')||await realpath(work)!==work
  ||typeof node!=='string'||!node.startsWith('/')||await realpath(node)!==node||!(await lstat(node)).isFile())fail('Worker执行现场无效');
 const {account,token,secrets}=deploymentCredentials(credentials,{secrets:true});exactKeys(secrets,requiredSecretNames,'Worker密钥');
 if(Object.values(secrets).some(value=>typeof value!=='string'||!value||Buffer.byteLength(value)>64*1024))fail('Worker密钥格式无效');
 const config=await publicationFile(work,'server/cloudflare/wrangler.toml',65536);if(hash(config)!==payload.config_sha256)fail('批准后Worker配置发生变化');
 const rendered=new TextDecoder('utf-8',{fatal:true}).decode(config),vars=blocks(sections(rendered),'vars',1)[0];
 const publicValues=Object.fromEntries(runtimeVariables.map(name=>[name,string(vars,name)]));let template=rendered;
 for(const name of runtimeVariables){const pattern=new RegExp('^'+name+' = .+$','gmu');if([...template.matchAll(pattern)].length!==1)fail('Worker动态配置边界无效');template=template.replace(pattern,name+' = ""');}
 const configuration=publicationConfiguration(template,publicValues);if(configuration.account_id!==account)fail('Worker部署账户不一致');
 await publicationFile(work,'target/build/cloudflare/worker/index.js');await publicationFile(work,'target/build/cloudflare/worker/index_bg.wasm');
 const lock=JSON.parse(await publicationFile(work,'test/worker/package-lock.json'));
 if(lock.packages?.['']?.devDependencies?.wrangler!=='4.149.0')fail('Worker执行Wrangler锁无效');
 const wrangler=join(work,'test/worker/node_modules/wrangler/bin/wrangler.js');await publicationFile(work,'test/worker/node_modules/wrangler/bin/wrangler.js');
 const environment={PATH:dirname(node)+':/usr/bin:/bin',HOME:work,CI:'1',WRANGLER_SEND_METRICS:'false'};
 if((await invoke(node,['--version'],work,environment,signal)).trim()!=='v25.2.1')fail('Worker执行Node不符合产品锁');
 const privateEnvironment={...environment,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account},protectedValues=[token,...Object.values(secrets)];
 signal?.throwIfAborted();
 await invoke(node,[wrangler,'secret','bulk','--config',join(work,'server/cloudflare/wrangler.toml')],work,privateEnvironment,signal,{input:JSON.stringify(secrets),protectedValues});
 const started=now();
 await invoke(node,[wrangler,'deploy','--no-bundle','--config',join(work,'server/cloudflare/wrangler.toml')],work,privateEnvironment,signal,{protectedValues});
 const result=await cloudflareJSON(account,token,'workers/scripts/citizenserve/deployments?per_page=1',{request,signal});
 const latest=result?.deployments?.[0],versions=latest?.versions;
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(latest?.id||'')||!Number.isFinite(Date.parse(latest.created_on))||Date.parse(latest.created_on)<started-30000
  ||!Array.isArray(versions)||versions.length!==1||versions[0].percentage!==100||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(versions[0].version_id||''))fail('Worker部署后身份回读失败');
 return {product_id:'citizenserve',platform:'cloudflare',worker:'citizenserve',release_tag:payload.release_tag,source_sha:payload.source_sha,config_sha256:payload.config_sha256,
  ...(payload.archive_sha256?{archive_sha256:payload.archive_sha256}:{}),deployed:true,deployment_id:latest.id,version_id:versions[0].version_id};
}

export async function publishCloudflare({proof,configSHA,runID,nodePath=process.execPath,publicValues,credentials,deploy=payload=>deployCloudflare(payload,credentials,{signal}),signal,beforeDeploy,request=publicRequest}={}){
 if(!proof||proof.product_id!=='citizenserve'||proof.platform!=='cloudflare'||!positive(proof.run_id)
  ||typeof runID!=='string'||!/^[1-9][0-9]{8}$/u.test(runID)||typeof deploy!=='function'
  ||typeof nodePath!=='string'||!nodePath.startsWith('/')||!sha(configSHA))fail('发布任务身份无效');
 const candidate=await selectedPublication(request,true);
 if(candidate.proof.tag!==proof.tag||candidate.proof.source_sha!==proof.source_sha||candidate.proof.run_id!==proof.run_id)fail('正式产物在授权后发生变化');
 const archiveSHA=approvedArchiveDigest(proof,candidate.proof);
 const {bytes:config}=renderedDeploymentConfig(candidate.contents,publicValues);
 if(hash(config)!==configSHA)fail('冷签批准后公开运行配置发生变化');
 const base=join(fileURLToPath(new URL('../target/publish/cloudflare/',import.meta.url)));
 await mkdir(base,{recursive:true,mode:0o700});const work=await mkdtemp(join(base,runID+'-'));
 try{
  for(const name of ['index.js','index_bg.wasm','server/cloudflare/wrangler.toml','test/worker/package-lock.json']){
   const bytes=name==='server/cloudflare/wrangler.toml'?config:candidate.contents.get(name);
   if(!bytes)fail('正式包缺少部署成员：'+name);
   const path=join(work,name.startsWith('index')?'target/build/cloudflare/worker/'+name:name);
   await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{flag:'wx',mode:0o600});
  }
  const lock=JSON.parse(candidate.contents.get('test/worker/package-lock.json'));
  const packages=lock.packages?.[''];if(!packages||packages.devDependencies?.wrangler!=='4.149.0')fail('正式包Wrangler锁无效');
  const packageJSON={name:packages.name??'citizenserve-publish',private:true,type:'module',devDependencies:packages.devDependencies};
  await writeFile(join(work,'test/worker/package.json'),JSON.stringify(packageJSON),{flag:'wx',mode:0o600});
  const environment={PATH:[dirname(nodePath),'/usr/bin','/bin'].join(':'),HOME:work,
   npm_config_cache:join(work,'npm-cache'),CI:'1'};
  const npmCLI=join(dirname(nodePath),'../lib/node_modules/npm/bin/npm-cli.js');
  await runTool(nodePath,[npmCLI,'ci','--ignore-scripts','--no-audit','--no-fund'],join(work,'test/worker'),environment,signal);
  signal?.throwIfAborted();beforeDeploy?.();
  const payload={schema:1,product_id:'citizenserve',platform:'cloudflare',run_id:runID,
   release_tag:proof.tag,source_sha:proof.source_sha,archive_sha256:archiveSHA,config_sha256:configSHA,
   work,node_path:nodePath};
  const result=await deploy(payload);
  if(result?.product_id!=='citizenserve'||result?.platform!=='cloudflare'||result?.release_tag!==proof.tag
   ||result?.source_sha!==proof.source_sha||result?.archive_sha256!==archiveSHA||result?.config_sha256!==configSHA
   ||result?.worker!=='citizenserve'||result?.deployed!==true)fail('Cloudflare部署回执无效');
  return result;
 }finally{await rm(work,{recursive:true,force:true});}
}

// GitHub候选读取保持只读；实际上传仅由显式publish或deploy调用进入产品实现。
async function publicRequest(path,{raw=false}={}){
 const url=path.startsWith('https:')?new URL(path):new URL(`https://api.github.com/repos/${repository}/${path}`);
 if(url.protocol!=='https:'||url.hostname!=='api.github.com'||!url.pathname.startsWith(`/repos/${repository}/`)||url.username||url.password)fail('GitHub公开来源无效');
 let response=await fetch(url,{method:'GET',redirect:raw?'manual':'error',credentials:'omit',headers:{Accept:raw?'application/octet-stream':'application/vnd.github+json'},signal:AbortSignal.timeout(300000)});
 if(raw&&response.status===302){const next=new URL(response.headers.get('location'));if(next.protocol!=='https:'||next.username||next.password||!['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))fail('资产重定向越界');response=await fetch(next,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(300000)});}
 if(!response.ok)fail('公开读取失败');if(raw)return response;
 let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>8*1024**2)fail('公开JSON超限');chunks.push(chunk);}
 return JSON.parse(Buffer.concat(chunks));
}
const direct=process.argv[1]===import.meta.filename,testing=direct&&Boolean(process.env.NODE_TEST_CONTEXT)&&process.argv.length===2;
if(direct&&!testing){
 const controller=new AbortController();for(const name of ['SIGTERM','SIGINT'])process.once(name,()=>controller.abort(Error('发布已取消')));
 void (async()=>{
  if(process.argv.length!==3||!['prepare','publish','deploy'].includes(process.argv[2]))fail('发布入口参数无效');
  if(process.argv[2]==='prepare')return preparePublication();
  let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>1024**2)fail('发布输入超限');}
  let value;try{value=JSON.parse(text);}catch{fail('发布输入JSON无效');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail('发布输入无效');
  if(process.argv[2]==='deploy')return deployCloudflare(value.payload,value.credentials,{signal:controller.signal});
  return publishCloudflare({...value,signal:controller.signal});
 })().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{console.error(error.message);process.exitCode=1;});
}

// 回归仅使用合成公开Run和内存归档，不连接GitHub或Cloudflare。
if(testing){
 const {test}=await import('node:test'),{default:assert}=await import('node:assert/strict'),{gzipSync}=await import('node:zlib');
 const {Readable}=await import('node:stream');
 function fixture(config=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8')){
  const files=Object.fromEntries(packageFiles.map(name=>[name,Buffer.from(name==='index_bg.wasm'?'synthetic-wasm':'fixture-'+name)]));
  files['server/cloudflare/wrangler.toml']=Buffer.from(config);
  const blocks=[];for(const [name,bytes]of Object.entries(files)){const h=Buffer.alloc(512);h.write(name);h.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257);h.write([...h].reduce((sum,b)=>sum+b,0).toString(8).padStart(6,'0')+'\0 ',148);blocks.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));}blocks.push(Buffer.alloc(1024));
  const archive=gzipSync(Buffer.concat(blocks)),head='a'.repeat(40),run={id:42,run_attempt:2,path:workflow,repository:{full_name:repository},head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success',head_sha:head};
  const manifest={schema:1,product_id:'citizenserve',platform:'cloudflare',software_version:'1.2.3',source_sha:head,producer_run_id:42,producer_run_attempt:2,assets:Object.entries(files).map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}))};
  const metadata=Buffer.from(JSON.stringify(manifest)),sums=Buffer.from(hash(archive)+'  '+assets[0]+'\n'+hash(metadata)+'  '+assets[1]+'\n'),body=new Map([[assets[0],archive],[assets[1],metadata],[assets[2],sums]]);
  const release={id:7,tag_name:'公民服务端·Cloudflare·v1.2.3',body:'<!-- automation:'+JSON.stringify({version:'1.2.3',run_id:42,run_attempt:2})+' -->',draft:false,prerelease:false,target_commitish:head,assets:assets.map((name,index)=>({id:index+1,name,state:'uploaded',size:body.get(name).length,digest:'sha256:'+hash(body.get(name)),url:`https://api.github.com/repos/${repository}/releases/assets/${index+1}`}))};
  return {run,release,body,readTag:async()=>({ref:'refs/tags/'+release.tag_name,object:{type:'commit',sha:head}}),readAsset:async asset=>Readable.from([body.get(asset.name)])};
 }
 test('成功Worker自动化的三件正式资产及全部包内容独立验真',async()=>{const f=fixture(),value=await inspectCandidate(f);assert.equal(value.run_id,42);assert.equal(value.run_attempt,2);assert.equal(value.assets.length,3);});
 test('已冷签资产摘要在实际部署前必须仍属于同一份产品候选',()=>{
  const proof={assets:[{name:'citizenserve-cloudflare-release.tgz',sha256:'a'.repeat(64)}]};
  assert.equal(approvedArchiveDigest(proof,proof),'a'.repeat(64));
  assert.throws(()=>approvedArchiveDigest(proof,{assets:[{name:'citizenserve-cloudflare-release.tgz',sha256:'b'.repeat(64)}]}));
  assert.throws(()=>approvedArchiveDigest(proof,{assets:[]}));
 });
 test('错误Run、Tag、资产字节与归档缺项都失败',async()=>{const f=fixture();await assert.rejects(inspectCandidate({...f,run:{...f.run,conclusion:'failure'}}));await assert.rejects(inspectCandidate({...f,readTag:async()=>null}));await assert.rejects(inspectCandidate({...f,readAsset:async()=>Readable.from([Buffer.from('changed')])}));assert.throws(()=>inspectArchive(f.body.get(assets[0]),[]));});
 test('公开发布接口自行分页，只消费读取能力并拒绝重复成功',async()=>{const f=fixture(),calls=[];const request=async(path,options={})=>{assert.equal(options.method,undefined);calls.push(path);if(path.startsWith('actions/runs?'))return {workflow_runs:[f.run]};if(path.startsWith('releases?'))return [f.release];if(path.startsWith('git/ref/tags/'))return f.readTag();return {body:await f.readAsset(f.release.assets.find(asset=>asset.url===path))};};assert.equal((await preparePublication({request})).release_id,7);assert.ok(calls.length>=6);await assert.rejects(preparePublication({request:async path=>path.startsWith('actions/')?{workflow_runs:[f.run,f.run]}:[f.release]}),/唯一/u);});
 const publicValues={CHAIN_URL:'https://chain.crcfrcn.com/',CF_ACCESS_CLIENT_ID:'fixture-client.access',ZONE_ID:'1'.repeat(32),APNS_KID:'ABCDEFGHIJ',APNS_TEAM:'0123456789',APNS_TOPIC:'example.chat',FCM_EMAIL:'service@example.iam.gserviceaccount.com',FCM_PROJECT:'example-project',TATACHAT_AUTH_KID:'chat-test-1'};
 const requestFor=f=>async path=>{if(path.startsWith('actions/runs?'))return {workflow_runs:[f.run]};if(path.startsWith('releases?'))return [f.release];if(path.startsWith('git/ref/tags/'))return f.readTag();return {body:await f.readAsset(f.release.assets.find(asset=>asset.url===path))};};
 test('统一门禁只增加准确业务媒体路由，媒体根域通配与其它路径仍拒绝',()=>{
  const source=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8');
  assert.deepEqual(publicationConfiguration(source,publicValues).routes,['www.crcfrcn.com/api/*','nrcrpc.crcfrcn.com','media.crcfrcn.com/square/*']);
  for(const changed of [source.replace('media.crcfrcn.com/square/*','media.crcfrcn.com/*'),source.replace('media.crcfrcn.com/square/*','other.example/square/*')])assert.throws(()=>publicationConfiguration(changed,publicValues));
 });
 test('Web计时器合同只接收准确兼容标记，缺失重复或扩展均拒绝',()=>{
  const source=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8');
  const declaration='compatibility_flags = ["no_nodejs_global_timers"]';
  assert.doesNotThrow(()=>publicationConfiguration(source,publicValues));
  for(const changed of [source.replace(declaration,''),source.replace(declaration,'compatibility_flags = []'),
   source.replace(declaration,'compatibility_flags = ["no_nodejs_global_timers", "no_nodejs_global_timers"]'),
   source.replace(declaration,'compatibility_flags = ["no_nodejs_global_timers", "no_nodejs_compat"]')]){
   assert.throws(()=>publicationConfiguration(changed,publicValues));
  }
 });
 test('链回源公开声明与Node既有根RPC一致，只接受准确HTTPS根地址',()=>{
  const source=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8');
  assert.equal(describeConfiguration().configuration.items.find(item=>item.name==='CHAIN_URL').format,'https_root_url:chain.crcfrcn.com');
  assert.doesNotThrow(()=>publicationConfiguration(source,publicValues));
  for(const value of ['https://chain.crcfrcn.com','https://chain.crcfrcn.com/protected/rpc','https://chain.crcfrcn.com/?x=1','https://chain.crcfrcn.com/#x','http://chain.crcfrcn.com/','https://chain.crcfrcn.com:443/','https://user@chain.crcfrcn.com/','https://other.example.test/'])
   assert.throws(()=>publicationConfiguration(source,{...publicValues,CHAIN_URL:value}));
 });
 test('正式包中的准确资源、路由和九项公开运行值形成无机密候选',async()=>{const f=fixture(),result=await prepareDeployment({request:requestFor(f),publicValues});assert.equal(result.publication.release_id,7);assert.equal(result.d1.TATACHAT_DB.name,'citizenserve-tatachat');assert.equal(result.public_var_names.length,9);assert.equal(result.secret_names.length,11);assert.notEqual((await prepareDeployment({request:requestFor(f),publicValues:{...publicValues,APNS_KID:'ZZZZZZZZZZ'}})).config_sha256,result.config_sha256);const declaration=describeConfiguration();assert.equal(declaration.configuration.items.length,23);assert.equal(declaration.configuration.items.filter(item=>item.accessLevel==='public').length,9);assert.equal(declaration.configuration.items.filter(item=>item.accessLevel==='protected').length,14);assert.equal(declaration.configuration.items.find(item=>item.name==='COLD_SIGNER_PUBLIC_KEY')?.accessLevel,'protected');assert.ok(!declaration.configuration.items.some(item=>item.accessLevel==='publish'));assert.ok(!declaration.configuration.items.some(item=>item.name==='CF_ACCOUNT_ID'));assert.equal(Object.hasOwn(declaration,'fixed'),false);const output=JSON.stringify(result);for(const name of runtimeVariables)assert.ok(!output.includes(publicValues[name]));});
 test('缺少或畸形公开值及扩大公开路由均拒绝候选',async()=>{const source=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8');for(const bad of [{...publicValues,CHAIN_URL:''},{...publicValues,CHAIN_URL:'https://chain.crcfrcn.com/protected/rpc'},{...publicValues,CHAIN_URL:'https://other.example.test/'},{...publicValues,CHAIN_URL:publicValues.CHAIN_URL+'?x=1'},{...publicValues,CF_ACCESS_CLIENT_ID:'invalid client id'},{...publicValues,ZONE_ID:'invalid'},{...publicValues,APNS_KID:'short'},{...publicValues,FCM_EMAIL:'invalid'},{...publicValues,FCM_PROJECT:'UPPERCASE'},{...publicValues,TATACHAT_AUTH_KID:'bad key'},{...publicValues,UNKNOWN:'x'}])assert.throws(()=>publicationConfiguration(source,bad));for(const changed of [source.replace('www.crcfrcn.com/api/*','*/*'),source.replace('TATACHAT_AUTH_KID = ""','TATACHAT_AUTH_KID = "fixed"'),source.replace('citizenserve-private','other-bucket'),source.replace('TATACHAT_AUTH_KEY','UNOWNED_SECRET'),source.replace('4 3 * * *','5 3 * * *'),source.replace('limit = 120','limit = 999'),source.replace('max_retries = 5','max_retries = 50'),source.replace('WEB_ORIGIN = "https://www.crcfrcn.com"','WEB_ORIGIN = "https://other.example.test"'),source+'\n[[d1_databases]]\nbinding = "CITIZENCHAIN_DOWNLOAD_DB"\ndatabase_name = "citizenweb-download"\ndatabase_id = "428b28ae-e02d-4ebb-b4a2-ac03faf2f58a"\n'])assert.throws(()=>publicationConfiguration(changed,publicValues));});
 // 只在本产品现场物化已有合成包；模拟全部云请求和Wrangler，绝不装配真实凭据。
 async function workerExecutionFixture(t){
  const f=fixture(),selected=await selectedPublication(requestFor(f),true),rendered=renderedDeploymentConfig(selected.contents,publicValues);
  const base=fileURLToPath(new URL('../target/publish/cloudflare/',import.meta.url));await mkdir(base,{recursive:true});
  const work=await realpath(await mkdtemp(join(base,'123456789-')));t.after(()=>rm(work,{recursive:true,force:true}));
  for(const [name,bytes]of [['server/cloudflare/wrangler.toml',rendered.bytes],['target/build/cloudflare/worker/index.js',Buffer.from('synthetic-js')],
   ['target/build/cloudflare/worker/index_bg.wasm',Buffer.from('synthetic-wasm')],['test/worker/package-lock.json',Buffer.from(JSON.stringify({packages:{'':{devDependencies:{wrangler:'4.149.0'}}}}))],
   ['test/worker/node_modules/wrangler/bin/wrangler.js',Buffer.from('synthetic')]]){await mkdir(dirname(join(work,name)),{recursive:true});await writeFile(join(work,name),bytes);}
  const payload={schema:1,product_id:'citizenserve',platform:'cloudflare',run_id:'123456789',release_tag:selected.proof.tag,source_sha:selected.proof.source_sha,
   archive_sha256:selected.proof.assets[0].sha256,config_sha256:hash(rendered.bytes),work,node_path:await realpath(process.execPath)};
  const credentials={account:rendered.candidate.account_id,token:'synthetic-worker-credential',secrets:Object.fromEntries(requiredSecretNames.map(name=>[name,'synthetic-value-'+name]))};
  const calls=[];let mode='success';const invoke=async(_node,args,_work,environment,_signal,options={})=>{
   calls.push(args);if(args[0]==='--version')return 'v25.2.1';assert.equal(args.includes(credentials.token),false);
   assert.equal(environment.CLOUDFLARE_API_TOKEN,credentials.token);
   if(args[1]==='secret')assert.deepEqual(JSON.parse(options.input),credentials.secrets);
   if(mode==='tool-failure'&&args[1]==='secret')throw Error('synthetic secret failure');return '';
  };
  const request=async url=>{assert.ok(url.endsWith('/workers/scripts/citizenserve/deployments?per_page=1'));return Response.json({success:true,result:{deployments:[{
   id:'00000000-0000-4000-8000-000000000001',created_on:new Date().toISOString(),versions:[{percentage:mode==='wrong-version'?50:100,version_id:'00000000-0000-4000-8000-000000000002'}]}]}});};
  return {payload,credentials,calls,invoke,request,setMode:value=>{mode=value;calls.length=0;}};
 }
 test('Worker密钥装配、上传和回读独立完成，原生载荷仍使用同一入口',async t=>{
  const f=await workerExecutionFixture(t),result=await deployCloudflare(f.payload,f.credentials,f);assert.equal(result.deployed,true);assert.equal(result.archive_sha256,f.payload.archive_sha256);
  assert.deepEqual(f.calls.slice(1).map(args=>args[1]),['secret','deploy']);
  const {archive_sha256,...nativePayload}=f.payload;f.setMode('success');assert.equal((await deployCloudflare(nativePayload,f.credentials,f)).deployed,true);
 });
 test('Worker配置漂移、密钥装配失败、错误回读和取消均停止',async t=>{
  const f=await workerExecutionFixture(t);f.setMode('tool-failure');await assert.rejects(deployCloudflare(f.payload,f.credentials,f),/synthetic secret failure/u);
  assert.equal(f.calls.some(args=>args[1]==='deploy'),false);
  f.setMode('wrong-version');await assert.rejects(deployCloudflare(f.payload,f.credentials,f),/回读失败/u);
  f.setMode('success');const abort=new AbortController();abort.abort(Error('synthetic cancellation'));
  await assert.rejects(deployCloudflare(f.payload,f.credentials,{...f,signal:abort.signal}),/synthetic cancellation/u);assert.equal(f.calls.length,0);
  await writeFile(join(f.payload.work,'server/cloudflare/wrangler.toml'),'changed');await assert.rejects(deployCloudflare(f.payload,f.credentials,f),/配置发生变化/u);assert.equal(f.calls.length,0);
 });

}
