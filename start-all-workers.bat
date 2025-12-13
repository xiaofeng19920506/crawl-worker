@echo off
echo ========================================
echo Starting All Workers
echo ========================================
echo.

echo Opening 3 terminal windows...
echo.

REM Start Manager Worker
start "Manager Worker" cmd /k "echo === Manager Worker === && set TABS_PER_BATCH=100 && npm run start:manager-worker"

timeout /t 2 /nobreak >nul

REM Start General Worker
start "General Worker (ID: 1)" cmd /k "echo === General Worker (ID: 1) === && set GENERAL_WORKER_ID=1 && set TABS_PER_BATCH=100 && npm run start:general-worker"

timeout /t 2 /nobreak >nul

REM Start Product Worker
start "Product Worker (ID: 1)" cmd /k "echo === Product Worker (ID: 1) === && set PRODUCT_WORKER_ID=1 && npm run start:product-worker"

echo.
echo ========================================
echo All workers started!
echo ========================================
echo.
echo Monitor each window to see:
echo   - Manager: Detects workers and assigns pages
echo   - General: Opens tabs and distributes work
echo   - Product: Crawls products from tabs
echo.
echo Press any key to close this window (workers will keep running)...
pause >nul

