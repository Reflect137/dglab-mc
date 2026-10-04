# 《我的世界》× DG-LAB

游戏里掉血就给郊狼加电。

## 装

先装 Termux。去[GitHub Releases](https://github.com/termux/termux-app/releases) 里安装带 `universal` 的那个 apk。

打开 Termux，粘这一行：

```bash
pkg update -y && pkg install -y curl && bash <(curl -fsSL https://cdn.jsdelivr.net/gh/Reflect137/dglab-mc@main/install.sh)
```

这条走的是 jsDelivr 镜像（`raw.githubusercontent.com` 在国内经常连不上）。拉不动就换下面 git 那条：

```bash
pkg update -y && pkg install -y git nodejs && git clone --depth 1 https://github.com/Reflect137/dglab-mc ~/dglab-mc && bash ~/dglab-mc/install.sh
```

不想用命令行的，直接下 [整个项目 ZIP](https://github.com/Reflect137/dglab-mc/archive/refs/heads/main.zip) 解压，进目录跑 `bash install.sh`。

装完就有个 `dglab` 命令，以后启动键盘上敲这一个词就行。换端口 `dglab --port 8888`。

## 用

1. 郊狼主机和电极接好，手机开 DG-LAB APP
2. Termux里输入`dglab`
3. 把 `dglab-hp.js` 放进跑路的脚本目录，进入游戏并执行脚本
4. APP 里进 Socket 控制，地址填 `ws://127.0.0.1:9999/mc-coyote`

配对成功游戏里会弹一条消息，之后挨打就有电了。

脚本不想自己找，可以：

```bash
bash ~/dglab-mc/tools/get-game-script.sh      # 存到 /sdcard/Download/
```

或者手机浏览器打开 <https://cdn.jsdelivr.net/gh/Reflect137/dglab-mc@main/dglab-hp.js> 另存为。

## 调参数

全在游戏里那个 **DG-LAB** 面板上，滑条和勾选框直接拖，改完自动存。常用的几个：

| 想干嘛 | 改哪个 |
|---|---|
| 电太狠 | 每点伤害加电调小、强度上限调小 |
| 电太弱 | 每点伤害加电调大，或者把基础强度设个 5 |
| 小伤不想被电 | 最小伤害设 2（一颗心以下不算） |
| 死了不想拉满 | 死亡处理改成「立即归零」 |
| 挨打后想有几秒反应时间 | 受伤后延迟加电设 1 秒 |
| 快死了别电了 | 低于血量就停设 6 |
| 左右两路一起电 | 控制通道选双路 A+B，右路倍率 0.5 就是一半 |
| 波形太急/太缓 | 波形快慢，0.5 到 2 |
| 面板太长碍事 | 面板只显示常用打开，或者开屏幕状态条 |

面板上有 78 项，剩下那些基本不用动。聊天指令默认是关的（面板里「接管聊天指令」打开后才认 `!dg` 打头的消息）。

## 出问题

| 现象 | 先看这个 |
|---|---|
| 游戏里说没连上中继 | Termux 那个窗口还开着吗，面板上「中继地址」跟启动时的端口一致吗 |
| APP 连不上 | 地址要跟面板上「设备连接地址」一字不差，先浏览器开 `http://127.0.0.1:9999/__status` 看中继活着没 |
| 能连上但没感觉 | 电极插好没；把基础强度临时调到 8 试试；确认「受伤出波形」是开的 |
| 满血了电量还不是 0 | 面板上有行「上次加电」，看是什么时候加的；挨打到半血是正常的，满血会自动清 |
| 点归零又被加回来 | 面板会显示「归零静默中」，静默期内挨打不加电；想彻底停手就点暂停 |
| 太疼 | 先把每点伤害加电改成 1、强度上限改成 10 |

中继那边的日志能看出配对情况：脚本连上是 `新 WebSocket 连接：mc-coyote`，APP 连上是 `新 WebSocket 连接：<一串id>，目标：mc-coyote`，配好是 `配对成功`。

## 说明

- 中继是自己重写的 DG-LAB V3 服务端，纯 Node 零依赖，行为跟官方 `wss://ws.dungeon-lab.cn/` 比对过，强度、波形、回执格式都对得上。所以把地址换成官方那条也能用。
- 内置的 11 组波形数据来自 [dglab-kit](https://github.com/dungeonlab-open/dglab-kit)，所以这个项目跟着用 GPL-3.0。
- 只有一台手机的话，中继、游戏、APP 都在本机，走 127.0.0.1，不用联网。
- 先小后大。第一次把每点伤害加电设 1、强度上限设 10 试手感。电极别贴心脏、脖子、头部。

## 改代码的话

两处协议坑记一下：强度指令的 `message` 不能以 `strength` 开头（中继会当成 APP 回传直接透传，官方 SDK 用的是 `set channel`）；波形包前缀是通道字母 `pulse-A:`，而强度和清除用的是通道号 `strength-1+2+20`、`clear-1`。


