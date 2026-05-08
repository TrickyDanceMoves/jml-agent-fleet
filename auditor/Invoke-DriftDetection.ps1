<#
.SYNOPSIS
    Scans Entra ID for configuration drift against the expected JML fleet state.

.DESCRIPTION
    Runs five checks and produces a JSON report in auditor/reports/:

    disabled-licensed   (critical) Disabled accounts still holding assigned licenses.
                        The Leaver agent should remove licenses on disable; any found
                        here means the leaver process did not complete cleanly.

    pim-group-drift     (critical) Unexpected active members in JML PIM groups.
                        JML-UserAdmin / JML-LicenseAdmin / JML-CloudDeviceAdmin should
                        be empty outside brief JIT activations. Any member found
                        indicates an unauthorized addition or a stuck activation.

    agent-role-drift    (critical) Agent service principals with direct directory role
                        assignments. After New-PIMGroups.ps1 all agent roles flow
                        through PIM group eligibility only; direct assignments are drift.

    stale-accounts      (warning)  Enabled user accounts with no sign-in for more than
                        staleAccountDays (default 90). Candidates for review/disable.

    orphaned-disabled   (info)     Disabled user accounts older than orphanedDisabledDays
                        with no assigned licenses. Candidates for permanent deletion.

    Writes report to auditor/reports/drift-YYYY-MM-DD-HHmmss.json.
    Sends Teams notification for critical findings if notifications.json is configured.

.PARAMETER Checks
    Comma-separated subset to run, or "all". Default: "all"
    Valid values: disabled-licensed, pim-group-drift, agent-role-drift,
                  stale-accounts, orphaned-disabled

.PARAMETER StaleThresholdDays
    Override staleAccountDays from drift-config.json.

.PARAMETER WhatIf
    Run checks and print findings, but skip report write and Teams notification.

.EXAMPLE
    .\Invoke-DriftDetection.ps1
    .\Invoke-DriftDetection.ps1 -Checks pim-group-drift,agent-role-drift
    .\Invoke-DriftDetection.ps1 -WhatIf
