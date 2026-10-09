
// 本仓塔塔门禁同时供本机与GitHub使用；只读取本仓提交和公开资源协议。
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve, join, dirname, extname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {spec} from 'node:test/reporters';
import {productRoot, claimWork, prepareFlowResources, runTool, fullChecks, checkoutSHA, runCLI} from '../../scripts/resources.mjs';
const gateDirectory = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(gateDirectory, 'contracts.json')));
const emptyTreeSHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const sha = /^[a-f0-9]{40}$/u;
const fail = message => { throw Error('本仓门禁：' + message); };
export function gateContract(value = contract) {
  if (!value || Object.keys(value).sort().join(',') !== 'checks,node_tests,platform_forbidden_values,repository,schema,tools,workflows' ||
    value.schema !== 1 || value.repository !== 'citizenserve' ||
    value.workflows?.join(',') !== 'citizenserve.cloudflare.ci,citizenserve.cloudflare.release' ||
    value.checks?.join(',') !== 'repository-contracts,product-full' ||
    value.tools?.node !== '25.2.1' || value.tools.actionlint !== '1.7.12' || value.tools.rust !== '1.97.1' ||
    Object.keys(value.tools).sort().join(',') !== 'actionlint,node,rust' ||
    value.node_tests?.join(',') !== 'scripts/resources.mjs,scripts/tatachat.mjs,scripts/ci/cloudflare.mjs,scripts/release/cloudflare.mjs' ||
    value.platform_forbidden_values?.join(',') !== ['macOS ARM64', 'macos-arm64', 'macos_arm64'].join(',')) fail('登记字段或真实检查闭集漂移');
  return value;
}
export function pushBaseSHA({forced, before, headSHA, parents, commitCount}) {
  if (typeof forced !== 'boolean' || !sha.test(before ?? '') || !sha.test(headSHA ?? '') || /^0{40}$/u.test(headSHA)) fail('push提交坐标无效');
  if (!forced) return /^0{40}$/u.test(before) ? emptyTreeSHA : before;
  if (/^0{40}$/u.test(before) || parents !== headSHA || commitCount !== '1') fail('历史清理必须是唯一无父提交');
  return emptyTreeSHA;
}
export function validateProductDocuments(root) {
  for (const name of ['CitizenServe.md', 'README.md']) {
    const path = join(root, name), st = lstatSync(path, {throwIfNoEntry: false});
    if (!st?.isFile() || st.isSymbolicLink() || !st.size || realpathSync(path) !== path) fail('所属根技术文档或简介必须为非空普通原件');
  }
  if (readdirSync(root).some(name => /\.md$/iu.test(name) && !['CitizenServe.md', 'README.md'].includes(name))) fail('所属根存在额外技术文档');
  return true;
}
export function assertNoProductOutputDirectories(root) {
  function visit(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (dir === root && entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (dir === root && entry.name === 'target') {
        if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path) fail('产品生成状态目录类型无效');
        continue;
      }
      if (['target', 'build', 'node_modules', '.dart_tool', '__pycache__', '.gradle'].includes(entry.name)) fail('临时生成目录必须归产品根target：' + path);
      if (entry.isSymbolicLink()) fail('源码含链接旁路');
      if (entry.isDirectory()) visit(path);
    }
  }
  visit(root);
  const scripts = join(root, 'scripts');
  for (const first of readdirSync(scripts, {withFileTypes: true})) {
    if (!first.isDirectory()) continue;
    const children = readdirSync(join(scripts, first.name), {withFileTypes: true});
    if (children.length < 2 || children.some(e => e.isDirectory() || e.isSymbolicLink())) fail('scripts必须只有一层且每目录至少两个真实直接文件');
  }
}
export function hasFirstPartyTemporaryComments(path, source) {
  const comment = ['.py', '.sh'].includes(extname(path)) ? source.split('\n').filter(l => /^(?!#!)\s*#/u.test(l)).join('\n') :
    [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu)].map(m => m[0]).join('\n');
  return /\b(?:TODO|FIXME|HACK|XXX)\b/u.test(comment);
}
export function hasSecretMaterial(source) {
  if (typeof source !== 'string') fail('机密扫描输入必须是文本');
  const token = /AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]{16,}/u;
  const material = text => {
    if (token.test(text)) return true;
    const normalized = text.replace(/\\r\\n|\\n|\\r/gu, '\n');
    for (const match of normalized.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)/gu)) {
      if (match[1].replace(/\s/gu, '').length >= 32) return true;
    }
    return false;
  };
  if (material(source)) return true;
  const documents = [];
  const trimmed = source.trim();
  if (/^(?:\{|\[|")/u.test(trimmed)) {
    try { documents.push(JSON.parse(trimmed)); } catch { /* 非JSON正文仍已执行原文扫描。 */ }
  }
  const begin = '<!-- PATCH_DATA\n', end = '\nPATCH_DATA -->';
  const start = source.indexOf(begin);
  if (start >= 0) {
    const stop = source.indexOf(end, start + begin.length);
    if (stop < 0 || source.indexOf(begin, start + begin.length) >= 0) fail('门禁补丁快照结构不可解析');
    try { documents.push(JSON.parse(source.slice(start + begin.length, stop))); }
    catch { fail('门禁补丁快照结构不可解析'); }
  }
  while (documents.length) {
    const value = documents.pop();
    if (typeof value === 'string') {
      if (material(value)) return true;
      // JSON内再次序列化的字符串仍解码扫描；不能把凭据放进键名或第二层转义。
      if (/^(?:\{|\[|")/u.test(value.trim())) {
        try { documents.push(JSON.parse(value)); } catch { /* 非JSON源码已按原文检查。 */ }
      }
    } else if (value && typeof value === 'object') {
      documents.push(...Object.keys(value), ...Object.values(value));
    }
  }
  return false;
}

// 公民产品原有增量防护完整保留在自身门禁，字典私有资料不进入公开仓。
export function insecureTransportLines(path, source) {
  const allowed = [];
  if (/(?:_tests\.rs|\/tests\/[^/]+\.rs)$/u.test(path)) {
    const tokens = [];
    const scanner = /\/\/[^\n]*|\/\*|r(#+)?"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\.|[^'\\])'|[A-Za-z_][A-Za-z0-9_]*|\S/gu;
    let match, valid = true;
    while ((match = scanner.exec(source))) {
      const value = match[0];
      if (value.startsWith('//')) continue;
      if (value === '/*') {
        let depth = 1, end = scanner.lastIndex;
        while (depth && end < source.length) {
          if (source.startsWith('/*', end)) { depth++; end += 2; }
          else if (source.startsWith('*/', end)) { depth--; end += 2; }
          else end++;
        }
        if (depth) { valid = false; break; }
        scanner.lastIndex = end; continue;
      }
      if (/^r#*"$/u.test(value)) {
        const end = source.indexOf('"' + (match[1] || ''), scanner.lastIndex);
        if (end < 0) { valid = false; break; }
        scanner.lastIndex = end + 1 + (match[1] || '').length;
        tokens.push({ value: '<raw>', start: match.index, end: scanner.lastIndex }); continue;
      }
      tokens.push({ value, start: match.index, end: scanner.lastIndex });
    }
    const text = (start, end) => tokens.slice(start, end).map(token => token.value).join(' ');
    if (valid) for (let index = 0; index < tokens.length; index++) {
      if (text(index, index + 5) !== '# [ test ] fn') continue;
      if (!/^[A-Za-z_]\w*$/u.test(tokens[index + 5]?.value || '')
        || text(index + 6, index + 9) !== '( ) {') continue;
      const begin = index + 9;
      let end = begin, depth = 1;
      for (; end < tokens.length && depth; end++) {
        if (tokens[end].value === '{') depth++;
        if (tokens[end].value === '}') depth--;
      }
      if (depth) continue;
      for (let at = begin; at < end; at++) {
        if (tokens[at].value !== 'for') continue;
        const variable = tokens[at + 1]?.value;
        if (!/^[A-Za-z_]\w*$/u.test(variable || '') || text(at + 2, at + 4) !== 'in [') continue;
        let cursor = at + 4;
        const inputs = [];
        while (/^"(?:\\.|[^"\\])*"$/u.test(tokens[cursor]?.value || '')) {
          inputs.push(tokens[cursor++]);
          if (tokens[cursor]?.value !== ',') break;
          cursor++;
        }
        if (!inputs.length || text(cursor, cursor + 2) !== '] {') continue;
        cursor += 2;
        // 循环体必须仅执行一次拒绝断言；多余调用、成功断言或被替换的参数均不豁免。
        const assertion = `assert ! ( endpoint ( ${variable} ) . is_err ( )`;
        if (text(cursor, cursor + 11) !== assertion) continue;
        cursor += 11;
        if (tokens[cursor]?.value === ',') {
          if (tokens[cursor + 1]?.value !== `"{${variable}}"`) continue;
          cursor += 2;
        }
        if (text(cursor, cursor + 3) !== ') ; }' || cursor + 3 > end) continue;
        for (const input of inputs) {
          if (/^"(?:http|ws):\/\/[A-Za-z0-9.-]+\.invalid(?:[/?#][^"\\]*)?"$/u.test(input.value)) allowed.push(input);
        }
      }
    }
  }
  const unsafe = new Set();
  for (const match of source.matchAll(/(?:http|ws):\/\//gu)) {
    if (!allowed.some(({ start, end }) => match.index >= start && match.index < end)) {
      unsafe.add(source.slice(0, match.index).split('\n').length);
    }
  }
  return [...unsafe];
}

export function scanAddedSource(path, source, added) {
  if (path === '.github/tatagate/index.mjs' || !/\.(?:mjs|js|rs|py|sh|sql)$/u.test(path)) return;
  const lines = added.split('\n');
  const unsafe = new Set(insecureTransportLines(path, source));
  if (source.split('\n').some((line, i) => unsafe.has(i + 1) && lines.includes(line))) fail('新增明文网络协议');
  const residue = /\b(?:TODO|FIXME|HACK|XXX)\b|debugger\s*;|dbg!\(|todo!\(|unimplemented!\(/u;
  if (residue.test(added) || !path.startsWith('scripts/') && !path.includes('test') && /\bconsole\.log\(/u.test(added)) fail('新增开发残留');
  const text = lines.join('\n')
    .replaceAll('QR_V1', '').replaceAll('create_v4_signed', '')
    .replace(/https:\/\/api\.cloudflare\.com\/client\/v4\/|https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/|https:\/\/fcm\.googleapis\.com\/v1\//gu, '')
    .replace(/citizenserve-cloudflare-v[0-9]+\.[0-9]+\.[0-9]+/gu, '');
  if (/[A-Za-z0-9][._:-]v[0-9]+|\/(?:api\/)?v[0-9]+|[A-Za-z0-9]_V[0-9]+|schema_version|cache_version|protocol_version/u.test(text)) fail('新增非QR_V1一方版本化标识');
  if (path.endsWith('.rs') && /#!?\[allow\((?:dead_code|unused)/u.test(added) &&
    !/(?:\/\/|\/\*).*[\p{Script=Han}]/u.test(added)) fail('编译器抑制缺少中文理由');
}
export function validateWorkflowSource(source, filename) {
  const flow = filename === 'citizenserve-cloudflare-ci.yml' ? 'ci' : filename === 'citizenserve-cloudflare-release.yml' ? 'release' : null;
  if (!flow || !source.includes('name: citizenserve.cloudflare.' + flow + '\n') ||
    !/^\s*workflow_dispatch:\s*$/mu.test(source) || /^\s*(?:push|workflow_run|pull_request):/mu.test(source) ||
    [...source.matchAll(/^  flow:$/gmu)].length !== 1 || !source.includes('  group: citizenserve.cloudflare.' + flow + '\n') ||
    !source.includes('scripts/' + flow + '/cloudflare.mjs') || source.includes('scripts/' + flow + '/cloudflare/')) fail('独立Workflow身份或入口错误');
  return 'citizenserve.cloudflare.' + flow;
}
export function validateWorkflow(root) {
  const names = readdirSync(join(root, '.github/workflows')).sort();
  if (names.join(',') !== ['tatagate.yml', 'citizenserve-cloudflare-ci.yml', 'citizenserve-cloudflare-release.yml'].sort().join(',')) fail('Workflow文件集合不符');
  for (const name of names) {
    const path = join(root, '.github/workflows', name), st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) fail('Workflow类型无效');
    const source = readFileSync(path, 'utf8');
    if (name === 'tatagate.yml') {
      if (!/^name: tatagate$/mu.test(source) || !/^\s*push:\s*$/mu.test(source) ||
        !source.includes('branches: [main]') || /^\s*(?:workflow_dispatch|workflow_run|pull_request):/mu.test(source) ||
        !source.includes('.github/tatagate/index.mjs') || !source.includes("'remote'")) fail('push塔塔门禁入口无效');
    } else validateWorkflowSource(source, name);
  }
  return names.map(n => '.github/workflows/' + n);
}
export default async function* reporter(events) {
  let final;
  async function* checked() {
    for await (const event of events) {
      if (event.type === 'test:summary') {
        const c = event.data.counts;
        final = {passed: c.passed, failed: c.failed, skipped: c.skipped, todo: c.todo, cancelled: c.cancelled};
        if (!event.data.success || c.failed || c.skipped || c.todo || c.cancelled) process.exitCode = 1;
      }
      yield event;
    }
    if (!final || !Number.isSafeInteger(final.passed) || final.passed < 1) process.exitCode = 1;
    const path = process.env.PRODUCT_TEST_REPORT, work = process.env.PRODUCT_WORK_DIR;
    if (path) {
      if (!work || resolve(path) !== path || !path.startsWith(work + '/') || realpathSync(dirname(path)) !== dirname(path)) fail('测试报告越界');
      writeFileSync(path, JSON.stringify(final ?? {passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0}) + '\n', {flag: 'wx', mode: 0o444});
    }
  }
  yield* Readable.from(checked()).pipe(spec());
}
export async function executeGate({root = productRoot, baseSHA, headSHA, receipt, signal}) {
  gateContract();
  if (root !== productRoot || realpathSync(root) !== root || !sha.test(headSHA ?? '') || !sha.test(baseSHA ?? '') || baseSHA === headSHA) fail('根与提交坐标无效');
  if (receipt.flow !== 'gate' || await checkoutSHA(receipt) !== headSHA) fail('门禁资源或检出SHA不符');
  const git = async args => (await runTool(receipt.tools.git, ['-c', 'credential.helper=', '-C', root, ...args],
    {work: receipt.work, tools: receipt.tools, signal})).stdout;
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all']); if (status.trim()) fail('门禁只接受干净已保存提交');
  if (baseSHA !== emptyTreeSHA) await git(['merge-base', '--is-ancestor', baseSHA, headSHA]);
  const files = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
  assertNoProductOutputDirectories(root); validateProductDocuments(root);
  for (const name of ['memory', 'TataConsole', 'AGENTS.md', 'MAP.md', 'CODEX.md', 'CLAUDE.md']) if (existsSync(join(root, name))) fail('私人规则或控制台残留');
  const flag = String.fromCodePoint(0x1f1e8, 0x1f1f3);
  for (const path of files) {
    const source = await readFile(join(root, path), 'utf8');
    if (source.includes(flag)) fail('禁止字符，仅报告路径：' + path);
    if (hasSecretMaterial(source)) fail('机密扫描未通过，仅报告路径：' + path);
    if (path !== '.github/tatagate/contracts.json' && path !== '.github/tatagate/index.mjs' &&
      contract.platform_forbidden_values.some(v => source.toLowerCase().includes(v.toLowerCase()) || path.includes(v))) fail('禁用平台命名：' + path);
    const sourceArguments = {work: receipt.work, tools: receipt.tools, signal};
    if (path.endsWith('.mjs')) await runTool(receipt.tools.node, ['--check', join(root, path)], sourceArguments);
    else if (path.endsWith('.sh')) await runTool(receipt.tools.bash, ['-n', join(root, path)], sourceArguments);
    else if (path.endsWith('.json')) JSON.parse(source);
  }
  const changed = baseSHA === emptyTreeSHA ? files : (await git(['diff', '--name-only', '-z', baseSHA, headSHA])).split('\0').filter(Boolean);
  for (const path of changed.filter(p => files.includes(p))) {
    const source = await readFile(join(root, path), 'utf8');
    const added = baseSHA === emptyTreeSHA ? source : (await git(['diff', '--unified=0', baseSHA, headSHA, '--', path])).split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
    scanAddedSource(path, source, added);
    if (!path.includes('test') && hasFirstPartyTemporaryComments(path, source)) fail('实现代码保留临时注释：' + path);
  }
  const workflows = validateWorkflow(root);
  const version = await runTool(receipt.tools.actionlint, ['-version'], {work: receipt.work, tools: receipt.tools, signal});
  if (!/^1\.7\.12(?:\s|$)/u.test(version.stdout)) fail('actionlint版本漂移');
  await runTool(receipt.tools.actionlint, ['-shellcheck=', '-pyflakes=', ...workflows], {work: receipt.work, tools: receipt.tools, signal});
  const acceptance = await fullChecks(receipt, signal);
  assertNoProductOutputDirectories(root);
  if (await git(['status', '--porcelain=v1', '--untracked-files=all']) !== status) fail('门禁修改了提交源码');
  return {repository: 'citizenserve', base_sha: baseSHA, head_sha: headSHA, acceptance};
}
export async function repositoryGateMain(args, signal) {
  if (args[0] === 'physical' && args.length === 2) { if (args[1] !== productRoot) fail('根越界'); assertNoProductOutputDirectories(productRoot); return; }
  if (args[0] === 'local' && args.length === 5) {
    if (args[1] !== productRoot || !process.env.PRODUCT_FLOW_RESOURCE_RECEIPT) fail('本机门禁缺少当前任务公开资源供给');
    const receipt = JSON.parse(await readFile(process.env.PRODUCT_FLOW_RESOURCE_RECEIPT));
    if (receipt.work !== args[4]) fail('本机门禁工作根与供给不符');
    return executeGate({baseSHA: args[2], headSHA: args[3], receipt, signal});
  }
  if (args.join(',') !== 'remote' || process.env.GITHUB_ACTIONS !== 'true') fail('门禁入口参数无效');
  const e = process.env, event = JSON.parse(await readFile(e.GITHUB_EVENT_PATH));
  if (e.GITHUB_EVENT_NAME !== 'push' || e.GITHUB_REF !== 'refs/heads/main' || e.GITHUB_WORKFLOW !== 'tatagate' ||
    e.GITHUB_JOB !== 'gate' || e.GITHUB_REPOSITORY !== 'crcfrcn/citizenserve' || event.ref !== e.GITHUB_REF ||
    event.after !== e.GITHUB_SHA || event.repository?.full_name !== e.GITHUB_REPOSITORY || event.deleted ||
    !/^[1-9][0-9]*$/u.test(e.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/u.test(e.GITHUB_RUN_ATTEMPT ?? '')) fail('真实push事件身份不符');
  const task = await claimWork('gate', e.GITHUB_RUN_ID + '-' + e.GITHUB_RUN_ATTEMPT);
  try {
    const receipt = await prepareFlowResources({flow: 'gate', work: task.work, mode: 'independent', signal,
      toolRoot: join(task.work,'tools'), dependencyRoot: join(task.work,'dependencies')});
    const readGit = async args => (await runTool(receipt.tools.git, args, {work: task.work, tools: receipt.tools, signal})).stdout.trim();
    const baseSHA = pushBaseSHA({forced: event.forced, before: event.before, headSHA: e.GITHUB_SHA,
      parents: event.forced ? await readGit(['rev-list', '--parents', '-n', '1', e.GITHUB_SHA]) : undefined,
      commitCount: event.forced ? await readGit(['rev-list', '--count', e.GITHUB_SHA]) : undefined});
    return await executeGate({baseSHA, headSHA: e.GITHUB_SHA, receipt, signal});
  } finally { await task.finish(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runCLI(signal => repositoryGateMain(process.argv.slice(2), signal));
