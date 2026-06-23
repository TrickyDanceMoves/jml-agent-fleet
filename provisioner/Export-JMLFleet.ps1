#Requires -Version 5.1
<#
.SYNOPSIS
    Packages the JML agent fleet for transfer to another PC.
.DESCRIPTION
    Zips ~/.claude/agents/ (excluding node_modules) and the Claude memory directory
    into a single timestamped archive ready to copy to another machine.
.PARAMETER OutputPath
    Where to save the zip. Defaults to the Desktop.
.EXAMPLE
    .\Export-JMLFleet.ps1
    .\Export-JMLFleet.ps1 -OutputPath D:\Transfers
#>
param(
    [string]$OutputPath = [Environment]::GetFolderPath("Desktop")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$timestamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$zipName    = "JMLFleet-$timestamp.zip"
$zipPath    = Join-Path $OutputPath $zipName
$stagingDir = Join-Path $env:TEMP "JMLFleet-$timestamp"

$agentsDir  = "C:\Users\$env:USERNAME\.claude\agents"
$memoryDir  = "C:\Users\$env:USERNAME\.claude\projects\C--Users-$env:USERNAME\memory"

Write-Host "`n=== JML Fleet Export ===" -ForegroundColor Cyan
Write-Host "Output : $zipPath"
Write-Host "Staging: $stagingDir`n"

# --- Validate source paths ---
foreach ($dir in @($agentsDir, $memoryDir)) {
    if (-not (Test-Path $dir)) {
        Write-Error "Source directory not found: $dir"
    }
}

# --- Create staging area ---
$null = New-Item -ItemType Directory -Path $stagingDir -Force
$null = New-Item -ItemType Directory -Path "$stagingDir\agents"  -Force
$null = New-Item -ItemType Directory -Path "$stagingDir\memory"  -Force

# --- Copy agents (exclude node_modules and sessions) ---
Write-Host "Copying agents (excluding node_modules, sessions)..." -ForegroundColor Yellow
$excludeDirs = @("node_modules", "sessions")

Get-ChildItem $agentsDir -Recurse | Where-Object {
    $relative = $_.FullName.Substring($agentsDir.Length + 1)
    $parts    = $relative -split '\\'
    # Exclude any item whose path contains an excluded dir name
    -not ($parts | Where-Object { $excludeDirs -contains $_ })
} | ForEach-Object {
    $dest = Join-Path "$stagingDir\agents" $_.FullName.Substring($agentsDir.Length + 1)
    if ($_.PSIsContainer) {
        $null = New-Item -ItemType Directory -Path $dest -Force
    } else {
        $null = New-Item -ItemType Directory -Path (Split-Path $dest) -Force
        Copy-Item $_.FullName -Destination $dest -Force
    }
}

# --- Copy memory ---
Write-Host "Copying memory files..." -ForegroundColor Yellow
Copy-Item "$memoryDir\*" -Destination "$stagingDir\memory\" -Recurse -Force

# --- Write transfer notes ---
$notesPath = Join-Path $stagingDir "TRANSFER_NOTES.txt"
@"
JML Agent Fleet - Transfer Package
Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Source machine: $env:COMPUTERNAME  ($env:USERNAME)
======================================================

WHAT'S IN THIS PACKAGE
  agents/   - All JML agent scripts, configs, built executables
  memory/   - Claude persistent memory (project context, architecture notes)

WHAT'S NOT INCLUDED
  node_modules/  - Run 'npm install' inside approver/ and electron-app/ on new PC
  sessions/      - Transient approver session state (safe to omit)

POST-INSTALL STEPS (run on new PC after Import-JMLFleet.ps1)
  1. Install Graph module if missing:
         Install-Module Microsoft.Graph.Users -Scope CurrentUser

  2. CREDENTIAL MIGRATION REQUIRED
     The EncryptedSecret values in each config.json are DPAPI-encrypted and
     tied to THIS machine. They will NOT work on the new PC. You must either:
       a) Run New-AgentCertificates.ps1 on the new PC (recommended - cert auth)
       b) Manually re-encrypt secrets: copy raw client secret from Entra app
          registration, then run the credential setup script for each agent.

  3. Rebuild the approver exe on the new PC:
         cd agents\approver && npm install && npm run build

  4. Start Electron GUI:
         cd agents\electron-app && npm install && npm start

  5. Run permission audit:
         .\agents\provisioner\Test-AgentPermissions.ps1

  6. Set Teams webhook:
         agents\shared\notifications.json  -> set teamsWebhookUrl

  7. Configure CA policy (optional):
         .\agents\provisioner\New-AgentConditionalAccess.ps1 -AllowedCidr "x.x.x.x/32" -ReportOnly
         (or configure manually in Entra Admin Center -> Conditional Access -> Workload identities)

TENANT ID:  <YOUR-TENANT-ID>
"@ | Set-Content $notesPath -Encoding UTF8

# --- Zip it ---
Write-Host "Creating zip archive..." -ForegroundColor Yellow
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingDir, $zipPath)

# --- Cleanup staging ---
Remove-Item $stagingDir -Recurse -Force

# --- Report ---
$size = (Get-Item $zipPath).Length / 1MB
Write-Host "`n=== Export complete ===" -ForegroundColor Green
Write-Host "Archive : $zipPath"
Write-Host "Size    : $([Math]::Round($size, 2)) MB"
Write-Host "`nCopy this zip to the new PC and run Import-JMLFleet.ps1" -ForegroundColor Cyan
