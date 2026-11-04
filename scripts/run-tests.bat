@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0.."
if errorlevel 1 goto folder_failed
if not exist "data" mkdir "data"
if not exist "data" goto folder_failed
where node.exe >nul 2>&1
if errorlevel 1 goto missing_node
node.exe --test >"data\tests-last.log" 2>&1
set "qaTestExitCode=%errorlevel%"
type "data\tests-last.log"
if not "%qaTestExitCode%"=="0" goto failed
echo All automated tests passed.
goto finished
:failed
echo Some tests failed. Please share data\tests-last.log
:finished
echo Results saved to data\tests-last.log
pause
exit /b %qaTestExitCode%
:missing_node
echo Node.js was not found. Install it from https://nodejs.org/ and try again.
pause
exit /b 1
:folder_failed
echo Cannot open the application folder or create its data directory.
pause
exit /b 1
