
// Release正常、失败、边界及回归；合成资产不构建、不签署、不创建真实版本。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cargoVersion, validateInput, validateCIRun, validateProof, validatePublished, payloadPaths} from './cloudflare.mjs';
const sourceSHA = 'a'.repeat(40);
const context = {sourceSHA, ciRunID: 42, version: '1.0.0', tag: 'citizenserve-cloudflare-v1.0.0'};
const environment = {GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', GITHUB_REPOSITORY: 'crcfrcn/citizenserve',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sourceSHA,
  GITHUB_RUN_ID: '43', GITHUB_RUN_ATTEMPT: '1'};
const input = {pipeline: 'citizenserve.cloudflare.release', run_title: '公民服务端 · Cloudflare · Release',
  source_sha: sourceSHA, ci_run_id: '42', software_version: '1.0.0', version_tag: context.tag};
test('软件版本只取根Cargo，Tag和真实来源必须一致', () => {
  assert.equal(cargoVersion('[package]\nname="citizenserve"\nversion="1.0.0"\n'), '1.0.0');
  assert.equal(validateInput(input, environment, '1.0.0').sourceSHA, sourceSHA);
  for (const source of ['', '[other]\nversion="1.0.0"', '[package]\nversion="01.0.0"', '[package]\nversion="1.100.0"']) assert.throws(() => cargoVersion(source));
});
test('Release拒绝错版本、错SHA、其它产品及Runtime字段', () => {
  for (const change of [{software_version: '1.0.1'}, {version_tag: 'other-v1.0.0'}, {source_sha: 'b'.repeat(40)},
    {ci_run_id: '0'}, {ci_run_id: 'main'}, {pipeline: 'other.cloudflare.release'}, {spec_version: '1'}, {extra: 'value'}]) {
    assert.throws(() => validateInput({...input, ...change}, environment, '1.0.0'));
  }
  for (const key of Object.keys(environment)) assert.throws(() => validateInput(input, {...environment, [key]: 'other'}, '1.0.0'));
});
const run = {id: 42, run_attempt: 2, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
  head_branch: 'main', head_sha: sourceSHA, path: '.github/workflows/citizenserve-cloudflare-ci.yml', repository: {full_name: 'crcfrcn/citizenserve'}};
test('CI来源严格绑定Run、Attempt、仓库、源码和实际终态', () => {
  assert.equal(validateCIRun(run, context), 2);
  for (const change of [{id: 1}, {run_attempt: 0}, {run_attempt: '2'}, {conclusion: 'cancelled'}, {conclusion: 'skipped'},
    {status: 'in_progress'}, {head_sha: 'b'.repeat(40)}, {path: 'other'}, {repository: {full_name: 'other/repo'}}]) assert.throws(() => validateCIRun({...run, ...change}, context));
});
function fixture() {
  const hash = b => createHash('sha256').update(b).digest('hex');
  const files = Object.fromEntries(payloadPaths.map(p => [p, Buffer.from('synthetic source')]));
  files['Cargo.toml'] = Buffer.from('[package]\nversion="1.0.0"\n');
  files['index_bg.wasm'] = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const count = {passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0};
  const proof = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', workflow: 'citizenserve.cloudflare.ci',
    source_sha: sourceSHA, run_id: 42, run_attempt: 2, artifact_name: 'citizenserve-cloudflare-ci-42-2',
    sources: [{path: 'Cargo.toml', sha256: hash(files['Cargo.toml']), bytes: files['Cargo.toml'].length}],
    files: payloadPaths.map(path => ({path, bytes: files[path].length, sha256: hash(files[path])})),
    acceptance: {rust: {...count}, python: {...count}, node: {...count}, worker: {...count},
      reports: Array.from({length: 8}, () => ({completed: true}))}};
  return {files, proof};
}
test('完整CI证明绑定十一件来源，真实Worker不能为空或错摘要', () => {
  const {files, proof} = fixture(); assert.equal(validateProof(proof, context, 2, files), proof);
  for (const change of [p => { p.run_attempt = 1; }, p => { p.run_id = 1; }, p => { p.files.pop(); },
    p => { p.files[0].sha256 = '0'.repeat(64); }, p => { p.acceptance.reports.pop(); }, p => { p.acceptance.worker.passed = 0; },
    p => { p.acceptance.node.skipped = 1; }, p => { p.acceptance.rust.cancelled = 1; }]) {
    const copy = structuredClone(proof); change(copy); assert.throws(() => validateProof(copy, context, 2, files));
  }
  assert.throws(() => validateProof(proof, context, 2, {...files, 'index.js': Buffer.alloc(0)}));
});
const published = {draft: false, prerelease: false, tag_name: context.tag, target_commitish: sourceSHA,
  html_url: 'https://github.com/crcfrcn/citizenserve/releases/tag/' + context.tag, published_at: '2026-10-08T00:00:00Z',
  assets: ['citizenserve-cloudflare-release.tgz', 'release-manifest.json', 'SHA256SUMS'].map(name => ({name}))};
test('仅完整已发布Release构成正式版本，Artifact和draft不得替代', () => {
  assert.equal(validatePublished(published, context), published);
  for (const change of [{draft: true}, {prerelease: true}, {published_at: null}, {assets: published.assets.slice(0, 2)},
    {target_commitish: 'main'}, {html_url: 'https://example.invalid/release'}]) assert.throws(() => validatePublished({...published, ...change}, context));
});
