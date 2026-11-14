@echo off
cd /d "%~dp0app"
echo Iniciando servidor en http://localhost:8765 ...
start http://localhost:8765
python -m http.server 8765
