#!/usr/bin/env node
// 由同一Node核对完整类型文件并调用本产品唯一Wrangler生成命令，生成失败不得假通过。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const path = 'scripts/worker-configuration.d.ts';
const npm = process.env.npm_execpath;
if (!npm || !isAbsolute(npm)) throw new Error('类型检查必须由npm脚本入口执行');
const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex');
const before = digest();
const generated = spawnSync(process.execPath, [npm, 'run', 'generate:types'], {
  env: process.env,
  stdio: 'inherit',
});
if (generated.error) throw generated.error;
if (generated.status !== 0) process.exit(Number.isInteger(generated.status) ? generated.status : 1);
if (before !== digest()) {
  console.error('scripts/worker-configuration.d.ts 已过期，请运行 npm run generate:types');
  process.exitCode = 1;
}
