// 聊天协议资源配方归本产品；控制台供给与独立准备共用同一声明及验真。
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {inflateRawSync, gunzipSync, gzipSync, zstdDecompressSync} from 'node:zlib';
import {lstat, realpath, readFile, writeFile, mkdir, rename, rm, link, readdir, chmod} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Socket} from 'node:net';

const unsafeWork = new Set();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = message => { throw Error('聊天资源：' + message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (base, value) => value.startsWith(base + sep);

// 父路径逐层核验，拒绝链接、特殊文件、硬链接及不规范路径。
async function checked(path, kind, create = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('路径必须是规范绝对路径');
  if (create) {
    const parent = dirname(path);
    if (parent === path) fail('资源根无效');
    await checked(parent, 'directory');
    try { await mkdir(path, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (let at = path; ; at = dirname(at)) {
    const info = await lstat(at);
    if (info.isSymbolicLink() || await realpath(at) !== at) fail('路径经过链接');
    if (at === path) {
      if (kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) fail('资源类型无效');
    } else if (!info.isDirectory()) fail('父路径不是目录');
    if (dirname(at) === at) break;
  }
  return path;
}
async function declaration() {
  const file = await checked(join(root, 'scripts/flows.json'), 'file');
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data.schema !== 1 || data.product_id !== 'citizenserve' || !data.tatachat) fail('所属产品声明缺失');
  const value = data.tatachat;
  if (!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+\.git$/u.test(value.protocol?.source)
      || !/^[a-f0-9]{40}$/u.test(value.protocol.commit)
      || value.protocol.files?.length !== 3
      || new Set(value.protocol.files.map(x => x.name)).size !== 3) fail('固定协议来源无效');
  for (const file of value.protocol.files) {
    if (!/^[a-z_]+\.proto$/u.test(file.name) || file.source_path !== 'lib/src/protocol/' + file.name
        || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 65536) fail('协议条目无效');
  }
  const archive = value.protoc?.archives?.[process.platform + '-' + process.arch];
  if (value.protoc?.id !== 'protoc' || value.protoc.version !== '35.0'
      || !archive || !/^https:\/\/github\.com\/protocolbuffers\/protobuf\/releases\/download\/v35\.0\/protoc-35\.0-[a-z0-9_-]+\.zip$/u.test(archive.url)
      || !/^[a-f0-9]{64}$/u.test(archive.sha256)) fail('当前宿主没有获准protoc原件');
  return {value, archive};
}
async function workDirectory(work) {
  await checked(work, 'directory');
  const base = join(root, 'target');
  if (!inside(base, work) || !['build', 'test'].includes(work.slice(base.length + 1).split(sep)[0])) fail('工作目录越界');
  return work;
}
export async function protocolRequirements() {
  const {value, archive} = await declaration();
  const repository = value.protocol.source.slice('https://github.com/'.length, -4);
  return {schema: 1, product_id: 'citizenserve', platform: 'cloudflare',
    locks: [{ecosystem: 'cargo', path: 'Cargo.lock'}, {ecosystem: 'npm', path: 'test/worker/package-lock.json', purpose:'worker_runtime_tests'}],
    tools: [{...value.protoc, archives: undefined, archive}],
    archives: value.protocol.files.map(file => ({name: file.name, bytes: file.bytes, sha256: file.sha256,
      url: 'https://raw.githubusercontent.com/' + repository + '/' + value.protocol.commit + '/' + file.source_path}))};
}

// 只提取固定可执行文件；归档先验真，禁止执行自解压、PATH解压器或归档内脚本。
export function protocBytes(zip) {
  if (zip.length > 32 * 1024 ** 2) fail('protoc归档超限');
  let end = -1;
  for (let n = zip.length - 22; n >= Math.max(0, zip.length - 65557); n--) {
    if (zip.readUInt32LE(n) === 0x06054b50 && n + 22 + zip.readUInt16LE(n + 20) === zip.length) { end = n; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)
      || zip.readUInt16LE(end + 8) !== zip.readUInt16LE(end + 10)) fail('ZIP目录无效');
  const count = zip.readUInt16LE(end + 10), size = zip.readUInt32LE(end + 12), start = zip.readUInt32LE(end + 16);
  if (count > 4096 || start + size !== end) fail('ZIP目录越界');
  let at = start, result;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) fail('ZIP条目损坏');
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20), length = zip.readUInt32LE(at + 24);
    const names = zip.readUInt16LE(at + 28), extras = zip.readUInt16LE(at + 30), comments = zip.readUInt16LE(at + 32);
    const next = at + 46 + names + extras + comments;
    if (next > end || zip.readUInt16LE(at + 34)) fail('ZIP条目越界');
    const nameBytes = zip.subarray(at + 46, at + 46 + names), name = nameBytes.toString('utf8');
    if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.')) fail('ZIP路径无效');
    if (name === 'bin/protoc') {
      const mode = zip.readUInt32LE(at + 38) >>> 16, offset = zip.readUInt32LE(at + 42);
      if (result || flags & 1 || ![0, 8].includes(method) || length > 32 * 1024 ** 2 || length < 1
          || mode && (mode & 0xf000) !== 0x8000 || offset + 30 > start || zip.readUInt32LE(offset) !== 0x04034b50) fail('protoc条目无效');
      const localNames = zip.readUInt16LE(offset + 26), localExtras = zip.readUInt16LE(offset + 28);
      const begin = offset + 30 + localNames + localExtras;
      if (begin + packed > start || !zip.subarray(offset + 30, offset + 30 + localNames).equals(nameBytes)
          || zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method) fail('ZIP本地头不一致');
      const data = zip.subarray(begin, begin + packed);
      result = method === 0 ? Buffer.from(data) : inflateRawSync(data, {maxOutputLength: 32 * 1024 ** 2});
      if (result.length !== length) fail('protoc展开大小不符');
    }
    at = next;
  }
  if (at !== end || !result) fail('protoc入口缺失');
  return result;
}
async function bounded(path, maximum) {
  await checked(path, 'file');
  if ((await lstat(path)).size > maximum) fail('资源超限');
  const bytes = await readFile(path);
  if (bytes.length > maximum) fail('读取资源超限');
  return bytes;
}
async function archive(path, entry, maximum) {
  const bytes = await bounded(path, maximum);
  if (digest(bytes) !== entry.sha256 || entry.bytes && bytes.length !== entry.bytes) fail('资源摘要或长度不符');
  return bytes;
}
async function tool(path, bytes, work, signal) {
  const current = await bounded(path, 32 * 1024 ** 2);
  if (!current.equals(bytes) || !((await lstat(path)).mode & 0o111)) fail('protoc运行字节不属于固定归档');
  const {stdout} = await runTool(path, ['--version'], {work, tools: {node: process.execPath}, signal, timeout: 10000});
  if (stdout.trim() !== 'libprotoc 35.0') fail('protoc版本不符');
}
async function fetchOriginal(entry, store, {offline, signal, fetcher}) {
  const destination = join(store, entry.sha256 + '.blob');
  try { await lstat(destination); return await archive(destination, entry, 32 * 1024 ** 2); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (offline) fail('离线缺少固定原件');
  signal?.throwIfAborted();
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  let url = entry.url, response;
  for (let n = 0; n <= 5; n++) {
    response = await fetcher(url, {signal: requestSignal, redirect: 'manual', credentials: 'omit'});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || n === 5) fail('官方资源重定向无效');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.hash
        || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) fail('官方资源重定向越界');
    url = next.href;
  }
  if (!response.ok || !response.body) fail('官方固定资源获取失败');
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    requestSignal.throwIfAborted(); count += chunk.length;
    if (count > 32 * 1024 ** 2) fail('官方资源超限');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== entry.sha256 || entry.bytes && bytes.length !== entry.bytes) fail('官方资源验真失败');
  const temporary = join(store, '.' + randomUUID() + '.pending');
  try {
    await writeFile(temporary, bytes, {flag: 'wx', mode: 0o444});
    signal?.throwIfAborted();
    // 同摘要提交是短暂原子操作；不锁住下载，不覆盖任何已有原件。
    try { await link(temporary, destination); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } finally { await rm(temporary, {force: true}); }
  return archive(destination, entry, 32 * 1024 ** 2);
}
export async function prepare({work, mode, store, toolStore = store, supply, offline = false, signal, fetcher = fetch}) {
  await workDirectory(work);
  if (!['independent', 'console'].includes(mode)) fail('供给模式必须显式选择');
  const requested = await protocolRequirements(); let originals, executable, originalPath;
  if (mode === 'console') {
    // 控制台必须先按公开需求准备供给；缺件、损坏或越界绝不自行下载。
    if (!supply || supply.schema !== 1 || supply.product_id !== 'citizenserve'
        || supply.platform !== 'cloudflare' || supply.work !== work) fail('控制台供给身份不符');
    await checked(supply.dependency_root, 'directory'); await checked(supply.tool_root, 'directory');
    originalPath = supply.protoc_archive;
    if (!inside(supply.tool_root, originalPath) || !inside(supply.tool_root, supply.protoc) && !inside(work, supply.protoc)) fail('工具供给越界');
    executable = protocBytes(await archive(originalPath, requested.tools[0].archive, 32 * 1024 ** 2));
    await tool(supply.protoc, executable, work, signal);
    originals = [];
    for (const entry of requested.archives) {
      signal?.throwIfAborted(); const path = supply.protocol?.[entry.name];
      if (!inside(supply.dependency_root, path ?? '')) fail('协议供给越界');
      originals.push(await archive(path, entry, 65536));
    }
  } else {
    if (supply) fail('独立模式不混入控制台供给');
    await checked(store, 'directory');
    if (store === root || inside(root, store)) fail('永久资源必须位于产品源码外');
    const options = {offline, signal, fetcher};
    const entry = requested.tools[0].archive;
    await checked(toolStore, 'directory');
    if (toolStore === root || inside(root, toolStore)) fail('工具永久原件必须位于源码外');
    executable = protocBytes(await fetchOriginal(entry, toolStore, options));
    originalPath = join(toolStore, entry.sha256 + '.blob'); originals = [];
    for (const file of requested.archives) originals.push(await fetchOriginal(file, store, options));
  }
  const destination = join(work, 'tatachat-protocol');
  try {
    await lstat(destination);
    const receipt = await verify(join(destination, 'receipt.json'), signal);
    if (receipt.work !== work) fail('已有协议准备身份不符');
    return receipt;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const pending = join(work, '.tatachat-protocol-' + randomUUID());
  await mkdir(pending, {mode: 0o700});
  try {
    const protocol = join(pending, 'protocol'); await mkdir(protocol, {mode: 0o700});
    for (let n = 0; n < originals.length; n++) await writeFile(join(protocol, requested.archives[n].name), originals[n], {flag: 'wx', mode: 0o444});
    const protoc = join(destination, 'protoc');
    await writeFile(join(pending, 'protoc'), executable, {flag: 'wx', mode: 0o555});
    const receipt = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work, mode,
      protocol: join(destination, 'protocol'), protoc, protoc_archive: originalPath,
      declaration_sha256: digest(await readFile(join(root, 'scripts/flows.json')))};
    await writeFile(join(pending, 'receipt.json'), JSON.stringify(receipt) + '\n', {flag: 'wx', mode: 0o444});
    signal?.throwIfAborted(); await rename(pending, destination);
    return await verify(join(destination, 'receipt.json'));
  } finally { await rm(pending, {recursive: true, force: true}); }
}
export async function verify(path, signal) {
  const value = JSON.parse((await bounded(path, 65536)).toString('utf8'));
  if (value.schema !== 1 || value.product_id !== 'citizenserve' || value.platform !== 'cloudflare'
      || !['independent', 'console'].includes(value.mode)) fail('协议回执身份无效');
  await workDirectory(value.work);
  const destination = join(value.work, 'tatachat-protocol');
  if (path !== join(destination, 'receipt.json') || value.protocol !== join(destination, 'protocol')
      || value.protoc !== join(destination, 'protoc')
      || value.declaration_sha256 !== digest(await readFile(join(root, 'scripts/flows.json')))) fail('回执或声明漂移');
  const requested = await protocolRequirements();
  const names = (await readdir(await checked(value.protocol, 'directory'))).sort();
  if (JSON.stringify(names) !== JSON.stringify(requested.archives.map(x => x.name).sort())) fail('协议目录含未知文件');
  for (const file of requested.archives) await archive(join(value.protocol, file.name), file, 65536);
  await tool(value.protoc, protocBytes(await archive(value.protoc_archive, requested.tools[0].archive, 32 * 1024 ** 2)), value.work, signal);
  return value;
}
// 运行现场接收已验真的锁定npm闭包，不在源码目录安装依赖，也不下载或更新锁。
export async function workerTestView(receiptPath,expectedSha,work){
  await workDirectory(work);if(!/^[a-f0-9]{64}$/u.test(expectedSha??''))fail('Worker供给摘要缺失');
  const bytes=await bounded(receiptPath,16*1024*1024);if(digest(bytes)!==expectedSha)fail('Worker供给回执损坏');
  const r=JSON.parse(bytes),view=join(work,'worker-smoke'),modules=join(view,'test/worker/node_modules');
  const scope=work.slice(join(root,'target').length+1).split(sep)[0], flow=r.flow;
  if(!['ci','release','gate','build','test'].includes(flow)||(flow==='gate'||flow==='test'?'test':'build')!==scope)fail('Worker供给流程与固定现场不符');
  if(r.schema!==1||r.product_id!=='citizenserve'||r.platform!=='cloudflare'||r.flow!==flow||r.work!==work||r.modules!==modules||!Array.isArray(r.files)||!r.files.length)fail('Worker供给身份不符');
  const lock=await readFile(await checked(join(root,'test/worker/package-lock.json'),'file'));
  if(r.lock_sha256!==digest(lock))fail('Worker供给与当前锁不符');await checked(modules,'directory');
  const expected=new Map();for(const file of r.files){if(typeof file.path!=='string'||file.path.split('/').some(x=>!x||x==='.'||x==='..')||file.path.includes('\\')||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>256*1024*1024||!/^[a-f0-9]{64}$/u.test(file.sha256)||expected.has(file.path))fail('Worker供给文件定义无效');expected.set(file.path,file);}
  async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const rel=prefix+entry.name,path=join(dir,entry.name);if(entry.isDirectory()){await checked(path,'directory');await walk(path,rel+'/');}else{const e=expected.get(rel);if(!e)fail('Worker供给有未登记文件');const b=await bounded(path,e.bytes);if(b.length!==e.bytes||digest(b)!==e.sha256)fail('Worker供给字节漂移');expected.delete(rel);}}}
  await walk(modules);if(expected.size)fail('Worker供给缺件');
  const packages=JSON.parse(lock).packages;
  for(const name of ['miniflare','workerd']){const p=JSON.parse(await bounded(join(modules,name,'package.json'),1024*1024));if(p.version!==packages['node_modules/'+name]?.version)fail('Worker真实版本与锁不符');}
  // 只物化测试输入与实际打包产物；不是第二Git检出或开发源码真源。
  async function directory(path){try{return await checked(path,'directory');}catch(e){if(e.code!=='ENOENT')throw e;await directory(dirname(path));await mkdir(path,{mode:0o700});return checked(path,'directory');}}
  async function copy(from,to){const st=await lstat(from);if(st.isDirectory()){await checked(from,'directory');await directory(to);for(const name of await readdir(from)){if(['node_modules','__pycache__'].includes(name))continue;await copy(join(from,name),join(to,name));}}else{const data=await bounded(from,64*1024*1024);await directory(dirname(to));try{await checked(to,'file');}catch(e){if(e.code!=='ENOENT')throw e;}await writeFile(to,data);}}
  await copy(join(root,'test'),join(view,'test'));await copy(join(root,'server/cloudflare'),join(view,'server/cloudflare'));await directory(join(view,'target/build/worker'));
  for(const name of ['index.js','index_bg.wasm'])await copy(join(work,'worker',name),join(view,'target/build/worker',name));
  return view;
}


