#!/usr/bin/env node
// 本仓本目标的完整自动化只由同名Workflow调用；版本与产物均在GitHub生成。
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {gzipSync} from 'node:zlib';

export const owner = Object.freeze({"product": "citizenserve", "platform": "cloudflare", "repository": "crcfrcn/citizenserve", "required_assets": Object.freeze(["citizenserve-cloudflare-release.tgz", "release-manifest.json", "SHA256SUMS"])});
// 本目标只解释自身已公开的Run/Tag身份；编译入口不持有此规则。
async function workerRelease(release,platform,readTag){
 if(platform!==owner.platform)fail('正式Worker平台无效');
 const tag=release?.tag_name;
 if(typeof tag!=='string'||!tag.startsWith('citizenserve-cloudflare-v'))return null;
 const parts=/^citizenserve-cloudflare-v(\d+\.\d+\.\d+)-r([1-9]\d*)-a([1-9]\d*)$/u.exec(tag);
 if(!parts||!Number.isSafeInteger(Number(parts[2]))||!Number.isSafeInteger(Number(parts[3])))fail('正式Worker Tag身份无效');
 const ref=await readTag(tag);
 if(ref?.ref!=='refs/tags/'+tag||ref.object?.type!=='commit'||!/^[a-f0-9]{40}$/u.test(ref.object.sha||''))fail('正式Worker源码提交无效');
 return {platform:owner.platform,tag,version:parts[1],source_sha:ref.object.sha,run_id:Number(parts[2]),run_attempt:Number(parts[3])};
}
const shaPattern = /^[0-9a-f]{40}$/u;
const fail = message => { throw new Error(message); };
const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = `.github/workflows/release-${owner.platform}.yml`;
const prefix = `${owner.product}-${owner.platform}-v`;
// 自动化与Build、Publish只消费产品Cargo声明，不互相读取流程脚本。
const releaseDeclaration=readFileSync(join(root,'Cargo.toml'),'utf8');
const declaredValue=name=>{const record=new RegExp('^'+name+' = '+String.fromCharCode(39).repeat(3)+'([^'+String.fromCharCode(39)+']+)'+String.fromCharCode(39).repeat(3),'mu').exec(releaseDeclaration);if(!record)fail('自动化声明缺失：'+name);return JSON.parse(record[1]);};
const automationTools=Object.freeze(declaredValue('linux_tool_sources'));
const packageInputs=Object.freeze(declaredValue('release_members'));
function tarGzip(files) {
  const blocks=[];
  for(const [name,data] of Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0)){
    if(!/^[A-Za-z0-9._/-]+$/u.test(name)||name.startsWith('/')||name.split('/').some(part=>part==='.'||part==='..'))fail('正式包路径无效');
    if(Buffer.byteLength(name)>100)fail('正式包路径过长');
    const value=Buffer.from(data),header=Buffer.alloc(512);
    const field=(at,size,value)=>header.write(value,at,size,'ascii');
    field(0,100,name);field(100,8,'0000644\0');field(108,8,'0000000\0');field(116,8,'0000000\0');
    field(124,12,value.length.toString(8).padStart(11,'0')+'\0');field(136,12,'00000000000\0');
    header.fill(32,148,156);header[156]=48;field(257,6,'ustar\0');field(263,2,'00');
    field(148,8,[...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ');
    blocks.push(header,value,Buffer.alloc((512-value.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(blocks),{level:9,mtime:0});
}
function workerParent(create=false){
 if(realpathSync(root)!==root)fail('源码根经过链接');
 let path=root;
 for(const name of ['target','build','cloudflare']){
  path=join(path,name);
  if(!existsSync(path)){if(!create)return null;mkdirSync(path,{mode:0o700});}
  const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(path)!==path)fail('Worker工作目录经过链接');
 }
 return path;
}
export function context(environment = process.env) {
  const number = name => {
    const value = environment[name];
    if (!/^[1-9][0-9]*$/u.test(value || '') || !Number.isSafeInteger(Number(value))) fail('GitHub运行坐标无效');
    return Number(value);
  };
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== owner.repository
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !shaPattern.test(environment.GITHUB_SHA || '')
    || environment.GITHUB_WORKFLOW_REF !== `${owner.repository}/${workflowPath}@refs/heads/main`) fail('所属GitHub运行身份无效');
  return { repository: owner.repository, product_id: owner.product, platform: owner.platform,
    source_sha: environment.GITHUB_SHA, run_id: number('GITHUB_RUN_ID'),
    run_number: number('GITHUB_RUN_NUMBER'), run_attempt: number('GITHUB_RUN_ATTEMPT'), workflow: workflowPath };
}

export async function request(path, { method = 'GET', body, raw = false, size, fetch: send = globalThis.fetch } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || /[\s\u0000-\u001f\u007f]/u.test(token)) fail('缺少GitHub任务令牌');
  const url = path.startsWith('https://') ? new URL(path) : new URL(`https://api.github.com/repos/${owner.repository}/${path}`);
  if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || !url.pathname.startsWith(`/repos/${owner.repository}/`)) fail('GitHub接口地址无效');
  const headers = { Authorization: `Bearer ${token}`, Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': owner.product };
  if (body !== undefined) headers['Content-Type'] = body?.pipe ? 'application/octet-stream' : 'application/json';
  if(body?.pipe){if(!Number.isSafeInteger(size)||size<=0)fail('资产上传长度无效');headers['Content-Length']=String(size);}
  let response = await send(url, { method, headers, redirect: raw ? 'manual' : 'error', signal: AbortSignal.timeout(300_000),
    ...(body === undefined ? {} : { body: body?.pipe ? body : JSON.stringify(body), ...(body?.pipe ? { duplex: 'half' } : {}) }) });
  if(raw&&response.status===302){
    const location=new URL(response.headers.get('location'));
    if(location.protocol!=='https:'||location.username||location.password)fail('正式资产回读地址无效');
    response=await send(location,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(300_000)});
  }
  if (response.status === 404) return null;
  if (!response.ok) fail(`GitHub接口失败：${response.status}，操作未确认`);
  if (raw) return response;
  return response.status === 204 ? {} : response.json();
}

export async function pages(path, field = null, api = request) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const values = field ? data?.[field] : data;
    if (!Array.isArray(values)) fail('GitHub分页数据无效');
    rows.push(...values);
    if (values.length < 100) return rows;
  }
}

