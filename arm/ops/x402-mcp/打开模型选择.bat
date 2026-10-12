@echo off
chcp 65001 >nul
rem 双击：打开心之音 AI 模型的本地选择界面（选 Cursor 默认模型、改上限、试问、看花费）。关掉这个黑窗口就退出。
cd /d "%~dp0"
node ui.mjs
pause
