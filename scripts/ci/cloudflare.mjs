
// CitizenServe Cloudflare CI完整实现；本机和控制台只发起这个准确Workflow。
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {flowDeclaration, claimWork, prepareFlowResources, fullChecks, sourceProof,
  githubRequest, tarGzip, checkoutSHA, runCLI, dispatchFlow, recoverFlow} from '../resources.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Error('公民CI：' + message); };
export const workflow = 'citizenserve.cloudflare.ci';
export const workflowFile = 'citizenserve-cloudflare-ci.yml';
export function validateInput(input, environment) {
  if (!input || input.pipeline !== workflow || input.run_title !== '公民服务端 · Cloudflare · CI' ||
    environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_OS !== 'Linux' ||
    environment.GITHUB_REPOSITORY !== 'crcfrcn/citizenserve' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ATTEMPT ?? '')) fail('Runner与手动CI输入身份不符');
  const allowed = new Set(['pipeline', 'run_title', 'source_sha', 'ci_run_id', 'version_tag', 'software_version',
    'spec_version', 'chain_spec_version', 'genesis_hash', 'finalized_head']);
  if (Object.keys(input).some(k => !allowed.has(k)) ||
    [...allowed].filter(k => !['pipeline', 'run_title', 'source_sha'].includes(k)).some(k => input[k])) fail('CI混入Release或未知字段');
  if (input.source_sha && input.source_sha !== environment.GITHUB_SHA) fail('CI请求SHA与GitHub事件不符');
  if (![environment.GITHUB_RUN_ID, environment.GITHUB_RUN_ATTEMPT, ...(input.ci_run_id ? [input.ci_run_id] : [])].every(v => Number.isSafeInteger(Number(v)) && Number(v) > 0)) fail('实际Run坐标超限');
  return {sourceSHA: environment.GITHUB_SHA, runID: Number(environment.GITHUB_RUN_ID),
    attempt: Number(environment.GITHUB_RUN_ATTEMPT)};
}
export function validateGate(run, sourceSHA) {
  if (!run || run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'push' ||
    run.head_branch !== 'main' || run.head_sha !== sourceSHA || run.path !== '.github/workflows/tatagate.yml' ||
    run.repository?.full_name !== 'crcfrcn/citizenserve') fail('同SHA的真实push塔塔门禁未成功');
  return run;
}
export async function successfulGate(sourceSHA, capability) {
  const page = await githubRequest('/repos/crcfrcn/citizenserve/actions/workflows/tatagate.yml/runs?event=push&branch=main&head_sha=' + sourceSHA + '&per_page=100', capability);
  const runs = page.workflow_runs?.filter(r => r.head_sha === sourceSHA).sort((a, b) => b.id - a.id);
  if (!runs?.length) fail('同SHA缺少push门禁');
  const latest = await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + runs[0].id, capability);
  return validateGate(latest, sourceSHA);
}
export function artifactName(runID, attempt) {
  if (!Number.isSafeInteger(runID) || runID < 1 || !Number.isSafeInteger(attempt) || attempt < 1) fail('CI Run或Attempt无效');
  return 'citizenserve-cloudflare-ci-' + runID + '-' + attempt;
}
export async function executeCI({environment = process.env, input, signal}) {
  const context = validateInput(input, environment);
  const task = await claimWork('ci', String(context.runID) + '-' + context.attempt);
  try {
    const receipt = await prepareFlowResources({flow: 'ci', work: task.work, mode: 'independent', signal,
      toolRoot: join(environment.RUNNER_TEMP, 'citizenserve-resources/tools'),
      dependencyRoot: join(environment.RUNNER_TEMP, 'citizenserve-resources/dependencies')});
    if (await checkoutSHA(receipt) !== context.sourceSHA) fail('检出源码与CI事件不符');
    const capability = {token: environment.GH_TOKEN, signal};
    await successfulGate(context.sourceSHA, capability);
    const acceptance = await fullChecks(receipt, signal);
    const proof = await sourceProof(receipt, context.sourceSHA, acceptance);
    Object.assign(proof, {workflow, run_id: context.runID, run_attempt: context.attempt, artifact_name: artifactName(context.runID, context.attempt)});
    const files = {};
    for (const path of ['server/cloudflare/schema.sql', 'server/cloudflare/download-schema.sql', 'server/cloudflare/tatachat/schema.sql', 'server/cloudflare/wrangler.toml', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'test/worker/package-lock.json']) files[path] = await readFile(join(receipt.environment.PRODUCT_ROOT, path));
    for (const name of ['index.js', 'index_bg.wasm']) files[name] = await readFile(join(task.work, 'worker', name));
    proof.files = Object.entries(files).map(([path, bytes]) => ({path, bytes: bytes.length, sha256: sha256(bytes)}));
    files['ci-proof.json'] = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
    await writeFile(join(task.work, 'ci.tgz'), tarGzip(files), {flag: 'wx', mode: 0o444});
    await writeFile(join(task.work, 'ci-proof.json'), files['ci-proof.json'], {flag: 'wx', mode: 0o444});
    const d = await flowDeclaration();
    if (d.platforms.cloudflare.ci !== 'scripts/ci/cloudflare.mjs') fail('流程入口声明漂移');
    return proof;
  } finally { await task.finish(); }
}
// 上传结束后读取GitHub实际Artifact；返回ID和摘要，不用文件名冒充资产身份。
export async function verifyUpload({environment = process.env, signal}) {
  const event = JSON.parse(await readFile(environment.GITHUB_EVENT_PATH));
  const c = validateInput(event.inputs, environment);
  const id = Number(environment.PRODUCT_ARTIFACT_ID), digest = environment.PRODUCT_ARTIFACT_DIGEST;
  if (!Number.isSafeInteger(id) || id < 1 || !/^[a-f0-9]{64}$/u.test(digest ?? '')) fail('上传动作未交付真实资产身份');
  const value = await githubRequest('/repos/crcfrcn/citizenserve/actions/artifacts/' + id, {token: environment.GH_TOKEN, signal});
  if (value.id !== id || value.expired || value.name !== artifactName(c.runID, c.attempt) ||
    value.workflow_run?.id !== c.runID || value.workflow_run?.head_sha !== c.sourceSHA ||
    value.digest !== 'sha256:' + digest) fail('GitHub上传回读与当前CI不一致');
  process.stdout.write('CI实际Artifact已回读验真：' + id + '\n');
  return {artifact_id: id, artifact_sha256: digest};
}
export async function main(args) {
  if (args.length === 1 && args[0] === 'execute') return runCLI(async signal => {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH));
    return executeCI({input: event.inputs, signal});
  });
  if (args.length === 1 && args[0] === 'verify-upload') return runCLI(signal => verifyUpload({signal}));
  if (args.length === 1 && args[0] === 'dispatch') return runCLI(signal => dispatchFlow('ci', {signal}));
  if (args[0] === 'recover') return runCLI(signal => recoverFlow('ci', args.slice(1), {signal}));
  fail('公开CI入口参数无效');
}
if (!process.env.NODE_TEST_CONTEXT && !process.execArgv.includes('--test') && process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

// 所属测试与生产实现同文件；普通导入和正式执行不注册测试。
// BEGIN INLINE TESTS
if (process.env.NODE_TEST_CONTEXT && process.argv[1] === fileURLToPath(import.meta.url)) {
const {default: test} = await import('node:test');
const {default: assert} = await import('node:assert/strict');
// CI真实输入、来源与Attempt边界；只使用合成坐标，不派发远端任务。

const sourceSHA = 'a'.repeat(40);
const environment = {GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', GITHUB_REPOSITORY: 'crcfrcn/citizenserve',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sourceSHA,
  GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2'};
const input = {pipeline: 'citizenserve.cloudflare.ci', run_title: '公民服务端 · Cloudflare · CI', source_sha: sourceSHA};
test('准确CI绑定事件SHA和真实Run尝试', () => {
  assert.deepEqual(validateInput(input, environment), {sourceSHA, runID: 42, attempt: 2});
  assert.equal(artifactName(42, 2), 'citizenserve-cloudflare-ci-42-2');
});
test('CI拒绝错仓错平台非main与非手动事件', () => {
  for (const key of Object.keys(environment)) {
    assert.throws(() => validateInput(input, {...environment, [key]: key === 'GITHUB_SHA' ? 'b'.repeat(40) : 'other'}));
  }
});
test('CI不接受Release字段、未知字段或错误展示标题', () => {
  for (const key of ['ci_run_id', 'version_tag', 'software_version', 'spec_version', 'chain_spec_version', 'genesis_hash', 'finalized_head', 'extra']) {
    assert.throws(() => validateInput({...input, [key]: 'injected'}, environment));
  }
  assert.throws(() => validateInput({...input, run_title: 'changed'}, environment));
  assert.throws(() => validateInput({...input, source_sha: 'b'.repeat(40)}, environment));
});
test('Run和Attempt必须为正安全整数，Attempt互不覆盖', () => {
  for (const value of [0, -1, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => artifactName(value, 1));
  assert.notEqual(artifactName(42, 1), artifactName(42, 2));
});
const gate = {id: 11, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main',
  head_sha: sourceSHA, path: '.github/workflows/tatagate.yml', repository: {full_name: 'crcfrcn/citizenserve'}};
test('只认可同SHA实际成功push门禁', () => {
  assert.equal(validateGate(gate, sourceSHA), gate);
  for (const change of [{status: 'in_progress'}, {conclusion: 'cancelled'}, {conclusion: 'neutral'}, {conclusion: 'skipped'},
    {head_sha: 'b'.repeat(40)}, {event: 'workflow_dispatch'}, {head_branch: 'other'}, {path: 'other'},
    {repository: {full_name: 'other/repo'}}]) assert.throws(() => validateGate({...gate, ...change}, sourceSHA));
});
test('最新门禁失败不能借较旧成功Run放行', async () => {
  const request = async url => new Response(JSON.stringify(url.includes('/workflows/') ? {workflow_runs: [gate, {...gate, id: 12}]} :
    {...gate, id: 12, conclusion: 'failure'}));
  await assert.rejects(successfulGate(sourceSHA, {token: 'synthetic', request}), /门禁未成功/u);
});

// 流程身份独立保存，实际领取只使用固定build、test；共享编译现场不得互相清理。
test('流程领取只建build、test并保护活跃任务及链接外文件',async t=>{
 const fs=await import('node:fs/promises'),{join,resolve}=await import('node:path'),{pathToFileURL}=await import('node:url');
 const root=resolve(import.meta.dirname,'../..'),parent=process.env.PRODUCT_WORK_DIR;
 assert.ok(parent&&resolve(parent)===parent&&await fs.realpath(parent)===parent,'必须使用当前任务的规范工作根');
 const fixture=await fs.mkdtemp(join(parent,'flow-work-'));t.after(()=>fs.rm(fixture,{recursive:true,force:true}));
 await fs.mkdir(join(fixture,'scripts'));await fs.writeFile(join(fixture,'scripts/resources.mjs'),await fs.readFile(join(root,'scripts/resources.mjs')));
 const {claimWork}=await import(pathToFileURL(join(fixture,'scripts/resources.mjs')));
 await fs.mkdir(join(fixture,'target/build'),{recursive:true});await fs.mkdir(join(fixture,'protected'));await fs.writeFile(join(fixture,'protected/keep'),'keep');await fs.symlink(join(fixture,'protected'),join(fixture,'target/build/link'));
 const ci=await claimWork('ci','123');assert.equal(ci.work,join(fixture,'target/build'));assert.equal(await fs.readFile(join(fixture,'protected/keep'),'utf8'),'keep');
 await assert.rejects(claimWork('release','124'),/活跃/);await ci.finish();
 const release=await claimWork('release','124');assert.equal(release.work,ci.work);await release.finish();
 const gate=await claimWork('gate','125');assert.equal(gate.work,join(fixture,'target/test'));await gate.finish();
 assert.deepEqual((await fs.readdir(join(fixture,'target'))).sort(),['build','test']);assert.deepEqual(await fs.readdir(ci.work),[]);assert.deepEqual(await fs.readdir(gate.work),[]);
});

// 直接调用同一生产模块的两类领取入口；被拒绝的入口不得改写任何活跃字节。
test('CI与Build双向拒绝活跃现场，候选待确认和同时领取仍互斥',async t=>{
 const fs=await import('node:fs/promises'),{join,resolve}=await import('node:path'),{pathToFileURL}=await import('node:url');
 const root=resolve(import.meta.dirname,'../..'),parent=process.env.PRODUCT_WORK_DIR;
 assert.ok(parent&&resolve(parent)===parent&&await fs.realpath(parent)===parent,'必须使用当前任务的规范工作根');
 const fixture=await fs.mkdtemp(join(parent,'cross-flow-'));
 t.after(()=>fs.rm(fixture,{recursive:true,force:true}));await fs.mkdir(join(fixture,'scripts'));
 await fs.writeFile(join(fixture,'scripts/resources.mjs'),await fs.readFile(join(root,'scripts/resources.mjs')));
 const {claimWork,claimBuildWork}=await import(pathToFileURL(join(fixture,'scripts/resources.mjs')));
 const ci=await claimWork('ci','ci-active'),work=ci.work,sentinel=join(work,'candidate');
 await fs.writeFile(sentinel,'CI结果');const active=await fs.readFile(join(work,'.active.json'));
 await assert.rejects(claimBuildWork('build-blocked',work),/活跃/);
 assert.deepEqual(await fs.readFile(join(work,'.active.json')),active);assert.equal(await fs.readFile(sentinel,'utf8'),'CI结果');
 assert.equal((await fs.readdir(work)).includes('.product-build.lock'),false);await ci.finish();
 const build=await claimBuildWork('build-active',work);await fs.writeFile(sentinel,'Build候选');
 let marker=await fs.readFile(join(work,'.product-build.lock'));
 await assert.rejects(claimWork('release','release-blocked'),/活跃/);
 assert.deepEqual(await fs.readFile(join(work,'.product-build.lock')),marker);assert.equal(await fs.readFile(sentinel,'utf8'),'Build候选');
 await build.ready();marker=await fs.readFile(join(work,'.product-build.lock'));
 await assert.rejects(claimWork('ci','ci-before-confirmation'),/活跃/);
 assert.deepEqual(await fs.readFile(join(work,'.product-build.lock')),marker);assert.equal(await fs.readFile(sentinel,'utf8'),'Build候选');
 await build.finish();const release=await claimWork('release','release-after-close');await release.finish();
 const race=await Promise.allSettled([claimWork('ci','race-ci'),claimBuildWork('race-build',work)]);
 assert.equal(race.filter(value=>value.status==='fulfilled').length,1);assert.equal(race.filter(value=>value.status==='rejected').length,1);
 await race.find(value=>value.status==='fulfilled').value.finish();assert.deepEqual(await fs.readdir(work),[]);
});
}
// END INLINE TESTS
