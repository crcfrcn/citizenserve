import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('citizenserve.cloudflare.ci的check远端Job物理独立', () => {
  const source = readFileSync(new URL('./execute.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('{"pipeline":"citizenserve.cloudflare.ci","job":"check"}'));
  assert.match(source, /function runExactWorkflowStep\(index\)/u);
  assert.match(source, /function requireExactRemoteJobEnvironment\(\)/u);
});


import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateTestShell, runShellTests, prepareTestShell, shellOriginal,
  TEST_SHELL_SOURCE, TEST_SHELL_BOOTSTRAP, EXACT_REMOTE_JOB_IDENTITY } from './execute.mjs';

// 只模拟公开工具回执和版本探测；不编译GNU、不触发npm下载或真实远端流程。
function shellFixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'citizenserve-shell-')));
  const kind=EXACT_REMOTE_JOB_IDENTITY.pipeline.endsWith('.ci')?'ci':'release';
  const object=join(root,'citizenserve-cloudflare-'+kind+'-shell','tools','bash'),entry=join(object,'payload','bin','bash');
  mkdirSync(dirname(entry),{recursive:true});writeFileSync(entry,'fixture executable\n',{mode:0o755});
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const receipt={pipeline:EXACT_REMOTE_JOB_IDENTITY.pipeline,source:structuredClone(TEST_SHELL_SOURCE),
    bootstrap:{commands:TEST_SHELL_BOOTSTRAP.commands.map(p=>({...p,sha256:'a'.repeat(64)})),packages:TEST_SHELL_BOOTSTRAP.packages.map(({name,version})=>({name,version}))},
    sha256:digest('fixture executable\n'),files:[{path:'payload/bin/bash',sha256:digest('fixture executable\n'),mode:0o755}]};
  const path=join(object,'receipt.json'),write=()=>writeFileSync(path,JSON.stringify(receipt,null,2)+'\n');
  write();
  const environment={RUNNER_TEMP:root,PRODUCT_SHELL_BIN:entry,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'crcfrcn/citizenserve',
    GITHUB_WORKFLOW:EXACT_REMOTE_JOB_IDENTITY.pipeline,GITHUB_JOB:'flow',GITHUB_EVENT_NAME:'workflow_dispatch'};
  const version=(command,args,options)=>{assert.equal(command,entry);assert.deepEqual(args,['--version']);assert.equal(options.env.BASH_ENV,undefined);return 'GNU bash, version 5.3.20(1)-release (fixture)\n';};
  return {root,entry,object,receipt,write,environment,version,close:()=>rmSync(root,{recursive:true})};
}

