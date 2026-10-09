
// CI真实输入、来源与Attempt边界；只使用合成坐标，不派发远端任务。
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateInput, validateGate, artifactName, successfulGate} from './cloudflare.mjs';
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
 const root=resolve(import.meta.dirname,'../..'),parent=join(root,'target/test');await fs.mkdir(parent,{recursive:true});
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
