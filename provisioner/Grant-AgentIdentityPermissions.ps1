<#
.SYNOPSIS
    Grants Microsoft Graph application permissions (appRoleAssignments) to the JML
    Entra Agent IDs, matching each agent's existing least-privilege scope set. This
    is the non-destructive migration step that makes the Agent IDs functional
    permission-wise, in parallel with the existing app-registration SPs.

.DESCRIPTION
    Per the Agent ID model: permissions live on the AGENT IDENTITY (credentials live
    on the blueprint). For each agent identity (resolved by display name) this assigns
    the same Graph app roles its SP holds today, then admin-consents them by virtue of
    the signed-in admin. Reports per-permission success/failure — some high-risk Graph
    permissions may be blocked for agent identities, which this surfaces.

.EXAMPLE
    .\Grant-AgentIdentityPermissions.ps1            # WhatIf: show planned grants
    .\Grant-AgentIdentityPermissions.ps1 -Execute   # apply grants
#>
param([switch]$Execute)

$ErrorActionPreference = "Stop"
$agentsRoot = Split-Path $PSScriptRoot -Parent

function Write-Log {
    param([string]$m, [string]$s = "INFO")
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [$s] $m")
}
function Get-RestError {
    param($e)
    if ($e.ErrorDetails -and $e.ErrorDetails.Message) { return $e.ErrorDetails.Message }
    try {
        $r = New-Object System.IO.StreamReader($e.Exception.Response.GetResponseStream())
        $r.BaseStream.Position = 0; $r.DiscardBufferedData(); return $r.ReadToEnd()
    } catch {}
    return $e.Exception.Message
}

# Agent display name -> Graph application permissions (matches the SP least-privilege matrix)
$matrix = @{
    "JML Joiner Agent"   = @("User.ReadWrite.All","Group.Read.All","GroupMember.ReadWrite.All","LicenseAssignment.ReadWrite.All")
    "JML Mover Agent"    = @("User.ReadWrite.All","Group.Read.All","GroupMember.ReadWrite.All","LicenseAssignment.ReadWrite.All")
    "JML Enroller Agent" = @("User.ReadWrite.All","Group.Read.All","GroupMember.ReadWrite.All","LicenseAssignment.ReadWrite.All")
    "JML Leaver Agent"   = @("User.ReadWrite.All","LicenseAssignment.ReadWrite.All","GroupMember.ReadWrite.All")
    "JML Approver Agent" = @("User.Read.All","Group.Read.All")
    "JML Auditor Agent"  = @("User.Read.All","Group.Read.All","Directory.Read.All","AuditLog.Read.All","Reports.Read.All")
}

$tenantId = (Get-Content (Join-Path $agentsRoot "joiner\config.json") -Raw | ConvertFrom-Json).TenantId
$clientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
$scope    = "https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All https://graph.microsoft.com/Application.Read.All offline_access openid profile"

Write-Log "Requesting device code..."
$dc = Invoke-RestMethod -Method POST -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/devicecode" -Body @{ client_id = $clientId; scope = $scope }
Write-Host ""
Write-Host "================================================================"
Write-Host " $($dc.message)"
Write-Host "================================================================"
Write-Host ""

$token = $null
$interval = [Math]::Max(5, [int]$dc.interval)
$deadline = (Get-Date).AddSeconds([int]$dc.expires_in)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $interval
    try {
        $tok = Invoke-RestMethod -Method POST -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token" -Body @{
            grant_type  = "urn:ietf:params:oauth:grant-type:device_code"
            client_id   = $clientId
            device_code = $dc.device_code
        } -ErrorAction Stop
        $token = $tok.access_token
        break
    } catch {
        $c = $null
        try { $c = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
        if ($c -eq "authorization_pending") { continue }
        elseif ($c -eq "slow_down")          { $interval += 5; continue }
        else { throw }
    }
}
if (-not $token) { Write-Log "Device code expired." "ERROR"; exit 1 }
Write-Log "Authenticated."
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

# Resolve the Microsoft Graph service principal + its app roles
$graphSp = (Invoke-RestMethod -Method GET -Headers $headers -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles").value[0]
$graphSpId = $graphSp.id
$roleMap = @{}
foreach ($r in $graphSp.appRoles) {
    if ($r.allowedMemberTypes -contains "Application") { $roleMap[$r.value] = $r.id }
}
Write-Log ("Microsoft Graph SP " + $graphSpId + " - " + $roleMap.Count + " application roles available.")

$granted = 0; $skipped = 0; $failed = 0
foreach ($displayName in $matrix.Keys) {
    $sp = (Invoke-RestMethod -Method GET -Headers $headers -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=displayName eq '$displayName'&`$select=id,displayName").value[0]
    if (-not $sp) { Write-Log ("Agent identity not found: " + $displayName) "WARN"; continue }
    Write-Log ($displayName + " (" + $sp.id + ")")

    # Existing assignments (avoid duplicates)
    $existing = (Invoke-RestMethod -Method GET -Headers $headers -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $sp.id + "/appRoleAssignments")).value
    $existingRoleIds = @($existing | ForEach-Object { $_.appRoleId })

    foreach ($perm in $matrix[$displayName]) {
        $roleId = $roleMap[$perm]
        if (-not $roleId) { Write-Log ("  ? unknown Graph role: " + $perm) "WARN"; continue }
        if ($existingRoleIds -contains $roleId) { Write-Log ("  = already granted: " + $perm); $skipped++; continue }
        if (-not $Execute) { Write-Log ("  + would grant: " + $perm) "WHATIF"; continue }
        $body = @{ principalId = $sp.id; resourceId = $graphSpId; appRoleId = $roleId } | ConvertTo-Json
        try {
            Invoke-RestMethod -Method POST -Headers $headers -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $sp.id + "/appRoleAssignments") -Body $body | Out-Null
            Write-Log ("  + granted: " + $perm) "ACTION"; $granted++
        } catch {
            Write-Log ("  x FAILED " + $perm + ": " + (Get-RestError $_)) "ERROR"; $failed++
        }
    }
}

Write-Host ""
if (-not $Execute) { Write-Log "WhatIf only - re-run with -Execute to apply grants." "WARN" }
else { Write-Log ("Done. $granted granted, $skipped already present, $failed failed.") "ACTION" }
