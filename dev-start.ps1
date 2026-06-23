<#
.SYNOPSIS
    Starts the full JML local dev stack: Azurite → Worker → API → ngrok tunnel

.DESCRIPTION
    Opens four separate PowerShell windows:
      1. Azurite  - Azure Storage emulator (queue + table on default ports)
      2. Worker   - polls jml-events queue, invokes PS1 agents
      3. API      - Azure Functions on http://localhost:7071
      4. ngrok    - public HTTPS tunnel → localhost:7071 (for BambooHR webhooks)

    Press Ctrl+C in each window to stop.

.EXAMPLE
    .\dev-start.ps1
#>

$root = $PSScriptRoot

Write-Host ""
Write-Host "=== JML Dev Stack ===" -ForegroundColor Cyan
Write-Host ""

# 1. Azurite
$azuriteData = Join-Path $root ".azurite"
Write-Host "[1/3] Starting Azurite (storage emulator)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Write-Host 'Azurite - Azure Storage Emulator' -ForegroundColor Cyan; azurite --location '$azuriteData' --skipApiVersionCheck --debug '$azuriteData\debug.log'"

Start-Sleep -Seconds 2

# 2. Worker
Write-Host "[2/3] Starting JML Queue Worker..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Write-Host 'JML Queue Worker' -ForegroundColor Green; Set-Location '$root\worker'; node src/worker.js"

Start-Sleep -Seconds 1

# 3. Azure Functions API
Write-Host "[3/3] Starting Azure Functions API..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Write-Host 'JML API - Azure Functions' -ForegroundColor Magenta; Set-Location '$root\api'; func start"

Start-Sleep -Seconds 1

# 4. ngrok tunnel (exposes localhost:7071 for BambooHR webhooks)
Write-Host "[4/4] Starting ngrok tunnel → localhost:7071..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "Write-Host 'ngrok tunnel - copy the Forwarding URL for BambooHR webhook config' -ForegroundColor Yellow; ngrok http 7071"

Write-Host ""
Write-Host "All four services starting in separate windows." -ForegroundColor Green
Write-Host ""
Write-Host "Endpoints (once ready):" -ForegroundColor White
Write-Host "  POST http://localhost:7071/api/jml                   (trigger JML event directly)"
Write-Host "  POST http://localhost:7071/api/webhooks/bamboohr      (BambooHR webhook - local)"
Write-Host "  POST https://<ngrok-url>/api/webhooks/bamboohr        (BambooHR webhook - public)"
Write-Host "  GET  http://localhost:7071/api/jml/status/{id}        (poll status)"
Write-Host ""
Write-Host "BambooHR webhook URL to paste into BambooHR Settings:" -ForegroundColor Cyan
Write-Host "  https://<ngrok-url>/api/webhooks/bamboohr"
Write-Host ""
Write-Host "API Key header: x-api-key: dev-local-key-changeme"
Write-Host ""
Write-Host "Test hire event (PowerShell):"
Write-Host '  Invoke-RestMethod -Uri "http://localhost:7071/api/jml" -Method POST \'
Write-Host '    -Headers @{ "x-api-key" = "dev-local-key-changeme"; "Content-Type" = "application/json" } \'
Write-Host '    -Body (ConvertTo-Json @{'
Write-Host '      eventType="hire"; effectiveDate="2026-05-20"'
Write-Host '      employee=@{ firstName="Jane"; lastName="Doe"; email="jane.doe@contoso.onmicrosoft.com"; department="Engineering"; jobTitle="Senior Engineer"; usageLocation="US" }'
Write-Host '    } -Depth 5)'
Write-Host ""
