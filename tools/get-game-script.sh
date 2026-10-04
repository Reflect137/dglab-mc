#!/usr/bin/env bash
# ============================================================================
#  get-game-script.sh —— 把游戏脚本 dglab-hp.js 下载/复制到手机存储
#
#  用法：
#      bash tools/get-game-script.sh                 # 存到 /sdcard/Download/
#      bash tools/get-game-script.sh /sdcard/某某/   # 存到指定目录
#      bash tools/get-game-script.sh /sdcard/x.js    # 存成指定文件名
#
#  存好之后：把它放进游戏的脚本目录（和 TimeUnity.js / zuoai_目标框*.js 一起），
#  重进世界或用你的加载器加载即可。
# ============================================================================
set -u

URL="https://cdn.jsdelivr.net/gh/Reflect137/dglab-mc@main/dglab-hp.js"
HERE="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || echo .)"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
    if [ -d /sdcard/Download ]; then
        TARGET="/sdcard/Download/dglab-hp.js"
    elif [ -d /sdcard ]; then
        TARGET="/sdcard/dglab-hp.js"
    else
        echo "找不到 /sdcard —— Termux 还没有存储权限。" >&2
        echo "先在 Termux 里执行一次： termux-setup-storage （弹窗点允许），再重跑这个脚本。" >&2
        echo "或者手动指定保存位置，例如： bash tools/get-game-script.sh /某个目录/" >&2
        exit 1
    fi
elif [ -d "$TARGET" ]; then
    TARGET="${TARGET%/}/dglab-hp.js"
fi

# 优先用仓库里已有的那份（版本一定一致），没有就联网下载
SRC_FILE="$HERE/dglab-hp.js"
if [ -f "$SRC_FILE" ] && [ "$(cd "$(dirname "$SRC_FILE")" && pwd)/$(basename "$SRC_FILE")" = "$(cd "$(dirname "$TARGET")" 2>/dev/null && pwd || echo '')/$(basename "$TARGET")" ]; then
    echo "脚本本来就在这个位置，没有复制：$TARGET"
    SRC="本地仓库（原地）"
elif [ -f "$SRC_FILE" ]; then
    cp "$SRC_FILE" "$TARGET" || { echo "复制失败：$TARGET"; exit 1; }
    SRC="本地仓库"
else
    if ! command -v curl >/dev/null 2>&1; then
        echo "没有 curl，也没找到本地脚本；请先 pkg install -y curl" >&2
        exit 1
    fi
    curl -fsSL "$URL" -o "$TARGET" || { echo "下载失败（检查网络）"; exit 1; }
    SRC="GitHub"
fi

SIZE="$(wc -c < "$TARGET" 2>/dev/null | tr -d ' ')"
echo "已保存（$SRC）：$TARGET（${SIZE:-?} 字节）"
echo
echo "下一步："
echo "  1) 打开文件管理器，把 dglab-hp.js 放进游戏的脚本目录"
echo "     （和 TimeUnity.js / zuoai_目标框*.js 放在一起）"
echo "  2) 重进游戏世界。面板「配对信息」按钮里能看到 APP 该连的地址"
