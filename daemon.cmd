@echo off
rem daemon.cmd -- one-click entry for the local daemon (no console flash beyond startup).
rem   double-click        : start (or open console if already running)
rem   daemon.cmd restart  : restart the daemon on the current port, then open console
rem   daemon.cmd stop     : stop the daemon on the current port
rem   daemon.cmd status   : print status (read-only)
rem   daemon.cmd console  : open the console page only
rem   optional 2nd arg   : port, e.g.  daemon.cmd status 7331
rem All logic lives in daemon\launch.ps1 (PowerShell 5.1, no dependencies).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0daemon\launch.ps1" %*
exit /b %ERRORLEVEL%
