# 把 publisher_gui.py 打成 发布机.exe（同目录双击用）。exe 本身不带浏览器和依赖，运行时调用同目录的 .venv 和 publisher.py。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$python = '.venv\Scripts\python.exe'
& $python -m pip install -q pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple
& $python -m PyInstaller --noconfirm --onefile --noconsole --name 发布机 --distpath . --workpath build --specpath build publisher_gui.py
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
Write-Host '已生成 发布机.exe' -ForegroundColor Green
