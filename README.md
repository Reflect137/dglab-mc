# 《我的世界》× DG-LAB

游戏里掉血就给郊狼加电。

## 装

先装 Termux：去 [F-Droid](https://f-droid.org/) 搜 Termux，或者下 [GitHub Releases](https://github.com/termux/termux-app/releases) 里带 `universal` 的 apk。应用商店里那个是停更旧版。

打开 Termux，粘这一行：

```bash
pkg update -y && pkg install -y git nodejs && (git -C ~/dglab-mc pull --ff-only 2>/dev/null || git clone --depth 1 https://github.com/Reflect137/dglab-mc ~/dglab-mc) && bash ~/dglab-mc/tools/install.sh
```

装完敲 `dglab` 启动中继。

## 用

1. 手机装 DG-LAB APP，**3.0 以上**才有 Socket 控制
2. Termux 里敲 `dglab` 启动中继，窗口别关
3. 把 `dglab-hp.js` 放进游戏的脚本目录，进游戏执行脚本
4. APP → Socket 控制 → 地址填 `ws://127.0.0.1:9999/mc-coyote`
5. APP 里打开`总开关`、关掉`屏蔽输出`

配对成功游戏里会弹一条消息，然后你就可以使用此项目了

脚本这样获取：

```bash
bash ~/dglab-mc/tools/get-game-script.sh
```

执行后脚本会下载到/sdcard/Download/，自行复制到跑路脚本目录里

## 更新

把「装」那一行**再粘一次**就是更新，或者用这条短的：

```bash
bash ~/dglab-mc/tools/install.sh --update
```

它会直接告诉你结果，不用自己比对：

```text
✅ 已经是最新版 v1.1.0（ec57846）
✅ 更新完成：v1.0.0（17cc456） → v1.1.0（f25180f）
```

更新完自己敲 `dglab` 启动（装完不会自动启动）。游戏脚本也要一起换新，不然新功能用不上：

```bash
bash ~/dglab-mc/tools/get-game-script.sh
```

想随时看自己装的是哪版：`dglab --version`

## 调参数

全在游戏里的 **DG-LAB** 面板上，拖完自动存。常改的：

| 想干嘛 | 改哪个 |
|---|---|
| 电太狠 / 太弱 | 每点伤害加电、强度上限、基础强度 |
| 小伤不想被电 | 最小伤害设 2 |
| 死了不想拉满 | 死亡处理改成「立即归零」 |
| 死亡拉满后想慢慢回落 | 复活后回落秒数设 3~8 |
| 挨打后想有几秒反应时间 | 受伤后延迟加电设 1 秒 |
| 快死了别电了 | 低于血量就停设 6 |
| 左右两路一起电 | 控制通道选双路 A+B |
| 波形太急/太缓、想自己换 | 波形快慢、波形轮换 |
| 想在屏幕上看到数值 | 屏幕提示电量打开 |
| 面板太长碍事 | 面板只显示常用打开 |

## 出问题

| 现象 | 先看这个 |
|---|---|
| 脚本像没生效（啥都没变） | 进世界时聊天栏应该弹「已加载 v…」；没有就是没加载上（文件没放对/复制不完整）。有报错就敲 `!dg errors` 看 |
| 游戏里说没连上中继 | Termux 那个窗口还开着吗 |
| APP 连不上 | 地址跟面板上「设备连接地址」一字不差吗 |
| 连上了没感觉 | 电极插好没；基础强度调到 8 试试 |
| 满血了电量还不是 0 | 面板「上次加电」看是什么时候加的；满血会自动清 |
| 点归零又被加回来 | 静默期内挨打不加电；想彻底停手点暂停 |
| 太疼 | 每点伤害加电改 1、强度上限改 10 |
| 面板只剩几项 / 整个不见了 | 点「显示全部设置」；整个关了就聊天栏敲 `!dg panel` |

排查用 `dglab --verbose` 启动，能看到每条协议消息。
