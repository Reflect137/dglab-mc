#!/usr/bin/env bash
# ============================================================================
#  DG-LAB × 我的世界 · 安装脚本
#
#  用法：
#      bash tools/install.sh                装好，然后敲 dglab 启动（默认）
#      bash tools/install.sh --run          装完立刻启动
#      bash tools/install.sh --check        只检查环境，不装不改
#      bash tools/install.sh --update       更新到最新版（在仓库目录里也能用）
#      bash tools/install.sh --port 8888    配合 --run 指定端口（默认 9999）
#      bash tools/install.sh --host 0.0.0.0 允许别的设备连（默认只绑本机 127.0.0.1）
#
#  支持：Termux（安卓手机）、Debian/Ubuntu、其它带 pkg/apt/apk 的 Linux
# ============================================================================
set -u

REPO="${DGLAB_REPO:-https://github.com/Reflect137/dglab-mc.git}"
DIR="${DGLAB_DIR:-$HOME/dglab-mc}"
PORT=""
HOST="127.0.0.1"
DO_CHECK=0
DO_UPDATE=0
DO_RUN=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }
die()  { printf '  ❌ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 读项目版本号（package.json 里的 version）
ver_of() {
    sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -1
}

# 当前这份是什么版本（新 → 有版本号；旧 → 空）
short_commit() {
    git -C "$1" rev-parse --short HEAD 2>/dev/null || echo ''
}

# 检查并更新；直接给出结论：已是最新版 / 更新完成 / 连不上
update_repo() {
    local dir="$1" before after vbefore vafter
    if [ ! -d "$dir/.git" ]; then
        warn "这个目录不是 git 仓库，没法自动更新（手动下载新版覆盖即可）"
        return 1
    fi
    have git || { warn "没有 git，没法自动更新"; return 1; }
    before="$(short_commit "$dir")"
    vbefore="$(ver_of "$dir")"
    if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
        warn "这个目录里有本地改动，更新会把它们覆盖掉"
    fi
    say "  查 GitHub 上的最新版…"
    if ! git -C "$dir" fetch --depth 1 origin main >/dev/null 2>&1; then
        warn "连不上 GitHub（网络问题？），继续用当前的 v${vbefore:-?}（$before）"
        return 1
    fi
    after="$(git -C "$dir" rev-parse --short FETCH_HEAD 2>/dev/null || echo '')"
    if [ "$before" = "$after" ]; then
        ok "已经是最新版 v${vbefore:-?}（$before）"
        return 0
    fi
    if ! git -C "$dir" reset --hard -q FETCH_HEAD 2>/dev/null; then
        warn "更新失败，继续用 v${vbefore:-?}（$before）"
        return 1
    fi
    vafter="$(ver_of "$dir")"
    ok "更新完成：v${vbefore:-?}（$before） → v${vafter:-?}（$after）"
    return 0
}

usage() {
    cat <<'USAGE'
DG-LAB × 我的世界 · 安装脚本

  bash tools/install.sh                装好，然后敲 dglab 启动（默认）
  bash tools/install.sh --run          装完立刻启动
  bash tools/install.sh --check        只检查环境，不装不改
  bash tools/install.sh --update       更新到最新版
  bash tools/install.sh --port 8888    配合 --run 指定端口（默认 9999）
  bash tools/install.sh --host 0.0.0.0 允许别的设备连（默认只绑本机）
  bash tools/install.sh -h             显示这段帮助

环境变量：DGLAB_DIR 安装目录（默认 ~/dglab-mc）、DGLAB_REPO 仓库地址
USAGE
}

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
    case "$1" in
        --check)   DO_CHECK=1; DO_RUN=0; shift ;;
        --update)  DO_UPDATE=1; shift ;;
        --run|-r)  DO_RUN=1; shift ;;
        --port)
            [ $# -ge 2 ] || { usage >&2; die "--port 需要一个端口号，例如 --port 8888"; }
            PORT="$2"; shift 2 ;;
        --port=*)
            PORT="${1#--port=}"
            [ -n "$PORT" ] || { usage >&2; die "--port= 后面要有端口号"; }
            shift ;;
        --host)
            [ $# -ge 2 ] || { usage >&2; die "--host 需要一个地址，例如 --host 0.0.0.0"; }
            HOST="$2"; shift 2 ;;
        --host=*)
            HOST="${1#--host=}"
            [ -n "$HOST" ] || { usage >&2; die "--host= 后面要有地址"; }
            shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "未知参数：$1" ;;
    esac
