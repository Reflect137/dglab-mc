#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-waveforms.py —— 从 dglab-kit 源码里抽取郊狼波形数据，注入 dglab-hp.js。

脚本里用下面这两个标记圈出波形数据的位置，本工具只替换标记之间的内容，
所以可以反复运行（不会越改越乱）：

    /*__WAVEFORMS_BEGIN__*/
    var WAVEFORM_DATA = { ... };
    /*__WAVEFORMS_END__*/

用法：
    python3 tools/build-waveforms.py <dglab-kit 源码目录> <dglab-hp.js>

例如：
    python3 tools/build-waveforms.py ../../_extract/kit/dglab-kit-main dglab-hp.js

抽取出来的波形数据版权归 dglab-kit 项目所有（GPL-3.0）。
"""
import json
import os
import re
import sys

# 要打包进脚本的波形（顺序即游戏面板里的顺序）
WANTED = [
    "EXTRUSTION",  # 挤压
    "BUBBLE",      # 气泡
    "RHYTHM",      # 律动
    "AIR_WAVES",   # 电波
    "CLIMB",       # 攀登
    "SHADE",       # 树荫
    "PULSE",       # 脉冲
    "BREATHING",   # 呼吸
    "TIDE",        # 潮汐
    "PULSATING",   # 连击
    "HEARTBEAT",   # 心跳节奏
]

BEGIN = "/*__WAVEFORMS_BEGIN__*/"
END = "/*__WAVEFORMS_END__*/"
BLOCK_RE = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.S)


def parse_coyote(path):
    src = open(path, encoding="utf-8").read()
    out = {}
    blocks = re.split(r"\[COYOTE_WAVEFORM\.(\w+)\]:", src)
    for i in range(1, len(blocks), 2):
        name, body = blocks[i], blocks[i + 1]
        cn = re.search(r"cn:\s*['\"]([^'\"]+)", body)
        raw = re.search(r"raw:\s*(\[.*?\])", body, re.S)
        if not raw:
            continue
        frames = re.findall(r"'([0-9A-Fa-f]{16})'", raw.group(1))
        out[name] = {"cn": cn.group(1) if cn else name, "frames": [f.upper() for f in frames]}
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    kit_dir, target = sys.argv[1], sys.argv[2]
    coyote = os.path.join(kit_dir, "src", "waveform", "coyote.ts")
    if not os.path.isfile(coyote):
        print("找不到 %s" % coyote)
        return 2

    presets = parse_coyote(coyote)
    data = {}
    for name in WANTED:
        if name not in presets:
            print("!! 找不到波形 %s" % name)
            continue
        data[name] = presets[name]
    print("打包波形 %d 个，共 %d 帧" % (len(data), sum(len(v["frames"]) for v in data.values())))

    js = open(target, encoding="utf-8").read()
    if not BLOCK_RE.search(js):
        print("!! 目标文件里没有 %s ... %s 标记" % (BEGIN, END))
        return 1

    body = json.dumps(data, ensure_ascii=False, indent=4)
    body = "\n".join("    " + line for line in body.split("\n"))
    block = BEGIN + "\nvar WAVEFORM_DATA = " + body.lstrip() + ";\n" + END
    js = BLOCK_RE.sub(lambda _m: block, js, count=1)
    open(target, "w", encoding="utf-8").write(js)
    print("已写入 %s（%d 字节）" % (target, len(js.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
