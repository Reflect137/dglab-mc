#!/data/data/com.termux/files/usr/bin/env bash
# ============================================================================
#  start-termux.sh —— 在 Termux（安卓手机）里一键启动 DG-LAB 中继
#
#  用法：
#      bash tools/start-termux.sh            # 默认端口 9999
#      bash tools/start-termux.sh 12345      # 指定端口
#      bash tools/start-termux.sh 9999 -v    # 打开逐条消息日志
#
#  首次使用：
#      pkg install nodejs
#      termux-setup-storage        # 让 Termux 能读 /sdcard
# ============================================================================
set -euo pipefail

PORT="${1:-9999}"
shift || true
EXTRA_ARGS=("$@")

# 脚本所在目录的上一级 = 项目根目录
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RELAY="$ROOT/tools/dglab-relay.js"

if [ ! -f "$RELAY" ]; then
    echo "找不到 $RELAY" >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "没有找到 node，请先在 Termux 里执行：pkg install nodejs" >&2
    exit 1
fi

# 尽量防止 Termux 被系统冻结/杀掉（没有这个命令也不影响）
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock || true
    echo "[start] 已申请 termux-wake-lock（锁住 CPU，别让系统冻掉 Termux）"
fi

if command -v termux-setup-storage >/dev/null 2>&1 && [ ! -d "$HOME/storage" ]; then
    echo "[start] 提示：如果读不到 /sdcard，先在 Termux 里跑一次 termux-setup-storage"
fi

echo "[start] 项目目录: $ROOT"
echo "[start] 启动中继，端口 $PORT（Ctrl+C 退出）"
echo

exec node "$RELAY" --port "$PORT" --host 0.0.0.0 ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
