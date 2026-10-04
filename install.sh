#!/usr/bin/env bash
# ============================================================================
#  DG-LAB × 我的世界 · 一键安装 / 启动脚本
#
#  给别人的用法（Termux 里粘一行就行）：
#      bash <(curl -fsSL https://raw.githubusercontent.com/Reflect137/dglab-mc/main/install.sh)
#
#  或者先克隆再跑：
#      git clone https://github.com/Reflect137/dglab-mc ~/dglab-mc
#      bash ~/dglab-mc/install.sh
#
#  其它用法：
#      bash install.sh --check        只检查环境，不装不改
#      bash install.sh --update       更新到最新版并重启
#      bash install.sh --port 8888    指定端口启动
#      bash install.sh --no-run       只安装 / 更新，不启动
#
#  支持：Termux（安卓手机）、Debian/Ubuntu、其它带 pkg/apt/apk 的 Linux
# ============================================================================
set -u

REPO="${DGLAB_REPO:-https://github.com/Reflect137/dglab-mc.git}"
DIR="${DGLAB_DIR:-$HOME/dglab-mc}"
PORT=""
DO_CHECK=0
DO_UPDATE=0
DO_RUN=1

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
    case "$1" in
        --check)   DO_CHECK=1; DO_RUN=0; shift ;;
        --update)  DO_UPDATE=1; shift ;;
        --no-run)  DO_RUN=0; shift ;;
        --port)    PORT="${2:-}"; shift 2 ;;
        --port=*)  PORT="${1#--port=}"; shift ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "未知参数：$1（用 --help 看用法）"; exit 2 ;;
    esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }
die()  { printf '  ❌ %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- 环境探测
IS_TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
    IS_TERMUX=1
fi

if [ "$IS_TERMUX" = "1" ]; then
    PLATFORM="Termux（安卓）"
    BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
elif [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
    PLATFORM="Linux"
    BIN_DIR="$HOME/.local/bin"
else
    PLATFORM="Linux"
    BIN_DIR="/usr/local/bin"
fi

say ""
say "=== DG-LAB × 我的世界 · 安装程序 ==="
say "  运行环境 : $PLATFORM"
say "  安装目录 : $DIR"
say ""

# ---------------------------------------------------------------- --check
if [ "$DO_CHECK" = "1" ]; then
    say "环境检查："
    if have node; then
        ok "Node.js 已安装：$(node -v)"
        NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
        [ "${NODE_MAJOR:-0}" -ge 18 ] 2>/dev/null || warn "Node 版本偏低（建议 ≥18）"
    else
        warn "没装 Node.js（安装时会自动装）"
    fi
    have git && ok "git 已安装" || warn "没装 git（安装时会自动装）"
    have curl && ok "curl 已安装" || warn "没装 curl（下载游戏脚本时要用）"
    [ -d "$DIR/.git" ] && ok "仓库已存在：$DIR" || warn "仓库还不存在：$DIR"
    [ -w "$BIN_DIR" ] && ok "可写目录：$BIN_DIR（能装 dglab 命令）" || warn "$BIN_DIR 不可写"
    say ""
    say "检查完毕。直接运行 bash install.sh 即可安装。"
    exit 0
fi

# ---------------------------------------------------------------- 装依赖
say "[1/4] 检查依赖（Node.js ≥18、git）"
need_install=0
have node || need_install=1
have git || need_install=1

if [ "$need_install" = "1" ]; then
    if have pkg; then
        say "  用 pkg 安装 nodejs / git（Termux 首次可能要一会儿）…"
        pkg install -y nodejs git || die "pkg 安装失败，请手动执行：pkg install -y nodejs git"
    elif have apt-get; then
        say "  用 apt 安装 nodejs / git …"
        if [ "$(id -u)" = "0" ]; then
            apt-get update -qq && apt-get install -y nodejs git
        else
            sudo apt-get update -qq && sudo apt-get install -y nodejs git
        fi || die "apt 安装失败，请手动装 nodejs 和 git"
    elif have apk; then
        apk add --no-cache nodejs git || die "apk 安装失败，请手动装"
    else
        die "找不到包管理器，请先自己装好 Node.js ≥18 和 git"
    fi
fi
have node || die "Node.js 仍然不可用"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null; then
    warn "Node $(node -v) 版本偏低，建议升级到 18+（脚本要求 ≥18）"
fi
ok "Node.js $(node -v)"
have git && ok "git 已就绪" || warn "没有 git（安装完就没法 --update，但可以继续用）"

# ---------------------------------------------------------------- 取代码
say ""
say "[2/4] 获取项目文件"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo '')"
if [ -f "$SCRIPT_DIR/dglab-hp.js" ] && [ -d "$SCRIPT_DIR/tools" ]; then
    # 已经在本仓库里运行（克隆后执行的）
    DIR="$SCRIPT_DIR"
    ok "用的就是当前目录：$DIR"
elif [ -d "$DIR/.git" ]; then
    if have git; then
        say "  更新已有仓库…"
        git -C "$DIR" pull --ff-only >/dev/null 2>&1 && ok "已更新到最新版" || warn "更新失败（离线？），继续用现有版本"
    fi
else
    have git || die "需要 git 才能下载，请先：pkg install -y git"
    say "  从 $REPO 克隆到 $DIR …"
    git clone --depth 1 "$REPO" "$DIR" >/dev/null 2>&1 || die "克隆失败（检查网络，或仓库地址）"
    ok "已下载到 $DIR"
fi
[ -f "$DIR/tools/dglab-relay.js" ] || die "没找到 tools/dglab-relay.js，项目不完整"

# ---------------------------------------------------------------- 装 dglab 命令
say ""
say "[3/4] 安装 dglab 命令"
WRAPPER="$BIN_DIR/dglab"
if [ -w "$BIN_DIR" ]; then
    cat > "$WRAPPER" <<EOF
#!/usr/bin/env sh
# 由 install.sh 生成：以后直接敲 dglab 就能启动中继
exec node "$DIR/tools/dglab-relay.js" "\$@"
EOF
    chmod +x "$WRAPPER" 2>/dev/null
    ok "已生成 $WRAPPER（以后敲 dglab 即可启动）"
    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) warn "$BIN_DIR 不在 PATH 里，可能要重开终端或手动加 PATH" ;;
    esac
