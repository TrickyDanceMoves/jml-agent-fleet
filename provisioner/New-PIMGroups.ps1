<#
.SYNOPSIS
    One-time setup: migrates JML agents from permanent role assignments to
    PIM for Groups eligible memberships using Microsoft Entra ID Governance.

.DESCRIPTION
    1. Creates three role-assignable security groups (JML-UserAdmin,
       JML-LicenseAdmin, JML-CloudDeviceAdmin)
    2. Assigns the corresponding directory roles to each group
    3. Adds each agent service principal as an ELIGIBLE member via PIM for Groups
       (activation duration controlled by shared/pim-config.json)
    4. Removes agents' permanent direct role assignments
    5. Writes group IDs back to shared/pim-config.json

    Requires Provisioner agent credentials with:
      - RoleManagement.ReadWrite.Directory
      - PrivilegedAccess.ReadWrite.AzureADGroup
      - Group.ReadWrite.All

    Run ONCE after granting the above permissions to the Provisioner app reg.

.PARAMETER WhatIf
    Preview all changes without making them.

.EXAMPLE
    .\New-PIMGroups.ps1
    .\New-PIMGroups.ps1 -WhatIf
#>
param([switch]$WhatIf)

$ErrorActionPreference = "Stop"

$agentsRoot  = Split-Path $PSScriptRoot -Parent
$pimConfig   = Get-Content (Join-Path $agentsRoot "shared\pim-config.json") | ConvertFrom-Json
$config      = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json

. (Join-Path $agentsRoot "shared\Helpers.ps1")
Connect-AgentGraph -Config $config
Write-Host "[PIM Setup] Connected to Microsoft Graph" -ForegroundColor Cyan

# Role template IDs (stable across all tenants)
$roleTemplateIds = @{
    "User Administrator"         = "fe930be7-5e62-47db-91af-98c3a49a38b1"
    "License Administrator"      = "4d6ac14f-3453-41d0-bef9-a3e0c569773a"
    "Cloud Device Administrator" = "7698a772-787b-4ac8-901f-60d6b08affd2"
}

# Eligible assignment expiry - 2 years (policy requires a finite date; renew as needed)
$eligibilityExpiry = @{
    type     = "afterDuration"
    duration = "P180D"
}

function New-RoleAssignableGroup {
    param([string]$DisplayName, [string]$Description)

    $existing = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq '$DisplayName'&`$select=id,displayName,isAssignableToRole"
    if ($existing.value.Count -gt 0) {
        Write-Host "[PIM Setup]   Group '$DisplayName' already exists (id: $($existing.value[0].id))" -ForegroundColor Yellow
        return $existing.value[0].id
    }

    if ($WhatIf) {
        Write-Host "[PIM Setup]   WHATIF: Would create group '$DisplayName'" -ForegroundColor DarkCyan
        return $null
    }

    $body = @{
        displayName         = $DisplayName
        description         = $Description
        mailEnabled         = $false
        mailNickname        = $DisplayName.Replace(" ", "-").ToLower()
        securityEnabled     = $true
        isAssignableToRole  = $true
    }
    $group = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/groups" -Body ($body | ConvertTo-Json)
    Write-Host "[PIM Setup]   Created group '$DisplayName' (id: $($group.id))" -ForegroundColor Green
    return $group.id
}

function Set-GroupRoleAssignment {
    param([string]$GroupId, [string]$RoleDisplayName)

    $templateId = $roleTemplateIds[$RoleDisplayName]
    if (-not $templateId) { throw "Unknown role: $RoleDisplayName" }

    # Check if assignment already exists
    $existing = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$GroupId'"
    $alreadyAssigned = $existing.value | Where-Object { $_.roleDefinitionId -eq $templateId }
    if ($alreadyAssigned) {
        Write-Host "[PIM Setup]   Role '$RoleDisplayName' already assigned to group" -ForegroundColor Yellow
        return
    }

    if ($WhatIf) {
        Write-Host "[PIM Setup]   WHATIF: Would assign '$RoleDisplayName' to group $GroupId" -ForegroundColor DarkCyan
        return
    }

    $body = @{ principalId = $GroupId; roleDefinitionId = $templateId; directoryScopeId = "/" }
    Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments" -Body ($body | ConvertTo-Json) | Out-Null
    Write-Host "[PIM Setup]   Assigned '$RoleDisplayName' to group" -ForegroundColor Green
}

function Add-EligibleMember {
    param([string]$GroupId, [string]$PrincipalId, [string]$AgentName)

    # Check if eligible assignment already exists
    $existing = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/eligibilitySchedules?`$filter=groupId eq '$GroupId' and principalId eq '$PrincipalId'"
    if ($existing.value.Count -gt 0) {
        Write-Host "[PIM Setup]   Eligible membership already exists for $AgentName" -ForegroundColor Yellow
        return
    }

    if ($WhatIf) {
        Write-Host "[PIM Setup]   WHATIF: Would add $AgentName as eligible member of group $GroupId" -ForegroundColor DarkCyan
        return
    }

    $body = @{
        accessId    = "member"
        principalId = $PrincipalId
        groupId     = $GroupId
        action      = "adminAssign"
        scheduleInfo = @{
            startDateTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            expiration    = $eligibilityExpiry
        }
        justification = "JML agent PIM migration - permanent eligibility, time-boxed activation"
    }
    Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests" `
        -Body ($body | ConvertTo-Json -Depth 5) | Out-Null
    Write-Host "[PIM Setup]   Added $AgentName as eligible member" -ForegroundColor Green
}