#>
param(
    [string]$Checks = "all",
    [int]$StaleThresholdDays = 0,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$startTime  = Get-Date

$agentsRoot = Split-Path $PSScriptRoot -Parent
$config     = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$driftCfg   = Get-Content (Join-Path $agentsRoot "shared\drift-config.json") | ConvertFrom-Json
$pimCfg     = Get-Content (Join-Path $agentsRoot "shared\pim-config.json") | ConvertFrom-Json

. (Join-Path $agentsRoot "shared\Helpers.ps1")
Connect-AgentGraph -Config $config
Write-Host "[Drift] Connected to Microsoft Graph" -ForegroundColor Cyan

$allChecks = @("disabled-licensed","pim-group-drift","agent-role-drift","stale-accounts","orphaned-disabled")
$runChecks = if ($Checks -eq "all") { $allChecks } else { $Checks -split "," | ForEach-Object { $_.Trim().ToLower() } }
$staleDays  = if ($StaleThresholdDays -gt 0) { $StaleThresholdDays } else { $driftCfg.staleAccountDays }

$excludePatterns = @($driftCfg.excludeUpnPatterns)

function Get-AllPages {
    param([string]$Uri, [hashtable]$Headers = @{})
    $all  = [System.Collections.Generic.List[object]]::new()
    $resp = Invoke-MgGraphRequest -Method GET -Uri $Uri -Headers $Headers
    foreach ($item in $resp.value) { $all.Add($item) }
    while ($resp."@odata.nextLink") {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $resp."@odata.nextLink" -Headers $Headers
        foreach ($item in $resp.value) { $all.Add($item) }
    }
    return ,$all
}

function Test-ExcludedUpn {
    param([string]$Upn)
    foreach ($pat in $excludePatterns) {
        if ($Upn -like "*$pat*") { return $true }
    }
    return $false
}

function Get-SafeString {
    param($Value, [string]$Default = "")
    if ($null -ne $Value) { return [string]$Value }
    return $Default
}

$findings = [System.Collections.Generic.List[object]]::new()

function Add-Finding {
    param([string]$CheckId, [string]$Severity, [string]$Title, [array]$Items)
    $finding = [PSCustomObject]@{
        checkId  = $CheckId
        severity = $Severity
        title    = $Title
        count    = $Items.Count
        items    = $Items
    }
    $findings.Add($finding)
    $color = switch ($Severity) { "critical" { "Red" } "warning" { "Yellow" } default { "Cyan" } }
    $plural = if ($Items.Count -ne 1) { "s" } else { "" }
    Write-Host "[Drift] [$($Severity.ToUpper())] $Title ($($Items.Count) item$plural)" -ForegroundColor $color
}

# -- Check 1: Disabled accounts with licenses ----------------------------------
if ("disabled-licensed" -in $runChecks) {
    Write-Host "`n[Drift] Checking disabled-licensed..." -ForegroundColor Cyan
    try {
        $disabled = Get-AllPages "https://graph.microsoft.com/v1.0/users?`$filter=accountEnabled eq false&`$select=id,displayName,userPrincipalName,assignedLicenses&`$top=999"
        $licensed = @($disabled | Where-Object {
            $upn = Get-SafeString $_.userPrincipalName
            $_.assignedLicenses -and $_.assignedLicenses.Count -gt 0 -and -not (Test-ExcludedUpn $upn)
        })
        if ($licensed.Count -gt 0) {
            Add-Finding -CheckId "disabled-licensed" -Severity "critical" `
                -Title "$($licensed.Count) disabled account(s) still have licenses assigned" `
                -Items @($licensed | ForEach-Object {
                    @{
                        userPrincipalName = Get-SafeString $_.userPrincipalName
                        displayName       = Get-SafeString $_.displayName
                        licenseCount      = $_.assignedLicenses.Count
                    }
                })
        } else {
            Write-Host "[Drift]   OK - no disabled accounts with licenses" -ForegroundColor Green
        }
    } catch {
        Write-Host "[Drift]   ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Add-Finding -CheckId "disabled-licensed" -Severity "warning" -Title "Check failed: $($_.Exception.Message)" -Items @()
    }
}

# -- Check 2: Unexpected active members in PIM groups -------------------------
if ("pim-group-drift" -in $runChecks) {
    Write-Host "`n[Drift] Checking pim-group-drift..." -ForegroundColor Cyan
    foreach ($prop in $pimCfg.groups.PSObject.Properties) {
        $groupName = $prop.Name
        $groupId   = $prop.Value.groupId
        if (-not $groupId) { Write-Host "[Drift]   Skipping $groupName - no groupId" -ForegroundColor Yellow; continue }

        try {
            $members = Get-AllPages "https://graph.microsoft.com/v1.0/groups/$groupId/members?`$select=id,displayName,userPrincipalName,appId"
            if ($members.Count -gt 0) {
                Add-Finding -CheckId "pim-group-drift" -Severity "critical" `
                    -Title "$groupName has $($members.Count) active member(s) - expected empty outside JIT activations" `
                    -Items @($members | ForEach-Object {
                        @{
                            id                = Get-SafeString $_.id
                            displayName       = Get-SafeString $_.displayName
                            userPrincipalName = Get-SafeString $_.userPrincipalName
                            appId             = Get-SafeString $_.appId
                            group             = $groupName
                        }
                    })
            } else {
                Write-Host "[Drift]   OK - $groupName is empty" -ForegroundColor Green
            }
        } catch {
            Write-Host "[Drift]   ERROR checking $groupName`: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

# -- Check 3: Agent SPs with direct directory role assignments -----------------
if ("agent-role-drift" -in $runChecks) {
    Write-Host "`n[Drift] Checking agent-role-drift..." -ForegroundColor Cyan
    $driftItems = @()
    foreach ($agentProp in $pimCfg.agents.PSObject.Properties) {
        $agentName = $agentProp.Name
        $objectId  = $agentProp.Value.objectId
        if (-not $objectId) { continue }

        try {
            $assignments = (Invoke-MgGraphRequest -Method GET `
                -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$objectId'&`$select=id,roleDefinitionId").value

            if ($assignments -and $assignments.Count -gt 0) {
                foreach ($a in $assignments) {
                    $roleName = "unknown"
                    try {
                        $roleDef  = Invoke-MgGraphRequest -Method GET `
                            -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleDefinitions/$($a.roleDefinitionId)?`$select=displayName"
                        $roleName = Get-SafeString $roleDef.displayName "unknown"
                    } catch {}
                    $driftItems += @{ agent = $agentName; objectId = $objectId; role = $roleName; assignmentId = $a.id }
                }
            } else {
                Write-Host "[Drift]   OK - $agentName has no direct role assignments" -ForegroundColor Green
            }
        } catch {
            Write-Host "[Drift]   ERROR checking $agentName`: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    if ($driftItems.Count -gt 0) {
        Add-Finding -CheckId "agent-role-drift" -Severity "critical" `
            -Title "$($driftItems.Count) agent SP(s) have unexpected direct directory role assignments" `
            -Items $driftItems
    }
}

# -- Check 4: Stale accounts ---------------------------------------------------
if ("stale-accounts" -in $runChecks) {
    Write-Host "`n[Drift] Checking stale-accounts (threshold: $staleDays days)..." -ForegroundColor Cyan
    try {
        $users = Get-AllPages `
            "https://graph.microsoft.com/v1.0/users?`$filter=accountEnabled eq true&`$select=id,displayName,userPrincipalName,signInActivity,createdDateTime&`$top=999" `
            -Headers @{ ConsistencyLevel = "eventual" }

        $cutoff = (Get-Date).AddDays(-$staleDays)
        $stale  = @($users | Where-Object {
            $upn = Get-SafeString $_.userPrincipalName
            if (Test-ExcludedUpn $upn) { return $false }
            $lastSignIn = $null
            if ($_.signInActivity -and $_.signInActivity.lastSignInDateTime) {
                $lastSignIn = [datetime]$_.signInActivity.lastSignInDateTime
            }
            return ($null -eq $lastSignIn -or $lastSignIn -lt $cutoff)
        })

        if ($stale.Count -gt 0) {
            Add-Finding -CheckId "stale-accounts" -Severity "warning" `
                -Title "$($stale.Count) enabled account(s) with no sign-in in $staleDays+ days" `
                -Items @($stale | ForEach-Object {
                    $lastSignInVal = "Never"
                    if ($_.signInActivity -and $_.signInActivity.lastSignInDateTime) {
                        $lastSignInVal = $_.signInActivity.lastSignInDateTime
                    }
                    @{
                        userPrincipalName = Get-SafeString $_.userPrincipalName
                        displayName       = Get-SafeString $_.displayName
                        lastSignIn        = $lastSignInVal
                        createdDateTime   = Get-SafeString $_.createdDateTime
                    }
                })
        } else {
            Write-Host "[Drift]   OK - no stale accounts found" -ForegroundColor Green
        }
    } catch {
        Write-Host "[Drift]   ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Add-Finding -CheckId "stale-accounts" -Severity "warning" `
            -Title "Check failed (signInActivity may require AuditLog.Read.All): $($_.Exception.Message)" -Items @()
    }
}

# -- Check 5: Orphaned disabled accounts --------------------------------------
if ("orphaned-disabled" -in $runChecks) {
    Write-Host "`n[Drift] Checking orphaned-disabled (threshold: $($driftCfg.orphanedDisabledDays) days)..." -ForegroundColor Cyan
    try {
        $cutoff   = (Get-Date).AddDays(-$driftCfg.orphanedDisabledDays)
        $disabled = Get-AllPages "https://graph.microsoft.com/v1.0/users?`$filter=accountEnabled eq false&`$select=id,displayName,userPrincipalName,createdDateTime,assignedLicenses&`$top=999"
        $orphaned = @($disabled | Where-Object {
            $upn = Get-SafeString $_.userPrincipalName
            if (Test-ExcludedUpn $upn) { return $false }
            if (-not $_.createdDateTime) { return $false }
            if ([datetime]$_.createdDateTime -ge $cutoff) { return $false }
            return (-not $_.assignedLicenses -or $_.assignedLicenses.Count -eq 0)
        })

        if ($orphaned.Count -gt 0) {
            Add-Finding -CheckId "orphaned-disabled" -Severity "info" `
                -Title "$($orphaned.Count) disabled account(s) older than $($driftCfg.orphanedDisabledDays) days with no licenses (deletion candidates)" `
                -Items @($orphaned | ForEach-Object {
                    @{
                        userPrincipalName = Get-SafeString $_.userPrincipalName
                        displayName       = Get-SafeString $_.displayName
                        createdDateTime   = Get-SafeString $_.createdDateTime
                    }
                })
        } else {
            Write-Host "[Drift]   OK - no orphaned disabled accounts" -ForegroundColor Green
        }
    } catch {
        Write-Host "[Drift]   ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# -- Build and write report ----------------------------------------------------
$duration = [int]((Get-Date) - $startTime).TotalSeconds
$runId    = [System.Guid]::NewGuid().ToString()

$summary = @{
    total    = $findings.Count
    critical = @($findings | Where-Object { $_.severity -eq "critical" }).Count
    warning  = @($findings | Where-Object { $_.severity -eq "warning"  }).Count
    info     = @($findings | Where-Object { $_.severity -eq "info"     }).Count
}

$report = [ordered]@{
    runId           = $runId
    timestamp       = (Get-Date -Format "o")
    durationSeconds = $duration
    checksRun       = $runChecks
    summary         = $summary
    findings        = @($findings)
}

$reportJson = $report | ConvertTo-Json -Depth 10

Write-Host "`n[Drift] Summary: $($summary.critical) critical / $($summary.warning) warning / $($summary.info) info" -ForegroundColor Cyan

if (-not $WhatIf) {
    $reportsDir = Join-Path $PSScriptRoot "reports"
    if (-not (Test-Path $reportsDir)) { New-Item -ItemType Directory -Path $reportsDir | Out-Null }
    $reportPath = Join-Path $reportsDir "drift-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').json"
    $reportJson | Set-Content $reportPath -Encoding UTF8
    Write-Host "[Drift] Report written: $reportPath" -ForegroundColor Cyan

    $outcome = if ($summary.critical -gt 0) { "failed" } elseif ($summary.warning -gt 0) { "partial" } else { "success" }
    Write-AuditEntry -Agent "auditor" -Action "DriftDetection" -Subject "tenant" `
        -WhatIf $false -Outcome $outcome `
        -Details @{ runId = $runId; critical = $summary.critical; warning = $summary.warning; info = $summary.info; report = $reportPath } `
        -Notify ([bool]($driftCfg.notifyOnCritical -and $summary.critical -gt 0))
} else {
    Write-Host "[Drift] WHATIF - report not written" -ForegroundColor DarkCyan
}

Write-Host "[Drift] Done (${duration}s)." -ForegroundColor Cyan
Write-Output $reportJson