function seedVersion(){
 const text=readFileSync(join(root,'Cargo.toml'),'utf8'),value=/^\[package\][\s\S]*?^version\s*=\s*"(\d+\.\d+\.\d+)"/mu.exec(text)?.[1];
 if(!value)fail('本仓Cargo版本真源无效');return value;
}

export function nextVersion(seed,versions,runNumber=1){
  const parse = value => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/u.exec(value);
    if (!match) fail('软件版本无效');
    const parts=match.slice(1).map(Number);if(parts.some(value=>!Number.isSafeInteger(value)))fail('软件版本越界');return parts;
  };
  const values = [seed, ...versions].map(parse).sort((a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
  let [major, minor, patch] = values.at(-1);
  if (versions.length) { if (++patch > 99) { patch = 0; if (++minor > 99) { minor = 0; major++; } } }
  if(!Number.isSafeInteger(runNumber)||runNumber<1)fail('版本运行序号无效');
  const initial=parse(seed),floor=BigInt(initial[0])*10000n+BigInt(initial[1])*100n+BigInt(initial[2])+BigInt(runNumber-1);
  const historical=BigInt(major)*10000n+BigInt(minor)*100n+BigInt(patch);
  if(floor>historical){major=Number(floor/10000n);minor=Number(floor/100n%100n);patch=Number(floor%100n);}
  if(![major,minor,patch].every(Number.isSafeInteger))fail('软件版本越界');
  return `${major}.${minor}.${patch}`;
}

function output(name, value, file = process.env.GITHUB_OUTPUT) {
  if (!file || /[\r\n]/u.test(String(value))) fail('GitHub步骤输出无效');
  appendFileSync(file, `${name}=${value}\n`);
}

export async function prepare({api=request,environment=process.env,emit=(name,value)=>output(name,value,environment.GITHUB_OUTPUT)}={}){
  const identity=context(environment);
  const releases=await pages('releases',null,api);
  const versions = [];
  for (const release of releases) {
    if (release.draft || release.prerelease || !String(release.tag_name).startsWith(prefix)) continue;
    const notes = (await workerRelease(release,owner.platform,tag=>api('git/ref/tags/'+encodeURIComponent(tag))));
    if (!notes || notes.platform !== owner.platform) continue;
    const run=await api(`actions/runs/${notes.run_id}`);
    if(run?.status==='completed'&&run.conclusion==='success'&&run.path===workflowPath&&run.repository?.full_name===owner.repository
      &&run.head_branch==='main'&&run.event==='workflow_dispatch'&&run.head_sha===notes.source_sha&&run.run_attempt===notes.run_attempt)versions.push(notes.version);
  }
  const version = nextVersion(seedVersion(),versions,identity.run_number);
  const tag = `${prefix}${version}-r${identity.run_id}-a${identity.run_attempt}`;
  for (const [name,value] of Object.entries({version, tag, source_sha:identity.source_sha,
    run_id:identity.run_id, run_attempt:identity.run_attempt, run_number:identity.run_number})) emit(name,value);
}

function runVersion(environment=process.env){
  const identity=context(environment);
  const version=environment.RELEASE_VERSION,tag=environment.RELEASE_TAG;
  nextVersion(version,[]);
  if (tag !== `${prefix}${version}-r${identity.run_id}-a${identity.run_attempt}`) fail('本次版本与Tag不一致');
  return {...identity, version, tag};
}

export function job() {
  const identity = runVersion();
  if (execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8'}).trim() !== identity.source_sha) fail('检出源码不符');
  const work = join(process.env.RUNNER_TEMP, owner.product, owner.platform, String(identity.run_id), String(identity.run_attempt), process.env.GITHUB_JOB);
  mkdirSync(work,{recursive:true});
  if(realpathSync(work)!==work||!lstatSync(work).isDirectory())fail('自动化现场经过链接');
  const variables = {RELEASE_WORK:work, RELEASE_ASSETS_DIR:join(work,'assets'), CARGO_HOME:join(work,'cargo-home'), CARGO_TARGET_DIR:join(work,'cargo'), PUB_CACHE:join(work,'pub'),
    GRADLE_USER_HOME:join(work,'gradle'), npm_config_cache:join(work,'npm'), XDG_CACHE_HOME:join(work,'cache'),
    TMPDIR:join(work,'tmp'), TMP:join(work,'tmp'), TEMP:join(work,'tmp')};
  for (const path of ['cargo-home','cargo','pub','gradle','npm','cache','tmp','assets']) mkdirSync(join(work,path),{recursive:true});
  for (const [name,value] of Object.entries(variables)) { process.env[name]=value; output(name,value,process.env.GITHUB_ENV); }
}

function regular(path) {
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0)fail('正式产物不是非空普通文件');return stat;
}
async function digestFile(path) { const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex'); }
function assetName(name) { if(!name||name!==basename(name)||/[\u0000-\u001f\u007f]/u.test(name))fail('正式资产文件名无效');return name; }

// 只接收本目标三件已产出的文件；不存在通用路径收集入口。
export async function collectProduced({identity=runVersion(),directory=process.env.RELEASE_ASSETS_DIR,emit=output}={}) {
  if(!directory||!isAbsolute(directory)||resolve(directory)!==directory||!lstatSync(directory).isDirectory())fail('正式产物目录无效');
  if(readdirSync(directory).sort().join('\0')!==[...owner.required_assets].sort().join('\0'))fail('本目标完整正式资产集合不符');
  const files=[];
  for(const name of owner.required_assets){
    const path=join(directory,name),stat=regular(path);
    files.push({name,size:stat.size,sha256:await digestFile(path)});
  }
  const metadata={schema:1,...identity,assets:files};
  writeFileSync(join(directory,'automation.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
  emit('assets',directory);return metadata;
}



export async function publish(directory) {
  const identity=runVersion();const metadata=JSON.parse(readFileSync(join(directory,'automation.json'),'utf8'));
  if(Object.entries(identity).some(([key,value])=>metadata[key]!==value)||!Array.isArray(metadata.assets)||!metadata.assets.length)fail('完整产物身份无效');
  const files=metadata.assets;
  if(files.map(value=>value?.name).sort().join('\0')!==[...owner.required_assets].sort().join('\0'))fail('正式资产集合与本目标不符');
  if(readdirSync(directory).sort().join('\0')!==[...files.map(value=>value.name),'automation.json'].sort().join('\0'))fail('产物目录与完整资产集合不符');
  for(const file of files){const path=join(directory,assetName(file.name));if(regular(path).size!==file.size||await digestFile(path)!==file.sha256)fail('正式产物在交付前改变');}
  if(await request(`git/ref/tags/${encodeURIComponent(identity.tag)}`)!==null)fail('本次Tag已经存在');
  await request('git/refs',{method:'POST',body:{ref:`refs/tags/${identity.tag}`,sha:identity.source_sha}});
  const release=await request('releases',{method:'POST',body:{tag_name:identity.tag,target_commitish:identity.source_sha,
    name:`${owner.product} · ${owner.platform} · ${identity.version}`,draft:false,prerelease:false,make_latest:'false',
    body:`${owner.product} · ${owner.platform} · ${identity.version}\nSource: ${identity.source_sha}\nRun: ${identity.run_id} / ${identity.run_attempt}`}});
  if(!Number.isSafeInteger(release?.id)||!release.upload_url)fail('正式Release创建未确认');
  for(const file of files){const url=new URL(release.upload_url.replace(/\{.*$/u,''));url.searchParams.set('name',file.name);
    const asset=await request(url.href,{method:'POST',body:createReadStream(join(directory,file.name)),size:file.size});
    if(asset?.name!==file.name||asset.size!==file.size||asset.state!=='uploaded')fail('正式资产上传未确认');
    const response=await request(asset.url,{raw:true});if(!response?.body)fail('正式资产回读失败');
    const hash=createHash('sha256');let size=0;for await(const bytes of response.body){hash.update(bytes);size+=bytes.length;if(size>file.size)fail('正式资产回读超过声明大小');}
    if(size!==file.size||hash.digest('hex')!==file.sha256)fail('GitHub资产逐件回读不一致');
  }
  const readback=await request(`releases/${release.id}`);if((await workerRelease(readback,owner.platform,tag=>request('git/ref/tags/'+encodeURIComponent(tag))))?.run_id!==identity.run_id||readback.draft||readback.prerelease
    ||readback.assets?.length!==files.length)fail('完整正式Release回查失败');
  for(const file of files){const asset=readback.assets.find(value=>value.name===file.name);if(!asset||asset.state!=='uploaded'||asset.size!==file.size||asset.digest!==`sha256:${file.sha256}`)fail('完整正式资产证明回查失败');}
  output('verified','true');output('release_id',release.id);output('tag',identity.tag);
}

function ownedRun(run) {
  // 每个目标只处理自身现行Workflow；文件缺失不能证明历史任务归属。
  return Number.isSafeInteger(run?.id)&&run.id>0&&run.path===workflowPath
    &&run.head_branch==='main'&&run.event==='workflow_dispatch'
    &&(!run.repository||run.repository.full_name===owner.repository);
}

export function cleanupPlan(runs,current,result) {
  if(!['success','failed'].includes(result)||!ownedRun(current)||!Number.isFinite(Date.parse(current.created_at)))fail('清理所属任务身份无效');
  const earlier=run=>Date.parse(run.created_at)<Date.parse(current.created_at)
    ||Date.parse(run.created_at)===Date.parse(current.created_at)&&run.id<current.id;
  return runs.filter(run=>ownedRun(run)&&run.id!==current.id&&run.status==='completed'&&earlier(run)
    &&(run.conclusion==='success'?'success':'failed')===result).sort((a,b)=>a.id-b.id);
}

async function remove(path,api) { await api(path,{method:'DELETE'});const readPath=path.replace(/^git\/refs\//u,'git/ref/');if(await api(readPath)!==null)fail('删除回查仍存在，清理失败'); }
async function removeRunRelease(run,releases,api) {
  for(const release of releases){
    const metadata=(await workerRelease(release,owner.platform,tag=>api('git/ref/tags/'+encodeURIComponent(tag))));
    if(!metadata||metadata.run_id!==run.id)continue;
    if(metadata.source_sha!==run.head_sha)fail('正式Release与所属Run不一致');
    const tag=metadata.tag;
    const again=await api(`actions/runs/${run.id}`);
    if(again&&again.id!==Number(process.env.GITHUB_RUN_ID)
      &&(again.status!=='completed'||again.run_attempt!==run.run_attempt||again.conclusion!==run.conclusion))fail('所属任务已变化，停止清理');
    await remove(`releases/${release.id}`,api);
    const beforeTag=await api(`actions/runs/${run.id}`);
    if(beforeTag&&beforeTag.id!==Number(process.env.GITHUB_RUN_ID)
      &&(beforeTag.status!=='completed'||beforeTag.run_attempt!==run.run_attempt||beforeTag.conclusion!==run.conclusion))fail('所属任务已变化，停止清理');
    await remove(`git/refs/tags/${encodeURIComponent(tag)}`,api);
  }
}
export async function cleanup(result,identity=context(),api=request) {
  const current=await api(`actions/runs/${identity.run_id}`);
  const plan=cleanupPlan(await pages('actions/runs','workflow_runs',api),current,result);
  const releases=await pages('releases',null,api),removed=[];
  for(const row of plan){const run=await api(`actions/runs/${row.id}`);if(!run){removed.push(row.id);continue;}
    if(run.run_attempt!==row.run_attempt||cleanupPlan([run],current,result).length!==1)continue;
    await removeRunRelease(run,releases,api);
    // 失败若只形成Tag也按它的准确Run坐标处理，不能留下同类孤立产物。
    const tags=await api(`git/matching-refs/tags/${prefix}`);
    if(!Array.isArray(tags))fail('所属Tag集合无效');
    for(const reference of tags){
      const tag=String(reference.ref||'').slice('refs/tags/'.length);
      if(!String(reference.ref||'').startsWith('refs/tags/'+prefix)
        ||!new RegExp(`-r${run.id}-a[1-9][0-9]*$`,'u').test(tag)||Number(tag.slice(tag.lastIndexOf('-a')+2))>run.run_attempt)continue;
      if(reference.object?.type!=='commit'||reference.object.sha!==run.head_sha)fail('所属Tag来源已改变，停止清理');
      const again=await api(`actions/runs/${run.id}`);
      if(!again||cleanupPlan([again],current,result).length!==1)fail('所属任务已改变，停止清理');
      await remove(`git/refs/tags/${encodeURIComponent(tag)}`,api);
    }
    for(const asset of await pages(`actions/runs/${run.id}/artifacts`,'artifacts',api)){
      if(!Number.isSafeInteger(asset.id)||asset.id<=0)fail('所属Artifact坐标无效');
      const again=await api(`actions/runs/${run.id}`);if(!again||again.status!=='completed'||again.run_attempt!==run.run_attempt||again.conclusion!==run.conclusion)fail('历史任务已变化，停止清理');
      await remove(`actions/artifacts/${asset.id}`,api);
    }
    const final=await api(`actions/runs/${run.id}`);
    if(final&&(final.run_attempt!==run.run_attempt||cleanupPlan([final],current,result).length!==1))fail('历史任务状态改变，停止清理');
    if(final)await remove(`actions/runs/${run.id}`,api);removed.push(run.id);
  }
  return removed;
}

export function precedingResult(needs) {
  if(!needs||typeof needs!=='object'||Array.isArray(needs)||!Object.keys(needs).length)fail('前置任务结果缺失');
  return Object.values(needs).every(value=>value?.result==='success')?'success':'failed';
}
async function discardCurrent(identity,api) {
  for(const release of await pages('releases',null,api)){
    const metadata=(await workerRelease(release,owner.platform,tag=>api('git/ref/tags/'+encodeURIComponent(tag))));
    if(metadata?.run_id===identity.run_id&&metadata.run_attempt===identity.run_attempt)
      await removeRunRelease({id:identity.run_id,head_sha:identity.source_sha},[release],api);
  }
  const tag=process.env.RELEASE_TAG;
  if(tag&&tag.startsWith(prefix)&&tag.endsWith(`-r${identity.run_id}-a${identity.run_attempt}`)){
    const path=`git/refs/tags/${encodeURIComponent(tag)}`;
    if(await api(path.replace(/^git\/refs\//u,'git/ref/'))!==null)await remove(path,api);
  }
}
export async function finish(needs=JSON.parse(process.env.RELEASE_NEEDS||'null'),api=request,identity=context()) {
  const result=precedingResult(needs),errors=[];
  const attempt=async action=>{try{return await action();}catch(error){errors.push(error);return null;}};
  let removed;
  if(result==='success') {
    removed=await attempt(()=>cleanup('success',identity,api));
    if(errors.length) {
      await attempt(()=>discardCurrent(identity,api));
      await attempt(()=>cleanup('failed',identity,api));
    }
  } else {
    // 本次撤销失败也必须尝试清理同目标旧失败；各项真实错误均保留。
    await attempt(()=>discardCurrent(identity,api));
    removed=await attempt(()=>cleanup('failed',identity,api));
  }
  if(errors.length)throw new AggregateError(errors,'本目标最后处理失败：'+errors.map(error=>error.message).join('；'));
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`本目标${result==='success'?'成功':'失败'}；已清理同类旧Run：${removed.join('、')||'无'}。\n`);
  if(result==='failed')fail('前置任务未全部成功');
}

// 自动化独立准备本目标工具与测试环境；产品Build不提供Runner命令。
function automationEnvironment(extra={}){
 const environment={...process.env,...extra,CI:'true',CARGO_INCREMENTAL:'0',WRANGLER_SEND_METRICS:'false'};
 for(const name of Object.keys(environment))if(name.startsWith('GITHUB_')||name.startsWith('ACTIONS_')||name.startsWith('RUNNER_')||['GH_TOKEN','GH_TOKEN_FILE','GITHUB_TOKEN'].includes(name))delete environment[name];
 return environment;
}
function runAutomation(file,args,{cwd=root,environment=automationEnvironment(),capture=true}={}){
 const result=spawnSync(file,args,{cwd,env:environment,encoding:'utf8',maxBuffer:32*1024*1024,timeout:7200000,
  stdio:capture?['ignore','pipe','pipe']:'inherit'});
 if(capture){if(result.stdout)process.stderr.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);}
 if(result.error||result.signal||result.status!==0)fail('自动化工具失败：'+basename(file));
 return (result.stdout||'')+(result.stderr||'');
}
async function lockedArchive(entry,destination){
 if(!entry||!/^https:\/\//u.test(entry.url)||!/^[a-f0-9]{64}$/u.test(entry.sha256||''))fail('自动化工具来源无效');
 if(existsSync(destination)){
  if(createHash('sha256').update(readFileSync(destination)).digest('hex')!==entry.sha256)fail('工具原件漂移');
  return destination;
 }
 let url=new URL(entry.url),response;
 for(let redirect=0;redirect<3;redirect++){
  if(url.protocol!=='https:'||url.username||url.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','static.crates.io'].includes(url.hostname))fail('工具下载地址无效');
  response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(300000)});
  if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');if(!next)fail('工具下载跳转缺失');url=new URL(next,url);continue;}
  break;
 }
 if(!response?.ok||!response.body)fail('工具原件下载失败');
 const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>256*1024*1024)fail('工具原件超限');chunks.push(Buffer.from(chunk));}
 const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)fail('工具原件摘要无效');
 writeFileSync(destination+'.pending',bytes,{flag:'wx',mode:0o600});renameSync(destination+'.pending',destination);return destination;
}
const extractCode=String.raw`import os,stat,sys,tarfile,zipfile
from pathlib import Path
source,target=Path(sys.argv[1]),Path(sys.argv[2]);target.mkdir()
def output(name,size):
 parts=Path(name).parts
 if not parts or name.startswith('/') or any(part in ('','.', '..') for part in parts) or size>256*1024*1024:raise SystemExit('工具归档成员无效')
 result=target.joinpath(*parts)
 if not result.is_relative_to(target):raise SystemExit('工具归档越界')
 return result
if zipfile.is_zipfile(source):
 with zipfile.ZipFile(source) as archive:
  for item in archive.infolist():
   mode=item.external_attr>>16
   if stat.S_ISLNK(mode):raise SystemExit('工具归档禁止链接')
   path=output(item.filename,item.file_size)
   if item.is_dir():path.mkdir(parents=True,exist_ok=True);continue
   path.parent.mkdir(parents=True,exist_ok=True)
   with archive.open(item) as original,path.open('xb') as final:final.write(original.read())
   if mode&0o111:path.chmod(0o755)
else:
 with tarfile.open(source,mode='r:*') as archive:
  for item in archive:
   path=output(item.name,item.size)
   if item.isdir():path.mkdir(parents=True,exist_ok=True);continue
   if not item.isfile():raise SystemExit('工具归档禁止链接或特殊文件')
   path.parent.mkdir(parents=True,exist_ok=True)
   with archive.extractfile(item) as original,path.open('xb') as final:final.write(original.read())
   if item.mode&0o111:path.chmod(0o755)`;
async function prepareAutomationTools(work){
 if(typeof work!=='string'||!isAbsolute(work)||resolve(work)!==work||!process.env.RUNNER_TEMP||!work.startsWith(resolve(process.env.RUNNER_TEMP)+sep)||realpathSync(work)!==work||!lstatSync(work).isDirectory())fail('自动化工具现场越界');
 if(process.version!=='v25.2.1'||!runAutomation('python3',['--version']).includes('3.14.3')||!runAutomation('rustc',['--version']).includes('1.97.1'))fail('Runner工具版本不符');
 const base=join(work,'tools');mkdirSync(join(base,'archives'),{recursive:true});mkdirSync(join(base,'extract'),{recursive:true});
 const paths={};
 for(const id of ['worker-build','wasm-bindgen','wasm-opt','protoc']){
  const record=automationTools[id],entry=record?.archive;if(!record?.version||!entry?.root||!entry.executable)fail('自动化工具声明缺失');
  const original=await lockedArchive(entry,join(base,'archives',id+'.archive'));
  const extracted=join(base,'extract',id);if(existsSync(extracted))rmSync(extracted,{recursive:true});
  runAutomation('python3',['-c',extractCode,original,extracted]);
  if(id==='worker-build'){
   const installed=join(base,'worker-build');mkdirSync(installed,{recursive:true});
   runAutomation('cargo',['install','--path',join(extracted,entry.root),'--locked','--root',installed]);
   paths[id]=join(installed,'bin/worker-build');
  }else paths[id]=join(extracted,entry.root,entry.executable);
  if(!existsSync(paths[id])||!lstatSync(paths[id]).isFile()||!(lstatSync(paths[id]).mode&0o111))fail('工具入口无效：'+id);
 }
 runAutomation('npm',['ci','--no-audit','--no-fund'],{cwd:join(root,'test/worker')});
 const esbuild=join(root,'test/worker/node_modules/esbuild/bin/esbuild');if(!existsSync(esbuild))fail('esbuild原锁入口缺失');
 paths.esbuild=esbuild;paths.python=execFileSync('which',['python3'],{encoding:'utf8'}).trim();
 const environment=automationEnvironment({WORKER_BUILD:paths['worker-build'],WASM_BINDGEN_BIN:paths['wasm-bindgen'],WASM_OPT_BIN:paths['wasm-opt'],PROTOC:paths.protoc,ESBUILD_BIN:esbuild,PYTHON:paths.python,PATH:[...new Set(Object.values(paths).map(dirname)),process.env.PATH].join(':')});
 return {paths,environment};
}
// 正式自动化直接执行产品原锁和真实测试；不调用本仓Build。
async function workflowProduct(command,input){
 if(command==='package-members')return [...packageInputs];
 const work=process.env.RELEASE_WORK;
 if(!work||!isAbsolute(work)||!process.env.RUNNER_TEMP||!work.startsWith(resolve(process.env.RUNNER_TEMP)+sep)||realpathSync(work)!==work||!lstatSync(work).isDirectory())fail('自动化工作根无效');
 const receiptPath=join(work,'automation-test.json'),worker=join(root,'target/build/cloudflare/worker');
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 if(command==='test'){
  if(existsSync(receiptPath)||lstatSync(worker,{throwIfNoEntry:false}))fail('自动化测试已有旧现场');
  const {environment}=await prepareAutomationTools(work);
  runAutomation('cargo',['fetch','--locked'],{environment});
  runAutomation('cargo',['fetch','--locked','--target','wasm32-unknown-unknown'],{environment});
  runAutomation('cargo',['fmt','--all','--','--check'],{environment});
  const rust=runAutomation('cargo',['test','-p','citizenserve','--all-targets','--locked','--offline'],{environment});
  const rustPassed=[...rust.matchAll(/test result: ok\. ([0-9]+) passed; ([0-9]+) failed; ([0-9]+) ignored;/gu)];
  if(!rustPassed.length||rustPassed.reduce((n,m)=>n+Number(m[1]),0)<1||rustPassed.some(m=>Number(m[2])||Number(m[3])))fail('Rust测试未完整成功');
  runAutomation('cargo',['clippy','-p','citizenserve','--all-targets','--locked','--offline','--','-D','warnings'],{environment});
  const storage=['import unittest,sys','suite=unittest.defaultTestLoader.discover("test",pattern="*storage_contract.py")','count=suite.countTestCases()','result=unittest.TextTestRunner(verbosity=2).run(suite)','sys.exit(0 if count>0 and result.testsRun==count and result.wasSuccessful() and not result.skipped else 1)'].join('\n');
  runAutomation(environment.PYTHON,['-c',storage],{environment});
  runAutomation('cargo',['clippy','-p','citizenserve-cloudflare','--target','wasm32-unknown-unknown','--locked','--offline','--','-D','warnings'],{environment});
  runAutomation('cargo',['build','-p','citizenserve-cloudflare','--target','wasm32-unknown-unknown','--release','--locked','--offline'],{environment});
  const chat=runAutomation(process.execPath,['--test','--test-reporter=tap','scripts/tatachat.mjs'],{environment});
  const chatCount=/^# tests ([1-9][0-9]*)$/mu.exec(chat);
  if(!chatCount||!/^# fail 0$/mu.test(chat)||/^# skipped [1-9]/mu.test(chat))fail('聊天资源回归缺失或失败');
  workerParent(true);
  runAutomation(environment.WORKER_BUILD,['--out-dir',worker,'--release','--','--locked','--offline'],{cwd:join(root,'server/cloudflare'),environment});
  const files={};for(const name of ['index.js','index_bg.wasm'])files[name]=readFileSync(join(worker,name));
  if(!files['index.js'].length||!files['index_bg.wasm'].subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])))fail('Worker产物无效');
  const smoke=runAutomation(process.execPath,['--test','--test-reporter=tap','push_crypto.mjs','worker_smoke.mjs','tatachat_smoke.mjs','tatachat_data_smoke.mjs'],{cwd:join(root,'test/worker'),environment});
  const smokeCount=/^# tests ([1-9][0-9]*)$/mu.exec(smoke);
  if(!smokeCount||!/^# fail 0$/mu.test(smoke)||/^# skipped [1-9]/mu.test(smoke))fail('真实Worker回归缺失或失败');
  writeFileSync(receiptPath,JSON.stringify({schema:1,product_id:owner.product,platform:owner.platform,run_id:input.run_id,source_sha:process.env.GITHUB_SHA,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,sha(bytes)])),rust_passed:rustPassed.reduce((n,m)=>n+Number(m[1]),0),chat_passed:Number(chatCount[1]),worker_passed:Number(smokeCount[1])})+'\n',{flag:'wx'});
  return {schema:2,product_id:owner.product,platform:owner.platform};
 }
 if(command!=='package')fail('自动化产品命令无效');
 const proof=JSON.parse(readFileSync(receiptPath,'utf8'));
 if(proof.schema!==1||proof.product_id!==owner.product||proof.platform!==owner.platform||proof.run_id!==input.run_id||proof.source_sha!==process.env.GITHUB_SHA||!proof.rust_passed||!proof.chat_passed||!proof.worker_passed)fail('自动化测试回执无效');
 const output=input.output;
 if(typeof output!=='string'||output!==join(work,'assets')||!isAbsolute(output)||resolve(output)!==output||!lstatSync(output).isDirectory()||readdirSync(output).length)fail('自动化资产目录无效');
 const files={};for(const name of packageInputs){
  const path=name==='index.js'||name==='index_bg.wasm'?join(worker,name):join(root,name);
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>128*1024*1024)fail('自动化包成员无效：'+name);
  files[name]=readFileSync(path);
 }
 if(sha(files['index.js'])!==proof.files['index.js']||sha(files['index_bg.wasm'])!==proof.files['index_bg.wasm'])fail('测试后Worker产物漂移');
 const archive=tarGzip(files),path=join(output,'citizenserve-cloudflare-release.tgz');
 writeFileSync(path,archive,{flag:'wx',mode:0o600});
 return {schema:1,product_id:owner.product,platform:owner.platform,archive:'citizenserve-cloudflare-release.tgz',path,bytes:archive.length,sha256:sha(archive),contents:Object.entries(files).map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:sha(bytes)}))};
}
async function productCommand(command,{invoke=workflowProduct,identity:chosen,environment=process.env}={}){
 if(!['test-product','build-cloudflare'].includes(command))return false;
 const identity=chosen??runVersion(environment),run_id=String(identity.run_id)+'-'+identity.run_attempt;
 if(command==='test-product'){const result=await invoke('test',{run_id},join(root,'target/test'));if(result?.schema!==2||result.product_id!==owner.product||result.platform!==owner.platform)fail('产品测试回执身份无效');return true;}
 const destination=environment.RELEASE_ASSETS_DIR;
 const bundle=await invoke('package',{run_id,output:destination},join(root,'target/build'));
 const expected=await invoke('package-members',{},null);
 if(!Array.isArray(expected)||expected.length!==10||new Set(expected).size!==10||expected.some(name=>typeof name!=='string'||!name||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..')))fail('产品包成员声明无效');
 if(bundle?.schema!==1||bundle.product_id!==owner.product||bundle.platform!==owner.platform||bundle.archive!=='citizenserve-cloudflare-release.tgz'||bundle.path!==join(destination,bundle.archive)||!Number.isSafeInteger(bundle.bytes)||bundle.bytes<1||!/^[a-f0-9]{64}$/u.test(bundle.sha256||'')||!Array.isArray(bundle.contents)||bundle.contents.length!==expected.length||bundle.contents.some(row=>!row||!expected.includes(row.path)||!Number.isSafeInteger(row.bytes)||row.bytes<1||!/^[a-f0-9]{64}$/u.test(row.sha256||''))||new Set(bundle.contents.map(row=>row.path)).size!==expected.length)fail('产品正式包归属无效');
 if(regular(bundle.path).size!==bundle.bytes||await digestFile(bundle.path)!==bundle.sha256)fail('产品正式包在交付前改变');
 const manifest={schema:1,product_id:owner.product,platform:owner.platform,software_version:identity.version,source_sha:identity.source_sha,producer_run_id:identity.run_id,producer_run_attempt:identity.run_attempt,assets:bundle.contents};
 const metadata=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
 writeFileSync(join(destination,'release-manifest.json'),metadata,{flag:'wx'});
 writeFileSync(join(destination,'SHA256SUMS'),bundle.sha256+'  citizenserve-cloudflare-release.tgz\n'+createHash('sha256').update(metadata).digest('hex')+'  release-manifest.json\n',{flag:'wx'});
 return true;
}

function cleanAutomation(){
 const identity=runVersion(),expected=join(process.env.RUNNER_TEMP,owner.product,owner.platform,String(identity.run_id),String(identity.run_attempt),process.env.GITHUB_JOB);
 if(process.env.GITHUB_JOB!=='flow'||(process.env.RELEASE_WORK&&process.env.RELEASE_WORK!==expected)||!expected.startsWith(resolve(process.env.RUNNER_TEMP)+sep))fail('自动化清理归属无效');
 const owned=workerParent();if(owned)rmSync(owned,{recursive:true,force:true});
 rmSync(expected,{recursive:true,force:true});
}


const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
const testing=direct&&Boolean(process.env.NODE_TEST_CONTEXT)&&process.argv.length===2;
if(direct&&!testing){
  try{const [command,...args]=process.argv.slice(2);
    if(command==='prepare')await prepare();else if(command==='job')job();else if(command==='clean')cleanAutomation();
    else if(command==='collect-produced')await collectProduced();else if(command==='publish')await publish(args[0]);else if(command==='finish')await finish();
    else if(!await productCommand(command,args))fail('自动化命令无效');
  }catch(error){console.error(error.message);process.exitCode=1;}
}

if(testing){
  const {default:assert}=await import('node:assert/strict');const {default:test}=await import('node:test');

  test('历史正式版本必须绑定同平台成功Run及源码提交',async()=>{
    const previous='a'.repeat(40),current='b'.repeat(40),release={tag_name:'citizenserve-cloudflare-v1.9.9-r42-a2',draft:false,prerelease:false};
    const environment={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:owner.repository,GITHUB_REF:'refs/heads/main',
      GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_SHA:current,GITHUB_WORKFLOW_REF:`${owner.repository}/${workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID:'99',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_NUMBER:'2'};
    const output=new Map(),api=async path=>path.startsWith('releases?')?[release]:path.startsWith('git/ref/tags/')?
      {ref:'refs/tags/'+release.tag_name,object:{type:'commit',sha:previous}}:
      {id:42,path:workflowPath,repository:{full_name:owner.repository},head_branch:'main',event:'workflow_dispatch',head_sha:previous,run_attempt:2,status:'completed',conclusion:'success'};
    await prepare({api,environment,emit:(name,value)=>output.set(name,value)});
    assert.equal(output.get('version'),'1.9.10');assert.equal(output.get('tag'),'citizenserve-cloudflare-v1.9.10-r99-a1');
    const wrong=async path=>path==='actions/runs/42'?{...await api(path),head_sha:'c'.repeat(40)}:api(path);
    const rejected=new Map();await prepare({api:wrong,environment,emit:(name,value)=>rejected.set(name,value)});
    assert.equal(rejected.get('version'),'1.0.1');
  });
  test('自动化从产品Cargo声明读取工具与成员且隔离授权环境',()=>{
    const environment=automationEnvironment({GH_TOKEN:'synthetic',ACTIONS_RUNTIME_TOKEN:'synthetic',GITHUB_REF:'refs/heads/main'});
    assert.equal(environment.GH_TOKEN,undefined);assert.equal(environment.ACTIONS_RUNTIME_TOKEN,undefined);assert.equal(environment.GITHUB_REF,undefined);
    assert.equal(packageInputs.length,10);assert.equal(new Set(packageInputs).size,10);
    for(const id of ['worker-build','wasm-bindgen','wasm-opt','protoc']){
      assert.match(automationTools[id].archive.url,/^https:\/\//u);assert.match(automationTools[id].archive.sha256,/^[a-f0-9]{64}$/u);
    }
  });
  test('产品组包输出由自动化绑定Run并生成三件正式候选',async t=>{
    const {mkdtempSync,realpathSync}=await import('node:fs'),directory=realpathSync(mkdtempSync('/tmp/citizenserve-automation-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const members=[...packageInputs],files=Object.fromEntries(members.map(name=>[name,Buffer.from('fixture-'+name)]));
    const archive=join(directory,'citizenserve-cloudflare-release.tgz'),bytes=tarGzip(files);writeFileSync(archive,bytes);
    const digest=createHash('sha256').update(bytes).digest('hex');
    const identity={version:'1.2.3',source_sha:'a'.repeat(40),run_id:42,run_attempt:2};
    const contents=members.map(path=>({path,bytes:files[path].length,sha256:createHash('sha256').update(files[path]).digest('hex')}));
    const bundle={schema:1,product_id:owner.product,platform:owner.platform,archive:basename(archive),path:archive,bytes:bytes.length,sha256:digest,contents};
    const invoked=[];
    assert.equal(await productCommand('test-product',{identity,invoke:(command,input,work)=>{invoked.push([command,input,work]);return {schema:2,product_id:owner.product,platform:owner.platform};}}),true);
    assert.equal(invoked[0][0],'test');
    const invoke=(command,input)=>{invoked.push([command,input]);return command==='package-members'?members:bundle;};
    for(const bad of [
      {...bundle,contents:[...contents.slice(0,9),contents[0]]},
      {...bundle,contents:[...contents.slice(0,9),{...contents[9],path:'owned/unknown'}]},
      {...bundle,contents:[...contents.slice(0,9),{...contents[9],sha256:'bad'}]},
    ])await assert.rejects(productCommand('build-cloudflare',{identity,environment:{RELEASE_ASSETS_DIR:directory},invoke:(command)=>command==='package-members'?members:bad}),/归属无效/u);
    assert.equal(await productCommand('build-cloudflare',{identity,environment:{RELEASE_ASSETS_DIR:directory},invoke}),true);
    const manifest=JSON.parse(readFileSync(join(directory,'release-manifest.json'),'utf8'));
    assert.equal(manifest.producer_run_id,42);assert.equal(manifest.producer_run_attempt,2);
    assert.equal(manifest.source_sha,identity.source_sha);assert.deepEqual(manifest.assets,contents);
    assert.equal(readdirSync(directory).length,3);
    assert.equal(invoked.at(-1)[0],'package-members');
    assert.equal(await productCommand('unknown',{identity}),false);
  });

  test('自动化只收集三件正式资产，缺件、多件或链接均拒绝',async t=>{
    const {mkdtempSync,realpathSync,symlinkSync}=await import('node:fs'),directory=realpathSync(mkdtempSync('/tmp/citizenserve-assets-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const identity={schema:1,product_id:owner.product,platform:owner.platform,run_id:42,run_attempt:2};
    const emit=()=>{};
    for(const name of owner.required_assets.slice(0,2))writeFileSync(join(directory,name),'synthetic-'+name);
    await assert.rejects(collectProduced({identity,directory,emit}),/集合不符/u);
    writeFileSync(join(directory,owner.required_assets[2]),'synthetic-sums');
    writeFileSync(join(directory,'extra.txt'),'unexpected');
    await assert.rejects(collectProduced({identity,directory,emit}),/集合不符/u);
    rmSync(join(directory,'extra.txt'));
    rmSync(join(directory,owner.required_assets[2]));symlinkSync(join(directory,owner.required_assets[0]),join(directory,owner.required_assets[2]));
    await assert.rejects(collectProduced({identity,directory,emit}),/普通文件/u);
    rmSync(join(directory,owner.required_assets[2]));writeFileSync(join(directory,owner.required_assets[2]),'synthetic-sums');
    const value=await collectProduced({identity,directory,emit});assert.deepEqual(value.assets.map(item=>item.name),owner.required_assets);
    assert.deepEqual(readdirSync(directory).sort(),[...owner.required_assets,'automation.json'].sort());
  });

  test('旧入口不能成为任一现行平台的清理归属证明',()=>{
    const current={id:9,path:workflowPath,head_branch:'main',event:'workflow_dispatch',created_at:'2026-01-02T00:00:00Z'};
    const old={...current,id:1,status:'completed',conclusion:'success',created_at:'2026-01-01T00:00:00Z'};
    for(const path of ['.github/workflows/release.yml',`.github/workflows/${owner.product}-${owner.platform}-ci.yml`,'.github/workflows/deleted.yml'])
      assert.deepEqual(cleanupPlan([{...old,path}],current,'success'),[]);
  });
  test('撤销当前产物失败仍处理旧失败且最终失败',async()=>{
    const current={id:9,path:workflowPath,head_branch:'main',event:'workflow_dispatch',created_at:'2026-01-02T00:00:00Z'};
    let releases=0,history=0;
    const api=async path=>{
      if(path.startsWith('releases?')){if(++releases===1)throw Error('撤销中断');return [];}
      if(path==='actions/runs/9')return current;
      if(path.startsWith('actions/runs?')){history++;return {workflow_runs:[]};}
      throw Error('未声明请求');
    };
    await assert.rejects(finish({build:{result:'failure'}},api,{run_id:9}),/撤销中断/);
    assert.equal(history,1);assert.equal(releases,2);
  });
  test('清理旧失败Run同时回收其多个Attempt的准确孤立Tag',async()=>{
    const old={id:2,run_attempt:2,path:workflowPath,head_branch:'main',event:'workflow_dispatch',head_sha:'a'.repeat(40),status:'completed',conclusion:'failure',created_at:'2026-01-01T00:00:00Z'},current={...old,id:9,status:'in_progress',created_at:'2026-01-02T00:00:00Z'};
    const deleted=new Set(),tags=[1,2].map(attempt=>({ref:`refs/tags/${prefix}1.0.0-r2-a${attempt}`,object:{type:'commit',sha:old.head_sha}}));
    const api=async(path,options={})=>{
      if(options.method==='DELETE'){deleted.add(path);return {};}
      if(deleted.has(path)||deleted.has(path.replace('git/ref/','git/refs/')))return null;
      if(path.startsWith('actions/runs?'))return {workflow_runs:[old,current]};
      if(path.startsWith('releases?')||path.includes('/artifacts?'))return path.includes('/artifacts?')?{artifacts:[]}:[];
      if(path.startsWith('git/matching-refs/'))return tags;
      if(path==='actions/runs/2')return old;if(path==='actions/runs/9')return current;
      throw Error('未声明的请求');
    };
    assert.deepEqual(await cleanup('failed',{run_id:9},api),[2]);assert.equal([...deleted].filter(path=>path.startsWith('git/refs/')).length,2);
  });
  test('全部前置成功才成功，其余结论一律失败',()=>{
    assert.equal(precedingResult({build:{result:'success'},publish:{result:'success'}}),'success');
    for(const result of ['failure','cancelled','skipped','timed_out',undefined])assert.equal(precedingResult({build:{result}}),'failed');
    assert.throws(()=>precedingResult({}));
  });
  test('当前Run尚在运行也能清理同目标旧结果，保护其它目标和活动任务',()=>{
    const row=(id,conclusion='success',status='completed',path=workflowPath)=>({id,conclusion,status,path,head_branch:'main',event:'workflow_dispatch',created_at:new Date(1700000000000+id*1000).toISOString()});
    const current=row(6,null,'in_progress');const rows=[row(1),row(2,'failure'),row(3,'success','in_progress'),row(4,'success','completed','.github/workflows/release-other.yml'),current,row(7)];
    assert.deepEqual(cleanupPlan(rows,current,'success').map(row=>row.id),[1]);
    assert.deepEqual(cleanupPlan(rows,current,'failed').map(row=>row.id),[2]);
  });
  test('Cargo软件版本进位与历史边界',()=>{
    assert.equal(nextVersion('1.0.0',['1.99.99']),'2.0.0');
    assert.equal(nextVersion('1.0.0',['1.9.9'],17),'1.9.10');
    assert.throws(()=>nextVersion('invalid',['1.0.0']));
  });
  test('历史完整分页不截断超过1000条记录',async()=>{
    const rows=Array.from({length:1005},(_,id)=>({id}));const api=async path=>rows.slice((Number(/page=(\d+)$/u.exec(path)[1])-1)*100,Number(/page=(\d+)$/u.exec(path)[1])*100);
    assert.equal((await pages('releases',null,api)).length,1005);
  });
  test('失败清理只删除所属旧失败产物及Run，成功和活动任务独立保留',async()=>{
    const row=(id,conclusion,status='completed')=>({id,run_attempt:1,conclusion,status,path:workflowPath,head_branch:'main',event:'workflow_dispatch',repository:{full_name:owner.repository},head_sha:'a'.repeat(40),created_at:new Date(1700000000000+id*1000).toISOString()});
    const current=row(10,null,'in_progress'),rows=[row(1,'success'),row(2,'failure'),row(3,null,'in_progress'),current];
    const gone=new Set(),removed=[];
    const api=async(path,options={})=>{
      if(options.method==='DELETE'){removed.push(path);gone.add(path);return {};}
      if(gone.has(path))return null;
      if(path.startsWith('actions/runs?'))return {workflow_runs:rows};
      if(path.startsWith('releases?')||path.startsWith('git/matching-refs/'))return [];
      if(path.startsWith('actions/runs/2/artifacts?'))return {artifacts:[{id:20}]};
      if(path==='actions/artifacts/20')return {id:20};
      const match=/^actions\/runs\/(\d+)$/u.exec(path);if(match)return rows.find(row=>row.id===Number(match[1]))??null;
      throw Error('未声明的模拟接口：'+path);
    };
    assert.deepEqual(await cleanup('failed',{run_id:10},api),[2]);
    assert.deepEqual(removed,['actions/artifacts/20','actions/runs/2']);
  });

  test('GitHub运行序号保证成功历史清理后版本不会回到初始值',()=>{
    assert.equal(nextVersion('1.0.0',[],4),'1.0.3');
    assert.equal(nextVersion('1.99.99',[],2),'2.0.0');
    assert.equal(nextVersion('1.0.0',['3.0.0'],4),'3.0.1');
    assert.throws(()=>nextVersion('1.0.0',[],0));
  });

}
