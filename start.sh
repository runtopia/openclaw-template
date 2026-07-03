#!/bin/bash
# OpenClaw startup script.
#
# 架构：
#   PID 1: node src/sidecar.js
#     ├─ 启动时写好 openclaw.json（幂等）
#     ├─ spawn openclaw gateway run（子进程，内部端口 18789）
#     ├─ 对外监听 $PORT，/health + /repair/* + 反代其他请求到 gateway
#     └─ gateway 崩溃自愈；修复助手不受影响
#
# Railway healthcheck 打 /health，sidecar 存活即 200，不依赖 gateway。
set -e

# 必须 export：sidecar.js 读 process.env.OPENCLAW_STATE_DIR，未导出则回退到
# os.homedir()/.openclaw（容器临时层，非 /data volume），重新部署即丢数据。
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
STATE_DIR="$OPENCLAW_STATE_DIR"
WORKSPACE_DIR="$OPENCLAW_WORKSPACE_DIR"

# 兼容旧变量名
if [ -z "$CLAWROUTERS_API_KEY" ] && [ -n "$CLAWROUTERS_KEY" ]; then
  export CLAWROUTERS_API_KEY="$CLAWROUTERS_KEY"
fi

if [ "$(id -u)" = "0" ]; then
  # Railway volume 挂载后是 root:root，修复权限后降权
  chown -R openclaw:openclaw /data
  mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"
  chown -R openclaw:openclaw "$STATE_DIR" "$WORKSPACE_DIR"
  exec gosu openclaw node /app/src/index.js
fi

# 本地开发（非 root）
mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"
exec node src/index.js