done

case "${PORT:-}" in
    '' ) ;;
    *[!0-9]* ) die "端口只能是数字：$PORT" ;;
    * ) [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口超出范围：$PORT" ;;
esac

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

# 是不是在项目目录里直接跑的
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo '')"
IN_REPO=0
if [ -n "$SCRIPT_DIR" ]; then
    # install.sh 放在 tools/ 里，项目根是它的上一级（也兼容直接放在根目录的旧版）
    if [ -f "$SCRIPT_DIR/dglab-hp.js" ] && [ -d "$SCRIPT_DIR/tools" ]; then
        IN_REPO=1; DIR="$SCRIPT_DIR"
    elif [ -f "$SCRIPT_DIR/../dglab-hp.js" ] && [ -d "$SCRIPT_DIR/../tools" ]; then
        IN_REPO=1; DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    fi
fi

say ""
say "=== DG-LAB × 我的世界 · 安装程序 ==="
say "  运行环境 : $PLATFORM"
say "  安装目录 : $DIR"
if [ "$IN_REPO" = "1" ] || [ -d "$DIR/.git" ]; then
    say "  当前版本 : v$(ver_of "$DIR" 2>/dev/null || echo '?')（$(short_commit "$DIR")）"
fi
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
    have curl && ok "curl 已安装" || warn "没装 curl（只是命令行下载文件方便，安装本身不需要）"
    if [ "$IN_REPO" = "1" ]; then
        ok "就在项目目录里：$DIR"
    elif [ -d "$DIR/.git" ]; then
        ok "已有仓库：$DIR"
    else
        warn "还没有项目文件：$DIR（安装时会克隆）"
    fi
    [ -w "$BIN_DIR" ] && ok "可写目录：$BIN_DIR（能装 dglab 命令）" || warn "$BIN_DIR 不可写"
    say ""
    say "检查完毕。直接运行 bash tools/install.sh 即可安装。"
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
have git && ok "git 已就绪" || warn "没有 git（装完还能用，但没法 --update）"

# ---------------------------------------------------------------- 取代码
say ""
say "[2/4] 获取项目文件"
if [ "$IN_REPO" = "1" ]; then
    ok "用的就是当前目录：$DIR"
    if [ "$DO_UPDATE" = "1" ]; then
        update_repo "$DIR"
    else
        say "  想检查有没有新版：bash tools/install.sh --update"
    fi
elif [ -d "$DIR/.git" ]; then
    if have git; then
        if [ "$DO_UPDATE" = "1" ]; then
            update_repo "$DIR"
        else
            ok "已有仓库：$DIR（要检查更新加 --update）"
        fi
    else
        warn "已有仓库但没有 git，跳过更新：$DIR"
    fi
else
    have git || die "需要 git 才能下载，请先 pkg install -y git；也可以手动下载 ZIP 解压后，在该目录里运行 bash tools/install.sh"
    if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
        die "$DIR 已存在，而且不是本项目的 git 仓库。先把它改名或清空再装，例如：mv \"$DIR\" \"$DIR.old\""
    fi
    say "  从 $REPO 克隆到 $DIR …"
    if ! clone_err="$(git clone --depth 1 "$REPO" "$DIR" 2>&1)"; then
        say "$clone_err" >&2
        die "克隆失败。检查网络；或者手动下载 ZIP 解压后在该目录里运行 bash tools/install.sh"
    fi
    ok "已下载到 $DIR"
