
// 本仓资料、真实流程与失败边界；不依赖已删除的构建入口或其它仓库测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {gateContract, pushBaseSHA, validateWorkflowSource, validateProductDocuments,
  assertNoProductOutputDirectories, hasSecretMaterial, scanAddedSource, hasFirstPartyTemporaryComments} from './index.mjs';
function fixture(callback) {
  const work = process.env.PRODUCT_WORK_DIR; assert.ok(work);
  const path = mkdtempSync(join(work, 'gate-'));
  try { callback(path); } finally { rmSync(path, {recursive: true, force: true}); }
}
test('门禁必须登记当前Rust、完整检查和实际四件合同测试', () => {
  const value = structuredClone(gateContract()); assert.equal(gateContract(value), value);
  for (const change of [v => { v.tools.rust = null; }, v => { v.node_tests.pop(); }, v => { v.checks.pop(); },
    v => { v.workflows.push('other.cloudflare.ci'); }, v => { v.extra = true; }]) {
    const copy = structuredClone(value); change(copy); assert.throws(() => gateContract(copy));
  }
});
test('首次push和唯一无父根不会写Git对象，带父强推仍拒绝', () => {
  const headSHA = 'a'.repeat(40), before = 'b'.repeat(40), empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  assert.equal(pushBaseSHA({forced: false, before: '0'.repeat(40), headSHA}), empty);
  assert.equal(pushBaseSHA({forced: false, before, headSHA}), before);
  assert.equal(pushBaseSHA({forced: true, before, headSHA, parents: headSHA, commitCount: '1'}), empty);
  assert.throws(() => pushBaseSHA({forced: true, before, headSHA, parents: headSHA + ' ' + before, commitCount: '2'}));
});
test('Workflow只能调用自己的扁平完整入口', () => {
  for (const flow of ['ci', 'release']) {
    const source = 'name: citizenserve.cloudflare.' + flow + '\non:\n  workflow_dispatch:\nconcurrency:\n  group: citizenserve.cloudflare.' +
      flow + '\njobs:\n  flow:\n    steps:\n    - run: scripts/' + flow + '/cloudflare.mjs\n';
    const path = 'citizenserve-cloudflare-' + flow + '.yml';
    assert.equal(validateWorkflowSource(source, path), 'citizenserve.cloudflare.' + flow);
    assert.throws(() => validateWorkflowSource(source.replace('workflow_dispatch', 'push'), path));
    assert.throws(() => validateWorkflowSource(source.replace('/cloudflare.mjs', '/cloudflare/check/execute.mjs'), path));
    assert.throws(() => validateWorkflowSource(source.replace('  flow:', '  other:'), path));
  }
});
test('所属唯一根文档拒绝空文件、链接和第二技术文档', () => fixture(root => {
  assert.throws(() => validateProductDocuments(root));
  for (const name of ['CitizenServe.md', 'README.md']) writeFileSync(join(root, name), '合成资料\n');
  assert.equal(validateProductDocuments(root), true);
  writeFileSync(join(root, 'CitizenServe.md'), ''); assert.throws(() => validateProductDocuments(root));
  unlinkSync(join(root, 'CitizenServe.md')); symlinkSync(join(root, 'README.md'), join(root, 'CitizenServe.md'));
  assert.throws(() => validateProductDocuments(root)); unlinkSync(join(root, 'CitizenServe.md'));
  writeFileSync(join(root, 'CitizenServe.md'), '合成资料'); writeFileSync(join(root, 'Extra.md'), '第二文档');
  assert.throws(() => validateProductDocuments(root));
}));
test('scripts一层目录和根target边界会检查实际物理路径', () => fixture(root => {
  mkdirSync(join(root, 'scripts/ci'), {recursive: true});
  writeFileSync(join(root, 'scripts/ci/cloudflare.mjs'), '实现'); writeFileSync(join(root, 'scripts/ci/cloudflare.test.mjs'), '测试');
  mkdirSync(join(root, 'target/nested/build'), {recursive: true}); assert.doesNotThrow(() => assertNoProductOutputDirectories(root));
  mkdirSync(join(root, 'scripts/ci/cloudflare')); assert.throws(() => assertNoProductOutputDirectories(root));
  rmSync(join(root, 'scripts/ci/cloudflare'), {recursive: true}); mkdirSync(join(root, 'source/target'), {recursive: true});
  assert.throws(() => assertNoProductOutputDirectories(root));
}));
test('新增残留和未知版本协议拒绝，既有上游URL不误判', () => {
  const code = 'const address="https://api.cloudflare.com/client/' + 'v4/zones";';
  assert.doesNotThrow(() => scanAddedSource('scripts/sample.mjs', code, code));
  for (const code of ['debug' + 'ger;', '// ' + ['TO', 'DO'].join('') + ': unfinished',
    'const address="https://example.invalid/' + 'v9";']) assert.throws(() => scanAddedSource('scripts/sample.mjs', code, code));
  assert.equal(hasFirstPartyTemporaryComments('sample.mjs', '// ' + ['HA', 'CK'].join('') + ': pending'), true);
});
test('资料机密扫描完整处理JSON和转义，仅使用合成格式', () => {
  assert.equal(hasSecretMaterial('正常资料'), false);
  const shaped = ['-----BEGIN ', 'PRIVATE KEY-----\n', 'A'.repeat(96), '\n-----END ', 'PRIVATE KEY-----'].join('');
  assert.equal(hasSecretMaterial(shaped), true);
  assert.equal(hasSecretMaterial(JSON.stringify({original: shaped})), true);
  assert.equal(hasSecretMaterial(JSON.stringify(JSON.stringify(shaped))), true);
  assert.throws(() => hasSecretMaterial('<!-- PATCH_DATA\n{}'));
});
