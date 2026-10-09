
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
if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