test('本流程Shell正常回执向真实测试命令显式交付唯一入口',()=>{
  const fixture=shellFixture();
  try {
    assert.equal(validateTestShell(fixture.environment,fixture.version),fixture.entry);
    let calls=0;
    const result=runShellTests({...fixture.environment,BASH_ENV:'/untrusted/preload'},(command,args,options)=>{
      calls++;assert.equal(command,fixture.entry);assert.equal(args.at(-1),'npm test');
      assert.equal(options.env.PRODUCT_SHELL_BIN,fixture.entry);
      assert.equal(options.env.npm_config_script_shell,fixture.entry);assert.equal(options.env.BASH_ENV,undefined);
      return {status:0};
    },fixture.version);
    assert.equal(calls,1);assert.equal(result.status,0);
  } finally {fixture.close();}
});
test('本流程Shell拒绝缺失相对路径普通性链接祖先和错误版本',()=>{
  const fixture=shellFixture();
  try {
    const link=join(fixture.root,'bash-link');symlinkSync(fixture.entry,link);
    const ancestor=join(fixture.root,'parent-link');symlinkSync(dirname(fixture.entry),ancestor);
    for(const value of [undefined,'bash',fixture.object,link,join(ancestor,'bash')])assert.throws(()=>validateTestShell({...fixture.environment,PRODUCT_SHELL_BIN:value},fixture.version));
    chmodSync(fixture.entry,0o644);assert.throws(()=>validateTestShell(fixture.environment,fixture.version),/普通/u);
    chmodSync(fixture.entry,0o755);
    assert.throws(()=>validateTestShell(fixture.environment,()=> 'GNU bash, version 5.2.21(1)-release'),/版本/u);
    assert.throws(()=>validateTestShell(fixture.environment,()=>{throw Error('version process failed');}),/version process failed/u);
  } finally {fixture.close();}
});
test('本流程Shell拒绝错源错摘要跨身份回执及对象漂移',()=>{
  for(const mutate of [
    f=>{f.receipt.pipeline='citizenserve.cloudflare.other';},
    f=>{f.receipt.source.sha256='0'.repeat(64);},
    f=>{f.receipt.sha256='0'.repeat(64);},
    f=>{f.receipt.source.upstream_patches.pop();},
    f=>{f.receipt.bootstrap.commands[0].path='/other/command';},
    f=>{f.receipt.bootstrap.packages[0].version='0';},
    f=>{f.receipt.files=[];},
    f=>{writeFileSync(join(f.object,'unexpected'),'not in receipt');},
  ]) {
    const fixture=shellFixture();
    try {mutate(fixture);fixture.write();assert.throws(()=>validateTestShell(fixture.environment,fixture.version));}
    finally {fixture.close();}
  }
});
test('本流程Shell拒绝阶段失败与未经所属身份的工具准备',async()=>{
  const fixture=shellFixture();
  try {
    for(const result of [{status:1},{status:null,error:Error('spawn failure')}])assert.throws(()=>runShellTests(fixture.environment,()=>result,fixture.version),/测试命令失败/u);
    await assert.rejects(prepareTestShell({...fixture.environment,GITHUB_WORKFLOW:'other'},{request:()=>assert.fail('错误身份不能联网')}),/身份/u);
    assert.throws(()=>validateTestShell({...fixture.environment,GITHUB_JOB:'other'},fixture.version),/身份/u);
  } finally {fixture.close();}
});
test('本流程GNU原件拒绝摘要漂移网络失败和重定向越界',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'citizenserve-original-')));
  const bytes=Buffer.from('GNU fixture'),record={...TEST_SHELL_SOURCE,sha256:createHash('sha256').update(bytes).digest('hex')};
  // 从同一登记坐标构造明文输入，只验证拒绝分支，不登记运行地址或发出网络请求。
  const insecure=new URL(record.url);insecure.protocol='http:';
  try {
    await shellOriginal(record,join(root,'accepted'),async(_url,options)=>{assert.equal(options.redirect,'manual');return new Response(bytes);});
    await assert.rejects(shellOriginal({...record,url:insecure.href},join(root,'rejected'),async()=>assert.fail('非法来源不能联网')));
    for(const response of [new Response('wrong'),new Response('',{status:404}),new Response('',{status:302}),
      new Response('',{status:302,headers:{location:'https://example.invalid/original'}}),
      new Response('',{status:302,headers:{location:insecure.href}})])await assert.rejects(shellOriginal(record,join(root,'rejected'),async()=>response));
  } finally {rmSync(root,{recursive:true});}
});

