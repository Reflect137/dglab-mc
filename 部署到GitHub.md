# 部署到 GitHub（Termux 全程操作）

> 目标：把 `dglab-mc` 这个项目推到你自己的 GitHub 仓库。
> 全程在 Termux 里敲命令，不需要电脑。

---

## 0. 先装 git 并设置身份（只做一次）

```bash
pkg install git
git config --global user.name "你的名字"
git config --global user.email "你的邮箱@example.com"
git config --global init.defaultBranch main
```

> 名字和邮箱会写进每次提交记录，随便填也行，但建议用你 GitHub 的邮箱。

---

## 1. 本地建仓

直接在项目目录里建（推荐，省得两头同步）：

```bash
cd /sdcard/MT/work/dg-lab/dglab-mc
git init
git config core.fileMode false      # /sdcard 是 FUSE 文件系统，关掉权限位检查，不然会一直显示改动
git add -A
git commit -m "DG-LAB × 我的世界：掉血加电脚本 + 本地 V3 中继"
```

看看提交成功了没：

```bash
git log --oneline
git status
```

`git status` 应该显示 `nothing to commit, working tree clean`（有个 `.gitignore` 已经把日志之类的排除了）。

> 如果 `/sdcard` 上 git 跑得特别慢或者报奇怪的错，就换成在 Termux 家目录建仓：
> ```bash
> cp -r /sdcard/MT/work/dg-lab/dglab-mc ~/dglab-mc && cd ~/dglab-mc && git init && git add -A && git commit -m "init"
> ```
> 以后改完文件，先 `cp` 回来再提交（`cp /sdcard/MT/work/dg-lab/dglab-mc/dglab-hp.js ~/dglab-mc/`）。

---

## 2. 在 GitHub 上建仓库

手机浏览器打开 https://github.com/new ，填：

| 项 | 填什么 |
|---|---|
| Repository name | `dglab-mc`（或你喜欢的名字） |
| Description | `《我的世界》掉血加电脚本 + DG-LAB V3 本地中继` |
| 公开/私有 | 想给别人用就 **Public**；只是自己用就 **Private** |
| Initialize this repository with | **全都不要勾**（README / .gitignore / license 我们本地都有了，勾了会冲突） |

点 **Create repository**，然后页面会显示仓库地址，形如：

```text
https://github.com/你的用户名/dglab-mc.git
```

---

## 3. 推送上去（三选一）

### 方式 A：HTTPS + 令牌（最直白）

GitHub **不接受账号密码**了，必须用 Personal Access Token（PAT）：

1. 浏览器打开 https://github.com/settings/tokens → **Generate new token (classic)**
2. Note 随便写（例如 `termux`），Expiration 选 90 天或 No expiration
3. 勾选 **repo** 这一项（要传私有仓库就必须勾）
4. 生成后**立刻复制**那串 `ghp_...`（页面关掉就再也看不到）

然后回到 Termux：

```bash
cd /sdcard/MT/work/dg-lab/dglab-mc
git remote add origin https://github.com/你的用户名/dglab-mc.git
git push -u origin main
```

提示输入时：
- `Username:` → 你的 GitHub 用户名
- `Password:` → **粘贴刚复制的 token**（输入时不显示任何字符，正常）

> 想省得每次输，可以记住：
> ```bash
> git config --global credential.helper store
> ```
> 第一次输入后就会存到 `~/.git-credentials`（明文，自己权衡）。

### 方式 B：gh 命令行（最省事）

```bash
pkg install gh
gh auth login          # 选 GitHub.com → HTTPS → 用浏览器登录，复制一次 8 位设备码即可
cd /sdcard/MT/work/dg-lab/dglab-mc
gh repo create dglab-mc --public --source=. --remote=origin --push
```

一条命令就把仓库建好并推上去了。

### 方式 C：SSH 密钥

```bash
pkg install openssh
ssh-keygen -t ed25519 -C "你的邮箱@example.com"     # 一路回车
cat ~/.ssh/id_ed25519.pub
```

把输出的整行贴到 https://github.com/settings/keys → **New SSH key**，然后：

```bash
cd /sdcard/MT/work/dg-lab/dglab-mc
git remote add origin git@github.com:你的用户名/dglab-mc.git
git push -u origin main
```

---

## 4. 以后更新（改完脚本重新推）

```bash
cd /sdcard/MT/work/dg-lab/dglab-mc
git add -A
git commit -m "调整参数：满血清电 + 双路独立波形"
git push
```

只想推一个文件也行：

```bash
git add dglab-hp.js && git commit -m "修 bug" && git push
```

查看改了哪些文件：`git status` / `git diff`。

---

## 5. 建议顺手做的几件事

1. **确认 License 对**：项目里已经放了 `LICENSE`（GPL-3.0）。因为内置波形数据来自 [dglab-kit](https://github.com/dungeonlab-open/dglab-kit)（GPL-3.0），所以整个仓库必须也是 GPL-3.0，别改成 MIT。
2. **仓库描述和话题**：仓库页面右上角 ⚙️ → Description 填一句话，Topics 加
   `dglab`、`coyote`、`minecraft`、`websocket`、`termux`、`netease`。
3. **不要提交令牌**：任何 `ghp_...`、私钥、`~/.git-credentials` 都别放进仓库。
4. **不要把 `/sdcard` 上的私人东西一起推**：只在这个项目目录里 `git init`，别在 `MT/work` 根目录建仓。
5. 想放截图的话，新建 `docs/` 目录塞图片，README 里用
   `![面板](docs/panel.png)` 引用。

---

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `remote origin already exists` | `git remote set-url origin <新地址>` |
| `failed to push some refs` / `rejected` | 远端有本地没有的提交，先 `git pull --rebase origin main` 再 push |
| `Support for password authentication was removed` | 你输的是账号密码，改成 PAT（方式 A） |
| `fatal: not a git repository` | 当前目录不对，`cd` 回项目目录 |
| 每次 `git status` 都显示文件被改动（但内容没变） | `git config core.fileMode false`（FUSE 权限位问题） |
| 中文文件名显示成转义（`\344\275\277...`） | `git config --global core.quotepath false` |
| 想改仓库可见性 | GitHub 仓库页 → Settings → 最下面 Danger Zone → Change visibility |

---

## 7. 推完之后别人怎么用

README 里已经写清了「Termux 起中继 → 脚本进游戏 → APP 连地址」，别人克隆下来就能跑：

```bash
pkg install nodejs git
git clone https://github.com/你的用户名/dglab-mc.git
cd dglab-mc && node tools/dglab-relay.js --port 9999
```

脚本文件是 `dglab-hp.js`，测试是 `npm test`（203 项 + 压力测试，约 42 秒跑完，零依赖）。
