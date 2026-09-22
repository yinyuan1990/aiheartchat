# 发布机（内容分发 · 推广）

跑在操作者本机 Windows 上：轮询后台领「树洞新帖 → AI 改写好的文案」，本地渲染卡片图，用真实浏览器 + 扫码 cookie 发到小红书 / 抖音 / 快手（走 [social-auto-upload](https://github.com/dreammis/social-auto-upload) 的 `sau` CLI）和知乎「想法」（自写 `zhihu.py`），结果回写后台。规则 / 队列 / AI 改写在后端 `houduan/src/publish/`，后台页「内容分发（推广）」。

## 首次安装（已在本机做过）

```powershell
cd E:\soft\aichat\aiheartchat\publisher
powershell -ExecutionPolicy Bypass -File setup.ps1     # 克隆 vendor、建 .venv、装依赖和 Chromium、生成 config.json
# 打开 config.json，把后台「内容分发」页里的发布机 token 填进去
powershell -ExecutionPolicy Bypass -File install-task.ps1   # 注册登录自启（pythonw 后台跑，无窗口），并立刻启动
```

## 日常操作：双击 `发布机.exe`

小窗口里有：后台发布任务 启动 / 停止 / 重启、四个平台「登录」按钮（弹浏览器扫码）、检查登录状态、token 编辑、看卡片样式、日志实时滚动、打开后台网页。
exe 由 `build-exe.ps1` 从 `publisher_gui.py` 打包（PyInstaller onefile，不进 git；改了 GUI 重新跑一次脚本）。它不带依赖，运行时调用同目录的 `.venv` 和 `publisher.py`。
也可以双击 `登录-xx.bat` / `检查登录状态.bat`。

## 日常命令（在 publisher 目录）

```powershell
.venv\Scripts\python publisher.py login xiaohongshu   # 弹浏览器，用小红书 App 扫码；douyin / kuaishou / zhihu 同理
.venv\Scripts\python publisher.py check               # 检查四个平台登录状态并上报后台
.venv\Scripts\python publisher.py card                # 渲染一张示例卡片到 cards\sample-1.png 看样式
.venv\Scripts\python publisher.py run                 # 前台跑一个实例（调试用；平时由计划任务后台跑）
```

- 计划任务：`Get-ScheduledTask PeiwanPublisher` 看状态；`Stop-ScheduledTask` / `Start-ScheduledTask` 停 / 起；改了代码要重启一次。
- 日志 `logs\publisher.log`；知乎发布失败会在 `logs\` 留截图。
- 某平台在后台显示「未登录 / 失效」→ 重新 `login 该平台`，发布机每 3 分钟会自动重新检查没登录的平台，不用重启。
- 电脑要常开：电源设置里睡眠改「从不」。

## VPN / 出口 IP

发布机每次领任务前先查出口 IP（ip-api.com，走系统代理所以 VPN 开着就测得出来）；**不在中国大陆就不领任务**，日志和后台「内容分发」页都会标「国外（VPN？已停发）」。
本机开着 TUN / 全局模式的 VPN 时浏览器加 `--no-proxy-server` 也绕不开（实测仍是德国 IP），所以要么发布时关 VPN / 把 VPN 切成规则模式让国内直连，要么把发布机放到没有 VPN 的电脑上。

## 换到另一台电脑

1. 整个 `publisher` 文件夹打 zip 拷过去（**`.venv` 不用带**，里面写死了旧机器的 Python 路径；`vendor`、`profiles`、`config.json`、`发布机.exe` 都带上）。
2. 新机器上双击 **`新机安装.bat`**：自动下载安装 Python 3.11 和 Git（静默）→ 重建 `.venv`、装依赖、下载浏览器内核 → 注册开机自启并启动。全程不用敲命令。
3. 双击 `发布机.exe`，四个平台点「登录」扫码（抖音 / 快手 / 小红书的登录态不跟着走，知乎的在 `profiles` 里可能还有效）。
4. 旧电脑这边：`Stop-ScheduledTask PeiwanPublisher; Unregister-ScheduledTask PeiwanPublisher -Confirm:$false`，两台同时跑会抢任务（不会重复发，但登录状态会互相覆盖）。

## 结构

- `publisher.py` 主程序（领任务 / 心跳 / 发布 / 登录 / 检查）
- `card.py` 文案 → 3:4 卡片图（长文自动拆成多张）
- `zhihu.py` 知乎「想法」适配器（持久化浏览器目录 `profiles/zhihu`）
- `vendor/social-auto-upload` 上游项目（gitignore，setup 时克隆；更新：`cd vendor\social-auto-upload; git pull`）
- 抖音 / 快手 / 小红书的 cookie 在 `vendor/social-auto-upload/cookies/<平台>_main.json`