// 两个镜像必须保持同一原件身份；只模拟响应，真实获取仍由正常入口完整验真。
test('GNU固定镜像的连接恢复摘要失败与来源闭集', async () => {
  const {sourceMirrors, requestGNUOriginal} = await import("./execute.mjs");
  const {shellOriginal:readOriginal} = await import('./execute.mjs');
  const {mkdtempSync, readFileSync, existsSync, rmSync} = await import('node:fs');
  const {join} = await import('node:path'); const {tmpdir} = await import('node:os');
  const {createHash} = await import('node:crypto');
  const bytes = Buffer.from('same locked GNU fixture'), file = 'bash/bash-5.3.tar.gz';
  const record = {url:'https://ftp.gnu.org/gnu/' + file,
    sha256:createHash('sha256').update(bytes).digest('hex'),
    mirrors:['https://mirrors.ocf.berkeley.edu/gnu/','https://mirror.csclub.uwaterloo.ca/gnu/'].map(base => base + file)};
  const addresses = sourceMirrors(record);
  assert.equal(addresses.length, 3);
  for (const mirrors of [undefined, [], record.mirrors.slice(0,1), [...record.mirrors].reverse(),
    [record.mirrors[0],record.mirrors[0]], record.mirrors.map(url => url.replace('https:', 'ht'+'tp:')),
    record.mirrors.map(url => url + '?unregistered=1'), ['https://other.invalid/' + file,record.mirrors[1]]]) {
    assert.throws(() => sourceMirrors({...record,mirrors}));
  }
  const calls = [];
  const connected = await requestGNUOriginal(record, async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'manual');
    if (calls.length === 1) throw Object.assign(new TypeError('fixture connection timeout'), {cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
    return new Response(bytes);
  });
  assert.deepEqual(calls, addresses.slice(0,2)); assert.deepEqual(Buffer.from(await connected.response.arrayBuffer()), bytes);
  const unavailable = [];
  await requestGNUOriginal(record, async url => {
    unavailable.push(url); return unavailable.length < 3 ? new Response(null,{status:503}) : new Response(bytes);
  });
  assert.deepEqual(unavailable, addresses);
  let tlsCalls = 0;
  await assert.rejects(requestGNUOriginal(record, async () => {tlsCalls++; throw Object.assign(Error('fixture invalid TLS'),{cause:{code:'CERT_HAS_EXPIRED'}});}));
  assert.equal(tlsCalls,1);
  let redirectCalls = 0;
  await assert.rejects(requestGNUOriginal(record, async () => {redirectCalls++; return new Response(null,{status:302,headers:{location:'https://other.invalid/original'}});}));
  assert.equal(redirectCalls,1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestGNUOriginal(record, () => assert.fail('取消不得联网'), {signal:controller.signal}));
  const root = mkdtempSync(join(tmpdir(),'gnu-mirror-'));
  try {
    const path = join(root,'original'); let attempts = 0;
    await readOriginal(record, path, async () => ++attempts === 1 ? new Response(null,{status:503}) : new Response(bytes));
    assert.equal(attempts,2); assert.deepEqual(readFileSync(path),bytes);
    let corrupted = 0; const rejected = join(root,'rejected');
    await assert.rejects(readOriginal({...record,sha256:'0'.repeat(64)}, rejected, async () => {corrupted++; return new Response(bytes);}));
    assert.equal(corrupted,1); assert.equal(existsSync(rejected),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});


// 合成已安装包快照验证依赖选择，不联网、安装包或运行本机Ubuntu工具。
test('Ubuntu虚拟依赖保留提供包的Depends与Pre-Depends闭包',async()=>{
  const {resolveBootstrapPackages:resolve}=await import('./execute.mjs');
  const status='install ok installed',roots=[{name:'compiler',version:'1'}],compare=(a,operator,b)=>operator==='='?a===b:operator==='>='&&Number(a)>=Number(b);
  const rows=[{name:'compiler',version:'1',status,depends:'awk'},
    {name:'mawk',version:'99',status,provides:'awk',depends:'libc (>= 2)',preDepends:'loader'},
    {name:'libc',version:'2',status},{name:'loader',version:'1',status}];
  assert.deepEqual(resolve(rows,roots,compare).map(row=>row.name),['compiler','libc','loader','mawk']);
  assert.deepEqual(resolve([{...rows[0],depends:'missing | awk'},...rows.slice(1)],roots,compare).map(row=>row.name),['compiler','libc','loader','mawk']);
  assert.deepEqual(resolve([...rows,{name:'awk',version:'1',status}],roots,compare).map(row=>row.name),['awk','compiler']);
  for(const changed of [rows.filter(row=>row.name!=='mawk'),rows.map(row=>row.name==='mawk'?{...row,status:'deinstall ok config-files'}:row),
    rows.filter(row=>row.name!=='loader'),rows.map(row=>row.name==='libc'?{...row,version:'1'}:row)])assert.throws(()=>resolve(changed,roots,compare));
  assert.throws(()=>resolve(rows,[{name:'awk',version:'99'}],compare));
  assert.throws(()=>resolve(rows,[{name:'compiler',version:'2'}],compare));
  assert.throws(()=>resolve([...rows,rows[0]],roots,compare));
  assert.throws(()=>resolve([{...rows[0],depends:'invalid [amd64]'},...rows.slice(1)],roots,compare));
  assert.throws(()=>resolve([{...rows[0],depends:'libc (>= 2)'},...rows.slice(1)],roots,()=>{throw Error('比较器失败');}),/比较器失败/u);
});
test('UbuntuProvides按声明版本匹配并保留同名不同版本',async()=>{
  const {resolveBootstrapPackages:resolve}=await import('./execute.mjs');
  const status='install ok installed',roots=[{name:'compiler',version:'1'}],compare=(a,operator,b)=>operator==='='&&a===b;
  const rows=[{name:'compiler',version:'1',status,depends:'dpkg-build-api (= 1), debhelper-compat (= 13)'},
    {name:'dpkg-dev',version:'99',status,provides:'dpkg-build-api (= 0), dpkg-build-api (= 1)'},
    {name:'debhelper',version:'99',status,provides:'debhelper-compat (= 9), debhelper-compat (= 10), debhelper-compat (= 11), debhelper-compat (= 12), debhelper-compat (= 13)'}];
  for(const api of ['0','1'])for(const compat of ['9','10','11','12','13'])assert.deepEqual(
    resolve([{...rows[0],depends:'dpkg-build-api (= '+api+'), debhelper-compat (= '+compat+')'},...rows.slice(1)],roots,compare).map(row=>row.name),
    ['compiler','debhelper','dpkg-dev']);
  for(const depends of ['dpkg-build-api (= 2)','dpkg-build-api (= 99)','debhelper-compat (= 14)'])assert.throws(()=>resolve([{...rows[0],depends},...rows.slice(1)],roots,compare));
  for(const provides of ['dpkg-build-api','dpkg-build-api (= 0), dpkg-build-api (= 0)',
    'dpkg-build-api (=0), dpkg-build-api (= 0)','dpkg-build-api, dpkg-build-api','dpkg-build-api (>= 1)'])assert.throws(
    ()=>resolve([rows[0],{...rows[1],provides},rows[2]],roots,compare));
});
