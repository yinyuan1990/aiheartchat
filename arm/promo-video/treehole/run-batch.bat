@echo off
chcp 65001 >nul
rem 双击：把树洞里还没做过的新帖都出成「情感密码」短片（out\th-编号.mp4），不用 AI。
cd /d "%~dp0"
"..\..\..\publisher\.venv\Scripts\python.exe" batch.py %*
echo.
echo 出好的视频在 out 文件夹，跳过的原因看 out\batch-log.txt
pause
