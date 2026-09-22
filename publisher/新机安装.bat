@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d %~dp0
title 心之音发布机 - 新机一键安装

echo ==========================================
echo  心之音发布机 · 新电脑一键安装
echo  会自动：装 Python 3.11 → 装 Git → 建运行环境 → 下载浏览器内核 → 注册开机自启
echo ==========================================
echo.

set "PYDIR=%LOCALAPPDATA%\Programs\Python\Python311"
set "PYEXE=%PYDIR%\python.exe"
set "GITEXE=%ProgramFiles%\Git\cmd\git.exe"
set "DL=%TEMP%\peiwan-setup"
if not exist "%DL%" mkdir "%DL%"

:: ---------- Python 3.11 ----------
if exist "%PYEXE%" goto :py_ok
where py >nul 2>nul && (py -3.11 -c "print(1)" >nul 2>nul && goto :py_ok)
echo [1/4] 下载 Python 3.11.9（约 25MB，先试华为云镜像，不行走官网）…
curl -L -o "%DL%\python-3.11.9-amd64.exe" --connect-timeout 20 "https://mirrors.huaweicloud.com/python/3.11.9/python-3.11.9-amd64.exe"
if not exist "%DL%\python-3.11.9-amd64.exe" curl -L -o "%DL%\python-3.11.9-amd64.exe" "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
if not exist "%DL%\python-3.11.9-amd64.exe" (
  echo Python 下载失败，请检查网络后重试。
  pause & exit /b 1
)
echo       静默安装 Python（当前用户，加入 PATH）…
"%DL%\python-3.11.9-amd64.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_launcher=1
if not exist "%PYEXE%" (
  echo Python 安装失败，请手动运行 %DL%\python-3.11.9-amd64.exe 安装后再运行本脚本。
  pause & exit /b 1
)
:py_ok
if exist "%PYEXE%" set "PATH=%PYDIR%;%PYDIR%\Scripts;%PATH%"
echo [1/4] Python 3.11 就绪
echo.

:: ---------- Git（可选：只用于以后更新 vendor；zip 里已带 vendor，装不上也不影响） ----------
if exist "%GITEXE%" goto :git_ok
where git >nul 2>nul && goto :git_ok
echo [2/4] 下载 Git for Windows（约 65MB，npmmirror 镜像）…
curl -L -o "%DL%\git-setup.exe" --connect-timeout 20 "https://registry.npmmirror.com/-/binary/git-for-windows/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
if exist "%DL%\git-setup.exe" (
  echo       静默安装 Git…
  "%DL%\git-setup.exe" /VERYSILENT /NORESTART /NOCANCEL /SP- /COMPONENTS="" 
) else (
  echo       Git 下载失败，跳过（不影响运行）。
)
:git_ok
if exist "%GITEXE%" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
echo [2/4] Git 处理完毕
echo.

:: ---------- 运行环境 ----------
echo [3/4] 建运行环境（重建 .venv、装依赖、下载浏览器内核，几分钟）…
if exist ".venv" rmdir /s /q ".venv"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if not exist ".venv\Scripts\python.exe" (
  echo 运行环境没建起来，把上面的报错发给开发者。
  pause & exit /b 1
)
echo.

:: ---------- 自启 ----------
findstr /C:"填这里" config.json >nul 2>nul && (
  echo config.json 里的 token 还没填：把老电脑的 config.json 拷过来覆盖，或打开 config.json 把后台「内容分发」页的 token 填进去，然后重新运行本脚本。
  pause & exit /b 1
)
echo [4/4] 注册开机自启并启动发布机…
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1"
echo.
echo ==========================================
echo  安装完成。接下来双击「发布机.exe」，四个平台点「登录」扫码。
echo  记得：电源设置里睡眠改「从不」；这台电脑别开 VPN。
echo ==========================================
pause
