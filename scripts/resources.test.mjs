// 直接检查本产品真实资源配方；所有临时文件限定在本次平台测试工作根。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile, symlink, rm, realpath, chmod, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {prepare, protocolRequirements, requirements, verify, protocBytes, workerTestView, runTool, assertWorkQuiescent, applyBashPatch} from './resources.mjs';

async function fixture(callback) {
  const base = process.env.PRODUCT_WORK_DIR;
  assert.ok(base && resolve(base) === base && await realpath(base) === base);
  const work = join(base, 'resource-test-' + randomUUID());
  await mkdir(work, {mode: 0o700});
  try { await callback(work); } finally { assertWorkQuiescent(work); await rm(work, {recursive: true, force: true}); }
}
function zip(data = Buffer.from('synthetic executable'), change = () => {}) {
  const name = Buffer.from('bin/protoc');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  change(local, central, end);
  return Buffer.concat([local, name, data, central, name, end]);
}
test('固定SDK协议三件及protoc35只来自当前产品声明', async () => {
  const value = await protocolRequirements();
  assert.equal(value.product_id, 'citizenserve'); assert.equal(value.platform, 'cloudflare');
  assert.equal(value.tools[0].version, '35.0');
  assert.deepEqual(value.archives.map(x => x.name), ['message.proto', 'attachment.proto', 'chat_frame.proto']);
  assert.ok(value.archives.every(x => new URL(x.url).protocol === 'https:' && /^[a-f0-9]{64}$/u.test(x.sha256)));
});
test('真实准备回执及协议和工具字节再次验真', async () => {
  const receipt = await verify(process.env.TATACHAT_RESOURCE_RECEIPT);
  assert.equal(receipt.work, process.env.PRODUCT_WORK_DIR);
  assert.equal(process.env.PROTOC,receipt.protoc);
});
test('缺件控制台模式不能调用产品下载或切换独立模式', async () => fixture(async work => {
  let called = false;
  await assert.rejects(prepare({work, mode: 'console', fetcher: () => { called = true; throw Error(); }}), /供给身份/);
  assert.equal(called, false);
}));
test('供给身份必须绑定当前产品平台和工作根', async () => fixture(async work => {
  for (const field of ['product_id', 'platform', 'work']) {
    const supply = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work, [field]: 'other'};
    await assert.rejects(prepare({work, mode: 'console', supply}), /身份/);
  }
}));
test('供给路径经过链接时先拒绝，不接触下载', async () => fixture(async work => {
  const link = join(work, 'link'); await symlink(work, link);
  const supply = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work, dependency_root: link, tool_root: work};
  await assert.rejects(prepare({work, mode: 'console', supply}), /链接/);
}));
test('资源模式必须显式且永久存储不得进入源码', async () => fixture(async work => {
  await assert.rejects(prepare({work, mode: 'automatic'}), /显式/);
  await assert.rejects(prepare({work, mode: 'independent', store: work}), /源码外/);
}));
test('损坏回执不能冒充成功准备或自行覆盖', async () => fixture(async work => {
  const dir = join(work, 'tatachat-protocol'); await mkdir(dir);
  const path = join(dir, 'receipt.json'); await writeFile(path, '{}');
  await assert.rejects(verify(path), /身份/);
}));
test('ZIP提取只返回固定入口的原始字节', () => {
  const data = Buffer.from('opaque synthetic executable');
  assert.deepEqual(protocBytes(zip(data)), data);
});
test('ZIP越界截断和错误入口被拒绝', () => {
  for (const value of [Buffer.alloc(0), zip().subarray(0, 20), zip(undefined, (_a, _b, end) => end.writeUInt32LE(0xffffffff, 16))]) {
    assert.throws(() => protocBytes(value));
  }
});
test('ZIP加密链接及大小不符不能生成工具', () => {
  for (const edit of [
    (a, b) => { a.writeUInt16LE(1, 6); b.writeUInt16LE(1, 8); },
    (_a, b) => b.writeUInt32LE((0o120777 << 16) >>> 0, 38),
    (_a, b) => b.writeUInt32LE(1, 24),
    (_a, b) => b.writeUInt16LE(1, 34),
  ]) assert.throws(() => protocBytes(zip(undefined, edit)));
});

