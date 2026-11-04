@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if not exist native\WasapiCapture.exe call npm run native
node_modules\electron\dist\electron.exe scripts\compare-capture.js %*
pause
