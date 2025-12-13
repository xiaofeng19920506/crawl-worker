# Test Flow Script - 1 Manager, 1 General Worker, 1 Product Worker, 100 tabs per batch
# Run this script to test the complete flow

Write-Host "=== Vine Crawler Test Flow ===" -ForegroundColor Green
Write-Host ""
Write-Host "Configuration:" -ForegroundColor Cyan
Write-Host "  - 1 Manager Worker" -ForegroundColor White
Write-Host "  - 1 General Worker (ID: 1)" -ForegroundColor White
Write-Host "  - 1 Product Worker (ID: 1)" -ForegroundColor White
Write-Host "  - 100 tabs per batch" -ForegroundColor White
Write-Host ""

# Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "ERROR: .env file not found!" -ForegroundColor Red
    Write-Host "Please copy env.template to .env and configure it." -ForegroundColor Yellow
    exit 1
}

# Check if Redis is running
Write-Host "Checking Redis connection..." -ForegroundColor Yellow
try {
    $redisTest = Test-NetConnection -ComputerName localhost -Port 6379 -WarningAction SilentlyContinue
    if (-not $redisTest.TcpTestSucceeded) {
        Write-Host "WARNING: Redis might not be running on localhost:6379" -ForegroundColor Yellow
        Write-Host "Make sure Redis is started: docker compose up -d redis" -ForegroundColor Yellow
    } else {
        Write-Host "✓ Redis connection OK" -ForegroundColor Green
    }
} catch {
    Write-Host "WARNING: Could not check Redis connection" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Starting services..." -ForegroundColor Cyan
Write-Host ""
Write-Host "Terminal 1: Manager Worker" -ForegroundColor Blue
Write-Host "Terminal 2: General Worker (ID: 1)" -ForegroundColor Blue
Write-Host "Terminal 3: Product Worker (ID: 1)" -ForegroundColor Blue
Write-Host ""
Write-Host "Press any key to open terminals..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

# Open terminals for each service
Write-Host ""
Write-Host "Opening terminals..." -ForegroundColor Cyan

# Terminal 1: Manager Worker
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; Write-Host '=== Manager Worker ===' -ForegroundColor Blue; `$env:TABS_PER_BATCH='100'; npm run start:manager-worker"

Start-Sleep -Seconds 2

# Terminal 2: General Worker
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; Write-Host '=== General Worker (ID: 1) ===' -ForegroundColor Green; `$env:GENERAL_WORKER_ID='1'; `$env:TABS_PER_BATCH='100'; npm run start:general-worker"

Start-Sleep -Seconds 2

# Terminal 3: Product Worker
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; Write-Host '=== Product Worker (ID: 1) ===' -ForegroundColor Magenta; `$env:PRODUCT_WORKER_ID='1'; npm run start:product-worker"

Write-Host ""
Write-Host "✓ All terminals opened!" -ForegroundColor Green
Write-Host ""
Write-Host "Monitor the terminals to see:" -ForegroundColor Cyan
Write-Host "  1. Manager detects general worker" -ForegroundColor White
Write-Host "  2. Manager assigns page range to general worker" -ForegroundColor White
Write-Host "  3. General worker opens 100 tabs in batch" -ForegroundColor White
Write-Host "  4. Product worker crawls products from tabs" -ForegroundColor White
Write-Host ""
Write-Host "To stop: Close the terminal windows or press Ctrl+C in each" -ForegroundColor Yellow

