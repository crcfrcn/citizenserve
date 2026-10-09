#!/bin/sh
# 仅锁定本地构建，不部署、不访问远程数据库。
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
: "${PRODUCT_NODE_BIN:?必须交付已验真的Node绝对入口}"
: "${TATACHAT_RESOURCE_RECEIPT:?必须先完成当前任务协议资源准备}"
case "$PRODUCT_NODE_BIN" in /*) ;; *) echo "Node入口必须为绝对路径" >&2; exit 1 ;; esac
: "${WORKER_BUILD:?必须交付已验真的worker-build绝对入口}"
tool="$WORKER_BUILD"
case "$tool" in /*) ;; *) echo "worker-build入口必须为绝对路径" >&2; exit 1 ;; esac
[ -x "$tool" ] || { echo "worker-build supplied resource missing" >&2; exit 1; }
[ "$("$tool" --version)" = '0.8.5' ] || { echo 'worker-build version mismatch' >&2; exit 1; }
cd "$root/server/cloudflare"
export PRODUCT_EXECUTION_CWD="$root/server/cloudflare"
"$PRODUCT_NODE_BIN" "$root/scripts/resources.mjs" exec "$TATACHAT_RESOURCE_RECEIPT" -- "$tool" --out-dir ../../target/build/worker --release -- --locked
