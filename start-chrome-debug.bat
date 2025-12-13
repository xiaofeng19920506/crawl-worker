@echo off
REM Start Chrome with remote debugging enabled for Playwright CDP connection

echo ========================================
echo Starting Chrome with Remote Debugging
echo ========================================
echo.

REM Close any existing Chrome instances
echo Closing existing Chrome instances...
taskkill /F /IM chrome.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM Set Chrome path (adjust if Chrome is installed elsewhere)
set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
set CHROME_PATH_X86="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

REM Check if Chrome exists in default location
if exist %CHROME_PATH% (
    set CHROME=%CHROME_PATH%
) else if exist %CHROME_PATH_X86% (
    set CHROME=%CHROME_PATH_X86%
) else (
    echo ERROR: Chrome not found in default locations!
    echo Please edit this script and set CHROME_PATH to your Chrome installation.
    pause
    exit /b 1
)

REM Set user data directory (separate profile for debugging)
set USER_DATA_DIR=%TEMP%\chrome-debug

REM Create user data directory if it doesn't exist
if not exist "%USER_DATA_DIR%" mkdir "%USER_DATA_DIR%"

echo Chrome path: %CHROME%
echo User data dir: %USER_DATA_DIR%
echo Remote debugging port: 9222
echo.

REM Start Chrome with remote debugging
echo Starting Chrome...
start "" %CHROME% ^
    --remote-debugging-port=9222 ^
    --user-data-dir="%USER_DATA_DIR%" ^
    --no-first-run ^
    --no-default-browser-check ^
    --disable-default-apps

timeout /t 3 /nobreak >nul

REM Test if remote debugging is working
echo.
echo Testing remote debugging connection...
curl -s http://localhost:9222/json/version >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo SUCCESS: Chrome started with remote debugging!
    echo ========================================
    echo.
    echo Remote debugging endpoint: http://localhost:9222
    echo You can now start your workers.
    echo.
) else (
    echo.
    echo WARNING: Could not verify remote debugging connection.
    echo Chrome should be running. Check if port 9222 is accessible.
    echo.
    echo Try accessing: http://localhost:9222/json/version
    echo.
)

echo Press any key to close this window (Chrome will stay open)...
pause >nul

