@echo off
REM 把 SRS 节点一键部署 GUI 打成单文件 exe（Windows）
REM 需要: python 3.11 + pip install paramiko pyinstaller
cd /d %~dp0
pyinstaller --noconfirm --clean --onefile --windowed --name "SRS-Node-Deploy" --add-data "srs-node-install.sh;." --hidden-import paramiko srs_deploy_gui.py
if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
copy /y srs-node-install.sh dist\srs-node-install.sh >nul
echo.
echo OUTPUT: %~dp0dist\SRS-Node-Deploy.exe   (exe 旁边放一份 srs-node-install.sh 可覆盖内置脚本，改脚本不用重新打包)
