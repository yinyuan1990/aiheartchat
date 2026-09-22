@echo off
chcp 65001 >nul
cd /d %~dp0
.venv\Scripts\python.exe publisher.py check
echo.
echo 按任意键关闭
pause >nul
