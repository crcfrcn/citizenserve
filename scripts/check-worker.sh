# 必须由当前资源供给的Bash绝对入口解释执行。
# 仅调用本产品完整资源验真的实现；不经PATH查找工具。
set -eu
: "${PRODUCT_NODE_BIN:?必须交付已验真Node绝对入口}"
: "${PRODUCT_ROOT:?必须绑定本产品真实源码根}"
: "${PRODUCT_FLOW_RESOURCE_RECEIPT:?必须交付当前任务完整资源回执}"
case "$PRODUCT_NODE_BIN:$PRODUCT_ROOT:$PRODUCT_FLOW_RESOURCE_RECEIPT" in /*:/*:/*) ;; *) exit 1 ;; esac
exec "$PRODUCT_NODE_BIN" "$PRODUCT_ROOT/scripts/resources.mjs" check-worker "$PRODUCT_FLOW_RESOURCE_RECEIPT"
