// 直接调用本产品Build；工具替身只验证调用与失败条件，不代表真实编译验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { testRoot as tmpdir } from './build.mjs';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = join(root, 'scripts', 'build-local.sh');
const shell = process.env.PRODUCT_SHELL_BIN;
// 调用方先验真工具来源；测试仅接纳准确、真实、普通且可执行的公开Shell入口。
if (!shell || !isAbsolute(shell) || resolve(shell) !== shell
    || realpathSync(shell) !== shell || !lstatSync(shell).isFile()
    || lstatSync(shell).isSymbolicLink() || !(lstatSync(shell).mode & 0o111)) {
  throw Error('构建测试缺少已验真的PRODUCT_SHELL_BIN');
}

test('错误参数与未知平台在执行工具前拒绝', () => {
  for (const args of [[], ['unknown', '/tmp/input', '/tmp/output'], ['linux-arm', 'relative', 'relative']]) {
    assert.notEqual(spawnSync(shell, [entry, ...args], { env: { PATH: process.env.PATH } }).status, 0);
  }
});
test('来源清单、源码外输出和工具失败由所属入口收口', t => {
  const work = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'citizenserve-build-unit-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const project = join(work, 'project'), output = join(work, 'compile'), cli = join(work, 'npm.mjs');
  mkdirSync(project);
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, file), join(project, file));
  writeFileSync(cli, "import { mkdirSync, writeFileSync } from 'node:fs';import { dirname } from 'node:path';\nif (process.env.TOOL_STATUS === '23') process.exit(23);\nconst output = process.env.UNIT_OUTPUT;mkdirSync(dirname(output), { recursive: true });writeFileSync(output, 'fixture');");
  const invoke = (status) => spawnSync(shell, [entry, 'linux-arm', project, output], {
    encoding: 'utf8', env: { ...process.env, NODE: process.execPath, NPM_CLI: cli,
      UNIT_OUTPUT: join(output, 'index.html'), TOOL_STATUS: String(status) },
  });
  assert.equal(invoke(0).status, 0);
  assert.equal(invoke(23).status, 23);
  writeFileSync(join(project, 'package.json'), '{"name":"another-product"}');
  assert.notEqual(invoke(0).status, 0);
  copyFileSync(join(root, 'package.json'), join(project, 'package.json'));
  assert.notEqual(spawnSync(shell, [entry, 'linux-arm', project, join(root, 'forbidden-output')], {
    env: { ...process.env, NODE: process.execPath, NPM_CLI: cli },
  }).status, 0);
});

// 替身验证dry-run参数及候选失败条件；真实Worker编译另由完整产品Build验收。
test('Cloudflare拥有本仓编译命令，拒绝空输出、旧输出和编译失败', t => {
 const work=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),'citizenserve-worker-contract-')));t.after(()=>rmSync(work,{recursive:true,force:true}));
 const project=join(work,'project');mkdirSync(join(project,'node_modules/wrangler/bin'),{recursive:true});
 for(const file of ['package.json','package-lock.json'])copyFileSync(join(root,file),join(project,file));
 const cli=join(project,'node_modules/wrangler/bin/wrangler.js');
 writeFileSync(cli,"const{writeFileSync}=require('node:fs');const{join}=require('node:path');const args=process.argv.slice(2);if(args[0]!=='deploy'||!args.includes('--dry-run')||args[args.indexOf('--config')+1]!=='scripts/wrangler.toml')process.exit(31);if(process.env.TOOL_STATUS==='23')process.exit(23);if(process.env.TOOL_STATUS!=='empty')writeFileSync(join(args[args.indexOf('--outdir')+1],'index.js'),'export default {}');");
 const invoke=(status,name)=>spawnSync(shell,[entry,'cloudflare',project,join(work,name)],{encoding:'utf8',env:{...process.env,NODE:process.execPath,NPM_CLI:cli,TOOL_STATUS:status}});
 const good=invoke('ok','good');assert.equal(good.status,0,good.stderr);assert.notEqual(invoke('ok','good').status,0);
 assert.equal(invoke('23','failed').status,23);assert.notEqual(invoke('empty','empty').status,0);
});
