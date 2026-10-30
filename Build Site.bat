@echo off
rem Double-click to gather just the website files into the "site" folder.
rem Then drag that folder onto Netlify (see FIREBASE_SETUP.md) to publish it.
cd /d "%~dp0"
if exist site rmdir /s /q site
mkdir site
for %%f in (index.html style.css scripts.js calendar-data.js firebase-config.js) do copy /y "%%f" site\ >nul
echo.
echo  Done. The "site" folder is ready to drag onto Netlify.
echo.
pause
