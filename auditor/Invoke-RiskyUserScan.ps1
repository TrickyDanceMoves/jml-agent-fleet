<#
.SYNOPSIS
    Polls Entra ID Identity Protection for risky users and produces a JSON report.

.DESCRIPTION
    Queries identityProtection/riskyUsers for accounts in atRisk or
    confirmedCompromised state and surfaces findings by severity:

    confirmedCompromised  (critical) Account confirmed compromised by Microsoft
                                     or an admin. Immediate action required.

    high + atRisk         (critical) High-confidence anomaly detected -- leaked
                                     credentials, impossible travel, malware-linked
                                     IP, etc.

    medium + atRisk       (warning)  Moderate-confidence anomaly. Review recommended.

    low + atRisk          (info)     Low-confidence signal. Informational only.

    Writes report to auditor/reports/risky-users-YYYY-MM-DD-HHmmss.json.
    Sends Teams notification for critical findings if notifications.json is configured.

    Optional: set autoRevokeSessionsOnHigh=true in identity-protection-config.json
    to automatically revoke sign-in sessions for critical-risk accounts.
    Requires User.RevokeSessions.All granted to the Auditor app registration.

.PARAMETER WhatIf
    Run scan and print findings without writing a report or sending notifications.

.EXAMPLE
    .\Invoke-RiskyUserScan.ps1
    .\Invoke-RiskyUserScan.ps1 -WhatIf
