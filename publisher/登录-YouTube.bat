@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开 YouTube 登录窗口（Chrome，要走国外出口），登录 Google 账号，进到频道页后会自动保存并关闭
.venv\Scripts\python.exe publisher.py login youtube
echo.
echo 完成，按任意键关闭
pause >nul