// 完整流程的资源需求从本仓声明和两份锁读取；不复制控制台工具实现。
export const productRoot = root;
export async function flowDeclaration() {
  return JSON.parse((await bounded(join(root, 'scripts/flows.json'), 1024 * 1024)).toString('utf8'));
}
export function cargoPackages(text) {
  const result = [];
  for (const block of text.split('[[package]]').slice(1)) {
    const source = block.match(/^source = "([^"]+)"$/mu)?.[1];
    if (!source) continue;
    if (source !== 'registry+https://github.com/rust-lang/crates.io-index') fail('Cargo存在未实现的来源');
    const name = block.match(/^name = "([a-zA-Z0-9_-]+)"$/mu)?.[1];
    const version = block.match(/^version = "([0-9][a-zA-Z0-9.+-]*)"$/mu)?.[1];
    const sha256 = block.match(/^checksum = "([a-f0-9]{64})"$/mu)?.[1];
    if (!name || !version || !sha256) fail('Cargo锁坐标无效');
    result.push({name, version, sha256, url: 'https://static.crates.io/crates/' + name + '/' + name + '-' + version + '.crate'});
  }
  if (!result.length) fail('Cargo锁闭包为空');
  return result;
}
// npm依赖由锁中真实解析位置闭包决定，平台不适用的可选包不下载。
export function npmPackages(lock, host, roots) {
  const [os, cpu] = host.split('-');
  const packages = lock.packages;
  if (lock.lockfileVersion !== 3 || !packages?.['']) fail('npm锁格式无效');
  const selected = new Set();
  function visit(path) {
    const entry = packages[path];
    if (!entry) fail('npm锁缺少解析条目：' + path);
    const matches = (values, value) => !values || (!values.includes('!' + value) && (values.every(v => v.startsWith('!')) || values.includes(value)));
    if (!matches(entry.os, os) || !matches(entry.cpu, cpu) || !matches(entry.libc, os === 'linux' ? 'glibc' : 'none')) return false;
    if (selected.has(path)) return true;
    selected.add(path);
    for (const [name, optional] of [...Object.keys(entry.dependencies ?? {}).map(n => [n, false]),
      ...Object.keys(entry.optionalDependencies ?? {}).map(n => [n, true])]) {
      let at = path, resolved;
      while (true) {
        const possible = (at ? at + '/' : '') + 'node_modules/' + name;
        if (packages[possible]) { resolved = possible; break; }
        if (!at) break;
        const marker = at.lastIndexOf('/node_modules/');
        at = marker >= 0 ? at.slice(0, marker) : '';
      }
      if (!resolved || !visit(resolved)) { if (!optional) fail('npm必要依赖缺失或宿主不符：' + name); }
    }
    return true;
  }
  for (const path of roots??Object.keys({...packages[''].dependencies,...packages[''].devDependencies}).map(name=>'node_modules/'+name)) {if(!packages[path])fail('npm构建根缺失');visit(path);}
  return [...selected].sort().map(path => {
    const p = packages[path];
    if (!/^https:\/\/registry\.npmjs\.org\/[a-zA-Z0-9@/_.+-]+\.tgz$/u.test(p.resolved ?? '') ||
      !/^sha512-[a-zA-Z0-9+/]+={0,2}$/u.test(p.integrity ?? '')) fail('npm固定原件来源无效');
    return {path, version: p.version, url: p.resolved, integrity: p.integrity};
  });
}
export async function flowRequirements(flow, host = process.platform + '-' + process.arch) {
  if (!['build','ci', 'release', 'gate'].includes(flow) || !['linux-x64', 'darwin-arm64'].includes(host)) fail('流程资源身份无效');
  const d = await flowDeclaration();
  const ids = flow==='build'?['node','rust','protoc','worker-build','wasm-bindgen','wasm-opt']:flow === 'release' ? ['node', 'git', 'gh'] : ['node', 'git', 'bash', 'python', 'rust', 'protoc', 'actionlint', 'worker-build', 'wasm-bindgen', 'wasm-opt'];
  const recipe_sha256=digest(await bounded(join(root,'scripts/resources.mjs'),4*1024**2));
  const tools = ids.map(id => {
    const value = id === 'node' ? {version: d.resources.bootstrap.node_version, platforms: d.resources.bootstrap.platforms} : d.resources.tools[id];
    const archive = value?.platforms[host];
    if (!archive) fail('当前宿主缺少工具配方：' + id);
    return {id, version: value.version, archive,recipe_sha256,slots:id==='rust'?['bin/cargo','bin/rustc','bin/rustdoc',...(flow==='build'?[]:['bin/rustfmt','bin/cargo-fmt','bin/cargo-clippy','bin/clippy-driver'])]:[archive.executable],...(id==='rust'?{components:[{...d.resources.tools.rust.std.platforms[host],target:d.resources.tools.rust.std.target}]}:{})};
  });
  const locks = await Promise.all(['Cargo.lock', 'test/worker/package-lock.json'].map(async path => ({
    path, sha256: digest(await bounded(join(root, path), 4 * 1024 * 1024)),
  })));
  return {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, host, tools, locks,...(host==='darwin-arm64'?{apple:{version:d.resources.apple.version,source:d.resources.apple.source,names:['clang','ar','ranlib','xcrun']}}:{}),
    declaration_sha256: digest(await readFile(join(root, 'scripts/flows.json'))),
    cargo: flow === 'release' ? [] : cargoPackages((await readFile(join(root, 'Cargo.lock'))).toString()),
    npm: flow === 'release' ? [] : npmPackages(JSON.parse(await readFile(join(root, 'test/worker/package-lock.json'))), host,flow==='build'?['node_modules/esbuild']:undefined)};
}
function integrity(bytes, entry) {
  if (entry.sha256) return digest(bytes) === entry.sha256;
  if (entry.integrity?.startsWith('sha512-')) return createHash('sha512').update(bytes).digest('base64') === entry.integrity.slice(7);
  if (entry.integrity?.startsWith('sha3-256:')) return createHash('sha3-256').update(bytes).digest('hex') === entry.integrity.slice(9);
  fail('原件缺少固定摘要');
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /[\x00-\x1f\x7f]/u.test(value) || value.startsWith('/') ||
    value.split('/').some(x => !x || x === '.' || x === '..')) fail('归档相对路径无效');
  return value;
}
// 只接受校验正确的tar，支持官方PAX长路径；链接只物化为归档内已验真常规文件。
export function tarEntries(bytes) {
  const entries = new Map(); let at = 0, extended = {};
  const string = b => b.toString('utf8').split('\0')[0];
  const number = b => { const s = string(b).trim(); if (!/^[0-7]*$/u.test(s)) fail('tar数字字段无效'); return parseInt(s || '0', 8); };
  while (at + 512 <= bytes.length) {
    const h = bytes.subarray(at, at + 512); if (!h.some(x => x)) break;
    const checksum = [...h].reduce((sum, x, i) => sum + (i >= 148 && i < 156 ? 32 : x), 0);
    if (checksum !== number(h.subarray(148, 156))) fail('tar头校验失败');
    const size = number(h.subarray(124, 136)), type = string(h.subarray(156, 157));
    if (size > 1024 ** 3 || at + 512 + size > bytes.length) fail('tar条目超限');
    const data = bytes.subarray(at + 512, at + 512 + size);
    let name = string(h.subarray(0, 100)), prefix = string(h.subarray(345, 500));
    if (prefix) name = prefix + '/' + name;
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L' || type === 'K') {
      if (size > 1024 * 1024) fail('GNU长路径超限');
      extended[type === 'L' ? 'path' : 'linkpath'] = string(data); continue;
    }
    if (type === 'x' || type === 'g') {
      if (size > 1024 * 1024) fail('PAX超限');
      const values = {};
      for (let p = 0; p < data.length;) {
        const space = data.indexOf(32, p), length = Number(data.subarray(p, space).toString());
        if (space < p || !Number.isSafeInteger(length) || length < 4 || p + length > data.length) fail('PAX字段无效');
        const record = data.subarray(space + 1, p + length - 1).toString(), equal = record.indexOf('=');
        if (equal < 1) fail('PAX键无效'); values[record.slice(0, equal)] = record.slice(equal + 1); p += length;
      }
      if (type === 'x') extended = values;
      continue;
    }
    name = (extended.path ?? name).replace(/\/$/u, '');
    const target = extended.linkpath ?? string(h.subarray(157, 257)); extended = {};
    if (!name || name === '.') continue;
    name = safeRelative(name);
    if (entries.has(name)) fail('tar重复路径');
    if (!['', '0', '1', '2', '5'].includes(type)) fail('tar含特殊设备或未知类型');
    entries.set(name, {type, mode: number(h.subarray(100, 108)) & 0o777, data: Buffer.from(data), target});
  }
  return entries;
}
export function zipEntries(zip) {
  let end = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 65557); p--) {
    if (zip.readUInt32LE(p) === 0x06054b50 && p + 22 + zip.readUInt16LE(p + 20) === zip.length) { end = p; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) fail('ZIP目录无效');
  const count = zip.readUInt16LE(end + 10), start = zip.readUInt32LE(end + 16);
  if (start + zip.readUInt32LE(end + 12) !== end || count > 65534) fail('ZIP目录越界');
  const entries = new Map(); let at = start;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) fail('ZIP条目损坏');
    const nameSize = zip.readUInt16LE(at + 28), extraSize = zip.readUInt16LE(at + 30), commentSize = zip.readUInt16LE(at + 32);
    const rawName = zip.subarray(at + 46, at + 46 + nameSize), name = rawName.toString('utf8').replace(/\/$/u, '');
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), offset = zip.readUInt32LE(at + 42);
    const size = zip.readUInt32LE(at + 24), packed = zip.readUInt32LE(at + 20), mode = zip.readUInt32LE(at + 38) >>> 16;
    if (flags & 1 || ![0, 8].includes(method) || size > 256 * 1024 ** 2 || offset + 30 > start ||
      zip.readUInt32LE(offset) !== 0x04034b50 || mode && ![0, 0x8000, 0x4000].includes(mode & 0xf000)) fail('ZIP类型无效');
    const begin = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    if (begin + packed > start || !zip.subarray(offset + 30, offset + 30 + nameSize).equals(rawName)) fail('ZIP本地头不符');
    const data = zip.subarray(begin, begin + packed);
    safeRelative(name); if (entries.has(name)) fail('ZIP重复路径');
    const output = method === 0 ? Buffer.from(data) : inflateRawSync(data, {maxOutputLength: 256 * 1024 ** 2});
    if (output.length !== size) fail('ZIP展开长度不符');
    entries.set(name, {type: rawName.at(-1) === 47 ? '5' : '0', mode: mode & 0o777, data: output});
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== end) fail('ZIP目录条数不符'); return entries;
}
export function debData(bytes) {
  if (bytes.subarray(0, 8).toString() !== '!<arch>\n') fail('Deb原件格式无效');
  let at = 8, result;
  while (at + 60 <= bytes.length) {
    const h = bytes.subarray(at, at + 60), name = h.subarray(0, 16).toString().trim().replace(/\/$/u, '');
    const length = Number(h.subarray(48, 58).toString().trim());
    if (!Number.isSafeInteger(length) || length < 0 || at + 60 + length > bytes.length || h.subarray(58).toString() !== '\x60\n') fail('Deb成员无效');
    if (/^data\.tar\.(?:gz|xz|zst)$/u.test(name)) { if (result) fail('Deb数据重复'); result = {name, data: bytes.subarray(at + 60, at + 60 + length)}; }
    at += 60 + length + length % 2;
  }
  if (!result) fail('Deb数据缺失'); return result;
}
async function directory(path) {
  try { return await checked(path, 'directory'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await directory(dirname(path)); await mkdir(path, {mode: 0o700}); return checked(path, 'directory');
  }
}
export async function materialize(entries, destination, prefix = '.') {
  await directory(destination);
  const selected = new Map();
  for (const [name, value] of entries) {
    if (prefix !== '.' && !name.startsWith(prefix + '/')) continue;
    const relative = prefix === '.' ? name : name.slice(prefix.length + 1);
    if (relative) selected.set(safeRelative(relative), value);
  }
  function data(name, chain = new Set()) {
    const entry = selected.get(name);
    if (!entry || chain.has(name) || chain.size > 32 || entry.type === '5') fail('归档链接目标无效');
    if (!['1', '2'].includes(entry.type)) return entry;
    chain.add(name);
    const target = entry.type === '1' ? (prefix === '.' ? entry.target : entry.target.replace(prefix + '/', '')) :
      resolve('/', dirname(name), entry.target).slice(1);
    if (entry.target.startsWith('/') || !selected.has(target)) fail('归档链接越界');
    return data(target, chain);
  }
  for (const [name, entry] of selected) {
    const path = join(destination, name);
    if (entry.type === '5') { await directory(path); continue; }
    const value = data(name);
    await directory(dirname(path));
    await writeFile(path, value.data, {flag: 'wx', mode: value.mode & 0o111 ? 0o555 : 0o444});
  }
  if (!selected.size) fail('归档根缺失');
  return destination;
}
// 不继承调用者PATH、代理、Rust包装器或npm配置；上游命令名仅解析当前任务已验真闭包。
export function cleanEnvironment(work, tools, extra = {}) {
  const environment = {LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: join(work, 'home'), TMPDIR: join(work, 'tmp'),
    PATH: join(work, 'bin'), PRODUCT_WORK_DIR: work, PRODUCT_ROOT: root, PRODUCT_FLOW_RESOURCE_RECEIPT: join(work, 'resources.json'), PRODUCT_NODE_BIN: tools.node, PYTHON: tools.python,
    PRODUCT_GIT_BIN: tools.git, CARGO: tools.cargo, RUSTC: tools.rustc, RUSTDOC: tools.rustdoc, CARGO_HOME: join(work, 'cargo-home'),
    CARGO_TARGET_DIR: join(work, 'cargo-target'), CARGO_NET_OFFLINE: 'true', CARGO_INCREMENTAL: '0',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', WORKER_BUILD: tools['worker-build'],
    WASM_BINDGEN_BIN: tools['wasm-bindgen'], WASM_OPT_BIN: tools['wasm-opt'], ESBUILD_BIN: tools.esbuild,
    PROTOC: tools.protoc, PRODUCT_BASH_BIN: tools.bash, WRANGLER_SEND_METRICS: 'false'};
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(environment, key)) { if (value !== environment[key]) fail('基础工具环境漂移'); continue; }
    if (!['TATACHAT_RESOURCE_RECEIPT', 'TATACHATSDK_PROTOCOL_DIR', 'WORKER_TEST_RECEIPT', 'WORKER_TEST_RECEIPT_SHA256',
      'OPENSSL_DIR', 'OPENSSL_STATIC', 'CC', 'CXX', 'AR', 'RANLIB', 'CONFIG_SHELL', 'SHELL',
      'CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'SQLITE3_CFLAGS', 'SQLITE3_LIBS', 'GIT_CONFIG_NOSYSTEM',
      'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER', 'PYTHONPATH', 'LD_LIBRARY_PATH',
      'DEVELOPER_DIR','SDKROOT','CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER','GH_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'PRODUCT_TEST_REPORT'].includes(key)) fail('工具环境有未知字段');
    environment[key] = value;
  }
  return Object.fromEntries(Object.entries(environment).filter(([, v]) => v !== undefined));
}
export async function runTool(path, args, {work, cwd = root, tools = {}, environment = {}, signal, capture = true, binary = false, timeout = 30 * 60 * 1000} = {}) {
  await checked(path, 'file'); await checked(cwd, 'directory'); await workDirectory(work);
  signal?.throwIfAborted();
  if (cwd !== root && !inside(work, cwd) && cwd !== join(root, 'server/cloudflare')) fail('工具执行目录越界');
  const child = spawn(path, args, {cwd, env: cleanEnvironment(work, tools, environment),
    detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failed = false, hard, processError, stopping = false;
  const tracker = child.pid ? descendantTracker(child.pid) : null;
  const ownedError = () => { failed = true; unsafeWork.add(work); };
  const terminate = kind => {
    if (!Number.isSafeInteger(child.pid)) return;
    try { process.kill(-child.pid, kind); } catch (e) { if (e.code !== 'ESRCH') ownedError(); }
  };
  const stop = () => {
    failed = true; if (stopping) return; stopping = true;
    terminate('SIGTERM');
    hard = setTimeout(() => { terminate('SIGKILL'); tracker?.stop().catch(ownedError); }, 5000);
  };
  const consume = (name, chunk) => {
    if (capture) {
      if (name === 'out') stdout += binary ? chunk.toString('binary') : chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > (binary ? 1024 ** 3 : 64 * 1024 ** 2)) stop();
    } else (name === 'out' ? process.stdout : process.stderr).write(chunk);
  };
  // 先登记输出和终态，再异步读取/proc；快速版本命令退出不能丢失close事件。
  child.stdout.on('data', b => consume('out', b)); child.stderr.on('data', b => consume('err', b));
  const completed = new Promise(ok => {
    child.once('error', () => { processError = true; });
    child.once('close', (code, terminalSignal) => ok({code, terminalSignal}));
  });
  const tracking = tracker ? setInterval(() => tracker.scan().catch(ownedError), 50) : null;
  tracker?.scan().catch(ownedError);
  const timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, {once: true});
  if (signal?.aborted) stop();
  const result = await completed;
  clearTimeout(timer); clearTimeout(hard); clearInterval(tracking); signal?.removeEventListener('abort', stop);
  // Linux同时回读实际后代PID和启动坐标；进程组退出不能代替已识别后代退出。
  let quiet;
  try {
    quiet = !tracker || await tracker.quiet();
    if (!quiet) {
      await tracker.stop();
      for (let n = 0; n < 100 && !quiet; n++) { await delay(50); quiet = await tracker.quiet(); }
      failed = true;
    }
  } catch { quiet = false; }
  if (!quiet) { unsafeWork.add(work); fail('实际工具后代退出未确认'); }
  if (processError || failed || signal?.aborted || result.code !== 0 || result.terminalSignal) {
    if (!environment.GH_TOKEN) { process.stdout.write(stdout); process.stderr.write(stderr); }
    fail('工具运行未完整成功：' + basename(path));
  }
  return {stdout, stderr};
}
async function treeManifest(path) {
  const files = [];
  async function walk(at, relative = '') {
    for (const name of (await readdir(at)).sort()) {
      const full = join(at, name), rel = relative + name, st = await lstat(full);
      if (st.isDirectory()) { await checked(full, 'directory'); await walk(full, rel + '/'); }
      else { const bytes = await bounded(full, 1024 ** 3); files.push({path: rel, sha256: digest(bytes), bytes: bytes.length, mode: st.mode & 0o777}); }
    }
  }
  await walk(path); return files;
}
async function verifyTree(path, files) {
  if (!Array.isArray(files) || JSON.stringify(await treeManifest(path)) !== JSON.stringify(files)) fail('工具或依赖视图漂移');
}
async function original(entry, options, kind) {
  const maximum = 1024 ** 3;
  if (options.mode === 'console') {
    if (typeof options.acquireOriginal !== 'function') fail('控制台未交付公开原件获取能力');
    const path = await options.acquireOriginal(entry, {kind, signal: options.signal, offline: options.offline});
    const base = kind === 'tool' ? options.toolRoot : options.dependencyRoot;
    await checked(base, 'directory');
    if (!inside(base, path)) fail('控制台原件越界');
    const bytes = await bounded(path, maximum); if (!integrity(bytes, entry)) fail('控制台原件摘要不符'); return {path, bytes};
  }
  const store = kind === 'tool' ? options.toolRoot : options.dependencyRoot;
  await directory(store);
  if (store === root || inside(root, store)) fail('永久原件存储必须位于源码外');
  const key = entry.sha256 ?? digest(Buffer.from(entry.integrity ?? ''));
  const path = join(store, key + '.blob');
  try { const bytes = await bounded(path, maximum); if (!integrity(bytes, entry)) fail('已有原件损坏'); return {path, bytes}; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (options.offline) fail('离线缺少锁定原件');
  const initial = new URL(entry.url);
  if (initial.protocol !== 'https:' || initial.username || initial.password || initial.hash) fail('原件来源无效');
  const allowed = new Set([initial.hostname, 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  let url = initial.href, response;
  const requestSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  for (let n = 0; n < 6; n++) {
    response = await (options.fetcher ?? fetch)(url, {signal: requestSignal, credentials: 'omit', redirect: 'manual'});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get('location'), url); await response.body?.cancel();
    if (n === 5 || next.protocol !== 'https:' || next.username || next.password || !allowed.has(next.hostname)) fail('原件重定向越界');
    url = next.href;
  }
  if (!response?.ok || !response.body) fail('锁定原件获取失败');
  const chunks = []; let size = 0;
  for await (const b of response.body) { requestSignal.throwIfAborted(); size += b.length; if (size > maximum) fail('原件超限'); chunks.push(Buffer.from(b)); }
  const bytes = Buffer.concat(chunks); if (!integrity(bytes, entry)) fail('原件摘要不符');
  const pending = join(store, '.' + randomUUID() + '.pending');
  try {
    await writeFile(pending, bytes, {flag: 'wx', mode: 0o444}); options.signal?.throwIfAborted();
    try { await link(pending, path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } finally { await rm(pending, {force: true}); }
  const saved = await bounded(path, maximum); if (!integrity(saved, entry)) fail('原件提交冲突'); return {path, bytes: saved};
}

async function unpack(bytes, kind, options, tools) {
  if (kind === 'deb') {
    const value = debData(bytes);
    return unpack(value.data, value.name.endsWith('.zst') ? 'tar-zstd' : value.name.endsWith('.xz') ? 'tar-xz' : 'tar-gzip', options, tools);
  }
  if (kind === 'zip' || kind === 'extract' && bytes.readUInt32LE(0) === 0x04034b50) return zipEntries(bytes);
  if (kind === 'tar-xz' || bytes.subarray(0, 6).equals(Buffer.from([253, 55, 122, 88, 90, 0]))) {
    if (!tools.busybox) return tarEntries(await xzBytes(bytes,options.signal));
    const source = join(options.work, 'unpack-' + randomUUID() + '.xz');
    await writeFile(source, bytes, {flag: 'wx', mode: 0o400});
    try {
      // xz只处理已验真归档；输出经Node逐条校验，不调用系统tar。
      const {stdout} = await runTool(tools.busybox, ['xz', '-dc', source], {...options, tools, binary: true});
      return tarEntries(Buffer.from(stdout, 'binary'));
    } finally { if (!unsafeWork.has(options.work)) await rm(source, {force: true}); }
  }
  const tar = kind === 'tar-zstd' ? zstdDecompressSync(bytes, {maxOutputLength: 1024 ** 3}) :
    bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes, {maxOutputLength: 1024 ** 3}) : bytes;
  return tarEntries(tar);
}
async function mutableTree(path) {
  for (const name of await readdir(path)) {
    const full = join(path, name), st = await lstat(full);
    if (st.isDirectory()) await mutableTree(full);
    else await chmod(full, st.mode & 0o111 ? 0o700 : 0o600);
  }
}
async function binaryFile(bytes, path) {
  await directory(dirname(path)); await writeFile(path, bytes, {flag: 'wx', mode: 0o555}); return path;
}
async function closeCommands(work, tools) {
  const bin = await directory(join(work, 'bin'));
  for (const [name, value] of Object.entries(tools)) {
    if (!value || name === 'busybox' || name === 'sh' || name.endsWith('Prefix') || !/^[a-zA-Z0-9_-]+$/u.test(name)) continue;
    const destination = join(bin, name);
    try { await lstat(destination); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await checked(value, 'file');
      await binaryFile(Buffer.from('#!'+tools.node+'\n'+"const {spawnSync}=require('node:child_process');const child=spawnSync("+JSON.stringify(value)+",process.argv.slice(2),{stdio:'inherit',env:process.env});if(child.error||child.signal)process.exit(1);process.exit(child.status??1);\n"),destination);
    }
  }
}
async function installRust(entries, archive, prefix) {
  const componentFile = entries.get(archive.root + '/components');
  if (!componentFile) fail('Rust组件清单缺失');
  const permitted = new Set(['rustc', 'cargo', 'rustfmt-preview', 'clippy-preview',
    'rust-std-x86_64-unknown-linux-gnu', 'rust-std-aarch64-apple-darwin', 'rust-std-wasm32-unknown-unknown']);
  const components = componentFile.data.toString().trim().split('\n').filter(c => permitted.has(c));
  if (!components.length) fail('Rust必要组件缺失');
  for (const component of components) {
    const marker = archive.root + '/' + component + '/';
    const files = new Map([...entries].filter(([name]) => name.startsWith(marker) && name !== marker + 'manifest.in')
      .map(([name, value]) => [name.slice(marker.length), value]));
    // 同版本公共许可证可重复；二进制或库重名必须逐字相同。
    const pending = join(prefix, '.component-' + randomUUID()); await materialize(files, pending);
    for (const file of await treeManifest(pending)) {
      const path = join(prefix, file.path); await directory(dirname(path));
      const bytes = await readFile(join(pending, file.path));
      try { if (!(await readFile(await checked(path, 'file'))).equals(bytes)) fail('Rust组件重名漂移'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; await binaryFile(bytes, path); await chmod(path, file.mode); }
    }
    await rm(pending, {recursive: true, force: true});
  }
}
async function nativeLinux(id, archive, options, tools, d) {
  const source = join(options.work, 'prepare', id, 'source'), prefix = join(options.work, 'prepare', id, 'payload');
  await directory(dirname(source)); await directory(prefix);
  const entry = await original(archive, options, 'tool');
  await materialize(await unpack(entry.bytes, archive.kind, options, tools), source, archive.root);
  await mutableTree(source);
  const common = {work: options.work, cwd: source, tools, signal: options.signal,
    environment: {CC: join(options.work, 'bin/cc'), CXX: join(options.work, 'bin/c++'),
      AR: join(options.work, 'bin/ar'), RANLIB: join(options.work, 'bin/ranlib'),
      CONFIG_SHELL: tools.sh, SHELL: tools.sh}};
  const make = (args = [], environment = {}) => runTool(tools.make, ['-j2', 'SHELL=' + tools.sh, ...args],
    {...common, environment: {...common.environment, ...environment}});
  const configure = args => runTool(tools.sh, [join(source, 'configure'), '--prefix=' + prefix, ...args], common);
  if (id === 'bash') {
    for (const patch of d.resources.tools.bash.patches) {
      const file = await original(patch, options, 'tool');
      await applyBashPatch(source, file.bytes);
    }
    await configure(['--disable-nls', '--without-bash-malloc', '--disable-readline']);
    await make(); await make(['install']);
  } else if (id === 'zlib') {
    await configure(['--static']); await make(); await make(['install']);
  } else if (id === 'perl') {
    await runTool(tools.sh, [join(source, 'Configure'), '-des', '-Dprefix=' + prefix,
      '-Dcc=' + join(options.work, 'bin/cc'), '-Dar=' + join(options.work, 'bin/ar'),
      '-Dranlib=' + join(options.work, 'bin/ranlib'), '-Duseshrplib=false'], common);
    await make(); await make(['install']);
  } else if (id === 'openssl') {
    await runTool(tools.perl, [join(source, 'Configure'), 'linux-x86_64', 'no-shared', 'no-tests',
      '--prefix=' + prefix, '--libdir=lib', '--openssldir=' + join(prefix, 'ssl')], common);
    await make(); await make(['install_sw']);
  } else if (id === 'python') {
    const sqliteArchive = d.resources.preparation['linux-x64'].sqlite;
    const sqlite = await original(sqliteArchive, options, 'tool');
    const sql = join(options.work, 'prepare/sqlite');
    await materialize(await unpack(sqlite.bytes, 'zip', options, tools), sql, sqliteArchive.root);
    const object = join(options.work, 'prepare/sqlite3.o'), library = join(options.work, 'prepare/libsqlite3.a');
    await runTool(join(options.work, 'bin/cc'), ['-O2', '-fPIC', '-DSQLITE_ENABLE_JSON1', '-DSQLITE_ENABLE_FTS5',
      '-DSQLITE_THREADSAFE=1', '-c', join(sql, 'sqlite3.c'), '-o', object], common);
    await runTool(join(options.work, 'bin/ar'), ['rcs', library, object], common);
    common.environment.SQLITE3_CFLAGS = '-I' + sql;
    common.environment.SQLITE3_LIBS = library + ' -lm -ldl -lpthread';
    common.environment.CPPFLAGS = '-I' + join(tools.zlibPrefix, 'include');
    common.environment.LDFLAGS = '-L' + join(tools.zlibPrefix, 'lib');
    await configure(['--without-ensurepip', '--disable-test-modules', '--with-openssl=' + tools.opensslPrefix]);
    await make(); await make(['install']);
  } else if (id === 'git') {
    const flags = ['prefix=' + prefix, 'NO_CURL=YesPlease', 'NO_OPENSSL=YesPlease', 'NO_GETTEXT=YesPlease',
      'NO_TCLTK=YesPlease', 'NO_PERL=YesPlease', 'NO_PYTHON=YesPlease', 'NO_EXPAT=YesPlease',
      'ZLIB_PATH=' + tools.zlibPrefix, 'CC=' + join(options.work, 'bin/cc'), 'AR=' + join(options.work, 'bin/ar')];
    // 流程只读提交对象；HTTPS操作由Node实现，不准备未调用的Git网络插件。
    await make([...flags, 'git']);
    await binaryFile(await readFile(join(source, 'git')), join(prefix, 'bin/git'));
  } else fail('未知原生工具配方');
  await normalizeLinks(prefix);
  // 原生准备命令及其已识别后代退出后，立即删除不再消费的可写源构建现场。
  if (unsafeWork.has(options.work)) fail('原生准备进程退出未确认');
  await rm(source, {recursive: true});
  return {prefix, path: join(prefix, archive.executable)};
}
async function cargoView(packages, destination, options, tools) {
  await directory(destination);
  for (const entry of packages) {
    const target = join(destination, entry.name + '-' + entry.version);
    try { await checked(target, 'directory'); continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const resource = await original(entry, options, 'dependency');
    await materialize(await unpack(resource.bytes, 'tar-gzip', options, tools), target, entry.name + '-' + entry.version);
    const files = Object.fromEntries((await treeManifest(target)).filter(f => f.path !== '.cargo-checksum.json').map(f => [f.path, f.sha256]));
    await writeFile(join(target, '.cargo-checksum.json'), JSON.stringify({files, package: entry.sha256}) + '\n', {mode: 0o444});
  }
}
async function npmView(packages, work, options, tools, flow) {
  const modules = join(work, 'worker-smoke/test/worker/node_modules');
  await directory(modules);
  for (const entry of packages) {
    const resource = await original(entry, options, 'dependency');
    const path = join(work, 'worker-smoke/test/worker', entry.path);
    await materialize(await unpack(resource.bytes, 'tar-gzip', options, tools), path, 'package');
    const value = JSON.parse(await readFile(join(path, 'package.json')));
    if (value.version !== entry.version) fail('npm展开版本不符');
  }
  const host = process.platform + '-' + process.arch;
  const packageName = host === 'linux-x64' ? '@esbuild/linux-x64' : '@esbuild/darwin-arm64';
  const esbuild = join(modules, packageName, 'bin/esbuild');
  const workerd = join(modules, host === 'linux-x64' ? '@cloudflare/workerd-linux-64' : '@cloudflare/workerd-darwin-arm64', 'bin/workerd');
  // 替代上游postinstall的唯一必要字节物化；不执行npm生命周期脚本。
  await rm(join(modules, 'esbuild/bin/esbuild'), {force: true});
  await binaryFile(await bounded(esbuild, 64 * 1024 ** 2), join(modules, 'esbuild/bin/esbuild'));
  if(flow!=='build'){await rm(join(modules,'workerd/bin/workerd'),{force:true});await binaryFile(await bounded(workerd,128*1024**2),join(modules,'workerd/bin/workerd'));}
  const receipt = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, work, modules,
    lock_sha256: digest(await readFile(join(root, 'test/worker/package-lock.json'))), files: await treeManifest(modules)};
  const path = join(work, 'worker-receipt.json'), bytes = Buffer.from(JSON.stringify(receipt) + '\n');
  await writeFile(path, bytes, {flag: 'wx', mode: 0o444});
  return {path, sha256: digest(bytes), esbuild};
}
export async function prepareFlowResources(options) {
  const {flow, work, mode, signal} = options;
  await workDirectory(work);
  if (!['independent', 'console'].includes(mode)) fail('资源模式必须明确');
  const requested = await flowRequirements(flow);
  const d = await flowDeclaration(), tools = {};
  for (const name of ['home', 'tmp']) await directory(join(work, name));
  if (mode === 'independent' && requested.host === 'linux-x64' &&
    (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Linux')) fail('Linux资源只在实际GitHub Linux Runner准备');
  if (requested.host === 'linux-x64' && process.report.getReport().header.glibcVersionRuntime !== '2.39') fail('Linux引导要求实际Ubuntu24.04的glibc2.39');
  if (requested.host === 'darwin-arm64') {
    const supply={schema:1,product_id:'citizenserve',flow,work,tools:{}};
    const policy={...options,acquireTool:null,acquireApple:null};
    const acquireTool=mode==='console'?options.acquireTool:(wanted=>independentTool(wanted,policy));
    const acquireApple=mode==='console'?options.acquireApple:(wanted=>macApple(work,wanted,signal));
    if(typeof acquireTool!=='function'||typeof acquireApple!=='function')fail('当前任务未交付公开工具或Apple能力');
    policy.acquireTool=acquireTool;policy.acquireApple=acquireApple;
    for(const item of requested.tools){
      signal?.throwIfAborted();const supplied=await acquireTool(item);await verifyExternalTool(item,supplied,options.toolRoot,signal);supply.tools[item.id]=supplied;tools[item.id]=supplied.path;
      for(const [slot,path] of Object.entries(supplied.slots))if(item.slots.includes(slot))tools[basename(slot)]=await realpath(path);
    }
    options.supply=supply;
    tools.node=process.execPath;
    if(digest(await bounded(tools.node,256*1024**2))!==d.resources.bootstrap.platforms[requested.host].executable_sha256)fail('运行Node字节与产品引导原件不符');
    const delivered=await acquireApple(requested.apple),verified=await macApple(work,requested.apple,signal);
    if(JSON.stringify(delivered)!==JSON.stringify(verified))fail('Apple交付与本机独立验真不符');
    options.apple=verified;Object.assign(tools,verified.tools);await closeCommands(work,tools);
  } else {
    const bootstrap = await original(d.resources.bootstrap.platforms[requested.host], options, 'tool');
    const entries = await unpack(bootstrap.bytes, 'tar-gzip', options, tools);
    const nodeBytes = entries.get(d.resources.bootstrap.platforms[requested.host].root + '/bin/node')?.data;
    if (!nodeBytes || !(await bounded(process.execPath, 256 * 1024 ** 2)).equals(nodeBytes) || process.versions.node !== '25.2.1') fail('运行Node不属于锁定官方原件');
    tools.node = process.execPath;
    const helpers = d.resources.preparation[requested.host];
    for (const id of ['busybox', 'make']) {
      const value = await original(helpers[id], options, 'tool');
      const at = join(work, 'prepare', id);
      await materialize(await unpack(value.bytes, 'deb', options, tools), at);
      tools[id] = join(at, helpers[id].executable);
    }
    // 引导闭包是固定BusyBox的实际appet，不读取系统PATH。
    const applets = ['sh', 'awk', 'grep', 'sed', 'cat', 'chmod', 'chown', 'cp', 'cut', 'date', 'dirname', 'echo',
      'env', 'expr', 'find', 'head', 'id', 'install', 'ln', 'ls', 'mkdir', 'mv', 'od', 'printf', 'pwd',
      'readlink', 'rm', 'rmdir', 'sort', 'tail', 'tee', 'test', 'touch', 'tr', 'uname', 'uniq', 'wc', 'xargs', 'which'];
    for (const id of applets) tools[id] = await binaryFile(await readFile(tools.busybox), join(work, 'bin', id));
    const zig = await original(helpers.zig, options, 'tool');
    const zigRoot = join(work, 'prepare/zig');
    await materialize(await unpack(zig.bytes, 'tar-xz', options, tools), zigRoot, helpers.zig.root);
    tools.zig = join(zigRoot, 'zig');
    for (const [name, args] of [['cc', 'cc -target x86_64-linux-gnu.2.39'], ['c++', 'c++ -target x86_64-linux-gnu.2.39'], ['ar', 'ar'], ['ranlib', 'ranlib']]) {
      await binaryFile(Buffer.from('#!' + tools.sh + '\nexec ' + shellQuote(tools.zig) + ' ' + args + ' "$@"\n'), join(work, 'bin', name));
    }
    const z = await nativeLinux('zlib', helpers.zlib, options, tools, d); tools.zlibPrefix = z.prefix;
    for (const id of ['git', ...(flow === 'release' ? [] : ['bash', 'perl', 'openssl', 'python'])]) {
      const toolArchive = d.resources.tools[id].platforms[requested.host];
      const value = await nativeLinux(id, toolArchive, options, tools, d);
      tools[id] = value.path;
      if (id === 'openssl') tools.opensslPrefix = value.prefix;
      await closeCommands(work, {node:tools.node,sh: tools.sh, [id]: value.path});
    }
    for (const tool of requested.tools.filter(x => !['node', 'git', 'bash', 'python', 'worker-build'].includes(x.id))) {
      const file = await original(tool.archive, options, 'tool'), prefix = join(work, 'prepare', tool.id, 'payload');
      const values = await unpack(file.bytes, tool.archive.kind, options, tools);
      if (tool.id === 'rust') {
        await installRust(values, tool.archive, prefix);
        for (const component of d.resources.tools.rust.components) {
          const item = await original(component, options, 'tool');
          await installRust(await unpack(item.bytes, component.kind, options, tools), component, prefix);
        }
        const std = d.resources.tools.rust.std.platforms[requested.host], stdBytes = await original(std, options, 'tool');
        await installRust(await unpack(stdBytes.bytes, std.kind, options, tools), std, prefix);
        Object.assign(tools, Object.fromEntries(['cargo', 'rustc', 'rustdoc', 'rustfmt', 'cargo-fmt', 'cargo-clippy', 'clippy-driver'].map(id => [id, join(prefix, 'bin', id)])));
      } else {
        await materialize(values, prefix, tool.archive.root); tools[tool.id] = join(prefix, tool.archive.executable);
      }
    }
    await closeCommands(work, tools);
  }
  for (const name of ['home', 'tmp', 'cargo-home', 'cargo-target', 'bin', 'prepare']) await directory(join(work, name));
  let protocol, npm;
  if (flow !== 'release') {
    const vendor = join(work, 'cargo-vendor');
    const all = new Map();
    for (const item of [...requested.cargo, ...(requested.host==='linux-x64'?d.resources.worker_build_packages:[]).map(p => ({...p, url: 'https://static.crates.io/crates/' + p.name + '/' + p.name + '-' + p.version + '.crate'}))]) {
      const key = item.name + '-' + item.version;
      if (all.has(key) && all.get(key).sha256 !== item.sha256) fail('Cargo同坐标原件摘要冲突');
      all.set(key, item);
    }
    await cargoView([...all.values()], vendor, options, tools);
    const config = '[source.crates-io]\nreplace-with = "locked"\n[source.locked]\ndirectory = ' + JSON.stringify(vendor) + '\n[net]\noffline = true\n';
    await writeFile(join(work, 'cargo-home/config.toml'), config, {flag: 'wx', mode: 0o444});
    if (requested.host === 'linux-x64') {
      const item = d.resources.tools['worker-build'], file = await original(item.platforms[requested.host], options, 'tool');
      const source = join(work, 'prepare/worker-build/source'), prefix = join(work, 'prepare/worker-build/payload');
      await materialize(await unpack(file.bytes, 'tar-gzip', options, tools), source, item.platforms[requested.host].root);
      if (digest(await readFile(join(source, 'Cargo.lock'))) !== d.resources.worker_build_lock_sha256) fail('worker-build内部锁漂移');
      await runTool(tools.cargo, ['install', '--path', source, '--locked', '--offline', '--root', prefix],
        {work, tools, signal, environment: {CC: join(work, 'bin/cc'), AR: join(work, 'bin/ar'), OPENSSL_DIR: tools.opensslPrefix,
          OPENSSL_STATIC: '1', CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: join(work, 'bin/cc')}});
      if (unsafeWork.has(work)) fail('worker-build准备进程退出未确认');
      await rm(source, {recursive: true}); await normalizeLinks(prefix);
      tools['worker-build'] = join(prefix, 'bin/worker-build'); await closeCommands(work, {node:tools.node,sh: tools.sh, 'worker-build': tools['worker-build']});
    }
    npm = await npmView(requested.npm, work, options, tools, flow); tools.esbuild = npm.esbuild;
    await closeCommands(work,tools);
    // 协议仍使用build.rs消费的唯一回执；控制台原件交由公开能力获取。
    const requestedProtocol = await protocolRequirements();
    if (mode === 'console') {
      const p = {}, a = await original(requestedProtocol.tools[0].archive, options, 'tool');
      for (const item of requestedProtocol.archives) p[item.name] = (await original(item, options, 'dependency')).path;
      protocol = await prepare({work, mode, signal, supply: {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work,
        dependency_root: options.dependencyRoot, tool_root: options.toolRoot, protoc_archive: a.path, protoc: tools.protoc, protocol: p}});
    } else protocol = await prepare({work, mode, store: options.dependencyRoot, toolStore: options.toolRoot, offline: options.offline, signal, fetcher: options.fetcher ?? fetch});
    // build.rs逐字核对协议回执中的实际入口，不能传入准备前的工具库坐标。
    tools.protoc=protocol.protoc;
  }
  const toolChecks = flow==='build'?[['node',['--version'],/^v25\.2\.1\s*$/u],['cargo',['--version'],/^cargo 1\.97\.1(?:\s|$)/u],['rustc',['--version'],/^rustc 1\.97\.1(?:\s|$)/u],['worker-build',['--version'],/^(?:worker-build )?0\.8\.5\s*$/u],['wasm-bindgen',['--version'],/^wasm-bindgen 0\.2\.127\s*$/u],['wasm-opt',['--version'],/^wasm-opt version 130(?:\s|$)/u],['esbuild',['--version'],/^0\.28\.1\s*$/u]]:flow === 'release' ? [['node', ['--version'], /^v25\.2\.1\s*$/u], ['git', ['--version'], /^git version 2\.54\.0\s*$/u], ['gh', ['--version'], /^gh version 2\.102\.0(?:\s|$)/u]] :
    [['node', ['--version'], /^v25\.2\.1\s*$/u], ['git', ['--version'], /^git version 2\.54\.0\s*$/u],
      ['python', ['--version'], /^Python 3\.14\.3\s*$/u], ['cargo', ['--version'], /^cargo 1\.97\.1(?:\s|$)/u],
      ['rustc', ['--version'], /^rustc 1\.97\.1(?:\s|$)/u], ['bash', ['--version'], /^GNU bash, version 5\.3\.20(?:\(|\s)/u],
      ['worker-build', ['--version'], /^(?:worker-build )?0\.8\.5\s*$/u], ['wasm-bindgen', ['--version'], /^wasm-bindgen 0\.2\.127\s*$/u],
      ['wasm-opt', ['--version'], /^wasm-opt version 130(?:\s|$)/u], ['esbuild', ['--version'], /^0\.28\.1\s*$/u]];
  for (const [id, args, expected] of toolChecks) {
    const {stdout} = await runTool(tools[id], args, {work, tools, signal});
    if (!expected.test(stdout)) fail('工具实际版本不符：' + id);
  }
  const environment = cleanEnvironment(work, tools, {...(protocol ? {TATACHAT_RESOURCE_RECEIPT: join(work, 'tatachat-protocol/receipt.json'), TATACHATSDK_PROTOCOL_DIR: protocol.protocol} : {}),
    ...(npm ? {WORKER_TEST_RECEIPT: npm.path, WORKER_TEST_RECEIPT_SHA256: npm.sha256} : {}),
    ...(options.apple?{CC:tools.clang,AR:tools.ar,RANLIB:tools.ranlib,DEVELOPER_DIR:options.apple.developerDirectory,SDKROOT:options.apple.sdk,CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER:tools.clang}:{}),
    ...(tools.opensslPrefix ? {OPENSSL_DIR: tools.opensslPrefix, OPENSSL_STATIC: '1', CC: join(work, 'bin/cc'), AR: join(work, 'bin/ar'),
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: join(work, 'bin/cc')} : {})});
  const receipt = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, work, mode,...(options.runID?{run_id:options.runID}:{}),apple:options.apple??null,
    requirements_sha256: digest(Buffer.from(JSON.stringify(requested))), tools, environment,
    external: requested.host === 'darwin-arm64' ? options.supply.tools : null, tool_root: options.toolRoot,
    files: await treeManifest(join(work, 'prepare')), bin: await treeManifest(join(work, 'bin')),
    vendor: flow !== 'release' ? await treeManifest(join(work, 'cargo-vendor')) : null,
    cargo_config_sha256: flow !== 'release' ? digest(await bounded(join(work, 'cargo-home/config.toml'), 65536)) : null,
    npm: npm ? {path: npm.path, sha256: npm.sha256} : null};
  const path = join(work, 'resources.json');
  await writeFile(path, JSON.stringify(receipt) + '\n', {flag: 'wx', mode: 0o444});
  return receipt;
}
export async function verifyFlowResources(receipt,signal) {
  const expected = await flowRequirements(receipt.flow);
  if (receipt.mode !== 'independent' && receipt.mode !== 'console') fail('资源回执模式无效');
  if (receipt.tools.node !== process.execPath) fail('资源回执试图替换运行Node');
  if(expected.host==='darwin-arm64'&&digest(await bounded(process.execPath,256*1024**2))!==(await flowDeclaration()).resources.bootstrap.platforms[expected.host].executable_sha256)fail('运行Node原件字节漂移');
  if (expected.host === 'darwin-arm64') {
    for (const wanted of expected.tools) {
      const value = receipt.external?.[wanted.id];
      if (!value || value.version !== wanted.version || value.archive_sha256 !== wanted.archive.sha256 || !inside(receipt.tool_root, value.root) || !['node','protoc'].includes(wanted.id)&&receipt.tools[wanted.id] !== value.path) fail('外部工具回执坐标不符');
      await verifyExternalTool(wanted,value,receipt.tool_root,signal);
    }
  } else for (const [id,path] of Object.entries(receipt.tools)) {
    if (id === 'node' || id.endsWith('Prefix')) continue;
    if (!inside(receipt.work, path)) fail('工具路径不属于当前验真视图');
  }
  if (receipt.schema !== 1 || receipt.product_id !== 'citizenserve' || receipt.platform !== 'cloudflare' ||
    receipt.requirements_sha256 !== digest(Buffer.from(JSON.stringify(expected)))) fail('流程资源回执漂移');
  await workDirectory(receipt.work);
  await verifyTree(join(receipt.work, 'prepare'), receipt.files); await verifyTree(join(receipt.work, 'bin'), receipt.bin);
  for (const [id,value] of Object.entries(receipt.tools).filter(([id,v]) => typeof v === 'string' && !id.endsWith('Prefix'))) await checked(value, 'file');
  if(expected.apple){const verified=await macApple(receipt.work,expected.apple,signal);if(JSON.stringify(verified)!==JSON.stringify(receipt.apple))fail('Apple回执漂移');}
  const base = cleanEnvironment(receipt.work, receipt.tools, receipt.environment);
  if (JSON.stringify(base) !== JSON.stringify(receipt.environment)) fail('流程环境漂移');
  if (receipt.flow !== 'release') {
    await verifyTree(join(receipt.work, 'cargo-vendor'), receipt.vendor);
    if (digest(await bounded(join(receipt.work, 'cargo-home/config.toml'), 65536)) !== receipt.cargo_config_sha256) fail('离线Cargo配置漂移');
    if (receipt.npm?.path !== receipt.environment.WORKER_TEST_RECEIPT || receipt.npm.sha256 !== receipt.environment.WORKER_TEST_RECEIPT_SHA256) fail('npm供给回执坐标漂移');
    const bytes = await bounded(receipt.npm.path, 16 * 1024 ** 2);
    if (digest(bytes) !== receipt.npm.sha256) fail('npm供给回执摘要漂移');
    const npm = JSON.parse(bytes);
    if (npm.modules !== join(receipt.work, 'worker-smoke/test/worker/node_modules') || npm.work !== receipt.work || npm.flow !== receipt.flow ||
      npm.lock_sha256 !== digest(await readFile(join(root, 'test/worker/package-lock.json')))) fail('npm供给任务或锁漂移');
    await verifyTree(npm.modules, npm.files);
    const protocol=await verify(receipt.environment.TATACHAT_RESOURCE_RECEIPT,signal);if(receipt.tools.protoc!==protocol.protoc)fail('实际protoc与协议回执入口漂移');
  }
  return receipt;
}

// 首个文件步骤声明同身份独占；短锁只用于检查、清空与登记，不覆盖活跃任务。
export async function claimWork(flow, runID) {
  if (!['ci', 'release', 'gate'].includes(flow) || !/^[a-zA-Z0-9_-]{1,96}$/u.test(runID ?? '')) fail('任务坐标无效');
  const platform = await directory(join(root, 'target'));
  const work = await directory(join(platform, flow === 'gate' ? 'test' : 'build'));
  const lock = join(work, '.claim.lock');
  try { await mkdir(lock, {mode: 0o700}); } catch (e) { if (e.code === 'EEXIST') fail('同身份短锁被占用'); throw e; }
  const active = join(work, '.active.json');
  try {
    try { await lstat(active); fail('同身份仍有活跃任务，禁止清空'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of await readdir(work)) if (name !== '.claim.lock') await rm(join(work, name), {recursive: true, force: true});
    if ((await readdir(work)).some(name => name !== '.claim.lock')) fail('任务工作根清空回读失败');
    await writeFile(active, JSON.stringify({schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, run_id: runID, work, pid: process.pid}) + '\n', {flag: 'wx', mode: 0o600});
  } finally { await rm(lock, {recursive: true, force: true}); }
  return {work, runID, flow, async finish() {
    if (unsafeWork.has(work)) fail('实际后代退出未确认，保留活跃标记并禁止清场');
    const marker = JSON.parse(await readFile(await checked(active, 'file')));
    if (marker.run_id !== runID || marker.pid !== process.pid || marker.work !== work) fail('活跃任务身份漂移');
    await rm(active);
  }};
}
export function assertWorkQuiescent(work) {
  if (unsafeWork.has(work)) fail('实际后代退出未确认，禁止清场');
}
export function requireSuccessCount(result, label) {
  if (!result || Object.keys(result).sort().join(',') !== 'cancelled,failed,passed,skipped,todo' || !Number.isSafeInteger(result.passed) || result.passed < 1 ||
    ['failed', 'skipped', 'todo', 'cancelled'].some(k => result[k] !== 0)) fail(label + '没有完整执行成功');
  return result;
}
export async function buildWorker(receipt, signal) {
  await verifyFlowResources(receipt,signal);
  const {work, tools} = receipt;
  for (const id of ['cargo', 'rustc', 'worker-build', 'wasm-bindgen', 'wasm-opt', 'esbuild']) await checked(tools[id], 'file');
  const output = join(work, 'worker'); await directory(output);
  const buildLog=await runTool(tools['worker-build'], ['--out-dir', output, '--release', '--', '--locked', '--offline'], {
    work, cwd: join(root, 'server/cloudflare'), tools, environment: receipt.environment, signal});
  process.stderr.write(buildLog.stdout+buildLog.stderr);
  for (const name of ['index.js', 'index_bg.wasm']) {
    const bytes = await bounded(join(output, name), 128 * 1024 ** 2);
    if (!bytes.length || name.endsWith('.wasm') && !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) fail('Worker真实产物无效');
  }
  return output;
}
export async function fullChecks(receipt, signal) {
  await verifyFlowResources(receipt,signal);
  const {work, tools} = receipt, reports = [];
  async function run(id, args, name, extra = {}) {
    const value = await runTool(tools[id], args, {work, tools, environment: receipt.environment, signal, ...extra});
    reports.push({name, completed: true});
    process.stdout.write(value.stdout); process.stderr.write(value.stderr);
    return value;
  }
  await run('cargo', ['fmt', '--all', '--', '--check'], 'Rust格式');
  const rust = await run('cargo', ['test', '-p', 'citizenserve', '--all-targets', '--locked', '--offline'], 'Rust核心及集成测试');
  const results = [...(rust.stdout + rust.stderr).matchAll(/test result: ok\. ([0-9]+) passed; ([0-9]+) failed; ([0-9]+) ignored;/gu)];
  const rustCount = requireSuccessCount({passed: results.reduce((n, m) => n + Number(m[1]), 0),
    failed: results.reduce((n, m) => n + Number(m[2]), 0), skipped: results.reduce((n, m) => n + Number(m[3]), 0), todo: 0, cancelled: 0}, 'Rust测试');
  await run('cargo', ['clippy', '-p', 'citizenserve', '--all-targets', '--locked', '--offline', '--', '-D', 'warnings'], 'Rust核心Clippy');
  const python = await run('python', ['-c', [
    'import unittest,json,sys',
    's=unittest.defaultTestLoader.discover("test",pattern="*storage_contract.py")',
    'n=s.countTestCases()',
    'r=unittest.TextTestRunner(verbosity=2).run(s)',
    'v={"passed":r.testsRun-len(r.failures)-len(r.errors)-len(r.skipped),"failed":len(r.failures)+len(r.errors),"skipped":len(r.skipped),"todo":0,"cancelled":0}',
    'print("CITIZENSERVE_TEST_COUNTS="+json.dumps(v))',
    'sys.exit(0 if n>0 and r.testsRun==n and r.wasSuccessful() and not r.skipped else 1)',
  ].join('\n')], 'SQLite存储合同');
  const counts = python.stdout.match(/^CITIZENSERVE_TEST_COUNTS=(\{.*\})$/mu);
  const pythonCount = requireSuccessCount(counts ? JSON.parse(counts[1]) : null, 'SQLite测试');
  await run('cargo', ['clippy', '-p', 'citizenserve-cloudflare', '--target', 'wasm32-unknown-unknown', '--locked', '--offline', '--', '-D', 'warnings'], 'WorkerWASM Clippy');
  await run('cargo', ['build', '-p', 'citizenserve-cloudflare', '--target', 'wasm32-unknown-unknown', '--release', '--locked', '--offline'], 'WorkerWASM Release编译');
  const nodeSources = ['scripts/resources.test.mjs', 'scripts/tatachat/resources.test.mjs', 'scripts/ci/cloudflare.test.mjs', 'scripts/release/cloudflare.test.mjs', '.github/tatagate/test.mjs'];
  await run('node', ['--test', '--test-reporter=' + join(root, '.github/tatagate/index.mjs'), ...nodeSources], '本仓资源和流程合同测试', {environment: {...receipt.environment, PRODUCT_TEST_REPORT: join(work, 'node-tests.json')}});
  const nodeCount = requireSuccessCount(JSON.parse(await readFile(join(work, 'node-tests.json'))), 'Node测试');
  await buildWorker(receipt, signal);
  const view = await workerTestView(receipt.environment.WORKER_TEST_RECEIPT, receipt.environment.WORKER_TEST_RECEIPT_SHA256, work);
  await run('node', ['--test', '--test-reporter=' + join(root, '.github/tatagate/index.mjs'),
    'push_crypto.mjs', 'worker_smoke.mjs', 'tatachat_smoke.mjs', 'tatachat_data_smoke.mjs'], '真实WASM/workerd接口测试', {cwd: join(view, 'test/worker'), environment: {...receipt.environment, PRODUCT_TEST_REPORT: join(work, 'worker-tests.json')}});
  const workerCount = requireSuccessCount(JSON.parse(await readFile(join(work, 'worker-tests.json'))), 'Worker测试');
  return {schema: 1, reports, rust: rustCount, python: pythonCount, node: nodeCount, worker: workerCount, node_sources: nodeSources,
    worker_sources: ['push_crypto.mjs', 'worker_smoke.mjs', 'tatachat_smoke.mjs', 'tatachat_data_smoke.mjs']};
}
export function tarGzip(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    safeRelative(name); if (Buffer.byteLength(name) > 100) fail('发布路径过长');
    const value = Buffer.from(data), header = Buffer.alloc(512);
    const field = (n, length, text) => header.write(text, n, length, 'ascii');
    field(0, 100, name); field(100, 8, '0000644\0'); field(108, 8, '0000000\0'); field(116, 8, '0000000\0');
    field(124, 12, value.length.toString(8).padStart(11, '0') + '\0'); field(136, 12, '00000000000\0');
    header.fill(32, 148, 156); header[156] = 48; field(257, 6, 'ustar\0'); field(263, 2, '00');
    const checksum = [...header].reduce((a, b) => a + b, 0); field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(header, value, Buffer.alloc((512 - value.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks), {level: 9, mtime: 0});
}
export async function githubRequest(path, {method = 'GET', token, body, signal, binary = false, request = fetch, missing = false} = {}) {
  if (!/^\/repos\/crcfrcn\/citizenserve\/[a-zA-Z0-9_/?=.&%+-]+$/u.test(path) || !token) fail('GitHub能力或准确仓库坐标缺失');
  const response = await request('https://api.github.com' + path, {method, credentials: 'omit', redirect: 'error',
    headers: {Authorization: 'Bearer ' + token, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)});
  if (missing && response.status === 404) return null;
  if (!response.ok) fail('GitHub准确仓库操作失败（状态' + response.status + '）');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > (binary ? 256 * 1024 ** 2 : 1024 * 1024)) fail('GitHub响应超限');
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null;
}
export async function checkoutSHA(receipt) {
  const {stdout} = await runTool(receipt.tools.git, ['-c', 'credential.helper=', '-C', root, 'rev-parse', 'HEAD'], {
    work: receipt.work, tools: receipt.tools, environment: {GIT_CONFIG_NOSYSTEM: '1'}});
  const sha = stdout.trim(); if (!/^[a-f0-9]{40}$/u.test(sha)) fail('准确检出SHA无效'); return sha;
}
export async function sourceProof(receipt, sourceSHA, acceptance) {
  if (await checkoutSHA(receipt) !== sourceSHA) fail('运行源码提交漂移');
  const {stdout} = await runTool(receipt.tools.git, ['-C', root, 'ls-files', '-z'], {work: receipt.work, tools: receipt.tools});
  const sources = [];
  for (const path of stdout.split('\0').filter(p => p && !p.startsWith('target/'))) {
    safeRelative(path);
    const bytes = await bounded(join(root, path), 32 * 1024 ** 2);
    sources.push({path, sha256: digest(bytes), bytes: bytes.length});
  }
  const dirty = await runTool(receipt.tools.git, ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], {work: receipt.work, tools: receipt.tools});
  if (dirty.stdout.trim()) fail('流程只接受干净的已保存提交');
  return {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', source_sha: sourceSHA,
    requirements_sha256: receipt.requirements_sha256, locks: (await flowRequirements('ci')).locks, sources, acceptance};
}
export async function runCLI(operation) {
  if (process.versions.node !== '25.2.1') fail('公开入口要求准确Node25.2.1');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { return await operation(controller.signal); }
  catch { process.stderr.write('公民服务端流程失败；未登记成功，请查看当前准确检查项。\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

// GitHub下载能力只跟随准确官方存储HTTPS重定向，令牌只交给本仓API。
export async function githubDownload(path, {token, signal, request = fetch} = {}) {
  if (!/^\/repos\/crcfrcn\/citizenserve\/(?:actions\/artifacts\/[1-9][0-9]*\/zip|releases\/assets\/[1-9][0-9]*)$/u.test(path) || !token) fail('下载能力坐标无效');
  let url = 'https://api.github.com' + path, response;
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  for (let n = 0; n < 6; n++) {
    const first = n === 0;
    response = await request(url, {redirect: 'manual', credentials: 'omit', signal: timeout,
      headers: first ? {Authorization: 'Bearer ' + token, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28'} : {}});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || n === 5) fail('下载重定向无效');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.hash ||
      !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) &&
      !/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u.test(next.hostname) &&
      !/^productionresultssa[0-9]+\.blob\.core\.usgovcloudapi\.net$/u.test(next.hostname)) fail('下载重定向越界');
    url = next.href;
  }
  if (!response?.ok || !response.body) fail('GitHub固定资产下载失败');
  const chunks = []; let size = 0;
  for await (const b of response.body) { timeout.throwIfAborted(); size += b.length; if (size > 256 * 1024 ** 2) fail('下载资产超限'); chunks.push(Buffer.from(b)); }
  return Buffer.concat(chunks);
}
export async function githubUpload(releaseID, name, bytes, {token, signal, request = fetch} = {}) {
  if (!Number.isSafeInteger(releaseID) || releaseID < 1 || !['citizenserve-cloudflare-release.tgz', 'release-manifest.json', 'SHA256SUMS'].includes(name) || !token) fail('资产上传坐标无效');
  const response = await request('https://uploads.github.com/repos/crcfrcn/citizenserve/releases/' + releaseID + '/assets?name=' + name, {
    method: 'POST', credentials: 'omit', redirect: 'error', headers: {Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/octet-stream'},
    body: bytes, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)});
  if (!response.ok) fail('正式资产上传失败');
  const value = await response.json(); if (value.name !== name || value.size !== bytes.length) fail('资产上传回执不符'); return value;
}
async function verifyDispatchNode() {
  const d = await flowDeclaration(), entry = d.resources.bootstrap.platforms[process.platform + '-' + process.arch];
  if (process.versions.node !== '25.2.1' || !entry?.executable_sha256 ||
    digest(await bounded(process.execPath, 256 * 1024 ** 2)) !== entry.executable_sha256) fail('本机发起器Node运行字节未验真');
}
function controlChannel(environment, signal) {
  if (environment.PRODUCT_CONTROL_FD === undefined) return null;
  if (environment.PRODUCT_CONTROL_FD !== '3') fail('公开控制FD无效');
  const socket = new Socket({fd: 3, readable: true, writable: true});
  let buffer = '', failed, waiter; const queue = [];
  socket.setEncoding('utf8');
  const reject = () => { failed = Error('公开控制通道中断'); waiter?.reject(failed); waiter = null; };
  socket.on('data', chunk => {
    buffer += chunk; if (Buffer.byteLength(buffer) > 8192) { socket.destroy(); reject(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (waiter) { const w = waiter; waiter = null; w.resolve(line); } else { queue.push(line); if (queue.length > 4) { socket.destroy(); reject(); } }
    }
  });
  socket.on('error', reject); socket.on('end', reject);
  signal?.addEventListener('abort', () => { socket.destroy(); reject(); }, {once: true});
  return {async next() {
    if (failed) throw failed; if (queue.length) return queue.shift(); if (waiter) fail('控制请求重叠');
    return new Promise((resolve, reject) => { waiter = {resolve, reject}; });
  }, close() { socket.destroy(); }};
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted(); const timer = setTimeout(done, ms);
  const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(Error('取消')); };
  function done() { signal?.removeEventListener('abort', cancel); resolve(); }
  signal?.addEventListener('abort', cancel, {once: true});
});
const emit = (name, value) => process.stdout.write(name + ':' + Buffer.from(JSON.stringify(value)).toString('base64') + '\n');
function validateRemoteRun(run, flow, sourceSHA) {
  if (!Number.isSafeInteger(run?.id) || run.id < 1 || run.path !== '.github/workflows/citizenserve-cloudflare-' + flow + '.yml' ||
    run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.head_sha !== sourceSHA ||
    run.repository?.full_name !== 'crcfrcn/citizenserve') fail('真实GitHub Run来源不符');
  return run;
}
async function runPages(flow, capability) {
  const results = [];
  for (let page = 1; page <= 100; page++) {
    const value = await githubRequest('/repos/crcfrcn/citizenserve/actions/workflows/citizenserve-cloudflare-' + flow + '.yml/runs?per_page=100&page=' + page, capability);
    if (!Array.isArray(value.workflow_runs)) fail('远端Run列表无效'); results.push(...value.workflow_runs);
    if (value.workflow_runs.length < 100) return results;
  }
  fail('远端Run清点超限');
}
export async function retainRemote(flow, currentID, capability) {
  const protectedIDs = new Set([currentID]);
  for (let page = 1; page <= 100; page++) {
    const releases = await githubRequest('/repos/crcfrcn/citizenserve/releases?per_page=100&page=' + page, capability);
    for (const value of releases) {
      const marker = value.body?.match(/<!-- citizenserve\.cloudflare\.release run_id:([1-9][0-9]*) ci_run_id:([1-9][0-9]*) -->/u);
      if (marker) { protectedIDs.add(Number(marker[1])); protectedIDs.add(Number(marker[2])); }
    }
    if (releases.length < 100) break;
    if (page === 100) fail('正式版本清点超限');
  }
  const runs = (await runPages(flow, capability)).sort((a, b) => b.id - a.id);
  for (const state of ['success', 'failed']) {
    const latest = runs.find(r => r.status === 'completed' && (r.conclusion === 'success' ? 'success' : 'failed') === state);
    if (latest) protectedIDs.add(latest.id);
  }
  const removed = [];
  for (const run of runs) {
    if (run.status !== 'completed' || protectedIDs.has(run.id)) continue;
    if (run.path !== '.github/workflows/citizenserve-cloudflare-' + flow + '.yml' || run.repository?.full_name !== 'crcfrcn/citizenserve') fail('历史清理跨身份');
    const current = await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + run.id, {...capability, missing: true});
    if (!current) { removed.push(run.id); continue; }
    if (current.status !== 'completed' || current.path !== run.path || current.repository?.full_name !== 'crcfrcn/citizenserve') fail('历史Run清理前漂移或仍活跃');
    await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + run.id, {...capability, method: 'DELETE'});
    if (await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + run.id, {...capability, missing: true}) !== null) fail('历史Run删除回读失败');
    removed.push(run.id);
  }
  return removed;
}
export async function dispatchFlow(flow, {environment = process.env, signal} = {}) {
  if (!['ci', 'release'].includes(flow)) fail('远端流程身份无效');
  await verifyDispatchNode();
  const capability = {token: environment.GH_TOKEN, signal}, channel = controlChannel(environment, signal);
  let remote, candidate;
  try {
    const ref = await githubRequest('/repos/crcfrcn/citizenserve/git/ref/heads/main', capability);
    const sourceSHA = ref.object?.sha; if (ref.ref !== 'refs/heads/main' || ref.object.type !== 'commit' || !/^[a-f0-9]{40}$/u.test(sourceSHA ?? '')) fail('准确远端main无效');
    const inputs = {pipeline: 'citizenserve.cloudflare.' + flow, run_title: '公民服务端 · Cloudflare · ' + (flow === 'ci' ? 'CI' : 'Release'), source_sha: sourceSHA};
    if (flow === 'release') {
      const runs = (await runPages('ci', capability)).filter(r => r.head_sha === sourceSHA && r.event === 'workflow_dispatch').sort((a, b) => b.id - a.id);
      const ci = validateRemoteRun(runs[0], 'ci', sourceSHA);
      if (ci.status !== 'completed' || ci.conclusion !== 'success') fail('最新同SHA CI未成功，必须先完成准确CI');
      const {cargoVersion} = await import('./release/cloudflare.mjs');
      const source = await githubRequest('/repos/crcfrcn/citizenserve/contents/Cargo.toml?ref=' + sourceSHA, capability);
      if (source.encoding !== 'base64' || source.type !== 'file') fail('版本源文件回读无效');
      const version = cargoVersion(Buffer.from(source.content.replace(/\s/gu, ''), 'base64').toString());
      candidate = {product_id: 'citizenserve', platform: 'cloudflare', software_flow: 'release', software_version: version,
        spec_version: null, source_sha: sourceSHA, workflow: 'citizenserve.cloudflare.release', ci_run_id: ci.id, run_id: null,
        version_tag: 'citizenserve-cloudflare-v' + version};
      if (environment.PRODUCT_RELEASE_RETRY_CONTEXT) {
        const previous = JSON.parse(Buffer.from(environment.PRODUCT_RELEASE_RETRY_CONTEXT, 'base64'));
        if (previous.source_sha !== sourceSHA || previous.ci_run_id !== ci.id || previous.version_tag !== candidate.version_tag) fail('持久候选与当前同SHA CI不一致');
        candidate = {...candidate, run_id: null};
      }
      Object.assign(inputs, {ci_run_id: String(ci.id), software_version: version, version_tag: candidate.version_tag});
      if (channel) { emit('PRODUCT_RELEASE_CANDIDATE', candidate); if (await channel.next() !== 'PRODUCT_RELEASE_CANDIDATE_ACCEPTED') fail('正式候选保存被拒绝'); }
    }
    const before = new Set((await runPages(flow, capability)).map(r => r.id));
    await githubRequest('/repos/crcfrcn/citizenserve/actions/workflows/citizenserve-cloudflare-' + flow + '.yml/dispatches', {...capability, method: 'POST', body: {ref: 'main', inputs}});
    for (let n = 0; n < 40 && !remote; n++) {
      await delay(1500, signal);
      const matches = (await runPages(flow, capability)).filter(r => !before.has(r.id) && r.head_sha === sourceSHA && r.event === 'workflow_dispatch');
      if (matches.length > 1) fail('远端发起结果存在歧义，禁止猜测Run');
      if (matches.length === 1) remote = validateRemoteRun(matches[0], flow, sourceSHA);
    }
    if (!remote) fail('未取得本次准确GitHub Run');
    if (candidate && channel) { candidate.run_id = remote.id; emit('PRODUCT_RELEASE_CANDIDATE', candidate); if (await channel.next() !== 'PRODUCT_RELEASE_CANDIDATE_ACCEPTED') fail('正式候选Run绑定被拒绝'); }
    emit('PRODUCT_REMOTE_RUN', {repository: 'crcfrcn/citizenserve', workflow: 'citizenserve.cloudflare.' + flow,
      run_id: remote.id, url: 'https://github.com/crcfrcn/citizenserve/actions/runs/' + remote.id});
    if (channel && await channel.next() !== 'PRODUCT_REMOTE_RUN_ACCEPTED:' + remote.id) fail('宿主Run绑定被拒绝');
    let state;
    if (channel) {
      const frame = await channel.next();
      if (!['PRODUCT_REMOTE_RESULT:' + remote.id + ':success', 'PRODUCT_REMOTE_RESULT:' + remote.id + ':failed'].includes(frame)) fail('宿主远端终态帧无效');
      state = frame.endsWith(':success') ? 'success' : 'failed';
    } else {
      for (let n = 0; n < 4320; n++) {
        const value = validateRemoteRun(await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + remote.id, capability), flow, sourceSHA);
        if (value.status === 'completed') { state = value.conclusion === 'success' ? 'success' : 'failed'; break; }
        await delay(5000, signal);
      }
    }
    if (!state) fail('远端任务超时');
    const recovered = await recoverFlow(flow, ['--run-id', String(remote.id), '--result', state], {environment: {...environment,
      ...(candidate ? {PRODUCT_RELEASE_RETRY_CONTEXT: Buffer.from(JSON.stringify(candidate)).toString('base64')} : {})}, signal, silent: true});
    if (state !== 'success') fail('远端流程未成功；停止同目标且禁止自动重试');
    return recovered;
  } catch (e) {
    if (signal?.aborted && remote) {
      // 只取消当前绑定的真实Run，失败诊断不夹带令牌或API响应。
      await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + remote.id + '/cancel', {token: environment.GH_TOKEN, method: 'POST'}).catch(() => {});
    }
    throw e;
  } finally { channel?.close(); }
}
export async function recoverFlow(flow, args, {environment = process.env, signal, silent = false} = {}) {
  await verifyDispatchNode();
  if (!['ci', 'release'].includes(flow) || args.length !== 4 || args[0] !== '--run-id' || args[2] !== '--result' ||
    !/^[1-9][0-9]*$/u.test(args[1] ?? '') || !['success', 'failed'].includes(args[3])) fail('恢复坐标无效');
  const id = Number(args[1]), capability = {token: environment.GH_TOKEN, signal};
  const run = await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + id, capability);
  validateRemoteRun(run, flow, run.head_sha);
  if (run.status !== 'completed' || (run.conclusion === 'success' ? 'success' : 'failed') !== args[3]) fail('实际Run终态与恢复输入不符');
  let formal = null;
  if (flow === 'release' && args[3] === 'success') {
    if (!environment.PRODUCT_RELEASE_RETRY_CONTEXT) fail('恢复缺少持久正式候选');
    const c = JSON.parse(Buffer.from(environment.PRODUCT_RELEASE_RETRY_CONTEXT, 'base64'));
    if (c.run_id !== id || c.source_sha !== run.head_sha || c.workflow !== 'citizenserve.cloudflare.release') fail('正式候选恢复身份不符');
    const {validatePublished} = await import('./release/cloudflare.mjs');
    const release = validatePublished(await githubRequest('/repos/crcfrcn/citizenserve/releases/tags/' + c.version_tag, capability), {tag: c.version_tag, sourceSHA: c.source_sha});
    let manifest;
    for (const asset of release.assets) {
      const bytes = await githubDownload('/repos/crcfrcn/citizenserve/releases/assets/' + asset.id, capability);
      if (bytes.length !== asset.size || 'sha256:' + digest(bytes) !== asset.digest) fail('正式版本恢复资产回读失败');
      if (asset.name === 'release-manifest.json') manifest = JSON.parse(bytes);
    }
    if (manifest?.release_run_id !== id || manifest.ci_run_id !== c.ci_run_id || manifest.source_sha !== c.source_sha ||
      manifest.software_version !== c.software_version) fail('正式版本恢复来源不符');
    const tag = await githubRequest('/repos/crcfrcn/citizenserve/git/ref/tags/' + c.version_tag, capability);
    if (tag.object.type !== 'commit' || tag.object.sha !== c.source_sha) fail('正式版本恢复Tag不符');
    formal = {record_type: 'github-release', product_id: 'citizenserve', platform: 'cloudflare', software_flow: 'release',
      state: 'success', repository: 'crcfrcn/citizenserve', product_title: '公民服务端', run_id: id, run_number: run.run_number,
      source_sha: c.source_sha, tag_sha: tag.object.sha, tag: c.version_tag, updated_at: release.published_at, url: release.html_url};
  }
  const value = {formal_release: formal, removed_run_ids: await retainRemote(flow, id, capability)};
  if (!silent) process.stdout.write(JSON.stringify(value) + '\n'); return value;
}

async function flowReceipt(path,signal) {
  const receipt = JSON.parse((await bounded(path, 16 * 1024 ** 2)).toString());
  if (path !== join(receipt.work, 'resources.json')) fail('完整资源回执路径不符');
  return verifyFlowResources(receipt,signal);
}

// Bash官方补丁使用context diff；精确匹配完整原行，拒绝删减上下文或多处匹配。
export async function applyBashPatch(sourceRoot, patchBytes) {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(patchBytes), lines = text.split('\n');
  let file, content, offset = 0, applied = 0;
  async function flush() { if (file) await writeFile(file, content.join('\n')); }
  for (let at = 0; at < lines.length; at++) {
    if (/^\*\*\* [^0-9]/u.test(lines[at]) && /^--- [^0-9]/u.test(lines[at + 1] ?? '')) {
      await flush();
      const relative = lines[++at].slice(4).split(/\s/u)[0]; safeRelative(relative);
      file = join(sourceRoot, relative); content = (await readFile(await checked(file, 'file'), 'utf8')).split('\n'); offset = 0; continue;
    }
    const oldRange = /^\*\*\* ([0-9]+)(?:,([0-9]+))? \*\*\*\*$/u.exec(lines[at]);
    if (!oldRange) continue;
    if (!file) fail('Bash补丁缺少目标文件');
    const before = [], after = []; let newRange;
    for (at++; at < lines.length; at++) {
      newRange = /^--- ([0-9]+)(?:,([0-9]+))? ----$/u.exec(lines[at]); if (newRange) break;
      if (!/^(?:  |- |! )/u.test(lines[at])) fail('Bash补丁旧行格式无效');
      before.push(lines[at]);
    }
    if (!newRange) fail('Bash补丁新范围缺失');
    for (at++; at < lines.length && /^(?:  |\+ |! )/u.test(lines[at]); at++) after.push(lines[at]);
    at--;
    // 官方纯增加/删除hunk可省略未变化的一侧；该侧只从另一侧完整context行恢复。
    const old = (before.length ? before : after.filter(l => l.startsWith('  '))).map(l => l.slice(2));
    const next = (after.length ? after : before.filter(l => l.startsWith('  '))).map(l => l.slice(2));
    const oldLength = Number(oldRange[2] ?? oldRange[1]) - Number(oldRange[1]) + 1;
    const nextLength = Number(newRange[2] ?? newRange[1]) - Number(newRange[1]) + 1;
    if (old.length !== oldLength || next.length !== nextLength || !old.length) fail('Bash补丁范围与原行数不符');
    const same = position => position >= 0 && old.every((line, i) => content[position + i] === line);
    let position = Number(oldRange[1]) - 1 + offset;
    if (!same(position)) {
      // 上游补丁行号可来自较早快照；只接受全文唯一完整原行，绝不丢context或猜测。
      const matches = []; for (let i = 0; i + old.length <= content.length; i++) if (same(i)) matches.push(i);
      if (matches.length !== 1) fail('Bash补丁完整原行缺失或匹配歧义');
      position = matches[0];
    }
    content.splice(position, old.length, ...next); offset += next.length - old.length; applied++;
  }
  await flush(); if (!applied) fail('Bash补丁没有真实变更');
}
async function normalizeLinks(rootPath) {
  async function walk(at) {
    for (const name of await readdir(at)) {
      const path = join(at, name), st = await lstat(path);
      if (st.isSymbolicLink()) {
        const target = await realpath(path);
        if (!inside(rootPath, target) || !(await lstat(target)).isFile()) fail('原生安装链接越界或类型无效');
        const bytes = await readFile(target), mode = (await lstat(target)).mode & 0o777;
        await rm(path); await writeFile(path, bytes, {flag: 'wx', mode});
      } else if (st.isDirectory()) await walk(path);
      else if (!st.isFile()) fail('原生安装产生特殊文件');
      else if (st.nlink !== 1) {
        const bytes = await readFile(path); await rm(path);
        await writeFile(path, bytes, {flag: 'wx', mode: st.mode & 0o777});
      }
    }
  }
  await walk(rootPath);
}

function shellQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) fail('工具脚本参数无效');
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function processTable() {
  if (process.platform !== 'linux') return null;
  const entries = await readdir('/proc'); const table = new Map();
  await Promise.all(entries.filter(n => /^[1-9][0-9]*$/u.test(n)).map(async name => {
    try {
      const text = await readFile('/proc/' + name + '/stat', 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ');
      table.set(Number(name), {pid: Number(name), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19]});
    } catch (e) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(e.code)) throw e; }
  }));
  return table;
}
function descendantTracker(pid) {
  const owned = new Map(); let current = Promise.resolve();
  function scan() {
    current = current.then(async () => {
      const table = await processTable(); if (!table) return null;
      let changed = true;
      while (changed) {
        changed = false;
        const rootValid = !owned.has(pid) || !table.has(pid) || table.get(pid).start === owned.get(pid);
        for (const value of table.values()) if (!owned.has(value.pid) && rootValid && (value.pid === pid ||
          value.parent === pid && (!owned.has(pid) || table.get(pid)?.start === owned.get(pid)) ||
          owned.has(value.parent) && table.get(value.parent)?.start === owned.get(value.parent) || value.group === pid)) { owned.set(value.pid, value.start); changed = true; }
      }
      return table;
    });
    return current;
  }
  async function stop() {
    const table = await scan();
    if (table) for (const [id, start] of owned) {
      const value = table.get(id); if (value?.start !== start || value.state === 'Z') continue;
      try { process.kill(id, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }
  async function quiet() {
    const table = await scan();
    if (table) return [...owned].every(([id, start]) => { const value = table.get(id); return !value || value.start !== start || value.state === 'Z'; });
    try { process.kill(-pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') throw e; return true; }
  }
  return {scan, stop, quiet};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCLI(async signal => {
    const [command, ...args] = process.argv.slice(2);
    if(command==='execute'){
      const [platform,...flags]=args,options={signal},allowed=new Set(['--work','--mode','--tool-root','--dependency-root','--run-id','--offline']);let mode;
      for(let n=0;n<flags.length;n++){const key=flags[n];if(!allowed.delete(key))fail('Build参数重复或未知');
       if(key==='--offline'){options.offline=true;continue;}const value=flags[++n];if(!value||value.startsWith('--'))fail('Build参数缺值');
       if(key==='--work')options.work=value;else if(key==='--mode')mode=value;else if(key==='--tool-root')options.toolRoot=value;else if(key==='--dependency-root')options.dependencyRoot=value;else options.runID=value;}
      let request;
      if(process.env.PRODUCT_RESOURCE_FD!==undefined){
       if(process.env.PRODUCT_RESOURCE_FD!=='4'||mode!==undefined||options.toolRoot||options.dependencyRoot||options.runID)fail('控制台模式不能混入独立参数');
       const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>2*1024**2)fail('Build输入超限');chunks.push(chunk);}request=JSON.parse(Buffer.concat(chunks));
       if(request.resource_mode!=='provided'||request.work!==options.work||request.platform!==platform)fail('Build输入与参数身份不符');
      }else{
       if(mode!=='independent'||platform!=='cloudflare'||!options.toolRoot||!options.dependencyRoot)fail('独立Build必须显式给出模式和两处源码外原件库');
       for(const path of [options.toolRoot,options.dependencyRoot]){if(path===root||inside(root,path))fail('独立原件库不得进入产品源码');await checked(path,'directory');}
       request={schema:1,product_id:'citizenserve',platform,work:options.work,run_id:options.runID??randomUUID(),resource_mode:'independent'};
      }
      process.stdout.write(JSON.stringify(await executeBuild(request,options))+'\n');
    }else if (command === 'requirements' && args.length===2) process.stdout.write(JSON.stringify(await requirements(args[0],args[1]))+'\n');
    else if(command==='protocol-requirements'&&!args.length)process.stdout.write(JSON.stringify(await protocolRequirements())+'\n');
    else if (command === 'flow-requirements' && args.length === 1) process.stdout.write(JSON.stringify(await flowRequirements(args[0])) + '\n');
    else if (command === 'verify' && args.length === 1) process.stdout.write(JSON.stringify(await verify(args[0], signal)) + '\n');
    else if (command === 'prepare' && args.length === 1) {
      const input = JSON.parse((await bounded(args[0], 65536)).toString());
      process.stdout.write(JSON.stringify(await prepare({...input, signal})) + '\n');
    } else if (command === 'prepare-flow' && args.length === 1) {
      const input = JSON.parse((await bounded(args[0], 1024 * 1024)).toString());
      process.stdout.write(JSON.stringify(await prepareFlowResources({...input, signal})) + '\n');
    } else if (command === 'worker-view' && args.length === 3) process.stdout.write(await workerTestView(args[0], args[1], args[2]) + '\n');
    else if (command === 'runtime') {
      const {runtimeCLI} = await import('./tatachat/resources.mjs');
      process.stdout.write(JSON.stringify(await runtimeCLI(args, {signal})) + '\n');
    } else if (['checks', 'build-worker', 'check-worker'].includes(command) && args.length === 1) {
      const receipt = await flowReceipt(args[0],signal);
      if (command === 'checks') await fullChecks(receipt, signal);
      else if (command === 'build-worker') await buildWorker(receipt, signal);
      else {
        const view = await workerTestView(receipt.environment.WORKER_TEST_RECEIPT, receipt.environment.WORKER_TEST_RECEIPT_SHA256, receipt.work);
        await runTool(receipt.tools.node, ['--test', '--test-reporter=' + join(root, '.github/tatagate/index.mjs'),
          'push_crypto.mjs', 'worker_smoke.mjs', 'tatachat_smoke.mjs', 'tatachat_data_smoke.mjs'], {
          work: receipt.work, tools: receipt.tools, environment: receipt.environment, cwd: join(view, 'test/worker'), signal});
      }
    } else if (command === 'exec' && args[1] === '--' && args.length >= 3) {
      const receipt = await flowReceipt(process.env.PRODUCT_FLOW_RESOURCE_RECEIPT,signal);
      if (args[0] !== receipt.environment.TATACHAT_RESOURCE_RECEIPT || !Object.values(receipt.tools).includes(args[2])) fail('执行器不属于当前已验真闭包');
      await runTool(args[2], args.slice(3), {work: receipt.work, tools: receipt.tools, environment: receipt.environment,
        cwd: process.env.PRODUCT_EXECUTION_CWD ?? root, signal, capture: false});
    } else if (['run', 'recover'].includes(command) && args[1] === 'cloudflare' && ['ci', 'release'].includes(args[0])) {
      const {main} = await import('./' + args[0] + '/cloudflare.mjs');
      await main(command === 'run' && args.length === 2 ? ['dispatch'] : ['recover', ...args.slice(2)]);
    } else fail('公开入口参数无效');
  });
}

// 可信Node直接展开已验真XZ，避免Mac准备Rust时调用系统xz或下载Linux解包工具。
// 格式依据 https://tukaani.org/xz/xz-file-format.txt；只接受本声明使用的单流LZMA2。
function xzCRC(bytes,width=32,initial){
 if(!xzCRC.tables){const table32=new Uint32Array(256),table64=[];for(let n=0;n<256;n++){let a=n,b=BigInt(n);for(let k=0;k<8;k++){a=(a>>>1)^((a&1)?0xedb88320:0);b=(b>>1n)^((b&1n)?0xc96c5795d7870f42n:0n);}table32[n]=a>>>0;table64[n]=b;}xzCRC.tables={table32,table64};}
 let value=initial??(width===32?0xffffffff:0xffffffffffffffffn);
 if(width===32){for(const byte of bytes)value=(value>>>8)^xzCRC.tables.table32[(value^byte)&255];return (value^0xffffffff)>>>0;}
 for(const byte of bytes)value=(value>>8n)^xzCRC.tables.table64[Number((value^BigInt(byte))&255n)];return value^0xffffffffffffffffn;
}
async function xzOutputCheck(bytes,kind,expected,signal){
 if(kind===0)return;
 const hash=kind===10?createHash('sha256'):null,width=kind===1?32:64,mask=width===32?0xffffffff:0xffffffffffffffffn;let value=width===32?0:0n;
 for(let at=0;at<bytes.length;at+=1024**2){signal?.throwIfAborted();await delay(0);const chunk=bytes.subarray(at,at+1024**2);if(hash)hash.update(chunk);else value=xzCRC(chunk,width,value^mask);}
 if(hash?!hash.digest().equals(expected):kind===1?value!==expected.readUInt32LE():value!==expected.readBigUInt64LE())fail('XZ展开校验失败');
}
function xzInteger(bytes,cursor,end){
 let value=0,scale=1;
 for(let n=0;n<9&&cursor.at<end;n++){const byte=bytes[cursor.at++];if(n&&byte===0)fail('XZ整数非规范');value+=(byte&127)*scale;if(!Number.isSafeInteger(value))fail('XZ整数超限');if(!(byte&128))return value;scale*=128;}
 fail('XZ整数截断');
}
async function lzma2Bytes(input,expected,dictionary,signal){
 const output=Buffer.alloc(expected);let pos=0,at=0,dictStart=0,initialized=false,props,models,state,reps;
 const probs=n=>new Uint16Array(n).fill(1024);
 function reset(){models={match:probs(192),rep:probs(12),g0:probs(12),g1:probs(12),g2:probs(12),short:probs(192),slot:probs(256),special:probs(114),align:probs(16),literal:probs(768*(1<<(props.lc+props.lp))),
  length:[{choice:probs(2),low:probs(128),mid:probs(128),high:probs(256)},{choice:probs(2),low:probs(128),mid:probs(128),high:probs(256)}]};state=0;reps=[0,0,0,0];}
 function read(){if(at>=input.length)fail('LZMA2截断');return input[at++];}
 function copy(distance,length,limit){
  if(distance>=dictionary||distance>=pos-dictStart||pos+length>limit)fail('LZMA2字典或长度越界');
  for(let n=0;n<length;n++){output[pos]=output[pos-distance-1];pos++;}
 }
 while(at<input.length){
  signal?.throwIfAborted();await delay(0);const control=read();if(control===0){if(at!==input.length||pos!==expected)fail('LZMA2终态不符');return output;}
  if(control===1||control===2){const count=(read()<<8|read())+1;if(control===1){dictStart=pos;initialized=true;}else if(!initialized)fail('LZMA2未初始化字典');
   if(at+count>input.length||pos+count>expected)fail('LZMA2原始块越界');input.copy(output,pos,at,at+count);at+=count;pos+=count;models=undefined;continue;}
  if(control<128||!initialized&&control<224)fail('LZMA2控制字无效');
  const size=((control&31)<<16|(read()<<8)|read())+1,packed=(read()<<8|read())+1,limit=pos+size;
  if(control>=224){dictStart=pos;initialized=true;}
  if(control>=192){const value=read();if(value>=225)fail('LZMA2属性无效');props={lc:value%9,lp:Math.floor(value/9)%5,pb:Math.floor(value/45)};if(props.lc+props.lp>4)fail('LZMA2字面量属性越界');}
  if(control>=160){if(!props)fail('LZMA2缺少属性');reset();}else if(!models)fail('LZMA2状态未复位');
  if(limit>expected||at+packed>input.length||packed<5)fail('LZMA2压缩块越界');
  const start=at,end=at+packed;let range=0xffffffff,code=0;
  if(read()!==0)fail('LZMA2范围编码头无效');for(let n=0;n<4;n++)code=(code*256+read())>>>0;
  const normalize=()=>{if(range<0x1000000){if(at>=end)fail('LZMA2范围编码截断');range=(range*256)>>>0;code=(code*256+read())>>>0;}};
  const bit=(array,index)=>{normalize();const p=array[index];if(p===undefined)fail('LZMA2概率索引越界');const bound=(range>>>11)*p;let value;
   if(code<bound){range=bound>>>0;array[index]=p+((2048-p)>>>5);value=0;}else{range=(range-bound)>>>0;code=(code-bound)>>>0;array[index]=p-(p>>>5);value=1;}return value;};
  const tree=(array,offset,bits,reverse=false)=>{let symbol=1,value=0;for(let n=0;n<bits;n++){const b=bit(array,offset+symbol);symbol=symbol*2+b;if(reverse)value+=b*2**n;}return reverse?value:symbol-2**bits;};
  const direct=bits=>{let value=0;for(let n=0;n<bits;n++){normalize();range>>>=1;const b=code>=range?1:0;if(b)code=(code-range)>>>0;value=value*2+b;}return value;};
  const length=(which,ps)=>{const m=models.length[which];if(!bit(m.choice,0))return 2+tree(m.low,ps*8,3);if(!bit(m.choice,1))return 10+tree(m.mid,ps*8,3);return 18+tree(m.high,0,8);};
  while(pos<limit){
   if((pos&65535)===0){signal?.throwIfAborted();await delay(0);}
   const position=pos-dictStart,ps=position&((1<<props.pb)-1),index=state*16+ps;
   if(!bit(models.match,index)){
    const previous=pos>dictStart?output[pos-1]:0,context=((position&((1<<props.lp)-1))<<props.lc)+(previous>>>(8-props.lc)),offset=context*768;let symbol=1;
    if(state>=7){if(reps[0]>=position||reps[0]>=dictionary)fail('LZMA2字面量匹配越界');let match=output[pos-reps[0]-1];while(symbol<256){const mb=match>>>7&1;match=(match<<1)&255;const b=bit(models.literal,offset+((1+mb)<<8)+symbol);symbol=symbol*2+b;if(b!==mb)break;}}
    while(symbol<256)symbol=symbol*2+bit(models.literal,offset+symbol);
    output[pos++]=symbol-256;state=state<4?0:state<10?state-3:state-6;continue;
   }
   let count;
   if(bit(models.rep,state)){
    if(!bit(models.g0,state)){if(!bit(models.short,index)){state=state<7?9:11;copy(reps[0],1,limit);continue;}}
    else{let distance;if(!bit(models.g1,state))distance=reps[1];else{if(!bit(models.g2,state))distance=reps[2];else{distance=reps[3];reps[3]=reps[2];}reps[2]=reps[1];}reps[1]=reps[0];reps[0]=distance;}
    count=length(1,ps);state=state<7?8:11;
   }else{
    count=length(0,ps);state=state<7?7:10;reps[3]=reps[2];reps[2]=reps[1];reps[1]=reps[0];
    const slot=tree(models.slot,Math.min(count-2,3)*64,6);let distance=slot;
    if(slot>=4){const bits=(slot>>>1)-1;distance=(2+(slot&1))*2**bits;if(slot<14)distance+=tree(models.special,distance-slot-1,bits,true);else distance+=direct(bits-4)*16+tree(models.align,0,4,true);}
    reps[0]=distance;
   }
   copy(reps[0],count,limit);
  }
  normalize();if(code!==0||at!==end||at<start+5)fail('LZMA2范围编码未完整结束');
 }
 fail('LZMA2缺少结束字');
}
export async function xzBytes(bytes,signal){
 if(bytes.length<32||bytes.length%4||!bytes.subarray(0,6).equals(Buffer.from([253,55,122,88,90,0]))||bytes[6]!==0||bytes[7]&240)fail('XZ流头无效');
 const check=bytes[7],checkSize={0:0,1:4,4:8,10:32}[check];if(checkSize===undefined)fail('XZ校验类型未实现');
 if(xzCRC(bytes.subarray(6,8))!==bytes.readUInt32LE(8))fail('XZ流头校验失败');
 const footer=bytes.length-12;if(bytes[footer+10]!==89||bytes[footer+11]!==90||bytes[footer+8]!==0||bytes[footer+9]!==check||xzCRC(bytes.subarray(footer+4,footer+10))!==bytes.readUInt32LE(footer))fail('XZ流尾校验失败');
 const indexSize=(bytes.readUInt32LE(footer+4)+1)*4,indexStart=footer-indexSize;
 if(indexStart<12||bytes[indexStart]!==0||xzCRC(bytes.subarray(indexStart,footer-4))!==bytes.readUInt32LE(footer-4))fail('XZ索引校验失败');
 const cursor={at:indexStart+1},count=xzInteger(bytes,cursor,footer-4);if(count<1||count>65536)fail('XZ块数量无效');
 const records=[];let total=0;for(let n=0;n<count;n++){const unpadded=xzInteger(bytes,cursor,footer-4),size=xzInteger(bytes,cursor,footer-4);if(unpadded<5||size<1||(total+=size)>4*1024**3)fail('XZ展开超限');records.push({unpadded,size});}
 if(bytes.subarray(cursor.at,footer-4).some(x=>x!==0))fail('XZ索引填充无效');
 const chunks=[];let block=12;
 for(const record of records){
  signal?.throwIfAborted();const headerSize=(bytes[block]+1)*4,headerEnd=block+headerSize;if(headerSize<8||headerEnd>indexStart||xzCRC(bytes.subarray(block,headerEnd-4))!==bytes.readUInt32LE(headerEnd-4))fail('XZ块头校验失败');
  const flags=bytes[block+1];if(flags&63)fail('XZ只接受单个LZMA2过滤器');const c={at:block+2};
  const compressed=flags&64?xzInteger(bytes,c,headerEnd-4):null,uncompressed=flags&128?xzInteger(bytes,c,headerEnd-4):null;
  if(xzInteger(bytes,c,headerEnd-4)!==33||xzInteger(bytes,c,headerEnd-4)!==1)fail('XZ过滤器不符');const prop=bytes[c.at++];if(prop>40||bytes.subarray(c.at,headerEnd-4).some(x=>x!==0))fail('XZ字典属性或填充无效');
  const dictionary=prop===40?0xffffffff:(2+(prop&1))*2**((prop>>>1)+11),packed=record.unpadded-headerSize-checkSize;
  if(packed<1||compressed!==null&&compressed!==packed||uncompressed!==null&&uncompressed!==record.size)fail('XZ块长度与索引不符');
  const dataEnd=headerEnd+packed,padding=(4-packed%4)%4,checkAt=dataEnd+padding,next=checkAt+checkSize;
  if(next>indexStart||bytes.subarray(dataEnd,checkAt).some(x=>x!==0))fail('XZ块越界或填充无效');
  const decoded=await lzma2Bytes(bytes.subarray(headerEnd,dataEnd),record.size,dictionary,signal);
  await xzOutputCheck(decoded,check,bytes.subarray(checkAt,next),signal);
  chunks.push(decoded);block=next;
 }
 if(block!==indexStart)fail('XZ块闭集不符');return Buffer.concat(chunks,total);
}

// 本机Build的公开需求覆盖实际编译闭包；协议需求仍由同一声明单独解析。
export async function requirements(platform,work) {
 if(process.platform!=='darwin'||process.arch!=='arm64')fail('本机Build没有当前宿主实现');
 if(platform!=='cloudflare'||work!==join(root,'target/build'))fail('Build平台或固定工作根无效');
 return {...await flowRequirements('build'),protocol:await protocolRequirements()};
}
async function externalManifest(path,signal){
 const result=[];await checked(path,'directory');
 async function walk(at,prefix=''){for(const name of (await readdir(at)).sort()){
  signal?.throwIfAborted();const full=join(at,name),rel=prefix+name,st=await lstat(full);
  if(st.isDirectory()){await checked(full,'directory');await walk(full,rel+'/');}
  else if(st.isSymbolicLink()){const target=await realpath(full);if(!inside(path,target)||(await lstat(target)).isDirectory())fail('外部工具链接越界');
   const b=await bounded(target,1024**3);result.push({path:rel,type:'link',target:join('/',relativePath(path,target)).slice(1),sha256:digest(b),bytes:b.length,mode:st.mode&0o777});}
  else{const b=await bounded(full,1024**3);result.push({path:rel,type:'file',sha256:digest(b),bytes:b.length,mode:st.mode&0o777});}
 }}await walk(path);return result;
}
function relativePath(base,path){if(!inside(base,path))fail('相对工具路径越界');return path.slice(base.length+1);}
async function verifyExternalTool(wanted,value,toolRoot,signal){
 if(!value||value.version!==wanted.version||value.archive_sha256!==wanted.archive.sha256||!inside(toolRoot,value.root)
  ||value.path!==join(value.root,wanted.archive.executable)||!value.slots||JSON.stringify(await externalManifest(value.root,signal))!==JSON.stringify(value.files))fail('工具交付与准确需求不符');
 for(const slot of wanted.slots){if(value.slots[slot]!==join(value.root,slot))fail('工具入口槽位漂移');const path=await realpath(value.slots[slot]);if(!inside(value.root,path))fail('工具入口越界');const st=await lstat(path);if(!st.isFile()||!(st.mode&0o111))fail('工具入口不能执行');}
 for(const entry of wanted.components||[])await checked(join(value.root,'lib/rustlib',entry.target,'lib'),'directory');
 return value;
}
async function macApple(work,wanted,signal){
 if(process.platform!=='darwin'||process.arch!=='arm64'||wanted?.source!=='https://developer.apple.com/xcode/'||!/^\d+\.\d+(?:\.\d+)?$/u.test(wanted.version))fail('Mac编译能力声明无效');
 const system={codesign:'/usr/bin/codesign',security:'/usr/bin/security',xcrun:'/usr/bin/xcrun',select:'/usr/bin/xcode-select'},tools={node:process.execPath};
 const call=(path,args,environment={})=>runTool(path,args,{work,cwd:work,tools,signal,environment,timeout:60000});
 for(const path of Object.values(system)){await checked(path,'file');await call(system.codesign,['--verify','--strict','-R','=anchor apple',path]);}
 const developerDirectory=(await call(system.select,['-p'])).stdout.trim();
 if(!/^\/Applications\/[^/\x00-\x1f]+\.app\/Contents\/Developer$/u.test(developerDirectory))fail('Xcode位置无效');await checked(developerDirectory,'directory');
 await call(system.codesign,['--verify','--deep','--strict','-R','=anchor apple and identifier "com.apple.dt.Xcode"',dirname(dirname(developerDirectory))]);
 const xcodebuild=join(developerDirectory,'usr/bin/xcodebuild');await checked(xcodebuild,'file');
 const environment={DEVELOPER_DIR:developerDirectory},version=(await call(xcodebuild,['-version'],environment)).stdout;
 if(!version.startsWith('Xcode '+wanted.version+'\n')||!/^Build version [A-Za-z0-9]+\s*$/u.test(version.split('\n').slice(1).join('\n')))fail('Xcode准确版本不符');
 const slots={};
 for(const name of wanted.names){const path=name==='xcrun'?system.xcrun:(await call(system.xcrun,['--find',name],environment)).stdout.trim(),actual=await realpath(path);
  if(name!=='xcrun'&&!inside(developerDirectory,actual))fail('Apple编译器越界');await checked(actual,'file');await call(system.codesign,['--verify','--strict','-R','=anchor apple',actual]);slots[name]=actual;}
 const sdk=(await call(system.xcrun,['--sdk','macosx','--show-sdk-path'],environment)).stdout.trim();if(!inside(developerDirectory,sdk))fail('SDK不属于当前Xcode');await checked(sdk,'directory');
 return {developerDirectory,version:wanted.version,tools:slots,sdk};
}
async function freezeResourceTree(path,writable=false){
 const info=await lstat(path);if(info.isSymbolicLink())return;
 if(info.isDirectory()){if(writable)await chmod(path,0o700);for(const name of await readdir(path))await freezeResourceTree(join(path,name),writable);if(!writable)await chmod(path,0o555);}
 else if(info.isFile())await chmod(path,writable?(info.mode|0o600):(info.mode&0o111?0o555:0o444));else fail('工具对象含特殊文件');
}
async function independentTool(wanted,options){
 const object=join(options.toolRoot,wanted.archive.sha256),payload=join(object,'payload');
 const deliver=async()=>{const value=JSON.parse(await bounded(join(object,'resource.json'),16*1024**2));
  if(value.recipe_sha256!==wanted.recipe_sha256||typeof value.original!=='string'||!inside(options.toolRoot,value.original)||digest(await bounded(value.original,1024**3))!==wanted.archive.sha256)fail('独立工具原件或配方漂移');
  return verifyExternalTool(wanted,value,options.toolRoot,options.signal);};
 try{await checked(object,'directory');return await deliver();}catch(e){if(e.code!=='ENOENT')throw e;}
 if(options.offline)fail('离线缺少本产品工具');const pending=join(options.work,'.tool-object-'+randomUUID());await directory(pending);await directory(join(pending,'payload'));
 try{
  const file=await original(wanted.archive,options,'tool'),prepared=await prepareToolSupply(wanted,{...options,original:file.path,payload:join(pending,'payload')});
  if(prepared.recipe_sha256!==wanted.recipe_sha256)fail('工具准备期间产品配方漂移');
  assertWorkQuiescent(options.work);await freezeResourceTree(join(pending,'payload'));
  const value={version:wanted.version,archive_sha256:wanted.archive.sha256,root:payload,path:join(payload,wanted.archive.executable),original:file.path,recipe_sha256:prepared.recipe_sha256,
   slots:Object.fromEntries(wanted.slots.map(x=>[x,join(payload,x)])),files:await externalManifest(join(pending,'payload'),options.signal)};
  await writeFile(join(pending,'resource.json'),JSON.stringify(value)+'\n',{flag:'wx',mode:0o444});
  await directory(options.toolRoot);const lock=join(options.toolRoot,'.'+wanted.archive.sha256+'.lock');await mkdir(lock,{mode:0o700});
  try{options.signal?.throwIfAborted();try{await lstat(object);}catch(e){if(e.code!=='ENOENT')throw e;await rename(pending,object);}}finally{await rm(lock,{recursive:true});}
  return await deliver();
 }finally{assertWorkQuiescent(options.work);try{await freezeResourceTree(pending,true);await rm(pending,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}}
}
// 缺件准备只使用产品本次声明、原件及同一公开能力；不导入或读取控制台源码和私有登记。
export async function prepareToolSupply(wanted,options){
 const {work,payload,signal}=options;await workDirectory(work);await checked(payload,'directory');
 const requested=await flowRequirements('build'),entry=requested.tools.find(x=>x.id===wanted.id);
 if(!entry||JSON.stringify(entry)!==JSON.stringify(wanted))fail('工具配方不属于本次Build需求');
 const bytes=await archive(options.original,wanted.archive,1024**3);
 if(wanted.id==='node'){
  const values=await unpack(bytes,wanted.archive.kind,options,{node:process.execPath});await materialize(values,payload,wanted.archive.root);
  if(!(await bounded(process.execPath,256*1024**2)).equals(await bounded(join(payload,'bin/node'),256*1024**2)))fail('引导Node运行字节不符');
 }else if(wanted.id==='worker-build'){
  const stage=join(work,'.worker-build-'+randomUUID());await directory(stage);
  try{
   const rust=await options.acquireTool(requested.tools.find(x=>x.id==='rust')),apple=await options.acquireApple(requested.apple);
   const tools={node:process.execPath,...Object.fromEntries(Object.entries(rust.slots).map(([slot,path])=>[basename(slot),path])),...apple.tools};
   for(const name of ['home','tmp','cargo-home','cargo-target','prepare'])await directory(join(stage,name));await closeCommands(stage,tools);
   const source=join(stage,'source');await materialize(await unpack(bytes,'tar-gzip',{...options,work:stage},tools),source,wanted.archive.root);
   if(digest(await readFile(join(source,'Cargo.lock')))!==(await flowDeclaration()).resources.worker_build_lock_sha256)fail('工具原始Cargo锁不符');
   // 独立工具工作区只隔离Cargo祖先发现；原件和锁保持原始字节。
   const manifest=join(source,'Cargo.toml'),originalManifest=await readFile(manifest);if(/^\[workspace\]/mu.test(originalManifest.toString()))fail('工具原始工作区超出配方');await chmod(manifest,0o600);await writeFile(manifest,Buffer.concat([originalManifest,Buffer.from('\n[workspace]\n')]));
   const packages=(await flowDeclaration()).resources.worker_build_packages.map(x=>({...x,url:'https://static.crates.io/crates/'+x.name+'/'+x.name+'-'+x.version+'.crate'}));
   await cargoView(packages,join(stage,'vendor'),{...options,work:stage},tools);
   await writeFile(join(stage,'cargo-home/config.toml'),'[source.crates-io]\nreplace-with = "locked"\n[source.locked]\ndirectory = '+JSON.stringify(join(stage,'vendor'))+'\n[net]\noffline = true\n',{flag:'wx',mode:0o444});
   await runTool(tools.cargo,['build','--manifest-path',manifest,'--release','--locked','--offline','--bin','worker-build'],{work:stage,cwd:source,tools,signal,environment:{CC:tools.clang,AR:tools.ar,RANLIB:tools.ranlib,DEVELOPER_DIR:apple.developerDirectory,SDKROOT:apple.sdk,CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER:tools.clang}});
   assertWorkQuiescent(stage);await binaryFile(await bounded(join(stage,'cargo-target/release/worker-build'),256*1024**2),join(payload,'bin/worker-build'));
  }finally{if(unsafeWork.has(stage)){unsafeWork.add(work);fail('工具准备后代未退出，保留现场');}await rm(stage,{recursive:true,force:true});}
 }else{
  await installOrExtract();
 }
 async function installOrExtract(){
  const values=await unpack(bytes,wanted.archive.kind,options,{node:process.execPath});
  if(wanted.id==='rust'){await installRust(values,wanted.archive,payload);for(const component of wanted.components){const originalBytes=await original(component,options,'tool');await installRust(await unpack(originalBytes.bytes,component.kind,options,{node:process.execPath}),component,payload);}}
  else await materialize(values,payload,wanted.archive.root);
 }
 // 准备回执引用已验真原件；工具对象不再永久复制同一归档。
 return {schema:1,id:wanted.id,version:wanted.version,source_sha256:wanted.archive.sha256,original:options.original,payload,recipe_sha256:digest(await bounded(join(root,'scripts/resources.mjs'),4*1024**2))};
}
async function readBuildResource(value,platform,work,signal){
 if(value?.schema!==1||value.product_id!=='citizenserve'||value.platform!==platform||value.flow!=='build'||value.work!==work||typeof value.run_id!=='string'
  ||value.receipt!==join(work,'resources.json')||!/^[a-f0-9]{64}$/u.test(value.sha256))fail('Build供给回执身份无效');
 const bytes=await bounded(value.receipt,64*1024**2);if(digest(bytes)!==value.sha256)fail('Build资源回执损坏');
 const receipt=JSON.parse(bytes);if(receipt.run_id!==value.run_id||receipt.work!==work||receipt.mode!==value.mode)fail('Build资源任务漂移');await verifyFlowResources(receipt,signal);return receipt;
}
export async function resourceEnvironment(platform,work,value,environment={},options={}){
 if(platform!=='cloudflare'||work!==join(root,'target/build'))fail('Build固定工作根无效');return (await readBuildResource(value,platform,work,options.signal)).environment;
}
async function buildSupply(request,options){
 await requirements(request.platform,request.work);
 const receipt=await prepareFlowResources({...options,flow:'build',work:request.work,runID:request.run_id}),path=join(request.work,'resources.json');
 return {schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work:request.work,run_id:request.run_id,mode:receipt.mode,receipt:path,sha256:digest(await bounded(path,64*1024**2))};
}
export async function prepareResourceSupply(platform,work,previous,options={}){
 if(previous?.schema!==1||previous.product_id!=='citizenserve'||previous.platform!==platform||previous.work!==work||typeof previous.run_id!=='string'||previous.resource_mode!=='provided')fail('公开Build资源请求身份不符');
 if(typeof options.acquireTool!=='function'||typeof options.acquireApple!=='function'||typeof options.acquireOriginal!=='function')fail('控制台公开资源能力不完整');
 const lock=await checked(join(work,'.product-build.lock'),'file'),owner=JSON.parse(await bounded(lock,65536));
 if(owner.run_id!==previous.run_id||owner.product_id!==previous.product_id||owner.platform!==platform)fail('资源准备与Build守卫不符');
 owner.supplier_pid=process.pid;owner.supply_quiet=false;await writeFile(lock,JSON.stringify(owner)+'\n');
 try{return await buildSupply(previous,{...options,mode:'console'});}
 finally{
  assertWorkQuiescent(work);const current=JSON.parse(await bounded(lock,65536));
  if(current.nonce!==owner.nonce||current.run_id!==owner.run_id||current.supplier_pid!==process.pid)fail('资源供给守卫漂移');
  current.supply_quiet=true;await writeFile(lock,JSON.stringify(current)+'\n');
 }
}
export async function requestBuildResources(stream,request,signal){
 return exchangeBuildResourceFrame(stream,request,await requirements(request.platform,request.work),signal);
}
// 帧协议与原件准备解耦：通道只承载当前身份、需求摘要和小回执。
export function exchangeBuildResourceFrame(stream,request,requested,signal){
 const identity={product_id:request.product_id,platform:request.platform,work:request.work,run_id:request.run_id};
 return new Promise((ok,reject)=>{
  let buffer='',ended=false;const finish=(error,value)=>{if(ended)return;ended=true;signal?.removeEventListener('abort',abort);stream.destroy();error?reject(error):ok(value);},abort=()=>finish(Error('Build资源请求已取消'));
  signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});stream.setEncoding('utf8');
  stream.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>2*1024**2)return finish(Error('Build资源回执超限'));const end=buffer.indexOf('\n');if(end<0)return;
   try{if(buffer.slice(end+1))throw Error('Build资源回执不是唯一帧');const reply=JSON.parse(buffer.slice(0,end));if(reply.id!=='1'||reply.ok!==true||Object.keys(reply).sort().join(',')!=='id,ok,value')throw Error(reply.error||'Build资源供给失败');const value=reply.value;
    if(value?.run_id!==request.run_id||value.mode!=='console')throw Error('Build资源任务漂移');finish(null,value);
   }catch(error){finish(error);}});
  stream.on('end',()=>finish(Error('Build资源通道提前结束')));stream.on('error',()=>finish(Error('Build资源通道失败')));stream.on('close',()=>{if(!ended)finish(Error('Build资源通道中断'));});
  stream.write(JSON.stringify({id:'1',operation:'prepare',identity,requirements_digest:digest(Buffer.from(JSON.stringify(requested))),previous:request})+'\n');
 });
}