else
    warn "$BIN_DIR 不可写，跳过（可以用 bash $DIR/tools/start-termux.sh 启动）"
fi

# 给游戏用的脚本下载助手
HELPER="$DIR/tools/get-game-script.sh"
if [ ! -f "$HELPER" ]; then
    warn "缺少 tools/get-game-script.sh（旧版本？）"
fi

# ---------------------------------------------------------------- 启动
say ""
say "[4/4] 完成"
say ""
say "  ┌──────────────────────────────────────────────────────────┐"
say "  │ 接下来：                                                 │"
say "  │ 1) 中继保持运行（Ctrl+C 停止）                            │"
say "  │ 2) 把 dglab-hp.js 放进游戏脚本目录                        │"
say "  │ 3) DG-LAB APP → Socket 控制 → 连接下面这个地址：           │"
say "  │      ws://127.0.0.1:${PORT:-9999}/mc-coyote                │"
say "  └──────────────────────────────────────────────────────────┘"
say ""
say "  游戏脚本下载（手机浏览器直接打开也行）："
say "    https://raw.githubusercontent.com/Reflect137/dglab-mc/main/dglab-hp.js"
say "  或在 Termux 里执行："
say "    bash $DIR/tools/get-game-script.sh        # 存到 /sdcard/Download/"
say ""

if [ "$DO_UPDATE" = "1" ]; then
    say "（--update 模式：已更新，下面继续启动）"
fi

if [ "$DO_RUN" = "0" ]; then
    say "（--no-run：不启动。手动启动：dglab  或  bash $DIR/tools/start-termux.sh）"
    exit 0
fi

if have termux-wake-lock; then
    termux-wake-lock 2>/dev/null && say "已申请 termux-wake-lock（防止后台被杀）"
fi

say "启动中继，端口 ${PORT:-9999}（Ctrl+C 退出）…"
say ""
exec node "$DIR/tools/dglab-relay.js" --port "${PORT:-9999}" --host 0.0.0.0
