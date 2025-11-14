# Upload Open-Source Package to GitHub
# Run this script to prepare and upload the package to GitHub

$ErrorActionPreference = "Stop"

$packageDir = Split-Path -Parent $PSScriptRoot
$targetDir = $PSScriptRoot

Write-Host "`n🚀 Preparing Open-Source Package for GitHub Upload...`n" -ForegroundColor Cyan

# Check if we're in the right directory
if (-not (Test-Path (Join-Path $targetDir "server.js"))) {
    Write-Host "❌ Error: server.js not found in current directory" -ForegroundColor Red
    Write-Host "   Please run this script from open-source/package-v2 directory" -ForegroundColor Yellow
    exit 1
}

# Check if server.js has been cleaned
$serverContent = Get-Content (Join-Path $targetDir "server.js") -Raw
if ($serverContent -match "subscriptionService|walletService|x402PaymentMiddleware") {
    Write-Host "⚠️  WARNING: server.js still contains payment/subscription code!" -ForegroundColor Yellow
    Write-Host "   Please follow CLEANUP_GUIDE.md to remove payment code first" -ForegroundColor Yellow
    Write-Host "   Or run: node prepare-server.js" -ForegroundColor Yellow
    $continue = Read-Host "Continue anyway? (y/n)"
    if ($continue -ne "y") {
        exit 1
    }
}

# Create .gitkeep for data folder if needed
if (-not (Test-Path (Join-Path $targetDir "data\.gitkeep"))) {
    New-Item -ItemType File -Path (Join-Path $targetDir "data\.gitkeep") -Force | Out-Null
}

Write-Host "✅ Package ready for GitHub upload!" -ForegroundColor Green
Write-Host "`n📋 Next steps:" -ForegroundColor Cyan
Write-Host "   1. Review all files in this directory" -ForegroundColor White
Write-Host "   2. Ensure server.js has been cleaned (no payment code)" -ForegroundColor White
Write-Host "   3. Initialize git repository:" -ForegroundColor White
Write-Host "      cd $targetDir" -ForegroundColor Gray
Write-Host "      git init" -ForegroundColor Gray
Write-Host "      git add ." -ForegroundColor Gray
Write-Host "      git commit -m 'Initial open-source release'" -ForegroundColor Gray
Write-Host "   4. Add remote and push:" -ForegroundColor White
Write-Host "      git remote add origin https://github.com/yunarax402/yunarax402.git" -ForegroundColor Gray
Write-Host "      git branch -M main" -ForegroundColor Gray
Write-Host "      git push -u origin main" -ForegroundColor Gray
Write-Host ""

