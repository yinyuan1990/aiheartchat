@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开 TikTok 登录窗口（固定走 v2rayN 127.0.0.1:10808 美国住宅 IP，v2rayN 要开着），登录成功后窗口会自动关闭
.venv\Scripts\python.exe publisher.py login tiktok
echo.
echo 完成，按任意键关闭
pause >nul
