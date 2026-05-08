<#
.SYNOPSIS
    Grants the Graph API permissions needed for PIM for Groups setup,
    agent self-activation, and access certification campaigns.

    Grants to Provisioner:
      - RoleManagement.ReadWrite.Directory      (create role assignments on groups)
      - PrivilegedAccess.ReadWrite.AzureADGroup (manage PIM group eligibility)
      - Group.ReadWrite.All                     (create role-assignable groups)
      - AccessReview.ReadWrite.All              (create access certification campaigns)

    Grants to Auditor:
      - IdentityRiskyUser.Read.All              (Identity Protection risky user scan)

    Grants to Joiner, Mover, Leaver, Enroller:
      - PrivilegedAccess.ReadWrite.AzureADGroup (self-activate PIM membership)
#>

$ErrorActionPreference = "Stop"
$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config
Write-Host "[Permissions] Connected as Provisioner" -ForegroundColor Cyan

# Resolve Microsoft Graph SP in this tenant
$graphSP = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles").value[0]
$graphSpId = $graphSP.id

# Map permission names to stable app role IDs
$needed = @{
    "RoleManagement.ReadWrite.Directory"       = ($graphSP.appRoles | Where-Object { $_.value -eq "RoleManagement.ReadWrite.Directory" }).id
    "PrivilegedAccess.ReadWrite.AzureADGroup"  = ($graphSP.appRoles | Where-Object { $_.value -eq "PrivilegedAccess.ReadWrite.AzureADGroup" }).id
    "Group.ReadWrite.All"                      = ($graphSP.appRoles | Where-Object { $_.value -eq "Group.ReadWrite.All" }).id
    "AccessReview.ReadWrite.All"               = ($graphSP.appRoles | Where-Object { $_.value -eq "AccessReview.ReadWrite.All" }).id
    "IdentityRiskyUser.Read.All"               = ($graphSP.appRoles | Where-Object { $_.value -eq "IdentityRiskyUser.Read.All" }).id
}

Write-Host "[Permissions] Resolved app role IDs:"
$needed.GetEnumerator() | ForEach-Object { Write-Host "  $($_.Key) = $($_.Value)" }

function Grant-AppPermission {
    param([string]$SpObjectId, [string]$AppName, [string]$Permission)

    $appRoleId = $needed[$Permission]
    if (-not $appRoleId) { Write-Host "[Permissions] SKIP $AppName - could not resolve role ID for $Permission" -ForegroundColor Yellow; return }

    # Check if already granted
    $existing = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignments").value
    if ($existing | Where-Object { $_.appRoleId -eq $appRoleId -and $_.resourceId -eq $graphSpId }) {
        Write-Host "[Permissions] $AppName already has $Permission - skipping" -ForegroundColor Yellow
        return
    }

    $body = @{ principalId = $SpObjectId; resourceId = $graphSpId; appRoleId = $appRoleId }
    Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignments" -Body ($body | ConvertTo-Json) | Out-Null
    Write-Host "[Permissions] Granted $Permission to $AppName" -ForegroundColor Green
}

# Provisioner — PIM + access certification permissions
$provisionerSpId = "dd691809-c93e-4fd7-8475-6e98b35e776d"
Write-Host "`n[Permissions] Provisioner..."
Grant-AppPermission -SpObjectId $provisionerSpId -AppName "Provisioner" -Permission "RoleManagement.ReadWrite.Directory"
Grant-AppPermission -SpObjectId $provisionerSpId -AppName "Provisioner" -Permission "PrivilegedAccess.ReadWrite.AzureADGroup"
Grant-AppPermission -SpObjectId $provisionerSpId -AppName "Provisioner" -Permission "Group.ReadWrite.All"
Grant-AppPermission -SpObjectId $provisionerSpId -AppName "Provisioner" -Permission "AccessReview.ReadWrite.All"

# Auditor - Identity Protection read
$auditorSpId = "21e2c37d-b4c8-452c-b81d-ced561beab2b"
Write-Host "`n[Permissions] Auditor..."
Grant-AppPermission -SpObjectId $auditorSpId -AppName "Auditor" -Permission "IdentityRiskyUser.Read.All"

# Agents - PIM self-activation only
$agents = @{
    Joiner   = "JOINER-SP-OBJECT-ID-000000000001a"
    Mover    = "MOVER-SP-OBJECT-ID-0000000000002a"
    Leaver   = "LEAVER-SP-OBJECT-ID-0000000000003a"
    Enroller = "ENROLLER-SP-OBJECT-ID-00000000004a"
}
foreach ($a in $agents.GetEnumerator()) {
    Write-Host "`n[Permissions] $($a.Key)..."
    Grant-AppPermission -SpObjectId $a.Value -AppName $a.Key -Permission "PrivilegedAccess.ReadWrite.AzureADGroup"
}

Write-Host "`n[Permissions] Done. Next steps:" -ForegroundColor Cyan
Write-Host "  1. Run .\New-PIMGroups.ps1 (if not already done)" -ForegroundColor Cyan
Write-Host "  2. Run auditor\Invoke-RiskyUserScan.ps1 -WhatIf to test Identity Protection integration" -ForegroundColor Cyan