test('Worker需求直接引用本产品唯一npm锁，不在源码安装',async()=>{const r=await protocolRequirements();assert.ok(r.locks.some(x=>x.ecosystem==='npm'&&x.path==='test/worker/package-lock.json'&&x.purpose==='worker_runtime_tests'));});
test('Worker供给摘要及任务身份不符在任何复制执行前失败',async()=>fixture(async work=>{const file=join(work,'worker.json');await writeFile(file,'{}');await assert.rejects(workerTestView(file,'00'.repeat(32),work),/损坏/);const {createHash}=await import('node:crypto');const sum=createHash('sha256').update('{}').digest('hex');await assert.rejects(workerTestView(file,sum,work),/身份/);}));

// 完整流程资源回归只读取锁与合成归档；不获取或执行Linux原件。
import {cargoPackages, npmPackages, safeRelative, tarGzip, tarEntries, zipEntries,
  requireSuccessCount, cleanEnvironment, flowRequirements, githubDownload} from './resources.mjs';
import {gunzipSync} from 'node:zlib';
test('Cargo锁逐坐标取官方原件，未知Git或漏摘要拒绝', () => {
  const source = '[[package]]\nname = "sample"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' + 'a'.repeat(64) + '"\n';
  assert.equal(cargoPackages(source)[0].url, 'https://static.crates.io/crates/sample/sample-1.0.0.crate');
  assert.throws(() => cargoPackages(source.replace('registry+', 'git+')));
  assert.throws(() => cargoPackages(source.replace('a'.repeat(64), 'invalid')));
  assert.throws(() => cargoPackages('version = 4'));
});
test('npm锁按真实解析路径和libc选闭包，不把其它平台装进当前任务', () => {
  const packageEntry = (name, extra = {}) => ({version: '1.0.0', resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-1.0.0.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), ...extra});
  const lock = {lockfileVersion: 3, packages: {'': {devDependencies: {app: '1.0.0'}},
    'node_modules/app': packageEntry('app', {optionalDependencies: {linux: '1.0.0', darwin: '1.0.0', musl: '1.0.0'}}),
    'node_modules/linux': packageEntry('linux', {os: ['linux'], cpu: ['x64'], libc: ['glibc']}),
    'node_modules/darwin': packageEntry('darwin', {os: ['darwin'], cpu: ['arm64']}),
    'node_modules/musl': packageEntry('musl', {os: ['linux'], cpu: ['x64'], libc: ['musl']})}};
  assert.deepEqual(npmPackages(lock, 'linux-x64').map(p => p.path), ['node_modules/app', 'node_modules/linux']);
  assert.deepEqual(npmPackages(lock, 'darwin-arm64').map(p => p.path), ['node_modules/app', 'node_modules/darwin']);
  delete lock.packages['node_modules/app']; assert.throws(() => npmPackages(lock, 'linux-x64'));
});
test('本机声明只选择Darwin原件，Linux需求保持Runner自己的闭包', async () => {
  const mac = await flowRequirements('ci', 'darwin-arm64'), linux = await flowRequirements('ci', 'linux-x64');
  assert.ok(mac.tools.every(t => !t.archive.url.includes('linux')));
  assert.ok(linux.tools.some(t => t.archive.url.includes('linux')));
  assert.ok(mac.npm.every(p => !p.path.includes('linux')));
  await assert.rejects(flowRequirements('ci', 'windows-x64'));
});
test('工具环境忽略调用者PATH和下载覆盖变量，拒绝重写基础环境', () => {
  const tools = {node: '/verified/node', cargo: '/verified/cargo', git: '/verified/git'};
  const value = cleanEnvironment('/owned/work', tools);
  assert.equal(value.PATH, '/owned/work/bin'); assert.equal(value.PRODUCT_NODE_BIN, '/verified/node');
  assert.equal(value.CARGO_NET_OFFLINE, 'true'); assert.equal(value.MINIFLARE_WORKERD_PATH, undefined);
  assert.throws(() => cleanEnvironment('/owned/work', tools, {PATH: '/caller/path'}));
  assert.throws(() => cleanEnvironment('/owned/work', tools, {RUSTC_WRAPPER: '/caller/script'}));
});
test('归档闭集保持真实字节，路径、头校验和重复目录拒绝', () => {
  const entries = tarEntries(gunzipSync(tarGzip({'b.txt': Buffer.from('b'), 'a.txt': Buffer.from('a')})));
  assert.deepEqual([...entries.keys()], ['a.txt', 'b.txt']); assert.equal(entries.get('a.txt').data.toString(), 'a');
  for (const path of ['../outside', '/outside', 'a\\b', 'a//b', 'a/\nfile']) assert.throws(() => safeRelative(path));
  const broken = gunzipSync(tarGzip({'a.txt': Buffer.from('a')})); broken[0] ^= 1; assert.throws(() => tarEntries(broken));
  assert.deepEqual(zipEntries(zip(Buffer.from('data'))).get('bin/protoc').data, Buffer.from('data'));
});
test('退出0也须有真实非零用例，取消跳过和缺报告仍失败', () => {
  const value = {passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0}; assert.equal(requireSuccessCount(value, 'test'), value);
  for (const change of [{passed: 0}, {failed: 1}, {skipped: 1}, {todo: 1}, {cancelled: 1}, {passed: '1'}, {extra: true}]) {
    assert.throws(() => requireSuccessCount({...value, ...change}, 'test'));
  }
});
test('Artifact下载的令牌不跟随官方存储重定向，未知来源拒绝', async () => {
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    if (calls === 1) { assert.equal(options.headers.Authorization, 'Bearer synthetic'); return new Response(null, {status: 302, headers: {location: 'https://productionresultssa1.blob.core.windows.net/assets/fixture'}}); }
    assert.equal(options.headers.Authorization, undefined); return new Response('archive');
  };
  assert.equal((await githubDownload('/repos/crcfrcn/citizenserve/actions/artifacts/1/zip', {token: 'synthetic', request})).toString(), 'archive');
  await assert.rejects(githubDownload('/repos/crcfrcn/citizenserve/actions/artifacts/1/zip', {token: 'synthetic',
    request: async () => new Response(null, {status: 302, headers: {location: 'https://example.invalid/asset'}})}), /越界/u);
});

