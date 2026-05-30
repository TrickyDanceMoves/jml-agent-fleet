<#
.SYNOPSIS
    Returns AI-assisted provisioning recommendations based on peer users.

.DESCRIPTION
    Queries users in the same department, tallies their license assignments and
    group memberships, and returns recommendations for licenses and groups
    held by a strict majority of sampled peers.

.PARAMETER Department
    The target department to find peers in.

.PARAMETER JobTitle
    The job title of the incoming user (used for context only).

.EXAMPLE
    .\Invoke-ProvisioningRecommendation.ps1 -Department "Engineering" -JobTitle "Software Engineer"
#>
param(
    [Parameter(Mandatory)][string]$Department,
    [Parameter(Mandatory)][string]$JobTitle
)

$ErrorActionPreference = 'Stop'
$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot 'shared\Helpers.ps1')
$config = Get-Content (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
Connect-AgentGraph -Config $config 2>$null

function Get-AllPages([string]$Uri) {
    $all  = @()
    $resp = Invoke-MgGraphRequest -Method GET -Uri $Uri
    $all += $resp.value
    while ($resp.'@odata.nextLink') {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $resp.'@odata.nextLink'
        $all += $resp.value
    }
    return ,$all
}

# ── Peer users in department ────────────────────────────────────────────────────
$deptEsc = $Department -replace "'", "''"
$peers   = Get-AllPages ("https://graph.microsoft.com/v1.0/users" +
    "?`$filter=department eq '$deptEsc' and accountEnabled eq true" +
    "&`$select=id,displayName,userPrincipalName,assignedLicenses" +
    "&`$top=20")

$peerCount = @($peers).Count

if ($peerCount -eq 0) {
    @{
        department          = $Department
        jobTitle            = $JobTitle
        peerCount           = 0
        confidence          = 'none'
        recommendedLicenses = @()
        recommendedGroups   = @()
        message             = "No peer users found in department '$Department'. Licenses and groups must be specified manually."
    } | ConvertTo-Json -Depth 4
    exit 0
}

# ── Tally license SKU IDs across all peers ──────────────────────────────────────
$licenseHits = @{}
foreach ($user in $peers) {
    foreach ($lic in @($user.assignedLicenses)) {
        $id = $lic.skuId
        if ($id) { if (-not $licenseHits.ContainsKey($id)) { $licenseHits[$id] = 0 }; $licenseHits[$id]++ }
    }
}

# ── Resolve skuId -> skuPartNumber ──────────────────────────────────────────────
$skuResp = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/subscribedSkus?`$select=skuId,skuPartNumber"
$skuMap  = @{}
foreach ($s in $skuResp.value) { $skuMap[$s.skuId] = $s.skuPartNumber }

# Tally group memberships (sample up to 10 peers to limit API calls)
$sampleSize = [Math]::Min($peerCount, 10)
$groupHits  = @{}
foreach ($user in ($peers | Select-Object -First $sampleSize)) {
    try {
        $grps = Get-AllPages (
            "https://graph.microsoft.com/v1.0/users/$($user.id)" +
            "/memberOf/microsoft.graph.group?`$select=displayName&`$top=50")
        foreach ($g in @($grps)) {
            $name = $g.displayName
            if ($name) {
                if (-not $groupHits.ContainsKey($name)) { $groupHits[$name] = 0 }
                $groupHits[$name]++
            }
        }
    } catch {}
}

# Apply strict >50% threshold.
$licThreshold = [Math]::Max(1, [Math]::Floor($peerCount / 2) + 1)
$grpThreshold = [Math]::Max(1, [Math]::Floor($sampleSize / 2) + 1)

$recommendedLicenses = @($licenseHits.GetEnumerator() |
    Where-Object { $_.Value -ge $licThreshold } |
    Sort-Object Value -Descending |
    ForEach-Object { if ($skuMap[$_.Key]) { $skuMap[$_.Key] } else { $_.Key } })

$recommendedGroups = @($groupHits.GetEnumerator() |
    Where-Object { $_.Value -ge $grpThreshold } |
    Sort-Object Value -Descending |
    ForEach-Object { $_.Key })

$confidence = if ($peerCount -ge 5) { 'high' } elseif ($peerCount -ge 2) { 'medium' } else { 'low' }

@{
    department          = $Department
    jobTitle            = $JobTitle
    peerCount           = $peerCount
    confidence          = $confidence
    recommendedLicenses = $recommendedLicenses
    recommendedGroups   = $recommendedGroups
    message             = "Based on $peerCount peer user(s) in '$Department' (confidence: $confidence)"
} | ConvertTo-Json -Depth 4
