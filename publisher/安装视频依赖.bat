@echo off
cd /d %~dp0
echo Installing video dependencies (edge-tts, imageio-ffmpeg, pillow)...
.venv\Scripts\python.exe -m pip install -q edge-tts imageio-ffmpeg pillow -i https://pypi.tuna.tsinghua.edu.cn/simple
.venv\Scripts\python.exe -c "import edge_tts, imageio_ffmpeg, PIL; print('OK - video dependencies ready, restart the publisher')"
pause
