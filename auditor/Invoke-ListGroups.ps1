<#
.SYNOPSIS
    Lists available groups for the Approver Agent to pick from.
.PARAMETER Filter
    Optional prefix filter on group display name.
#>
param([string]$Filter = '')

$ErrorActionPreference = 'Stop'
$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot 'shared\Helpers.ps1')
$config = Get-Content (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
Connect-AgentGraph -Config $config 2>$null

$base = "https://graph.microsoft.com/v1.0/groups?`$select=displayName,mailEnabled,securityEnabled,groupTypes&`$top=100&`$orderby=displayName"
if ($Filter) {
    $f = $Filter -replace "'", "''"
    $base += "&`$filter=startsWith(displayName,'$f')"
}

$resp = Invoke-MgGraphRequest -Method GET -Uri $base
$groups = @($resp.value | ForEach-Object {
    $t = if ($_.groupTypes -contains 'Unified') { 'M365' } `
         elseif ($_.securityEnabled -and -not $_.mailEnabled) { 'Security' } `
         else { 'Distribution' }
    @{ displayName = $_.displayName; type = $t }
})

@{ groups = $groups; count = $groups.Count } | ConvertTo-Json -Depth 4 -Compress
