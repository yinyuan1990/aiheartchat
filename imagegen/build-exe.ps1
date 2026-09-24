# 把 imagegen_gui.py 打成 AI生图.exe（自带 requests / Pillow，双击即用）。借用 publisher 的 .venv 打包。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$python = '..\publisher\.venv\Scripts\python.exe'
& $python -m pip install -q pyinstaller pillow requests -i https://pypi.tuna.tsinghua.edu.cn/simple
& $python -m PyInstaller --noconfirm --onefile --noconsole --name AI生图 --distpath . --workpath build --specpath build imagegen_gui.py
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
Write-Host '已生成 AI生图.exe' -ForegroundColor Green
