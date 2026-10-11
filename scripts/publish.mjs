#!/usr/bin/env node
// 公民服务发布只消费成功自动化的公开Worker资产；不创建Release或改变Cloudflare资源。
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const repository='crcfrcn/citizenserve',workflow='.github/workflows/release-cloudflare.yml';
const assets=['citizenserve-cloudflare-release.tgz','release-manifest.json','SHA256SUMS'];
// 所属测试入口只交付本仓实际变更覆盖的Node回归，不要求先编译Worker产物。
export function testFiles(){return ['scripts/publish.mjs'];}
export function testTools(){return [];}
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
  ||one(root,'workers_dev')!=='false'||one(root,'preview_urls')!=='false')fail('Worker部署身份无效');
 if(one(root,'routes')!=='[{ pattern = "www.crcfrcn.com/api/*", zone_name = "crcfrcn.com" }, { pattern = "nrcrpc.crcfrcn.com", custom_domain = true }]')fail('Worker公开路由越界');
 const secretBlock=blocks(value,'secrets',1)[0];let secretNames;try{secretNames=JSON.parse(one(secretBlock,'required'));}catch{fail('必需Secret声明无效');}
 if(!Array.isArray(secretNames)||secretNames.length!==requiredSecretNames.length||new Set(secretNames).size!==secretNames.length
  ||secretNames.some(name=>typeof name!=='string'||!/^\w+$/u.test(name))
  ||secretNames.slice().sort().join('\0')!==requiredSecretNames.slice().sort().join('\0'))fail('必需Secret名称越界');
 for(const name of runtimeVariables)if(string(vars,name)!=='')fail('动态公开变量不得在正式资产中固化：'+name);
 if(string(vars,'WEB_ORIGIN')!=='https://www.crcfrcn.com'||string(vars,'REGISTRATION_SCOPE')!=='citizenserve:production'
  ||string(vars,'TATACHAT_QUEUE_NAME')!=='citizenserve-tatachat'||string(vars,'SQUARE_PUBLIC_MEDIA_BASE_URL')!=='https://media.crcfrcn.com'
  ||string(vars,'RELAY_ENABLED')!=='0')fail('静态生产变量越界');
 const variables=validateDynamicPublic(publicValues);
 const expectedD1={DB:'citizenserve',CITIZENCHAIN_DOWNLOAD_DB:'citizenweb-download',TATACHAT_DB:'citizenserve-tatachat'};
 const d1=Object.fromEntries(blocks(value,'d1_databases',3).map(block=>[string(block,'binding'),{name:string(block,'database_name'),id:string(block,'database_id')}]));
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
 return {worker:'citizenserve',account_id,zone_id:variables.ZONE_ID,routes:['www.crcfrcn.com/api/*','nrcrpc.crcfrcn.com'],secret_names:secretNames,
  public_var_names:runtimeVariables,d1,r2,kv:{SQUARE_CACHE:string(kvBlock,'id')},queues:producers,durable_object:'TataChatDevice',migration:'tatachat-1'};
}
function verifyInventory(candidate,inventory){
 exactKeys(inventory,['account_id','zone_id','d1','r2','kv','queues'],'Cloudflare资源回执');
 if(inventory.account_id!==candidate.account_id||inventory.zone_id!==candidate.zone_id)fail('Cloudflare账户或Zone回执不符');
 for(const field of ['d1','r2','kv','queues']){
  exactKeys(inventory[field],Object.keys(candidate[field]),'Cloudflare '+field+'回执');
  for(const [binding,value] of Object.entries(candidate[field])){
   if(field==='d1'){
    const remote=inventory[field][binding];exactKeys(remote,['name','id'],'Cloudflare D1回执');
    if(remote.name!==value.name||remote.id!==value.id)fail('Cloudflare资源绑定回执不符：'+binding);
   }else if(inventory[field][binding]!==value)fail('Cloudflare资源绑定回执不符：'+binding);
  }
 }
 return true;
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
 const match=/^citizenserve-cloudflare-v(\d+\.\d+\.\d+)-r([1-9]\d*)-a([1-9]\d*)$/u.exec(release?.tag_name||'');
 if(!match||Number(match[2])!==run.id||Number(match[3])!==run.run_attempt||!positive(release.id)
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
 if(success.length!==1)fail('缺少唯一保留成功自动化');
 const run=success[0],suffix='-r'+run.id+'-a'+run.run_attempt;
 const release=releases.filter(value=>value?.tag_name?.startsWith('citizenserve-cloudflare-v')&&value.tag_name.endsWith(suffix));
 if(release.length!==1)fail('成功自动化缺少唯一Release');
 return inspectCandidate({run,release:release[0],readTag:tag=>request('git/ref/tags/'+encodeURIComponent(tag)),readAsset:async asset=>(await request(asset.url,{raw:true}))?.body,includeContents});
}
export async function preparePublication({request=publicRequest}={}){return selectedPublication(request,false);}

// 候选只读核对正式资产、运行值的形状与真实资源回执；不输出运行值，也不执行上传。
export async function prepareDeployment({request=publicRequest,publicValues,inventory}={}){
 const {proof,contents}=await selectedPublication(request,true);
 let config;try{config=new TextDecoder('utf-8',{fatal:true}).decode(contents.get('server/cloudflare/wrangler.toml'));}catch{fail('正式Wrangler配置编码无效');}
 const candidate=publicationConfiguration(config,publicValues);verifyInventory(candidate,inventory);
 const {zone_id:_verifiedZoneId,...publicCandidate}=candidate;
 return {schema:1,product_id:'citizenserve',platform:'cloudflare',operation:'deployment-candidate',publication:proof,
  config_sha256:hash(contents.get('server/cloudflare/wrangler.toml')),...publicCandidate};
}

// 独立入口只进行公开GET读取，不接受部署凭据或写入能力。
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
if(direct&&!testing){if(process.argv.length!==3||process.argv[2]!=='prepare')fail('发布只读入口参数无效');void preparePublication().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{console.error(error.message);process.exitCode=1;});}

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
  const release={id:7,tag_name:'citizenserve-cloudflare-v1.2.3-r42-a2',draft:false,prerelease:false,target_commitish:head,assets:assets.map((name,index)=>({id:index+1,name,state:'uploaded',size:body.get(name).length,digest:'sha256:'+hash(body.get(name)),url:`https://api.github.com/repos/${repository}/releases/assets/${index+1}`}))};
  return {run,release,body,readTag:async()=>({ref:'refs/tags/'+release.tag_name,object:{type:'commit',sha:head}}),readAsset:async asset=>Readable.from([body.get(asset.name)])};
 }
 test('成功Worker自动化的三件正式资产及全部包内容独立验真',async()=>{const f=fixture(),value=await inspectCandidate(f);assert.equal(value.run_id,42);assert.equal(value.run_attempt,2);assert.equal(value.assets.length,3);});
 test('错误Run、Tag、资产字节与归档缺项都失败',async()=>{const f=fixture();await assert.rejects(inspectCandidate({...f,run:{...f.run,conclusion:'failure'}}));await assert.rejects(inspectCandidate({...f,readTag:async()=>null}));await assert.rejects(inspectCandidate({...f,readAsset:async()=>Readable.from([Buffer.from('changed')])}));assert.throws(()=>inspectArchive(f.body.get(assets[0]),[]));});
 test('公开发布接口自行分页，只消费读取能力并拒绝重复成功',async()=>{const f=fixture(),calls=[];const request=async(path,options={})=>{assert.equal(options.method,undefined);calls.push(path);if(path.startsWith('actions/runs?'))return {workflow_runs:[f.run]};if(path.startsWith('releases?'))return [f.release];if(path.startsWith('git/ref/tags/'))return f.readTag();return {body:await f.readAsset(f.release.assets.find(asset=>asset.url===path))};};assert.equal((await preparePublication({request})).release_id,7);assert.ok(calls.length>=6);await assert.rejects(preparePublication({request:async path=>path.startsWith('actions/')?{workflow_runs:[f.run,f.run]}:[f.release]}),/唯一/u);});
 const publicValues={CHAIN_URL:'https://chain.crcfrcn.com/',CF_ACCESS_CLIENT_ID:'fixture-client.access',ZONE_ID:'1'.repeat(32),APNS_KID:'ABCDEFGHIJ',APNS_TEAM:'0123456789',APNS_TOPIC:'example.chat',FCM_EMAIL:'service@example.iam.gserviceaccount.com',FCM_PROJECT:'example-project',TATACHAT_AUTH_KID:'chat-test-1'};
 const requestFor=f=>async path=>{if(path.startsWith('actions/runs?'))return {workflow_runs:[f.run]};if(path.startsWith('releases?'))return [f.release];if(path.startsWith('git/ref/tags/'))return f.readTag();return {body:await f.readAsset(f.release.assets.find(asset=>asset.url===path))};};
 const inventoryFor=c=>({account_id:c.account_id,zone_id:c.zone_id,d1:structuredClone(c.d1),r2:{...c.r2},kv:{...c.kv},queues:{...c.queues}});
 test('正式包中的准确资源、路由和九项公开值形成无机密候选',async()=>{assert.deepEqual(testFiles(),['scripts/publish.mjs']);assert.deepEqual(testTools(),[]);const f=fixture(),source=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8'),c=publicationConfiguration(source,publicValues),result=await prepareDeployment({request:requestFor(f),publicValues,inventory:inventoryFor(c)});assert.equal(result.publication.release_id,7);assert.equal(result.d1.TATACHAT_DB.name,'citizenserve-tatachat');assert.equal(result.public_var_names.length,9);assert.equal(result.secret_names.length,12);assert.equal(describeConfiguration().fixed.length,28);const output=JSON.stringify(result);for(const name of runtimeVariables)assert.ok(!output.includes(publicValues[name]));});
 test('缺少或畸形公开值、错误资源回执和扩大公开路由均拒绝候选',async()=>{const source=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8'),c=publicationConfiguration(source,publicValues);for(const bad of [{...publicValues,CHAIN_URL:''},{...publicValues,CHAIN_URL:'https://other.example.test/'},{...publicValues,CF_ACCESS_CLIENT_ID:'invalid client id'},{...publicValues,ZONE_ID:'invalid'},{...publicValues,APNS_KID:'short'},{...publicValues,FCM_EMAIL:'invalid'},{...publicValues,FCM_PROJECT:'UPPERCASE'},{...publicValues,TATACHAT_AUTH_KID:'bad key'},{...publicValues,UNKNOWN:'x'}])assert.throws(()=>publicationConfiguration(source,bad));assert.throws(()=>verifyInventory(c,{...inventoryFor(c),d1:{...c.d1,TATACHAT_DB:{...c.d1.TATACHAT_DB,id:'2'.repeat(36)}}}),/绑定回执不符/u);for(const changed of [source.replace('www.crcfrcn.com/api/*','*/*'),source.replace('TATACHAT_AUTH_KID = ""','TATACHAT_AUTH_KID = "fixed"'),source.replace('citizenserve-private','other-bucket'),source.replace('TATACHAT_AUTH_KEY','UNOWNED_SECRET'),source.replace('4 3 * * *','5 3 * * *'),source.replace('limit = 120','limit = 999'),source.replace('max_retries = 5','max_retries = 50'),source.replace('WEB_ORIGIN = "https://www.crcfrcn.com"','WEB_ORIGIN = "https://other.example.test"')])assert.throws(()=>publicationConfiguration(changed,publicValues));});
}