function Remove-PermanentRoleAssignment {
    param([string]$PrincipalId, [string]$RoleDisplayName, [string]$AgentName)

    $templateId = $roleTemplateIds[$RoleDisplayName]
    $existing = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$PrincipalId' and roleDefinitionId eq '$templateId'"
    if ($existing.value.Count -eq 0) {
        Write-Host "[PIM Setup]   No permanent '$RoleDisplayName' assignment to remove for $AgentName" -ForegroundColor Yellow
        return
    }

    if ($WhatIf) {
        Write-Host "[PIM Setup]   WHATIF: Would remove permanent '$RoleDisplayName' from $AgentName" -ForegroundColor DarkCyan
        return
    }

    foreach ($assignment in $existing.value) {
        Invoke-MgGraphRequest -Method DELETE `
            -Uri "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments/$($assignment.id)" | Out-Null
        Write-Host "[PIM Setup]   Removed permanent '$RoleDisplayName' from $AgentName" -ForegroundColor Green
    }
}

# --- Phase 1: Create groups ---
Write-Host "`n[PIM Setup] Phase 1: Creating role-assignable groups..." -ForegroundColor Cyan
$groupIds = @{}

foreach ($groupName in $pimConfig.groups.PSObject.Properties.Name) {
    $groupCfg = $pimConfig.groups.$groupName
    $id = New-RoleAssignableGroup -DisplayName $groupName -Description "JML PIM group for $($groupCfg.roleDisplayName)"
    $groupIds[$groupName] = $id
}

# Allow Entra replication to catch up before assigning roles
Write-Host "`n[PIM Setup] Waiting 30s for Entra replication before role assignment..." -ForegroundColor DarkGray
Start-Sleep -Seconds 30

# --- Phase 2: Assign roles to groups ---
Write-Host "`n[PIM Setup] Phase 2: Assigning directory roles to groups..." -ForegroundColor Cyan
foreach ($groupName in $pimConfig.groups.PSObject.Properties.Name) {
    if (-not $groupIds[$groupName]) { continue }
    $groupCfg = $pimConfig.groups.$groupName
    Write-Host "[PIM Setup] $groupName → $($groupCfg.roleDisplayName)"
    Set-GroupRoleAssignment -GroupId $groupIds[$groupName] -RoleDisplayName $groupCfg.roleDisplayName
}

# --- Phase 3: Add agents as eligible members ---
Write-Host "`n[PIM Setup] Phase 3: Adding agents as eligible members..." -ForegroundColor Cyan
foreach ($agentName in $pimConfig.agents.PSObject.Properties.Name) {
    $agentCfg  = $pimConfig.agents.$agentName
    foreach ($groupName in $agentCfg.requiredGroups) {
        $gid = $groupIds[$groupName]
        if (-not $gid) { Write-Host "[PIM Setup]   Skipping $agentName → $groupName (no group ID)"; continue }
        Write-Host "[PIM Setup] $agentName → $groupName"
        Add-EligibleMember -GroupId $gid -PrincipalId $agentCfg.objectId -AgentName $agentName
    }
}

# --- Phase 4: Remove permanent role assignments ---
Write-Host "`n[PIM Setup] Phase 4: Removing permanent role assignments from agents..." -ForegroundColor Cyan
$rolesToRemove = @{
    joiner   = @("User Administrator", "License Administrator")
    mover    = @("User Administrator", "License Administrator")
    leaver   = @("User Administrator", "License Administrator")
    enroller = @("License Administrator")
}
foreach ($agentName in $rolesToRemove.Keys) {
    $agentCfg = $pimConfig.agents.$agentName
    foreach ($role in $rolesToRemove[$agentName]) {
        Write-Host "[PIM Setup] Removing '$role' from $agentName"
        Remove-PermanentRoleAssignment -PrincipalId $agentCfg.objectId -RoleDisplayName $role -AgentName $agentName
    }
}

# --- Phase 5: Write group IDs back to pim-config.json ---
if (-not $WhatIf) {
    Write-Host "`n[PIM Setup] Phase 5: Writing group IDs to pim-config.json..." -ForegroundColor Cyan
    $updatedConfig = Get-Content (Join-Path $agentsRoot "shared\pim-config.json") | ConvertFrom-Json
    foreach ($groupName in $groupIds.Keys) {
        if ($groupIds[$groupName]) {
            $updatedConfig.groups.$groupName.groupId = $groupIds[$groupName]
        }
    }
    $updatedConfig | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $agentsRoot "shared\pim-config.json") -Encoding UTF8
    Write-Host "[PIM Setup] pim-config.json updated with group IDs" -ForegroundColor Green
}

Write-Host "`n[PIM Setup] Done$(if ($WhatIf) { ' (WHATIF - no changes made)' })." -ForegroundColor Cyan
