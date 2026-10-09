
// CitizenServe Cloudflare Release完整实现：验真同提交CI、来源证明、正式发布和逐资产回读。
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {productRoot, claimWork, prepareFlowResources, verifyFlowResources, checkoutSHA, flowRequirements, runTool,
  githubRequest, githubDownload, githubUpload, tarEntries, zipEntries, tarGzip, safeRelative, requireSuccessCount,
  runCLI, dispatchFlow, recoverFlow} from '../resources.mjs';
import {successfulGate, artifactName} from '../ci/cloudflare.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Error('公民Release：' + message); };
export const workflow = 'citizenserve.cloudflare.release';
export const workflowFile = 'citizenserve-cloudflare-release.yml';
export const payloadPaths = Object.freeze(['index.js', 'index_bg.wasm', 'server/cloudflare/schema.sql',
  'server/cloudflare/download-schema.sql', 'server/cloudflare/tatachat/schema.sql', 'server/cloudflare/wrangler.toml',
  'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'test/worker/package-lock.json'].sort());
export function cargoVersion(source) {
  const version = source.match(/^\[package\][\s\S]*?^version\s*=\s*"((?:0|[1-9][0-9]*)\.[0-9]{1,2}\.[0-9]{1,2})"\s*$/mu)?.[1];
  if (!version) fail('根Cargo软件版本无效'); return version;
}
export function validateInput(input, environment, version) {
  const keys = ['pipeline', 'run_title', 'source_sha', 'ci_run_id', 'version_tag', 'software_version',
    'spec_version', 'chain_spec_version', 'genesis_hash', 'finalized_head'];
  if (!input || Object.keys(input).some(k => !keys.includes(k)) || input.pipeline !== workflow ||
    input.run_title !== '公民服务端 · Cloudflare · Release' || input.software_version !== version ||
    input.version_tag !== 'citizenserve-cloudflare-v' + version || !/^[a-f0-9]{40}$/u.test(input.source_sha ?? '') ||
    !/^[1-9][0-9]*$/u.test(input.ci_run_id ?? '') ||
    ['spec_version', 'chain_spec_version', 'genesis_hash', 'finalized_head'].some(k => input[k]) ||
    environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_OS !== 'Linux' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' || environment.GITHUB_REPOSITORY !== 'crcfrcn/citizenserve' ||
    environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_SHA !== input.source_sha ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ATTEMPT ?? '')) fail('正式Release输入及Runner身份无效');
  if (![environment.GITHUB_RUN_ID, environment.GITHUB_RUN_ATTEMPT, ...(input.ci_run_id ? [input.ci_run_id] : [])].every(v => Number.isSafeInteger(Number(v)) && Number(v) > 0)) fail('实际Run坐标超限');
  return {sourceSHA: input.source_sha, ciRunID: Number(input.ci_run_id), version, tag: input.version_tag,
    runID: Number(environment.GITHUB_RUN_ID), attempt: Number(environment.GITHUB_RUN_ATTEMPT)};
}
export function validateCIRun(run, context) {
  if (!run || run.id !== context.ciRunID || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
    run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success' ||
    run.head_branch !== 'main' || run.head_sha !== context.sourceSHA || run.path !== '.github/workflows/citizenserve-cloudflare-ci.yml' ||
    run.repository?.full_name !== 'crcfrcn/citizenserve') fail('实际CI Run不属于同SHA成功完整CI');
  return run.run_attempt;
}
export function validateProof(proof, context, attempt, files) {
  if (!proof || proof.schema !== 1 || proof.product_id !== 'citizenserve' || proof.platform !== 'cloudflare' ||
    proof.workflow !== 'citizenserve.cloudflare.ci' || proof.source_sha !== context.sourceSHA ||
    proof.run_id !== context.ciRunID || proof.run_attempt !== attempt ||
    proof.artifact_name !== artifactName(context.ciRunID, attempt) ||
    !Array.isArray(proof.sources) || !proof.sources.length || !Array.isArray(proof.files) ||
    proof.files.map(f => f.path).sort().join('\0') !== payloadPaths.join('\0')) fail('完整CI来源证明缺失或身份漂移');
  requireSuccessCount(proof.acceptance?.rust, 'Rust');
  requireSuccessCount(proof.acceptance?.python, 'SQLite');
  requireSuccessCount(proof.acceptance?.node, 'Node');
  requireSuccessCount(proof.acceptance?.worker, 'Worker');
  if (proof.acceptance?.reports?.length !== 8 || proof.acceptance.reports.some(r => r.completed !== true)) fail('完整CI实际检查缺项');
  for (const entry of proof.files) {
    safeRelative(entry.path); const bytes = files[entry.path];
    if (!bytes || entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) fail('CI真实产物摘要不符');
  }
  if (!files['index_bg.wasm'].subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
    !files['index.js'].length || cargoVersion(files['Cargo.toml'].toString()) !== context.version) fail('CI Worker或软件版本无效');
  return proof;
}
async function downloadCI(context, capability) {
  const first = await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + context.ciRunID, capability);
  const attempt = validateCIRun(first, context);
  const artifactPage = await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + context.ciRunID + '/artifacts?per_page=100', capability);
  const artifacts = artifactPage.artifacts?.filter(a => a.name === artifactName(context.ciRunID, attempt));
  if (artifacts?.length !== 1) fail('当前CI Attempt缺少唯一真实Artifact');
  const artifact = artifacts[0];
  if (artifact.expired || !Number.isSafeInteger(artifact.id) || artifact.workflow_run?.id !== context.ciRunID ||
    artifact.workflow_run?.head_sha !== context.sourceSHA || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '')) fail('CI实际资产元数据无效');
  const zip = await githubDownload('/repos/crcfrcn/citizenserve/actions/artifacts/' + artifact.id + '/zip', capability);
  if ('sha256:' + sha256(zip) !== artifact.digest) fail('GitHub不可变Artifact整体ZIP摘要不符');
  const zipped = zipEntries(zip);
  if (zipped.size !== 1 || !zipped.has('ci.tgz')) fail('CI Artifact文件闭集不符');
  const entries = tarEntries(gunzipSync(zipped.get('ci.tgz').data, {maxOutputLength: 256 * 1024 ** 2}));
  if ([...entries.keys()].sort().join('\0') !== [...payloadPaths, 'ci-proof.json'].sort().join('\0') ||
    [...entries.values()].some(e => !['0', ''].includes(e.type))) fail('CI归档十一件闭集不符');
  const files = Object.fromEntries([...entries].map(([path, e]) => [path, e.data]));
  const proof = validateProof(JSON.parse(files['ci-proof.json']), context, attempt, files);
  if (proof.requirements_sha256 !== sha256(Buffer.from(JSON.stringify(await flowRequirements('ci'))))) fail('CI资源需求与当前声明不一致');
  // 已保存源码与CI证明逐件对应；不读取其它工作树、不重编译CI产物。
  const seen = new Set();
  for (const source of proof.sources) {
    safeRelative(source.path); if (seen.has(source.path) || source.path.startsWith('target/')) fail('CI源码证明条目重复或越界'); seen.add(source.path);
    const current = await readFile(join(productRoot, source.path));
    if (current.length !== source.bytes || sha256(current) !== source.sha256) fail('Release源码与成功CI字节不符');
  }
  const second = await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + context.ciRunID, capability);
  if (validateCIRun(second, context) !== attempt) fail('CI下载期间发生重跑');
  const again = await githubRequest('/repos/crcfrcn/citizenserve/actions/artifacts/' + artifact.id, capability);
  if (again.digest !== artifact.digest || again.name !== artifact.name || again.expired) fail('CI资产下载期间漂移');
  return {files, proof, artifactID: artifact.id, artifactSHA: artifact.digest.slice(7), attempt};
}
export async function prepareRelease({input, environment = process.env, signal}) {
  const version = cargoVersion(await readFile(join(productRoot, 'Cargo.toml'), 'utf8'));
  const context = validateInput(input, environment, version);
  const task = await claimWork('release', String(context.runID) + '-' + context.attempt);
  try {
    const receipt = await prepareFlowResources({flow: 'release', work: task.work, mode: 'independent', signal,
      toolRoot: join(environment.RUNNER_TEMP, 'citizenserve-resources/tools'),
      dependencyRoot: join(environment.RUNNER_TEMP, 'citizenserve-resources/dependencies')});
    if (await checkoutSHA(receipt) !== context.sourceSHA) fail('Release检出SHA不符');
    const capability = {token: environment.GH_TOKEN, signal};
    await successfulGate(context.sourceSHA, capability);
    const ci = await downloadCI(context, capability);
    const files = Object.fromEntries(payloadPaths.map(path => [path, ci.files[path]]));
    const archive = tarGzip(files);
    const manifest = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', software_version: version,
      source_sha: context.sourceSHA, version_tag: context.tag, ci_run_id: context.ciRunID, ci_run_attempt: ci.attempt,
      artifact_id: ci.artifactID, artifact_sha256: ci.artifactSHA,
      release_run_id: context.runID, release_run_attempt: context.attempt,
      files: payloadPaths.map(path => ({path, sha256: sha256(files[path]), bytes: files[path].length})),
      archive_sha256: sha256(archive)};
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const sums = Buffer.from(sha256(archive) + '  citizenserve-cloudflare-release.tgz\n' +
      sha256(manifestBytes) + '  release-manifest.json\n');
    await writeFile(join(task.work, 'citizenserve-cloudflare-release.tgz'), archive, {flag: 'wx', mode: 0o444});
    await writeFile(join(task.work, 'release-manifest.json'), manifestBytes, {flag: 'wx', mode: 0o444});
    await writeFile(join(task.work, 'SHA256SUMS'), sums, {flag: 'wx', mode: 0o444});
    await writeFile(join(task.work, 'release-context.json'), JSON.stringify(context) + '\n', {flag: 'wx', mode: 0o444});
    return manifest;
  } finally { await task.finish(); }
}
export function validatePublished(value, context) {
  const names = ['citizenserve-cloudflare-release.tgz', 'release-manifest.json', 'SHA256SUMS'].sort();
  if (!value || value.draft || value.prerelease || value.tag_name !== context.tag ||
    value.target_commitish !== context.sourceSHA || value.assets?.map(a => a.name).sort().join('\0') !== names.join('\0') ||
    value.html_url !== 'https://github.com/crcfrcn/citizenserve/releases/tag/' + context.tag || !value.published_at) fail('正式Release发布回读不完整');
  return value;
}
export async function publishRelease({input, environment = process.env, signal}) {
  const context = validateInput(input, environment, cargoVersion(await readFile(join(productRoot, 'Cargo.toml'), 'utf8')));
  const work = join(productRoot, 'target/build');
  const saved = JSON.parse(await readFile(join(work, 'release-context.json')));
  if (JSON.stringify(saved) !== JSON.stringify(context)) fail('Release签署阶段任务漂移');
  const receipt = await verifyFlowResources(JSON.parse(await readFile(join(work, 'resources.json'))));
  const capability = {token: environment.GH_TOKEN, signal};
  await successfulGate(context.sourceSHA, capability);
  const currentCI = await githubRequest('/repos/crcfrcn/citizenserve/actions/runs/' + context.ciRunID, capability);
  const files = {};
  for (const name of ['citizenserve-cloudflare-release.tgz', 'release-manifest.json', 'SHA256SUMS']) {
    const bytes = await readFile(join(work, name)); files[name] = bytes;
    const result = await runTool(receipt.tools.gh, ['attestation', 'verify', join(work, name), '--repo', 'crcfrcn/citizenserve',
      '--signer-workflow', 'github.com/crcfrcn/citizenserve/.github/workflows/' + workflowFile,
      '--source-digest', context.sourceSHA, '--signer-digest', context.sourceSHA, '--source-ref', 'refs/heads/main',
      '--deny-self-hosted-runners', '--no-public-good', '--format', 'json'], {
      work, tools: receipt.tools, signal, environment: {GH_TOKEN: environment.GH_TOKEN, GH_HOST: 'github.com', GH_CONFIG_DIR: join(work, 'gh')}});
    const verified = JSON.parse(result.stdout);
    if (!Array.isArray(verified) || !verified.some(v => v.verificationResult?.statement?.subject?.some(s => s.digest?.sha256 === sha256(bytes)))) fail('正式资产密码学来源证明未覆盖当前字节');
  }
  const manifest = JSON.parse(files['release-manifest.json']);
  if (manifest.source_sha !== context.sourceSHA || manifest.version_tag !== context.tag ||
    manifest.ci_run_id !== context.ciRunID || manifest.ci_run_attempt !== validateCIRun(currentCI, context) ||
    manifest.archive_sha256 !== sha256(files['citizenserve-cloudflare-release.tgz']) ||
    files.SHA256SUMS.toString() !== sha256(files['citizenserve-cloudflare-release.tgz']) + '  citizenserve-cloudflare-release.tgz\n' +
      sha256(files['release-manifest.json']) + '  release-manifest.json\n') fail('签署后的正式资产或CI来源漂移');
  let release = await githubRequest('/repos/crcfrcn/citizenserve/releases/tags/' + context.tag, {...capability, missing: true});
  if (release && (release.tag_name !== context.tag || release.target_commitish !== context.sourceSHA || release.prerelease)) fail('同Tag已被其它来源占用');
  if (!release) release = await githubRequest('/repos/crcfrcn/citizenserve/releases', {...capability, method: 'POST', body: {
    tag_name: context.tag, target_commitish: context.sourceSHA, name: '公民服务端 · Cloudflare · Release',
    body: '公民服务端 Cloudflare ' + context.version + '\n<!-- citizenserve.cloudflare.release run_id:' + context.runID + ' ci_run_id:' + context.ciRunID + ' -->',
    draft: true, prerelease: false, make_latest: 'false'}});
  for (const [name, bytes] of Object.entries(files)) {
    const old = release.assets.find(a => a.name === name);
    if (old) {
      const current = await githubDownload('/repos/crcfrcn/citizenserve/releases/assets/' + old.id, capability);
      if (!current.equals(bytes)) fail('同名正式资产已存在不同字节，禁止覆盖');
    } else {
      if (!release.draft) fail('已发布版本缺资产，禁止追加改写');
      await githubUpload(release.id, name, bytes, capability);
    }
  }
  if (release.assets.some(a => !Object.hasOwn(files, a.name))) fail('正式版本含未知资产');
  if (release.draft) await githubRequest('/repos/crcfrcn/citizenserve/releases/' + release.id, {...capability, method: 'PATCH', body: {draft: false, make_latest: 'false'}});
  release = validatePublished(await githubRequest('/repos/crcfrcn/citizenserve/releases/' + release.id, capability), context);
  for (const [name, bytes] of Object.entries(files)) {
    const asset = release.assets.find(a => a.name === name);
    if (asset.size !== bytes.length || asset.digest !== 'sha256:' + sha256(bytes) ||
      !(await githubDownload('/repos/crcfrcn/citizenserve/releases/assets/' + asset.id, capability)).equals(bytes)) fail('正式资产发布回读不符');
  }
  const tag = await githubRequest('/repos/crcfrcn/citizenserve/git/ref/tags/' + context.tag, capability);
  if (tag.object?.type !== 'commit' || tag.object.sha !== context.sourceSHA) fail('正式Tag没有指向准确源码SHA');
  await writeFile(join(work, 'release-receipt.json'), JSON.stringify({schema: 1, product_id: 'citizenserve', platform: 'cloudflare',
    flow: 'release', state: 'success', source_sha: context.sourceSHA, run_id: context.runID, tag: context.tag,
    release_id: release.id, assets: release.assets.map(a => ({id: a.id, name: a.name, digest: a.digest, bytes: a.size}))}) + '\n', {flag: 'wx', mode: 0o444});
  return release;
}
export async function main(args) {
  if (args.length === 1 && ['prepare', 'publish'].includes(args[0])) return runCLI(async signal => {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH));
    return args[0] === 'prepare' ? prepareRelease({input: event.inputs, signal}) : publishRelease({input: event.inputs, signal});
  });
  if (args.length === 1 && args[0] === 'dispatch') return runCLI(signal => dispatchFlow('release', {signal}));
  if (args[0] === 'recover') return runCLI(signal => recoverFlow('release', args.slice(1), {signal}));
  fail('公开Release入口参数无效');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