#>
param(
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$startTime = Get-Date

$agentsRoot = Split-Path $PSScriptRoot -Parent
$config     = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$ipCfg      = Get-Content (Join-Path $agentsRoot "shared\identity-protection-config.json") | ConvertFrom-Json

. (Join-Path $agentsRoot "shared\Helpers.ps1")
Connect-AgentGraph -Config $config
Write-Host "[RiskyScan] Connected to Microsoft Graph" -ForegroundColor Cyan

$excludePatterns = @($ipCfg.excludeUpnPatterns)

function Test-ExcludedUpn {
    param([string]$Upn)
    foreach ($pat in $excludePatterns) {
        if ($Upn -like ("*" + $pat + "*")) { return $true }
    }
    return $false
}

function Get-SafeString {
    param($Value, [string]$Default = "")
    if ($null -ne $Value) { return [string]$Value }
    return $Default
}

function Get-UserSummary {
    param($User)
    @{
        userPrincipalName = Get-SafeString $User.userPrincipalName
        displayName       = Get-SafeString $User.userDisplayName
        riskLevel         = Get-SafeString $User.riskLevel
        riskState         = Get-SafeString $User.riskState
        riskDetail        = Get-SafeString $User.riskDetail
        riskLastUpdated   = Get-SafeString $User.riskLastUpdatedDateTime
    }
}

$findings = [System.Collections.Generic.List[object]]::new()

function Add-Finding {
    param([string]$Severity, [string]$Title, [array]$Items)
    $findings.Add([PSCustomObject]@{
        severity = $Severity
        title    = $Title
        count    = $Items.Count
        items    = $Items
    })
    $color  = switch ($Severity) { "critical" { "Red" } "warning" { "Yellow" } default { "Cyan" } }
    $plural = if ($Items.Count -ne 1) { "s" } else { "" }
    Write-Host ("[RiskyScan] [" + $Severity.ToUpper() + "] " + $Title + " (" + $Items.Count + " user" + $plural + ")") -ForegroundColor $color
}

# -- Query Identity Protection --------------------------------------------------
Write-Host "[RiskyScan] Querying Identity Protection for at-risk accounts..." -ForegroundColor Cyan

$allRisky = [System.Collections.Generic.List[object]]::new()
try {
    $uri  = "https://graph.microsoft.com/v1.0/identityProtection/riskyUsers?`$filter=riskState eq 'atRisk' or riskState eq 'confirmedCompromised'&`$select=id,userPrincipalName,userDisplayName,riskLevel,riskState,riskDetail,riskLastUpdatedDateTime,isDeleted&`$top=200"
    $resp = Invoke-MgGraphRequest -Method GET -Uri $uri
    foreach ($u in $resp.value) { $allRisky.Add($u) }
    while ($resp."@odata.nextLink") {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $resp."@odata.nextLink"
        foreach ($u in $resp.value) { $allRisky.Add($u) }
    }
} catch {
    Write-Host ("[RiskyScan] ERROR querying riskyUsers: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

Write-Host ("[RiskyScan] Found " + $allRisky.Count + " risky user(s) in Identity Protection") -ForegroundColor Cyan

# Filter deleted accounts and excluded UPN patterns
$filtered = @($allRisky | Where-Object {
    if ([bool]$_.isDeleted) { return $false }
    if (Test-ExcludedUpn (Get-SafeString $_.userPrincipalName)) { return $false }
    return $true
})

Write-Host ("[RiskyScan] " + $filtered.Count + " user(s) after filtering") -ForegroundColor Cyan

# -- Categorise by severity -----------------------------------------------------
$confirmedCompromised = @($filtered | Where-Object { $_.riskState -eq "confirmedCompromised" })
$highAtRisk           = @($filtered | Where-Object { $_.riskState -eq "atRisk" -and $_.riskLevel -eq "high" })
$mediumAtRisk         = @($filtered | Where-Object { $_.riskState -eq "atRisk" -and $_.riskLevel -eq "medium" })
$lowAtRisk            = @($filtered | Where-Object { $_.riskState -eq "atRisk" -and $_.riskLevel -eq "low" })

Write-Host ""
if ($confirmedCompromised.Count -gt 0) {
    Add-Finding -Severity "critical" `
        -Title ($confirmedCompromised.Count.ToString() + " account(s) confirmed compromised") `
        -Items @($confirmedCompromised | ForEach-Object { Get-UserSummary $_ })
} else {
    Write-Host "[RiskyScan]   OK - no confirmed compromised accounts" -ForegroundColor Green
}

if ($highAtRisk.Count -gt 0) {
    Add-Finding -Severity "critical" `
        -Title ($highAtRisk.Count.ToString() + " account(s) at high risk") `
        -Items @($highAtRisk | ForEach-Object { Get-UserSummary $_ })
} else {
    Write-Host "[RiskyScan]   OK - no high-risk accounts" -ForegroundColor Green
}

if ($mediumAtRisk.Count -gt 0) {
    Add-Finding -Severity "warning" `
        -Title ($mediumAtRisk.Count.ToString() + " account(s) at medium risk") `
        -Items @($mediumAtRisk | ForEach-Object { Get-UserSummary $_ })
} else {
    Write-Host "[RiskyScan]   OK - no medium-risk accounts" -ForegroundColor Green
}

if ($lowAtRisk.Count -gt 0) {
    Add-Finding -Severity "info" `
        -Title ($lowAtRisk.Count.ToString() + " account(s) at low risk") `
        -Items @($lowAtRisk | ForEach-Object { Get-UserSummary $_ })
}

# -- Optional: auto-revoke sessions for high/critical accounts ------------------
$revokedSessions = [System.Collections.Generic.List[string]]::new()
$revocationTargets = @($confirmedCompromised) + @($highAtRisk)

if ([bool]$ipCfg.autoRevokeSessionsOnHigh -and $revocationTargets.Count -gt 0) {
    if ($WhatIf) {
        foreach ($u in $revocationTargets) {
            Write-Host ("[RiskyScan] WHATIF - would revoke sessions for: " + (Get-SafeString $u.userPrincipalName)) -ForegroundColor DarkCyan
        }
    } else {
        Write-Host "`n[RiskyScan] Auto-revoking sessions for critical-risk accounts..." -ForegroundColor Yellow
        foreach ($u in $revocationTargets) {
            $upn = Get-SafeString $u.userPrincipalName
            try {
                Invoke-MgGraphRequest -Method POST -Uri ("https://graph.microsoft.com/v1.0/users/" + $u.id + "/revokeSignInSessions") | Out-Null
                Write-Host ("[RiskyScan] Revoked sessions: " + $upn) -ForegroundColor Yellow
                $revokedSessions.Add($upn)
            } catch {
                Write-Host ("[RiskyScan] Failed to revoke sessions for " + $upn + ": " + $_.Exception.Message) -ForegroundColor Red
            }
        }
    }
}

# -- Build and write report -----------------------------------------------------
$duration = [int]((Get-Date) - $startTime).TotalSeconds
$runId    = [System.Guid]::NewGuid().ToString()

$summary = @{
    total             = $findings.Count
    critical          = @($findings | Where-Object { $_.severity -eq "critical" }).Count
    warning           = @($findings | Where-Object { $_.severity -eq "warning"  }).Count
    info              = @($findings | Where-Object { $_.severity -eq "info"     }).Count
    riskyUsersFound   = $filtered.Count
    revokedSessions   = $revokedSessions.Count
}

$report = [ordered]@{
    runId           = $runId
    timestamp       = (Get-Date -Format "o")
    durationSeconds = $duration
    summary         = $summary
    findings        = @($findings)
}

$reportJson = $report | ConvertTo-Json -Depth 10

Write-Host ("`n[RiskyScan] Summary: " + $summary.critical + " critical / " + $summary.warning + " warning / " + $summary.info + " info") -ForegroundColor Cyan

if (-not $WhatIf) {
    $reportsDir = Join-Path $PSScriptRoot "reports"
    if (-not (Test-Path $reportsDir)) { New-Item -ItemType Directory -Path $reportsDir | Out-Null }
    $reportPath = Join-Path $reportsDir ("risky-users-" + (Get-Date -Format "yyyy-MM-dd-HHmmss") + ".json")
    $reportJson | Set-Content $reportPath -Encoding UTF8
    Write-Host ("[RiskyScan] Report written: " + $reportPath) -ForegroundColor Cyan

    $outcome = if ($summary.critical -gt 0) { "failed" } elseif ($summary.warning -gt 0) { "partial" } else { "success" }
    Write-AuditEntry -Agent "auditor" -Action "RiskyUserScan" -Subject "tenant" `
        -WhatIf $false -Outcome $outcome `
        -Details @{ runId = $runId; critical = $summary.critical; warning = $summary.warning; riskyUsersFound = $summary.riskyUsersFound; revokedSessions = $summary.revokedSessions; report = $reportPath } `
        -Notify ([bool]($ipCfg.notifyOnCritical -and $summary.critical -gt 0))
} else {
    Write-Host "[RiskyScan] WHATIF - report not written" -ForegroundColor DarkCyan
}

Write-Host ("[RiskyScan] Done (" + $duration + "s).") -ForegroundColor Cyan
Write-Output $reportJson
