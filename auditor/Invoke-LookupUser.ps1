<#
.SYNOPSIS
    Looks up a user by UPN or display name for the Approver/Auditor agents.
.PARAMETER UpnOrName
    Full UPN (e.g. john.doe@contoso.com) or partial display name to search.
#>
param(
    [Parameter(Mandatory)][string]$UpnOrName
)

$ErrorActionPreference = 'Stop'
$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot 'shared\Helpers.ps1')
$config = Get-Content (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
Connect-AgentGraph -Config $config 2>$null

$sel = 'id,displayName,userPrincipalName,accountEnabled,department,jobTitle,mail,usageLocation,assignedLicenses,createdDateTime,signInActivity'

# Try exact UPN first
$user = $null
if ($UpnOrName -match '@') {
    try {
        $user = Invoke-MgGraphRequest -Method GET -Uri (
            "https://graph.microsoft.com/v1.0/users/$([System.Uri]::EscapeDataString($UpnOrName))" +
            "?`$select=$sel&`$expand=manager(`$select=displayName,userPrincipalName)")
    } catch {}
}

# Fall back to display name / UPN prefix search
if (-not $user) {
    $nameEsc = $UpnOrName -replace "'", "''"
    $resp = Invoke-MgGraphRequest -Method GET -Uri (
        "https://graph.microsoft.com/v1.0/users" +
        "?`$filter=startsWith(displayName,'$nameEsc') or startsWith(userPrincipalName,'$nameEsc')" +
        "&`$select=$sel&`$top=5")
    $hits = @($resp.value)
    if ($hits.Count -eq 1) {
        $user = $hits[0]
    } elseif ($hits.Count -gt 1) {
        @{
            found    = $false
            multiple = $true
            matches  = @($hits | ForEach-Object { @{ displayName = $_.displayName; upn = $_.userPrincipalName } })
            message  = "Multiple users match '$UpnOrName'. Provide the full UPN."
        } | ConvertTo-Json -Depth 4 -Compress
        exit 0
    }
}

if (-not $user) {
    @{ found = $false; message = "No user found matching '$UpnOrName'." } | ConvertTo-Json -Compress
    exit 0
}

# Group memberships (up to 50)
$groups = @()
try {
    $grpResp = Invoke-MgGraphRequest -Method GET -Uri (
        "https://graph.microsoft.com/v1.0/users/$($user.id)/memberOf/microsoft.graph.group" +
        "?`$select=displayName&`$top=50")
    $groups = @($grpResp.value | ForEach-Object { $_.displayName })
} catch {}

# Resolve license SKU IDs → skuPartNumber
$skuMap = @{}
try {
    $skuResp = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/subscribedSkus?`$select=skuId,skuPartNumber"
    foreach ($s in $skuResp.value) { $skuMap[$s.skuId] = $s.skuPartNumber }
} catch {}
$licenses = @($user.assignedLicenses | ForEach-Object {
    if ($skuMap[$_.skuId]) { $skuMap[$_.skuId] } else { $_.skuId }
} | Where-Object { $_ })

# Last sign-in
$lastSignIn = $null
try { $lastSignIn = $user.signInActivity?.lastSignInDateTime } catch {}

@{
    found             = $true
    id                = $user.id
    displayName       = $user.displayName
    userPrincipalName = $user.userPrincipalName
    accountEnabled    = $user.accountEnabled
    department        = $user.department
    jobTitle          = $user.jobTitle
    mail              = $user.mail
    usageLocation     = $user.usageLocation
    createdAt         = $user.createdDateTime
    lastSignIn        = $lastSignIn
    manager           = if ($user.manager) { $user.manager.userPrincipalName } else { $null }
    assignedLicenses  = $licenses
    groupMemberships  = $groups
} | ConvertTo-Json -Depth 4 -Compress
