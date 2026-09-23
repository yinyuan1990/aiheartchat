@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开视频号助手登录窗口，请用手机微信扫码…
.venv\Scripts\python.exe publisher.py login shipinhao
echo.
echo 完成，按任意键关闭
pause >nul
