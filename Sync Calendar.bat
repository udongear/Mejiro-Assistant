@echo off
setlocal
title Mejiro Assistant - Calendar Sync
rem Double-click this file to update racing_calendar.db. No typing Python commands needed.
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"

rem ---- Find Python (the "py" launcher first, then "python") ----
set "PY="
py -3 --version >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto found
python --version >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto found

echo.
echo  Python isn't installed on this computer yet.
echo.
echo   1. Go to https://www.python.org/downloads/ and click the yellow Download button.
echo   2. Run the installer. On the FIRST screen, tick "Add python.exe to PATH".
echo   3. Click Install Now, then double-click this file again.
echo.
pause
exit /b 1

:found
rem "Sync Calendar.bat auto" = run once with no menu (for Task Scheduler), output goes to sync.log
if /i "%~1"=="auto" goto auto

:menu
echo.
echo  ==========================================
echo   Mejiro Assistant - racetrack calendar
echo  ==========================================
echo   1  Sync now  (update the calendar)
echo   2  Preview a sync  (shows changes, saves nothing)
echo   3  Show what's in the database
echo   4  Quit
echo.
set "choice="
set /p "choice=Type a number and press Enter: "
echo.
if "%choice%"=="1" %PY% sync_calendar.py sync --source all
if "%choice%"=="2" %PY% sync_calendar.py sync --source all --dry-run
if "%choice%"=="3" %PY% sync_calendar.py status
if "%choice%"=="4" exit /b 0
goto menu

:auto
echo ===== %date% %time% ===== >> sync.log
%PY% sync_calendar.py sync --source all >> sync.log 2>&1
exit /b %errorlevel%