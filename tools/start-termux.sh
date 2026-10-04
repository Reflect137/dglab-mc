#!/usr/bin/env bash
# ============================================================================
#  start-termux.sh —— 在 Termux（安卓手机）里一键启动 DG-LAB 中继
#
#  用法：
#      bash tools/start-termux.sh                  # 默认端口 9999，只允许本机连
#      bash tools/start-termux.sh --port 8888      # 指定端口
#      bash tools/start-termux.sh 8888 -v          # 旧写法也认，加逐条消息日志
#      bash tools/start-termux.sh --host 0.0.0.0   # 允许别的设备连（无密码，注意风险）
#
#  首次使用：
#      pkg install nodejs
#      termux-setup-storage        # 让 Termux 能读 /sdcard
# ============================================================================
set -euo pipefail

PORT="9999"
HOST="127.0.0.1"
EXTRA_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --port)   [ $# -ge 2 ] || { echo "--port 需要端口号" >&2; exit 2; }; PORT="$2"; shift 2 ;;
        --port=*) PORT="${1#--port=}"; shift ;;
        --host)   [ $# -ge 2 ] || { echo "--host 需要地址" >&2; exit 2; }; HOST="$2"; shift 2 ;;
        --host=*) HOST="${1#--host=}"; shift ;;
        --*)      EXTRA_ARGS+=("$1"); shift ;;
        *)        PORT="$1"; shift ;;      # 兼容旧的「第一个参数是端口」写法
    esac
done

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
echo "[start] 启动中继，端口 $PORT，监听 $HOST（Ctrl+C 退出）"
echo

if [ "$HOST" != "127.0.0.1" ]; then
    echo "[start] 注意：监听 $HOST，同网络的其他设备都能连（无密码）"
fi
exec node "$RELAY" --port "$PORT" --host "$HOST" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