test('快速Node工具退出与非零失败均取得实际close，取消后才能清场', async () => fixture(async work => {
  const tools = {node: process.execPath};
  const actual = await runTool(process.execPath, ['-e', 'process.stdout.write("completed")'], {work, cwd: work, tools});
  assert.equal(actual.stdout, 'completed');
  await assert.rejects(runTool(process.execPath, ['-e', 'process.exit(7)'], {work, cwd: work, tools}), /未完整成功/u);
  const controller = new AbortController(), ready = join(work, 'child-ready');
  const child = 'require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)';
  const pending = runTool(process.execPath, ['-e', child, ready], {work, cwd: work, tools, signal: controller.signal});
  const observed = assert.rejects(pending, /未完整成功|取消|aborted/iu);
  try {
    const {readFile} = await import('node:fs/promises'); let started = false;
    for (let n = 0; n < 100 && !started; n++) {
      try { started = (await readFile(ready, 'utf8')) === 'ready'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!started) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(started, true, '必须真实启动子进程后再验证取消');
  } finally { controller.abort(); await observed; }
  assertWorkQuiescent(work);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runTool(process.execPath, ['-e', 'process.exit(0)'], {work, cwd: work, tools, signal: cancelled.signal}));
}));
test('Bash官方context省略侧从完整上下文恢复，错原行与越界拒绝', async () => fixture(async work => {
  const source = join(work, 'sample.c'); await writeFile(source, 'first\nlast\n');
  const patch = Buffer.from('*** upstream/sample.c\n--- sample.c\n***************\n*** 1,2 ****\n--- 1,3 ----\n  first\n+ added\n  last\n');
  await applyBashPatch(work, patch);
  const {readFile} = await import('node:fs/promises'); assert.equal(await readFile(source, 'utf8'), 'first\nadded\nlast\n');
  await assert.rejects(applyBashPatch(work, Buffer.from('*** upstream/sample.c\n--- ../outside\n')), /路径/u);
  await assert.rejects(applyBashPatch(work, Buffer.from('*** upstream/sample.c\n--- sample.c\n***************\n*** 1,2 ****\n  absent\n! line\n--- 1,2 ----\n  absent\n! changed\n')), /原行/u);
}));

