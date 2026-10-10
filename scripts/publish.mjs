#!/usr/bin/env node
// 公民服务发布只消费成功自动化的公开Worker资产；不创建Release或改变Cloudflare资源。
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const repository='crcfrcn/citizenserve',workflow='.github/workflows/release-cloudflare.yml';
const assets=['citizenserve-cloudflare-release.tgz','release-manifest.json','SHA256SUMS'];
// 发布包成员只读取本仓既有Cargo声明，不维护第二份清单。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const releaseDeclaration=readFileSync(fileURLToPath(new URL('../Cargo.toml',import.meta.url)),'utf8');
const releaseMembers=/^release_members = '''([^']+)'''/mu.exec(releaseDeclaration);
if(!releaseMembers)throw Error('CitizenServe发布成员声明缺失');
const packageFiles=Object.freeze(JSON.parse(releaseMembers[1]));
const fail=message=>{throw Error('CitizenServe发布：'+message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);

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
function inspectArchive(bytes,records){
 let tar;try{tar=gunzipSync(bytes,{maxOutputLength:256*1024**2});}catch{fail('正式Worker归档无效');}
 const expected=new Map(records.map(record=>[record.path,record])),seen=new Set();let at=0,ended=false;
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
  seen.add(name);at+=512+Math.ceil(size/512)*512;
 }
 if(!ended||tar.length%512||seen.size!==expected.size)fail('归档内容不完整');
}

async function inspectCandidate({run,release,readTag,readAsset}){
 if(run?.path!==workflow||run.repository?.full_name!==repository||run.head_branch!=='main'
  ||run.event!=='workflow_dispatch'||run.status!=='completed'||run.conclusion!=='success'
  ||!positive(run.id)||!positive(run.run_attempt)||!/^[a-f0-9]{40}$/u.test(run.head_sha||''))fail('成功自动化身份无效');
 const match=/^citizenserve-cloudflare-v(\d+\.\d+\.\d+)-r([1-9]\d*)-a([1-9]\d*)$/u.exec(release?.tag_name||'');
 if(!match||Number(match[2])!==run.id||Number(match[3])!==run.run_attempt||!positive(release.id)
  ||release.draft||release.prerelease||release.target_commitish!==run.head_sha||!Array.isArray(release.assets)
  ||release.assets.length!==assets.length)fail('正式Release身份无效');
 const tag=await readTag(release.tag_name);
 if(tag?.ref!=='refs/tags/'+release.tag_name||tag.object?.type!=='commit'||tag.object.sha!==run.head_sha)fail('正式Tag源码不一致');
 const loaded=new Map(),proof=[];
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
  loaded.set(name,bytes);proof.push({name,asset_id:asset.id,bytes:size,sha256:hash(bytes)});
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
 inspectArchive(loaded.get(assets[0]),manifest.assets);
 return {schema:1,product_id:'citizenserve',platform:'cloudflare',version:match[1],source_sha:run.head_sha,
  run_id:run.id,run_attempt:run.run_attempt,release_id:release.id,tag:release.tag_name,assets:proof};
}

export async function preparePublication({request=publicRequest}={}){
 const runs=await pages('actions/runs','workflow_runs',request),releases=await pages('releases',null,request);
 const success=runs.filter(run=>run?.path===workflow&&run.repository?.full_name===repository&&run.head_branch==='main'
  &&run.event==='workflow_dispatch'&&run.status==='completed'&&run.conclusion==='success');
 if(success.length!==1)fail('缺少唯一保留成功自动化');
 const run=success[0],suffix='-r'+run.id+'-a'+run.run_attempt;
 const release=releases.filter(value=>value?.tag_name?.startsWith('citizenserve-cloudflare-v')&&value.tag_name.endsWith(suffix));
 if(release.length!==1)fail('成功自动化缺少唯一Release');
 return inspectCandidate({run,release:release[0],readTag:tag=>request('git/ref/tags/'+encodeURIComponent(tag)),readAsset:async asset=>(await request(asset.url,{raw:true}))?.body});
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
 function fixture(){
  const files=Object.fromEntries(packageFiles.map(name=>[name,Buffer.from(name==='index_bg.wasm'?'synthetic-wasm':'fixture-'+name)]));
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
}
