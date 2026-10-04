// 直接调用本产品Build；工具替身只验证调用与失败条件，不代表真实编译验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = join(root, 'scripts', 'build-local.sh');
test('错误参数与未知平台在执行工具前拒绝', () => {
  for (const args of [[], ['unknown', '/tmp/input', '/tmp/output'], ['linux-arm', 'relative', 'relative']]) {
    assert.notEqual(spawnSync('/bin/bash', [entry, ...args], { env: {} }).status, 0);
  }
});
test('来源清单、源码外输出和工具失败由所属入口收口', t => {
  const work = mkdtempSync(join(tmpdir(), 'citizenserve-build-unit-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const project = join(work, 'project'), output = join(work, 'compile'), cli = join(work, 'npm.mjs');
  mkdirSync(project);
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, file), join(project, file));
  writeFileSync(cli, "import { mkdirSync, writeFileSync } from 'node:fs';import { dirname } from 'node:path';\nif (process.env.TOOL_STATUS === '23') process.exit(23);\nconst output = process.env.UNIT_OUTPUT;mkdirSync(dirname(output), { recursive: true });writeFileSync(output, 'fixture');");
  const invoke = (status) => spawnSync('/bin/bash', [entry, 'linux-arm', project, output], {
    encoding: 'utf8', env: { ...process.env, NODE: process.execPath, NPM_CLI: cli,
      UNIT_OUTPUT: join(output, 'index.html'), TOOL_STATUS: String(status) },
  });
  assert.equal(invoke(0).status, 0);
  assert.equal(invoke(23).status, 23);
  writeFileSync(join(project, 'package.json'), '{"name":"another-product"}');
  assert.notEqual(invoke(0).status, 0);
  copyFileSync(join(root, 'package.json'), join(project, 'package.json'));
  assert.notEqual(spawnSync('/bin/bash', [entry, 'linux-arm', project, join(root, 'forbidden-output')], {
    env: { ...process.env, NODE: process.execPath, NPM_CLI: cli },
  }).status, 0);
});
