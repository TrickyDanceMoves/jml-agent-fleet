<#
.SYNOPSIS
    Ingests JML audit and security findings into Microsoft Sentinel (Log Analytics).

.DESCRIPTION
    Sends two custom log types to a Log Analytics workspace via the HTTP Data
    Collector API:

      JML_AuditLog_CL      - entries from audit.jsonl
      JML_SecurityFindings_CL - findings from latest UEBA, Drift, and Identity
                                 Protection reports

    Writes a status JSON to auditor/reports/sentinel-status.json for the
    Electron app to display.

    Configure by copying sentinel.config.json.example to sentinel.config.json
    and filling in your workspace details.

.PARAMETER WhatIf
    Print what would be sent without actually posting to Log Analytics.

.EXAMPLE
    .\Invoke-SentinelIngest.ps1
    .\Invoke-SentinelIngest.ps1 -WhatIf
#>
[CmdletBinding()]
param([switch]$WhatIf)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$scriptDir  = Split-Path $MyInvocation.MyCommand.Path
$configFile = Join-Path $scriptDir 'sentinel.config.json'
$reportsDir = Join-Path $scriptDir 'reports'
$statusFile = Join-Path $reportsDir 'sentinel-status.json'
$auditFile  = Join-Path $scriptDir '..' 'audit.jsonl'

function Write-Status([hashtable]$s) {
    $null = New-Item -ItemType Directory -Force -Path $reportsDir
    $s | ConvertTo-Json | Set-Content $statusFile -Encoding UTF8
}

function Build-Signature([string]$workspaceId, [string]$sharedKey, [string]$date,
                          [int]$length, [string]$method, [string]$contentType, [string]$resource) {
    $xHeaders     = "x-ms-date:$date"
    $stringToHash = "$method`n$length`n$contentType`n$xHeaders`n$resource"
    $bytesToHash  = [Text.Encoding]::UTF8.GetBytes($stringToHash)
    $keyBytes     = [Convert]::FromBase64String($sharedKey)
    $hmac         = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key     = $keyBytes
    $hash         = [Convert]::ToBase64String($hmac.ComputeHash($bytesToHash))
    return "SharedKey ${workspaceId}:${hash}"
}

function Post-LogAnalytics([string]$workspaceId, [string]$sharedKey,
                            [string]$logType, [array]$records) {
    if ($records.Count -eq 0) { return }

    $body        = $records | ConvertTo-Json -Depth 10
    $bytes       = [Text.Encoding]::UTF8.GetBytes($body)
    $rfc1123date = (Get-Date).ToUniversalTime().ToString('R')
    $uri         = "https://$workspaceId.ods.opinsights.azure.com/api/logs?api-version=2016-04-01"
    $signature   = Build-Signature $workspaceId $sharedKey $rfc1123date `
                       $bytes.Length 'POST' 'application/json' '/api/logs'

    Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json' `
        -Headers @{
            'Authorization'        = $signature
            'Log-Type'             = $logType
            'x-ms-date'            = $rfc1123date
            'time-generated-field' = 'timestamp'
        } | Out-Null
}

# ── Not configured ─────────────────────────────────────────────────────────────
if (-not (Test-Path $configFile)) {
    Write-Warning "[SKIP] sentinel.config.json not found. Copy sentinel.config.json.example to configure."
    Write-Status @{ configured = $false; lastRun = $null; error = $null; eventsIngested = 0 }
    exit 0
}

$config = Get-Content $configFile -Raw | ConvertFrom-Json

foreach ($req in @('WorkspaceId','SharedKey')) {
    if (-not $config.$req) { throw "sentinel.config.json is missing '$req'" }
}

# ── Collect audit log entries ──────────────────────────────────────────────────
$auditRecords = @()
if (Test-Path $auditFile) {
    $auditRecords = Get-Content $auditFile | Where-Object { $_ -match '\S' } | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
    } | Where-Object { $_ -ne $null }
}

# ── Collect security findings from latest reports ──────────────────────────────
function Get-LatestReport([string]$prefix) {
    $f = Get-ChildItem $reportsDir -Filter "$prefix*.json" -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -ne 'blob-export-status.json' -and $_.Name -ne 'sentinel-status.json' } |
         Sort-Object Name -Descending | Select-Object -First 1
    if (-not $f) { return $null }
    try { return Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { return $null }
}

$secFindings = @()
foreach ($prefix in @('ueba-','drift-','risky-users-')) {
    $report = Get-LatestReport $prefix
    if ($report -and $report.findings) {
        $source = switch -Wildcard ($prefix) {
            'ueba-*'        { 'UEBA' }
            'drift-*'       { 'DriftDetection' }
            'risky-users-*' { 'IdentityProtection' }
        }
        foreach ($f in $report.findings) {
            $secFindings += [PSCustomObject]@{
                timestamp  = $report.timestamp
                scanner    = $source
                severity   = $f.severity
                title      = $f.title
                ruleId     = $f.ruleId
                eventCount = @(if ($f.events) { $f.events } elseif ($f.items) { $f.items } else { @() }).Count
            }
        }
    }
}

$totalEvents = @($auditRecords).Count + $secFindings.Count

if ($WhatIf) {
    Write-Host "[WHATIF] Would ingest $(@($auditRecords).Count) audit entries + $($secFindings.Count) security findings to workspace $($config.WorkspaceId)"
    exit 0
}

if ($totalEvents -eq 0) {
    Write-Host "[SKIP] Nothing to ingest."
    Write-Status @{ configured = $true; lastRun = (Get-Date -Format 'o'); error = $null; eventsIngested = 0; workspaceId = $config.WorkspaceId }
    exit 0
}

# ── Post to Log Analytics ──────────────────────────────────────────────────────
Write-Host "[ACTION] Ingesting $(@($auditRecords).Count) audit entries to JML_AuditLog_CL..."
try {
    Post-LogAnalytics $config.WorkspaceId $config.SharedKey 'JML_AuditLog' @($auditRecords)
} catch {
    $msg = $_.Exception.Message
    Write-Error "[ERROR] Audit log ingestion failed: $msg"
    Write-Status @{ configured = $true; lastRun = (Get-Date -Format 'o'); error = $msg; eventsIngested = 0; workspaceId = $config.WorkspaceId }
    exit 1
}

Write-Host "[ACTION] Ingesting $($secFindings.Count) security findings to JML_SecurityFindings_CL..."
try {
    if ($secFindings.Count -gt 0) {
        Post-LogAnalytics $config.WorkspaceId $config.SharedKey 'JML_SecurityFindings' $secFindings
    }
} catch {
    $msg = $_.Exception.Message
    Write-Error "[ERROR] Security findings ingestion failed: $msg"
    Write-Status @{ configured = $true; lastRun = (Get-Date -Format 'o'); error = $msg; eventsIngested = @($auditRecords).Count; workspaceId = $config.WorkspaceId }
    exit 1
}

Write-Host "[ACTION] Ingestion complete."

$status = @{
    configured     = $true
    lastRun        = (Get-Date -Format 'o')
    error          = $null
    eventsIngested = $totalEvents
    auditEntries   = @($auditRecords).Count
    secFindings    = $secFindings.Count
    workspaceId    = $config.WorkspaceId
}
Write-Status $status
Write-Host "[ACTION] Status written to $statusFile"
$status | ConvertTo-Json
