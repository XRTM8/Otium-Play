@echo off
title Otium Play - Running
cd /d "%~dp0"
echo ========================================================
echo    OTIUM PLAY - جاري تشغيل التطبيق (120FPS / OLED Dark)
echo ========================================================
echo.
start http://localhost:3000
node server.js
pause
