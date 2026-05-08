#Requires -Version 5.1
<#
.SYNOPSIS
    Restores the JML agent fleet from an export package on a new PC.
.DESCRIPTION
    Extracts agents and Claude memory from a JMLFleet-*.zip created by Export-JMLFleet.ps1,
    installs required PowerShell modules, and prints post-install steps.
.PARAMETER ZipPath
    Path to the JMLFleet-*.zip file.
.EXAMPLE
    .\Import-JMLFleet.ps1 -ZipPath C:\Transfers\JMLFleet-20260507-120000.zip
#>
param(
    [Parameter(Mandatory)]
    [string]$ZipPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$agentsTarget = "C:\Users\$env:USERNAME\.claude\agents"
$memoryTarget = "C:\Users\$env:USERNAME\.claude\projects\C--Users-$env:USERNAME\memory"
$stagingDir   = Join-Path $env:TEMP "JMLFleet-import-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Write-Host "`n=== JML Fleet Import ===" -ForegroundColor Cyan
Write-Host "Source : $ZipPath"
Write-Host "Agents : $agentsTarget"
Write-Host "Memory : $memoryTarget`n"

# --- Validate zip ---
if (-not (Test-Path $ZipPath)) {
    Write-Error "Zip not found: $ZipPath"
}

# --- Warn if target agents dir already exists ---
if (Test-Path $agentsTarget) {
    Write-Host "WARNING: $agentsTarget already exists." -ForegroundColor Yellow
    $confirm = Read-Host "Overwrite existing agents? Files will be merged (existing files replaced). [y/N]"
    if ($confirm -notmatch '^[Yy]$') {
        Write-Host "Aborted." -ForegroundColor Red
        exit 1
    }
}

# --- Extract ---
Write-Host "Extracting archive..." -ForegroundColor Yellow
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $stagingDir)

# --- Copy agents ---
Write-Host "Restoring agents..." -ForegroundColor Yellow
$null = New-Item -ItemType Directory -Path $agentsTarget -Force
Copy-Item "$stagingDir\agents\*" -Destination $agentsTarget -Recurse -Force

# --- Copy memory ---
Write-Host "Restoring Claude memory..." -ForegroundColor Yellow
$null = New-Item -ItemType Directory -Path $memoryTarget -Force
Copy-Item "$stagingDir\memory\*" -Destination $memoryTarget -Recurse -Force

# --- Cleanup staging ---
Remove-Item $stagingDir -Recurse -Force

# --- Check Graph module ---
Write-Host "`nChecking Microsoft.Graph.Users module..." -ForegroundColor Yellow
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Users)) {
    Write-Host "  Not found — installing..." -ForegroundColor Yellow
    Install-Module Microsoft.Graph.Users -Scope CurrentUser -Force
    Write-Host "  Installed." -ForegroundColor Green
} else {
    $ver = (Get-Module -ListAvailable -Name Microsoft.Graph.Users | Select-Object -First 1).Version
    Write-Host "  Found v$ver — OK" -ForegroundColor Green
}

# --- Set execution policy if needed ---
$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -eq "Restricted") {
    Write-Host "Setting execution policy to RemoteSigned for CurrentUser..." -ForegroundColor Yellow
    Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
    Write-Host "  Done." -ForegroundColor Green
}

# --- Summary ---
Write-Host "`n=== Import complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "NEXT STEPS (required before agents will work):" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Migrate credentials (DPAPI secrets from source machine won't work here):" -ForegroundColor Yellow
Write-Host "       cd $agentsTarget\provisioner"
Write-Host "       .\New-AgentCertificates.ps1 -WhatIf   # preview first"
Write-Host "       .\New-AgentCertificates.ps1            # then run for real"
Write-Host ""
Write-Host "  2. Rebuild approver exe:" -ForegroundColor Yellow
Write-Host "       cd $agentsTarget\approver && npm install && npm run build"
Write-Host ""
Write-Host "  3. Restore Electron GUI:" -ForegroundColor Yellow
Write-Host "       cd $agentsTarget\electron-app && npm install && npm start"
Write-Host ""
Write-Host "  4. Run permission audit:" -ForegroundColor Yellow
Write-Host "       .\$agentsTarget\provisioner\Test-AgentPermissions.ps1"
Write-Host ""
Write-Host "  5. Set Teams webhook in:" -ForegroundColor Yellow
Write-Host "       $agentsTarget\shared\notifications.json"
Write-Host ""
Write-Host "See TRANSFER_NOTES.txt (in the zip) for full details." -ForegroundColor DarkGray
