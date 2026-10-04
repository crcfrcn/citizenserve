#!/usr/bin/env bash
# 产品独立Build拥有编译和失败条件；调用方仅提供只读源码视图、工具和源码外输出。
set -euo pipefail
[[ $# -eq 3 && "$1" == linux-arm && "$2" == /* && "$3" == /* ]] \
  || { echo 'Build参数无效' >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
project="$2"; output="$3"
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
"$NODE" "$NPM_CLI" run typecheck
