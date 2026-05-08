<#
.SYNOPSIS
    Checks a user's current memberships against the SoD policy before provisioning.

.DESCRIPTION
    Loads shared/sod-policy.json and evaluates each conflict rule against the user's
    current group memberships and directory role assignments.

    Returns an object with:
      .Passed   - $true if no blocking conflicts found
      .Blocks   - array of rule IDs that must stop provisioning
      .Warnings - array of rule IDs that should be flagged but can proceed
      .Details  - human-readable strings for audit log

    Call Connect-AgentGraph before invoking this function.

.PARAMETER UserPrincipalName
    UPN of the user to evaluate (existing user for Mover, new user for Joiner).

.PARAMETER IncomingGroups
    Array of group displayNames being added by the current operation.
    Included so the check catches conflicts introduced by this very operation.

.PARAMETER WhatIf
    If set, logs the check but does not block (for dry-run mode).

.EXAMPLE
    $sod = Invoke-SoDCheck -UserPrincipalName "jane.doe@contoso.com" -IncomingGroups @("Finance-Approvers")
    if (-not $sod.Passed) { exit 1 }
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$UserPrincipalName,

    [string[]]$IncomingGroups = @(),

    # Set for Joiner (user doesn't exist yet) - skips Graph memberOf lookup,
    # checks only whether incoming groups conflict with each other.
    [switch]$NewUser,

    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$policyPath = Join-Path $PSScriptRoot "sod-policy.json"
if (-not (Test-Path $policyPath)) {
    Write-Warning "[SoD] sod-policy.json not found at $policyPath - skipping check"
    return [PSCustomObject]@{ Passed = $true; Blocks = @(); Warnings = @(); Details = @("Policy file not found - check skipped") }
}

$policy = Get-Content $policyPath | ConvertFrom-Json

# --- Fetch current memberships (skipped for new users that don't exist yet) ---
$currentGroups = @()
$currentRoles  = @()

if (-not $NewUser.IsPresent) {
    try {
        $memberOf = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/users/$UserPrincipalName/memberOf?`$select=displayName,@odata.type"
        $currentGroups = @($memberOf.value | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.group' } | Select-Object -ExpandProperty displayName)
        $currentRoles  = @($memberOf.value | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.directoryRole' } | Select-Object -ExpandProperty displayName)
    } catch {
        Write-Warning "[SoD] Could not fetch memberships for $UserPrincipalName - $($_.Exception.Message)"
    }
}

# Combine current + incoming so we catch conflicts introduced by this operation
$effectiveGroups = ($currentGroups + $IncomingGroups) | Select-Object -Unique

function Resolve-MemberSet {
    param($rule)
    $setA = @()
    $setB = @()

    foreach ($side in @("conflictA","conflictB")) {
        $item = $rule.$side
        $set  = if ($side -eq "conflictA") { [ref]$setA } else { [ref]$setB }
        switch ($item.type) {
            "group"         { $set.Value += $effectiveGroups | Where-Object { $_ -eq $item.displayName } }
            "directoryRole" { $set.Value += $currentRoles   | Where-Object { $_ -eq $item.displayName } }
        }
    }
    return $setA, $setB
}

$blocks   = @()
$warnings = @()
$details  = @()

foreach ($rule in $policy.rules) {
    $setA, $setB = Resolve-MemberSet $rule

    if ($setA.Count -gt 0 -and $setB.Count -gt 0) {
        $msg = "[$($rule.id)] $($rule.description) - '$($rule.conflictA.displayName)' conflicts with '$($rule.conflictB.displayName)'"
        $details += $msg

        if ($rule.action -eq "block") {
            $blocks   += $rule.id
            Write-Host "[SoD] BLOCK  : $msg" -ForegroundColor Red
        } else {
            $warnings += $rule.id
            Write-Host "[SoD] WARN   : $msg" -ForegroundColor Yellow
        }
    }
}

if ($blocks.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host "[SoD] PASS   : No conflicts detected for $UserPrincipalName" -ForegroundColor Green
    $details += "No SoD conflicts detected"
}

$passed = ($blocks.Count -eq 0) -or $WhatIf.IsPresent

if (-not $passed) {
    Write-Host "[SoD] Provisioning BLOCKED due to $($blocks.Count) conflict(s). Resolve before re-submitting." -ForegroundColor Red
}

return [PSCustomObject]@{
    Passed   = $passed
    Blocks   = $blocks
    Warnings = $warnings
    Details  = $details
}
