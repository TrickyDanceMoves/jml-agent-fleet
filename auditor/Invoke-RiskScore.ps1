<#
.SYNOPSIS
    Scores a provisioning operation for risk before it executes.

.DESCRIPTION
    Checks freeze windows, sensitive license/group flags, SoD policy conflicts,
    and operation baseline risk. Returns a score (0-100), risk level, reasons,
    and whether the operation is blocked or requires dual approval.

.PARAMETER Operation
    One of: joiner, enroller, mover, leaver_soft, leaver_hard

.PARAMETER UserPrincipalName
    The target user's UPN. Use 'NEW_USER' for joiners who don't exist yet.

.PARAMETER Licenses
    Comma-separated license SKU part numbers being assigned.

.PARAMETER Groups
    Comma-separated group display names being assigned.

.PARAMETER NewDepartment
    For movers: the destination department (informational).

.EXAMPLE
    .\Invoke-RiskScore.ps1 -Operation joiner -UserPrincipalName NEW_USER -Licenses "INTUNE_D" -Groups "All-Staff"
    .\Invoke-RiskScore.ps1 -Operation leaver_soft -UserPrincipalName "jane.doe@contoso.com"
#>
param(
    [Parameter(Mandatory)]
    [ValidateSet('joiner','enroller','mover','leaver_soft','leaver_hard')]
    [string]$Operation,

    [Parameter(Mandatory)][string]$UserPrincipalName,
    [string]$Licenses      = '',
    [string]$Groups        = '',
    [string]$NewDepartment = ''
)

$ErrorActionPreference = 'Stop'
$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot 'shared\Helpers.ps1')

$sodPolicy  = Get-Content (Join-Path $agentsRoot 'shared\sod-policy.json')  | ConvertFrom-Json
$policies   = Get-Content (Join-Path $agentsRoot 'approver\policies.json') | ConvertFrom-Json

$reasons  = [System.Collections.Generic.List[string]]::new()
$score    = 0
$blocked  = $false
$dualApproval = $false

$requestedLicenses = if ($Licenses) { @($Licenses -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }
$requestedGroups   = if ($Groups)   { @($Groups   -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

# ── 1. Baseline risk by operation ──────────────────────────────────────────────
$score += switch ($Operation) {
    'joiner'      { 10 }
    'enroller'    { 15 }
    'mover'       { 25 }
    'leaver_soft' { 40 }
    'leaver_hard' { 60 }
}

# ── 2. Freeze window check ─────────────────────────────────────────────────────
$today = (Get-Date).DayOfWeek.ToString()
foreach ($fw in @($policies.freezeWindows)) {
    if ($fw.allDay -and ($fw.days -contains $today)) {
        $score  += 50
        $blocked = $true
        $reasons.Add("FREEZE: $($fw.message)")
    }
}

# ── 3. Sensitive license flags ─────────────────────────────────────────────────
foreach ($lic in $requestedLicenses) {
    if ($policies.sensitiveLicenses -contains $lic) {
        $score += 20
        $reasons.Add("SENSITIVE_LICENSE: '$lic' is flagged for additional review")
    }
}

# ── 4. Sensitive group flags ───────────────────────────────────────────────────
foreach ($grp in $requestedGroups) {
    if ($policies.sensitiveGroups -contains $grp) {
        $score += 25
        $reasons.Add("SENSITIVE_GROUP: '$grp' is a privileged group requiring approval")
    }
}

# ── 5. SoD conflict check (skip for new users who don't exist yet) ─────────────
if ($requestedGroups.Count -gt 0 -and $UserPrincipalName -ne 'NEW_USER') {
    try {
        $config = Get-Content (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
        Connect-AgentGraph -Config $config 2>$null
        $existing = Invoke-MgGraphRequest -Method GET -Uri (
            "https://graph.microsoft.com/v1.0/users/$UserPrincipalName" +
            "/memberOf/microsoft.graph.group?`$select=displayName&`$top=100")
        $existingGroups = @($existing.value | ForEach-Object { $_.displayName })
        $allGroups      = @($existingGroups + $requestedGroups) | Select-Object -Unique

        foreach ($rule in @($sodPolicy.rules)) {
            $hasA = $allGroups -contains $rule.conflictA.displayName
            $hasB = $allGroups -contains $rule.conflictB.displayName
            if ($hasA -and $hasB) {
                if ($rule.action -eq 'block') {
                    $score  += 40
                    $blocked = $true
                    $reasons.Add("SOD_BLOCK [$($rule.id)]: $($rule.description)")
                } else {
                    $score += 20
                    $reasons.Add("SOD_WARN [$($rule.id)]: $($rule.description)")
                }
            }
        }
    } catch {
        $reasons.Add("SOD_CHECK_SKIPPED: Could not retrieve existing memberships for '$UserPrincipalName'")
    }
}

# ── 6. Dual approval requirement ───────────────────────────────────────────────
if ($policies.requireDualApproval -contains "submit_$Operation") {
    $dualApproval = $true
    $reasons.Add("DUAL_APPROVAL_REQUIRED: This operation requires a second operator to approve before execution")
}

# ── 7. Derive risk level ───────────────────────────────────────────────────────
$score     = [Math]::Min($score, 100)
$riskLevel = if ($score -ge 80) { 'critical' } elseif ($score -ge 50) { 'high' } elseif ($score -ge 25) { 'medium' } else { 'low' }

@{
    operation    = $Operation
    subject      = $UserPrincipalName
    riskLevel    = $riskLevel
    score        = $score
    blocked      = $blocked
    dualApproval = $dualApproval
    reasons      = @($reasons)
} | ConvertTo-Json -Depth 3 -Compress
