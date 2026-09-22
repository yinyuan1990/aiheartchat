@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开知乎登录窗口，扫码或手机号登录都行，登录成功后窗口会自动关…
.venv\Scripts\python.exe publisher.py login zhihu
echo.
echo 完成，按任意键关闭
pause >nul
