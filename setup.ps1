# Setup script for Vine Crawler
# Run this script to complete the setup

Write-Host "=== Vine Crawler Setup ===" -ForegroundColor Green
Write-Host ""

# Step 1: Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "Creating .env file from template..." -ForegroundColor Yellow
    Copy-Item env.template .env
    Write-Host "✅ .env file created. Please edit it and add your Amazon credentials." -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "✅ .env file already exists" -ForegroundColor Green
    Write-Host ""
}

# Step 2: Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
npm install --workspaces
Write-Host "✅ Dependencies installed" -ForegroundColor Green
Write-Host ""

# Step 3: Generate Prisma client
Write-Host "Generating Prisma client..." -ForegroundColor Yellow
Set-Location shared
npm run prisma:generate
Set-Location ..
Write-Host "✅ Prisma client generated" -ForegroundColor Green
Write-Host ""

# Step 4: Install Playwright
Write-Host "Installing Playwright Chromium..." -ForegroundColor Yellow
npx playwright install chromium
Write-Host "✅ Playwright installed" -ForegroundColor Green
Write-Host ""

# Step 5: Check Docker
Write-Host "Checking Docker..." -ForegroundColor Yellow
try {
    docker --version | Out-Null
    Write-Host "✅ Docker is installed" -ForegroundColor Green
    Write-Host ""
    Write-Host "To start Docker services, run:" -ForegroundColor Cyan
    Write-Host "  docker compose up -d" -ForegroundColor White
    Write-Host ""
    Write-Host "Then run database migrations:" -ForegroundColor Cyan
    Write-Host "  cd shared" -ForegroundColor White
    Write-Host "  npm run prisma:migrate" -ForegroundColor White
    Write-Host "  cd .." -ForegroundColor White
} catch {
    Write-Host "⚠️  Docker is not installed or not in PATH" -ForegroundColor Yellow
    Write-Host "   Install Docker Desktop or set up MySQL/Redis manually" -ForegroundColor Yellow
    Write-Host ""
}

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Edit .env file and add your Amazon credentials" -ForegroundColor White
Write-Host "2. Start Docker services: docker compose up -d" -ForegroundColor White
Write-Host "3. Run database migrations: cd shared && npm run prisma:migrate" -ForegroundColor White
Write-Host "4. Start the workers:" -ForegroundColor White
Write-Host "   - npm run start:general-worker" -ForegroundColor White
Write-Host "   - npm run start:product-worker" -ForegroundColor White
Write-Host "   - npm run start:api" -ForegroundColor White
Write-Host ""