fi
[ -f "$DIR/tools/dglab-relay.js" ] || die "没找到 $DIR/tools/dglab-relay.js，项目不完整"

# ---------------------------------------------------------------- 装 dglab 命令
say ""
say "[3/4] 安装 dglab 命令"
WRAPPER="$BIN_DIR/dglab"
if [ ! -w "$BIN_DIR" ]; then
    warn "$BIN_DIR 不可写，跳过（手动启动：node $DIR/tools/dglab-relay.js --port 9999）"
elif [ -d "$WRAPPER" ]; then
    warn "$WRAPPER 是个目录，没动它（手动启动：node $DIR/tools/dglab-relay.js --port 9999）"
elif cat > "$WRAPPER" <<EOF
#!/usr/bin/env sh
# 由 install.sh 生成。项目被移动或改名后，重新跑一次 install.sh 即可。
DIR="$DIR"
if [ ! -f "\$DIR/tools/dglab-relay.js" ]; then
    echo "找不到 \$DIR/tools/dglab-relay.js（项目被移动或删除了？）" >&2
    echo "重新跑一次安装脚本即可修复：bash \$DIR/tools/install.sh" >&2
    exit 1
fi
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
exec node "\$DIR/tools/dglab-relay.js" "\$@"
EOF
then
    chmod +x "$WRAPPER" 2>/dev/null || warn "chmod +x $WRAPPER 失败，可能要用 sh $WRAPPER 启动"
    ok "已生成 $WRAPPER（以后敲 dglab 即可启动）"
    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) warn "$BIN_DIR 不在 PATH 里，可能要重开终端或手动加 PATH" ;;
    esac
else
    warn "写 $WRAPPER 失败（磁盘满或只读？），手动启动：node $DIR/tools/dglab-relay.js --port 9999"
fi

# ---------------------------------------------------------------- 完成
RUN_PORT="${PORT:-9999}"
SHOW_PORT=9999
[ "$DO_RUN" = "1" ] && SHOW_PORT="$RUN_PORT"

say ""
say "[4/4] 完成"
say ""
say "  ┌──────────────────────────────────────────────────────────┐"
say "  │ 装好了。接下来：                                          │"
say "  │ 1) 敲 dglab 启动中继（Ctrl+C 停止）                       │"
say "  │ 2) 把 dglab-hp.js 放进游戏的脚本目录                      │"
say "  │ 3) DG-LAB APP → Socket 控制 → 连接：                      │"
say "  │      ws://127.0.0.1:${SHOW_PORT}/mc-coyote                │"
say "  └──────────────────────────────────────────────────────────┘"
say ""
say "  游戏脚本这样拿（存到 /sdcard/Download/）："
say "    bash $DIR/tools/get-game-script.sh"
say ""
say "  其它：换端口 dglab --port 8888 ｜ 检查环境 bash tools/install.sh --check"
say "        更新版本 bash tools/install.sh --update（在 $DIR 里跑）"
say ""

if [ "$DO_RUN" = "0" ]; then
    if [ -n "$PORT" ]; then
        say "注意：--port $PORT 只在配合 --run 时生效；敲 dglab 启动时想换端口用：dglab --port $PORT"
        say ""
    fi
    say "现在敲 dglab 就能启动中继。"
    say ""
    exit 0
fi

if have termux-wake-lock; then
    termux-wake-lock 2>/dev/null && say "已申请 termux-wake-lock（防止后台被杀）"
fi

if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ]; then
    warn "监听 $HOST：同一个网络里的其他设备都能连到这个中继（无密码，别人可以控制你的设备）"
fi

say "启动中继：端口 ${RUN_PORT}，监听 ${HOST}（Ctrl+C 退出）…"
say ""
exec node "$DIR/tools/dglab-relay.js" --port "$RUN_PORT" --host "$HOST"
