@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开快手创作者后台登录窗口，请用手机快手 App 扫码…
.venv\Scripts\python.exe publisher.py login kuaishou
echo.
echo 完成，按任意键关闭
pause >nul
