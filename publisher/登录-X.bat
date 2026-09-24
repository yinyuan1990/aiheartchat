@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开 X 登录窗口（要走国外出口），用账号密码或 Google 登录，登录成功后窗口会自动关闭
.venv\Scripts\python.exe publisher.py login x
echo.
echo 完成，按任意键关闭
pause >nul
