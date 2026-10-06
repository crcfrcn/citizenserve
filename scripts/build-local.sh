#!/usr/bin/env bash
# 产品独立Build拥有编译和失败条件；调用方仅提供只读源码视图、工具和源码外输出。
set -euo pipefail
[[ $# -eq 3 && ( "$1" == linux-arm || "$1" == cloudflare ) && "$2" == /* && "$3" == /* ]] \
  || { echo 'Build参数无效' >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
platform="$1"; project="$2"; output="$3"
: "${NODE:?缺少Node入口}" "${NPM_CLI:?缺少npm公开入口}"
# 验真视图仍消费本产品真实清单，不能用相邻产品或将输出写入源码。
"$NODE" --input-type=module - "$root" "$project" "$output" <<'VERIFY_BUILD_INPUT'
import { realpathSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
const [root, project, output] = process.argv.slice(2);
for (const file of ['package.json', 'package-lock.json']) {
  if (!readFileSync(join(project, file)).equals(readFileSync(join(root, file)))) throw Error('Build源码视图不属于本产品');
}
const actual = realpathSync(output.slice(0, output.lastIndexOf('/')));
const difference = relative(root, actual);
if (!difference.startsWith('..') && !isAbsolute(difference)) throw Error('Build输出不得进入源码');
VERIFY_BUILD_INPUT
cd "$project"
# 两个平台只消费本产品工程；Cloudflare编译命令及真实候选失败条件由本仓维护。
if [[ "$platform" == cloudflare ]]; then
  [[ ! -e "$output" && ! -L "$output" ]] || { echo '本轮Worker输出已经存在' >&2; exit 1; }
  mkdir -p "$output"
  "$NODE" "$project/node_modules/wrangler/bin/wrangler.js" deploy --config scripts/wrangler.toml --dry-run --outdir "$output"
  "$NODE" --input-type=module - "$output" <<'VERIFY_WORKER'
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
const root=process.argv[2];
const outputs=readdirSync(root).filter(name=>name.endsWith('.js')||name.endsWith('.mjs'));
if(!outputs.length||realpathSync(root)!==root)throw Error('真实Worker候选缺失');
for(const name of outputs){const path=join(root,name),info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||!info.size)throw Error('Worker候选无效');}
VERIFY_WORKER
else
"$NODE" "$NPM_CLI" run typecheck

fi