export async function claimBuildWork(runID,work){
 if(work!==join(root,'target/build')||typeof runID!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/u.test(runID))fail('Build任务坐标无效');
 await directory(join(root,'target'));await directory(work);
 const lock=join(work,'.product-build.lock'),claim=join(work,'.claim.lock');
 const marker={schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work,run_id:runID,pid:process.pid,nonce:randomUUID()};
 let stat;
 async function short(action){await mkdir(claim,{mode:0o700});const held=await lstat(claim);try{return await action();}finally{const now=await lstat(claim);if(now.dev!==held.dev||now.ino!==held.ino)fail('Build短锁漂移');await rm(claim,{recursive:true});}}
 async function owner(){const info=await lstat(lock),value=JSON.parse(await readFile(await checked(lock,'file')));if(info.dev!==stat.dev||info.ino!==stat.ino||value.supply_quiet===false||Object.entries(marker).some(([key,v])=>value[key]!==v))fail('Build守卫或资源后代退出未确认');return value;}
 await short(async()=>{await writeFile(lock,JSON.stringify(marker)+'\n',{flag:'wx',mode:0o600});stat=await lstat(lock);
  try{for(const name of await readdir(work))if(![basename(lock),basename(claim)].includes(name))await rm(join(work,name),{recursive:true,force:true});if((await readdir(work)).some(name=>![basename(lock),basename(claim)].includes(name)))fail('Build清空回读失败');}
  catch(error){await rm(lock);throw error;}});
 return {async ready(){assertWorkQuiescent(work);const value=await owner();value.quiet=true;await writeFile(lock,JSON.stringify(value)+'\n');},
 async finish(){assertWorkQuiescent(work);await short(async()=>{await owner();await rm(lock);for(const name of await readdir(work))if(name!==basename(claim))await rm(join(work,name),{recursive:true,force:true});if((await readdir(work)).some(name=>name!==basename(claim)))fail('Build收尾未清空');});}};
}
export async function buildOutputDigest(path){
 const info=await lstat(await checked(path,'file')),bytes=await bounded(path,256*1024**2);
 return digest(Buffer.concat([Buffer.from(JSON.stringify(['','file',Boolean(info.mode&0o111),bytes.length])+'\n'),bytes]));
}
export async function executeBuild(request,options={}){
 const {signal}=options,work=request?.work;
 const keys=['schema','product_id','platform','work','run_id','resource_mode','program_digest'];
 if(!request||Object.keys(request).some(x=>!keys.includes(x))||request.schema!==1||request.product_id!=='citizenserve'||request.platform!=='cloudflare'||!['provided','independent'].includes(request.resource_mode)||request.program_digest!==undefined&&!/^[a-f0-9]{64}$/u.test(request.program_digest))fail('完整Build请求无效');
 if(process.platform!=='darwin'||process.arch!=='arm64')fail('本机Cloudflare Build只接受当前Mac宿主');
 const bootstrap=(await flowDeclaration()).resources.bootstrap;
 if(process.versions.node!==bootstrap.node_version||digest(await bounded(process.execPath,256*1024**2))!==bootstrap.platforms[process.platform+'-'+process.arch].executable_sha256)fail('完整Build必须由本产品准确官方Node引导');
 const guard=await claimBuildWork(request.run_id,work);let completed=false;
 try{
  if(request.resource_mode==='provided'&&process.env.PRODUCT_RESOURCE_FD!=='4')fail('控制台资源通道缺失');
  const resources=request.resource_mode==='provided'?await requestBuildResources(new Socket({fd:4,readable:true,writable:true}),request,signal):await buildSupply(request,{...options,mode:'independent'});
  const receipt=await readBuildResource(resources,'cloudflare',work,signal);await buildWorker(receipt,signal);assertWorkQuiescent(work);
  const d=await flowDeclaration(),files=[];for(const name of d.platforms.cloudflare.files){if(!name.startsWith('worker/'))fail('Build输出声明漂移');const path=join(work,name);files.push({path,sha256:await buildOutputDigest(path)});}
  signal?.throwIfAborted();if(files.length!==2)fail('Build必须验真两件实际Worker输出');completed=true;
  return {schema:1,product_id:'citizenserve',platform:'cloudflare',work,run_id:request.run_id,completion:'compile-only',files};
 }finally{
  if(request.resource_mode==='provided'&&completed)await guard.ready();else await guard.finish();
  // 控制台在完成同一结果核验、状态收口后清场；独立执行只保留本次返回的有界摘要。
  // 独立及失败的清场已在guard.finish的同一短锁内完成。
 }
}
// 结果先由适配器验真并登记确认；守卫保留至控制台SQLite记录和同一短锁清场。
export async function completeResourceSupply(platform,work,result,{process_id,signal}={}){
 signal?.throwIfAborted();if(platform!=='cloudflare'||work!==join(root,'target/build')||result?.work!==work||result.platform!==platform||result.product_id!=='citizenserve')fail('Build完成身份无效');
 const lock=await checked(join(work,'.product-build.lock'),'file'),owner=JSON.parse(await bounded(lock,65536));
 if(!Number.isSafeInteger(process_id)||process_id<2||owner.schema!==1||owner.work!==work||owner.flow!=='build'||owner.supplier_pid!==process.pid||owner.supply_quiet!==true||owner.pid!==process_id||owner.run_id!==result.run_id||owner.product_id!==result.product_id||owner.platform!==platform||owner.quiet!==true||owner.supply_quiet===false)fail('Build进程或完成守卫不符');
 try{process.kill(process_id,0);fail('Build子进程仍未退出');}catch(error){if(error.code!=='ESRCH')throw error;}
 owner.controller_id=process.pid;owner.result_verified=true;await writeFile(lock,JSON.stringify(owner)+'\n');
}
