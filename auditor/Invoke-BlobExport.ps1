<#
.SYNOPSIS
    Exports the JML audit log to Azure Blob Storage.

.DESCRIPTION
    Reads audit.jsonl and uploads it as a timestamped blob using a SAS token.
    Writes a status JSON to auditor/reports/blob-export-status.json for the
    Electron app to display.

    Configure by copying blob-export.config.json.example to blob-export.config.json
    and filling in your storage account details.

.PARAMETER WhatIf
    Print what would be uploaded without actually uploading.

.EXAMPLE
    .\Invoke-BlobExport.ps1
    .\Invoke-BlobExport.ps1 -WhatIf
#>
[CmdletBinding()]
param([switch]$WhatIf)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$scriptDir  = Split-Path $MyInvocation.MyCommand.Path
$configFile = Join-Path $scriptDir 'blob-export.config.json'
$reportsDir = Join-Path $scriptDir 'reports'
$statusFile = Join-Path $reportsDir 'blob-export-status.json'
$auditFile  = Join-Path $scriptDir '..' 'audit.jsonl'

function Write-Status([hashtable]$s) {
    $null = New-Item -ItemType Directory -Force -Path $reportsDir
    $s | ConvertTo-Json | Set-Content $statusFile -Encoding UTF8
}

# ── Not configured ────────────────────────────────────────────────────────────
if (-not (Test-Path $configFile)) {
    Write-Warning "[SKIP] blob-export.config.json not found. Copy blob-export.config.json.example to configure."
    Write-Status @{ configured = $false; lastRun = $null; error = $null; entriesExported = 0 }
    exit 0
}

$config = Get-Content $configFile -Raw | ConvertFrom-Json

foreach ($req in @('StorageAccountName','ContainerName','SasToken')) {
    if (-not $config.$req) { throw "blob-export.config.json is missing '$req'" }
}

# ── Read audit log ─────────────────────────────────────────────────────────────
if (-not (Test-Path $auditFile)) {
    Write-Warning "[SKIP] Audit log not found: $auditFile"
    Write-Status @{ configured = $true; lastRun = $null; error = "Audit log not found"; entriesExported = 0 }
    exit 0
}

$lines   = Get-Content $auditFile | Where-Object { $_ -match '\S' }
$entries = $lines | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { $null }
} | Where-Object { $_ -ne $null }

$count = @($entries).Count
if ($count -eq 0) {
    Write-Host "[SKIP] No audit entries to export."
    Write-Status @{ configured = $true; lastRun = (Get-Date -Format 'o'); error = $null; entriesExported = 0 }
    exit 0
}

$timestamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$blobName  = "audit-$timestamp.jsonl"
$sasToken  = $config.SasToken.TrimStart('?')
$blobUrl   = "https://$($config.StorageAccountName).blob.core.windows.net/$($config.ContainerName)/$blobName`?$sasToken"
$content   = ($entries | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join "`n"
$bytes     = [System.Text.Encoding]::UTF8.GetBytes($content)

# ── WORM / immutability ─────────────────────────────────────────────────────────
# Optional tamper-proofing for compliance: write the audit blob under a
# time-based retention (WORM) policy and/or a legal hold so it cannot be
# altered or deleted until the retention window expires — even by a storage
# account owner. Requires version-level immutability enabled on the container
# or account. Configure ImmutabilityDays (int) and/or LegalHold (bool).
$immutabilityDays = if ($config.PSObject.Properties.Name -contains 'ImmutabilityDays') { [int]$config.ImmutabilityDays } else { 0 }
$immutabilityMode = if ($config.PSObject.Properties.Name -contains 'ImmutabilityMode' -and $config.ImmutabilityMode) { [string]$config.ImmutabilityMode } else { 'Unlocked' }
$legalHold        = if ($config.PSObject.Properties.Name -contains 'LegalHold') { [bool]$config.LegalHold } else { $false }

$headers = @{ 'x-ms-blob-type' = 'BlockBlob'; 'x-ms-version' = '2021-08-06' }
$wormNote = 'none'
if ($immutabilityDays -gt 0) {
    $untilDate = (Get-Date).ToUniversalTime().AddDays($immutabilityDays).ToString('R')
    $headers['x-ms-immutability-policy-until-date'] = $untilDate
    $headers['x-ms-immutability-policy-mode']       = $immutabilityMode
    $wormNote = "retain-until $untilDate ($immutabilityMode)"
}
if ($legalHold) {
    $headers['x-ms-legal-hold'] = 'true'
    $wormNote = if ($wormNote -eq 'none') { 'legal-hold' } else { "$wormNote + legal-hold" }
}

if ($WhatIf) {
    Write-Host "[WHATIF] Would upload $count entries as '$blobName' to container '$($config.ContainerName)' (immutability: $wormNote)"
    exit 0
}

# ── Upload ─────────────────────────────────────────────────────────────────────
Write-Host "[ACTION] Uploading $count audit entries to blob: $blobName (immutability: $wormNote)"
try {
    Invoke-RestMethod -Method Put -Uri $blobUrl -Body $bytes `
        -ContentType 'application/octet-stream' `
        -Headers $headers | Out-Null
} catch {
    $msg = $_.Exception.Message
    Write-Error "[ERROR] Blob upload failed: $msg"
    Write-Status @{
        configured      = $true
        lastRun         = (Get-Date -Format 'o')
        error           = $msg
        entriesExported = 0
        lastBlobName    = $null
        storageAccount  = $config.StorageAccountName
        container       = $config.ContainerName
    }
    exit 1
}

Write-Host "[ACTION] Upload complete."

$status = @{
    configured      = $true
    lastRun         = (Get-Date -Format 'o')
    error           = $null
    entriesExported = $count
    lastBlobName    = $blobName
    storageAccount  = $config.StorageAccountName
    container       = $config.ContainerName
    immutability    = $wormNote
}
Write-Status $status
Write-Host "[ACTION] Status written to $statusFile"
$status | ConvertTo-Json
