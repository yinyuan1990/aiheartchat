@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开小红书登录窗口，请用手机小红书 App 扫码…
.venv\Scripts\python.exe publisher.py login xiaohongshu
echo.
echo 完成，按任意键关闭
pause >nul
