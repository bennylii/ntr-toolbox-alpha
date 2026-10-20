@echo off
rem daemon/tray.cmd -- silent tray launcher (no console window).
rem Double-click to start the tray; it owns a hidden "node daemon\index.mjs serve".
rem Optional 1st arg = port, e.g.  tray.cmd 7331
setlocal
set "PORTARG="
if not "%~1"=="" set "PORTARG=-Port %~1"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1" %PORTARG%
exit /b 0
