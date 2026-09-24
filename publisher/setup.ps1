# 发布机一键安装（Windows PowerShell，在 publisher 目录下运行：powershell -ExecutionPolicy Bypass -File setup.ps1）
# 1) 克隆 social-auto-upload 到 vendor/  2) 建 .venv 并安装  3) 装 patchright Chromium  4) 生成 config.json（要手填 token）
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path vendor)) { New-Item -ItemType Directory vendor | Out-Null }
if (-not (Test-Path vendor\social-auto-upload\sau_cli.py)) {
  Write-Host '>> 克隆 social-auto-upload…'
  git clone --depth 1 https://github.com/dreammis/social-auto-upload.git vendor\social-auto-upload
} else {
  Write-Host '>> vendor/social-auto-upload 已存在，跳过克隆（要更新：cd vendor\social-auto-upload; git pull）'
}
if (-not (Test-Path vendor\social-auto-upload\conf.py)) {
  Copy-Item vendor\social-auto-upload\conf.example.py vendor\social-auto-upload\conf.py
}
# 我们对上游的补丁（vendor 不进 git，改动放 patches/ 里，安装时覆盖过去）：
#   douyin_uploader_main.py → 抖音图文页标题 / 正文框多选择器 + 找不到时截图和输入框列表
Write-Host '>> 应用本地补丁…'
Copy-Item patches\douyin_uploader_main.py vendor\social-auto-upload\uploader\douyin_uploader\main.py -Force
Copy-Item patches\youtube_uploader_main.py vendor\social-auto-upload\uploader\youtube_uploader\main.py -Force

if (-not (Test-Path .venv\Scripts\python.exe)) {
  Write-Host '>> 创建虚拟环境 .venv（Python 3.10~3.12）…'
  if (Get-Command py -ErrorAction SilentlyContinue) { py -3.11 -m venv .venv } else { python -m venv .venv }
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

Write-Host '>> 安装依赖（social-auto-upload + requests）…'
& $python -m pip install -q --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
& $python -m pip install -q -e .\vendor\social-auto-upload -i https://pypi.tuna.tsinghua.edu.cn/simple
# 上游个别 uploader 还 import 的是 playwright（不是 patchright），一并装上，不然 sau 启动就报 ModuleNotFoundError
& $python -m pip install -q requests playwright -i https://pypi.tuna.tsinghua.edu.cn/simple
# 视频任务（快手 / 视频号）：edge-tts 配音、imageio-ffmpeg 自带 ffmpeg、pillow 处理图片
& $python -m pip install -q edge-tts imageio-ffmpeg pillow -i https://pypi.tuna.tsinghua.edu.cn/simple

# 离线内核：如果 publisher\browsers\ 里放了从别的机器拷来的 chromium-1208 / chromium_headless_shell-1208 等目录，先复制到 ms-playwright，下面就不用下载 170MB+
$pwHome = Join-Path $env:LOCALAPPDATA 'ms-playwright'
if (Test-Path browsers) {
  New-Item -ItemType Directory -Force $pwHome | Out-Null
  Get-ChildItem browsers -Directory | ForEach-Object {
    if (-not (Test-Path (Join-Path $pwHome $_.Name))) {
      Write-Host ">> 复制离线浏览器内核 $($_.Name)…"
      Copy-Item $_.FullName $pwHome -Recurse
    }
  }
}

Write-Host '>> 安装 patchright Chromium（本机已有就跳过；否则先试 npmmirror 镜像，再直连）…'
$env:PLAYWRIGHT_DOWNLOAD_HOST = 'https://npmmirror.com/mirrors/playwright'
& $python -m patchright install chromium
if ($LASTEXITCODE -ne 0) {
  Remove-Item Env:PLAYWRIGHT_DOWNLOAD_HOST -ErrorAction SilentlyContinue
  & $python -m patchright install chromium
}

if (-not (Test-Path config.json)) {
  Copy-Item config.example.json config.json
  Write-Host ''
  Write-Host '>> 已生成 config.json，请打开它把后台「内容分发」页的发布机 token 填进去。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '安装完成。接下来：' -ForegroundColor Green
Write-Host '  .venv\Scripts\python publisher.py card                 # 先看卡片图效果（cards\sample-1.png）'
Write-Host '  .venv\Scripts\python publisher.py login xiaohongshu    # 依次登录 xiaohongshu / douyin / kuaishou / zhihu'
Write-Host '  .venv\Scripts\python publisher.py check                # 检查并上报登录状态'
Write-Host '  .venv\Scripts\python publisher.py run                  # 常驻运行（或运行 install-task.ps1 注册开机自启）'
