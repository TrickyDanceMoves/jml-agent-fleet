param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadJson
)

$ErrorActionPreference = "Stop"

$payload = $PayloadJson | ConvertFrom-Json
$results = [ordered]@{
    valid    = $true
    warnings = @()
    errors   = @()
    resolved = [ordered]@{}
}

Import-Module Microsoft.Graph.Users -ErrorAction Stop
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config 2>$null

# Validate manager UPN
if ($payload.manager) {
    try {
        $mgr = Get-MgUser -UserId $payload.manager -Property "id,displayName,accountEnabled" -ErrorAction Stop
        if (-not $mgr.AccountEnabled) {
            $results.warnings += ("Manager account is disabled: " + $payload.manager)
        }
        $results.resolved["manager"] = $mgr.DisplayName
    } catch {
        $results.errors += ("Manager not found: " + $payload.manager)
        $results.valid = $false
    }
}

# Validate newManager UPN (Mover)
if ($payload.newManager) {
    try {
        $mgr = Get-MgUser -UserId $payload.newManager -Property "id,displayName,accountEnabled" -ErrorAction Stop
        if (-not $mgr.AccountEnabled) {
            $results.warnings += ("New manager account is disabled: " + $payload.newManager)
        }
        $results.resolved["newManager"] = $mgr.DisplayName
    } catch {
        $results.errors += ("New manager not found: " + $payload.newManager)
        $results.valid = $false
    }
}

# Validate subject UPN exists (Leaver/Mover)
if ($payload.validateSubjectExists -and $payload.userPrincipalName) {
    try {
        $subject = Get-MgUser -UserId $payload.userPrincipalName `
            -Property "id,displayName,accountEnabled" -ErrorAction Stop
        $results.resolved["subject"] = $subject.DisplayName
        if (-not $subject.AccountEnabled) {
            $results.warnings += ("Subject account is already disabled: " + $payload.userPrincipalName)
        }
    } catch {
        $results.errors += ("User not found: " + $payload.userPrincipalName)
        $results.valid = $false
    }
}

# Validate groups exist
$groupsToCheck = @()
if ($payload.groups)         { $groupsToCheck += $payload.groups }
if ($payload.groupsToAdd)    { $groupsToCheck += $payload.groupsToAdd }
if ($payload.groupsToRemove) { $groupsToCheck += $payload.groupsToRemove }

foreach ($groupName in $groupsToCheck) {
    try {
        $resp = Invoke-MgGraphRequest -Method GET `
            -Uri ("https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq '" + $groupName + "'&`$select=id,displayName") `
            -ErrorAction Stop
        if ($resp.value.Count -eq 0) {
            $results.warnings += ("Group not found in tenant: " + $groupName)
        } else {
            $results.resolved[$groupName] = $resp.value[0]["id"]
        }
    } catch {
        $results.warnings += ("Could not verify group: " + $groupName)
    }
}

Disconnect-MgGraph 2>$null | Out-Null
Write-Output ($results | ConvertTo-Json -Depth 3 -Compress)
