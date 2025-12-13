# Start Chrome with remote debugging enabled for Playwright CDP connection

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Starting Chrome with Remote Debugging" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Close any existing Chrome instances
Write-Host "Closing existing Chrome instances..." -ForegroundColor Yellow
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Find Chrome executable
$chromePaths = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)

$chromePath = $null
foreach ($path in $chromePaths) {
    if (Test-Path $path) {
        $chromePath = $path
        break
    }
}

if (-not $chromePath) {
    Write-Host "ERROR: Chrome not found!" -ForegroundColor Red
    Write-Host "Please install Google Chrome or edit this script with the correct path." -ForegroundColor Yellow
    exit 1
}

# Set user data directory
$userDataDir = Join-Path $env:TEMP "chrome-debug"

# Create user data directory if it doesn't exist
if (-not (Test-Path $userDataDir)) {
    New-Item -ItemType Directory -Path $userDataDir | Out-Null
}

Write-Host "Chrome path: $chromePath" -ForegroundColor Green
Write-Host "User data dir: $userDataDir" -ForegroundColor Green
Write-Host "Remote debugging port: 9222" -ForegroundColor Green
Write-Host ""

# Start Chrome with remote debugging
Write-Host "Starting Chrome..." -ForegroundColor Yellow
$chromeArgs = @(
    "--remote-debugging-port=9222",
    "--user-data-dir=$userDataDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps"
)

Start-Process -FilePath $chromePath -ArgumentList $chromeArgs

Start-Sleep -Seconds 3

# Test if remote debugging is working
Write-Host ""
Write-Host "Testing remote debugging connection..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://localhost:9222/json/version" -TimeoutSec 2 -ErrorAction Stop
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "SUCCESS: Chrome started with remote debugging!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Remote debugging endpoint: http://localhost:9222" -ForegroundColor Cyan
    Write-Host "You can now start your workers." -ForegroundColor Cyan
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host "WARNING: Could not verify remote debugging connection." -ForegroundColor Yellow
    Write-Host "Chrome should be running. Check if port 9222 is accessible." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Try accessing: http://localhost:9222/json/version" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "Chrome is running. You can close this window." -ForegroundColor Green

