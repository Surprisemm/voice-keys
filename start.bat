@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto folder_failed
if not exist "data" mkdir "data"
if not exist "data" goto folder_failed
>>"data\startup.log" echo [%date% %time%] Starting Voice Keys
where node.exe >nul 2>&1
if errorlevel 1 goto missing_node
if not exist "node_modules\koffi\package.json" goto install
if not exist "node_modules\vosk-browser\package.json" goto install
if not exist "node_modules\sherpa-onnx-node\package.json" goto install
if exist "node_modules\electron\dist\electron.exe" goto models
:install
echo Installing dependencies. Details: data\startup.log
call npm.cmd ci >>"data\startup.log" 2>&1
if errorlevel 1 goto failed
if exist "node_modules\electron\dist\electron.exe" goto models
node.exe "node_modules\electron\install.js" >>"data\startup.log" 2>&1
if errorlevel 1 goto failed
:models
rem Speech models are downloaded inside the app (the Download button next to the model selector).
if exist "native\WasapiCapture.exe" goto run
echo Building the audio helper. Details: data\startup.log
node.exe "scripts\build-native.js" >>"data\startup.log" 2>&1
:run
echo Starting Voice Keys...
"node_modules\electron\dist\electron.exe" "." >>"data\startup.log" 2>&1
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo Node.js was not found. Install it from https://nodejs.org/ and try again.
pause
exit /b 1
:folder_failed
echo Cannot open the application folder or create its data directory.
pause
exit /b 1
:failed
echo Voice Keys could not start. Details: "%~dp0data\startup.log"
type "data\startup.log"
pause
exit /b 1