import {Duplex} from 'node:stream';
import {xzBytes,exchangeBuildResourceFrame,claimBuildWork,buildOutputDigest} from './resources.mjs';
import {fileURLToPath} from 'node:url';
const productRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/u,'');
test('本机完整Build的最小闭包及准确Mac标准库坐标来自产品声明',async()=>{
 const mac=await flowRequirements('build','darwin-arm64');
 assert.deepEqual(mac.tools.map(x=>x.id),['node','rust','protoc','worker-build','wasm-bindgen','wasm-opt']);
 assert.ok(mac.tools.every(x=>x.slots.length&&/^[a-f0-9]{64}$/u.test(x.recipe_sha256)));
 assert.equal(mac.tools.find(x=>x.id==='rust').components[0].sha256,'fa0edb6e9f34faae5735554d62d50875eded839dc707d0f1c01467a918d8453b');
 assert.deepEqual(mac.npm.map(x=>x.path).sort(),['node_modules/@esbuild/darwin-arm64','node_modules/esbuild']);
 assert.deepEqual(mac.apple.names,['clang','ar','ranlib','xcrun']);
 const linux=await flowRequirements('build','linux-x64');
 assert.equal(linux.tools.find(x=>x.id==='rust').components[0].sha256,'13902d5573eeea50701d75acc774b6df2dfb4942ec88cdbe40bb07e448c307ea');
 await assert.rejects(requirements('cloudflare',join(productRoot,'target/other')));
});
test('领取固定Build现场前拒绝缺任务ID及越界路径，不触碰已有文件',async()=>fixture(async work=>{
 const sentinel=join(work,'keep');await writeFile(sentinel,'untouched');
 for(const id of [undefined,null,'','bad/id'])await assert.rejects(claimBuildWork(id,work),/坐标/);
 await assert.rejects(claimBuildWork(undefined,join(productRoot,'target/build')),/坐标/);
 assert.equal(await readFile(sentinel,'utf8'),'untouched');
}));
test('完整Build输出摘要与控制台文件协议一致，模式变化产生不同摘要',async()=>fixture(async work=>{
 const path=join(work,'worker.wasm'),bytes=Buffer.from([0,97,115,109,1,0,0,0]);await writeFile(path,bytes,{mode:0o600});
 const expected=createHash('sha256').update(Buffer.concat([Buffer.from(JSON.stringify(['','file',false,bytes.length])+'\n'),bytes])).digest('hex');
 assert.equal(await buildOutputDigest(path),expected);await chmod(path,0o700);assert.notEqual(await buildOutputDigest(path),expected);
}));
class ResourceWire extends Duplex{
 sent=[];_read(){} _write(data,_encoding,done){this.sent.push(JSON.parse(data.toString()));done();}
 reply(value){this.push(JSON.stringify(value)+'\n');}
}
function frameFixture(){
 const stream=new ResourceWire(),request={schema:1,product_id:'citizenserve',platform:'cloudflare',work:'/owned/build',run_id:'123456789',resource_mode:'provided'},plan={schema:1,product_id:'citizenserve',flow:'build',tools:[]};
 return {stream,request,plan};
}
test('FD4只发送当前身份及真实需求摘要，小回执不传归档和工具清单',async()=>{
 const {stream,request,plan}=frameFixture(),waiting=exchangeBuildResourceFrame(stream,request,plan);
 assert.equal(stream.sent.length,1);assert.equal(stream.sent[0].requirements_digest,createHash('sha256').update(JSON.stringify(plan)).digest('hex'));
 assert.deepEqual(stream.sent[0].identity,{product_id:request.product_id,platform:request.platform,work:request.work,run_id:request.run_id});
 const value={schema:1,product_id:request.product_id,platform:request.platform,flow:'build',work:request.work,run_id:request.run_id,mode:'console',receipt:request.work+'/resources.json',sha256:'a'.repeat(64)};
 stream.reply({id:'1',ok:true,value});assert.deepEqual(await waiting,value);assert.equal(stream.destroyed,true);
});
test('资源通道截断、失败、多帧、任务漂移和取消均拒绝，绝不切换独立准备',async()=>{
 for(const kind of ['closed','failure','extra','identity','cancel']){
  const {stream,request,plan}=frameFixture(),abort=new AbortController(),waiting=exchangeBuildResourceFrame(stream,request,plan,abort.signal),rejected=assert.rejects(waiting);
  if(kind==='closed')stream.push(null);
  if(kind==='failure')stream.reply({id:'1',ok:false,error:'缺件'});
  if(kind==='extra')stream.push('{"id":"1","ok":true,"value":{}}\n{}\n');
  if(kind==='identity')stream.reply({id:'1',ok:true,value:{run_id:'other',mode:'console'}});
  if(kind==='cancel')abort.abort();
  await rejected;assert.equal(stream.destroyed,true);assert.equal(stream.sent.length,1);
 }
});
// CPython官方LZMA测试的独立编码样本；输入为公共领域莎士比亚文本。
// https://github.com/python/cpython/blob/v3.14.3/Lib/test/test_lzma.py
// PSF许可证：https://docs.python.org/3/license.html；仅保存压缩样本和预期摘要，不执行其测试源码。
const xzGolden=Buffer.from('fd377a585a000004e6d6b4460200210116000000742fe5a3e0078003df5d00051407625819cddd6e9815e4b49d6f1dc4e50a03cc3268c75c86fff8e2fce7d9fe36b828a87764c222752e6e1ec3f28e8d8f02172fa63df0a2df2f4d89bedea71c7a182d5dd5ef138f725a15808cf88d6ffa129b237a2feff0fa460182a34d8ea174ca3620424624e551a498eede6ce87ff09d2c626e0b13d4a881e44ec8861533f57832a24f134051a1002fa5d04f97dc6faef77ac4cd53b6743c16f29c4923897564c63659d9eee6ce125de5f0aa962d5065ad653a04091bf7db370a861f70c84abaf4f056a9dcf0022547f9df3d3f151be128ce823dd649ac33120c52b7ae0db169039501bdbefa027301509d9658b1326ac84ca88462f6c3d4632d48936f4a6cd06951e46b840bc1b7bcb11788b1ca3f40f607eae678f1483132500f8ac9ea7577e3beaa69a957d080cd2363623599d85da9640cbda2dc576ced5547bf897946f7378176bd3598be6838185708f01b99353a1a3f724496a1040faeba85eb9d3540f583d337838a6306d49769cd741653826bf64b01767988919b3654da650dfd5d3a6bba6ca9bb61c334f972eb7d72dbc7db2a8f037adc3868ccc9d3bc6ca52dcbea4ba2c515c0e3c1865afbeb4ce133cf9ce31dc9edc206ccce2192e5fe9c5ea53977209b50a3504b0864f9e25a7da7bfedeb25240c82b82fb001a9262cf771687b519629f27196c380b412b0bae66ff421b45bd48a7710f7740cb3d9d5c3605e81113f3f5ca4998552d48e83c91e58bf61f1acb0eaead7d0ab18e2f2ede1b7c918cb53e43ec99548e8cb090d25ebc7242e6ff1f352171d62bbd855a55ecc53160187f32f93d1f076c072d7cca2476b7aca800efdd08bbbd24978b31e79ca2d30e37a5ed6d68f5ff19d509f69a7d1e89084dcbfcd6b798edc817fa3b22bbf04efd85cc4dfe1b001e993e359f11d59e86881cff177ccb4ef208b7c04ea83656abe1fd47a9c60d31a924106e58fa913099e3dfa1ce55f9f25761b6f115a4fd8f409dd4d162d04fc183c22434ddd677e62f6ef8e0cd0de7ca0278a0cd678ae214aa646881575003817bc3779b3d875ac5f858de7c1409cec7163a323adf19335b5295f0dec335d0f6f5d35d06d79079bee81b50fcf4b2b00c0e46210e40c1a209be09774f6a19e8530ba0c9a8dc88f07d7aec8f92b69dcb96bb03e6619b80da8f81f24a57b70c68830cedbcfca5f86ac8868368b5a2527d00abf0f9c22bae5869f0f37583d6d4e585bcc194655c98630bc90612b2a20ae5f24031ed3cd5fa09cdeaf343671a5c992d7cae3609d857db4ffb383fbb6caae600b777ffcd8ac566519c8170b5aad88eb23970313b1640f7b0c0477070d97bdd6c1c3423a95085e1056ae614802d9e30a5c0158f69c8a06752325be2aa1187685ec21093400000000566a3f754c55f3a60001fb07810f000074779950b1c467fb020000000004595a','hex');
test('真实压缩LZMA2样本逐字节摘要正确，无系统xz依赖',async()=>{const bytes=await xzBytes(xzGolden);assert.equal(bytes.length,1921);assert.equal(createHash('sha256').update(bytes).digest('hex'),'b64857892c3f1ff008e910d6f8786bffb7f6651b7c5ea58ae3b7975d3ac119de');});

test('XZ头、压缩数据、索引、尾损坏及截断均拒绝，取消不返回部分输出',async()=>{
 for(const offset of [8,40,xzGolden.length-16,xzGolden.length-12]){const bad=Buffer.from(xzGolden);bad[offset]^=1;await assert.rejects(xzBytes(bad));}
 await assert.rejects(xzBytes(xzGolden.subarray(0,-4)));
 const abort=new AbortController();abort.abort();await assert.rejects(xzBytes(xzGolden,abort.signal));
});
