param([switch]$WhatIf)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message)
}

$agentsRoot       = Split-Path $PSScriptRoot -Parent
$provisionerObjId = "<PROVISIONER-SP-OBJECT-ID>"

$targetApps = @(
    @{ Name = "Claude IAM Agent Joiner";   ClientId = "<JOINER-APP-CLIENT-ID>" },
    @{ Name = "Claude IAM Agent Mover";    ClientId = "<MOVER-APP-CLIENT-ID>" },
    @{ Name = "Claude IAM Agent Enroller"; ClientId = "<ENROLLER-APP-CLIENT-ID>" }
)

$permissionsNeeded = @("Group.Read.All", "GroupMember.ReadWrite.All")

# ── Step 1: Enable Provisioner user account (via Leaver — has User Admin role) ──
Import-Module Microsoft.Graph.Users
Write-Log "Connecting as Leaver agent to enable Provisioner account"
$leaverConfig = Get-Content (Join-Path $agentsRoot "leaver\config.json") | ConvertFrom-Json
$leaverSecret  = ConvertTo-SecureString $leaverConfig.EncryptedSecret
$leaverCred    = New-Object System.Management.Automation.PSCredential($leaverConfig.ClientId, $leaverSecret)
Connect-MgGraph -TenantId $leaverConfig.TenantId -ClientSecretCredential $leaverCred -NoWelcome

if (-not $WhatIf) {
    Update-MgUser -UserId $provisionerObjId -AccountEnabled:$true -ErrorAction Stop
    Write-Log "Provisioner account enabled" "ACTION"
} else {
    Write-Log "Would enable Provisioner account" "WHATIF"
}
Disconnect-MgGraph | Out-Null

# ── Step 2: Connect as Provisioner ──
Write-Log "Connecting as Provisioner"
$provConfig = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$provSecret  = ConvertTo-SecureString $provConfig.EncryptedSecret
$provCred    = New-Object System.Management.Automation.PSCredential($provConfig.ClientId, $provSecret)
Connect-MgGraph -TenantId $provConfig.TenantId -ClientSecretCredential $provCred -NoWelcome
Write-Log "Connected as Provisioner (AppOnly)"

# ── Step 3: Resolve Microsoft Graph service principal ──
$graphResp = Invoke-MgGraphRequest -Method GET `
    -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles" `
    -ErrorAction Stop
$graphSP = $graphResp.value[0]
Write-Log ("Microsoft Graph SP: " + $graphSP["id"])

$roleMap = @{}
foreach ($role in $graphSP["appRoles"]) {
    if ($permissionsNeeded -contains $role["value"]) {
        $roleMap[$role["value"]] = $role["id"]
        Write-Log ("Resolved " + $role["value"] + " -> " + $role["id"])
    }
}
foreach ($perm in $permissionsNeeded) {
    if (-not $roleMap.ContainsKey($perm)) {
        Write-Log ("Could not resolve permission ID for: " + $perm) "ERROR"
        exit 1
    }
}

# ── Step 4: Grant permissions to each target app ──
foreach ($app in $targetApps) {
    Write-Log ("Processing: " + $app.Name)
    $spResp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '" + $app.ClientId + "'&`$select=id,displayName") `
        -ErrorAction Stop
    if ($spResp.value.Count -eq 0) {
        Write-Log ("Service principal not found for: " + $app.Name) "WARN"
        continue
    }
    $sp = $spResp.value[0]

    $existingResp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $sp.id + "/appRoleAssignments") `
        -ErrorAction Stop
    $existingRoleIds = @($existingResp.value | Where-Object { $_["resourceId"] -eq $graphSP["id"] } | ForEach-Object { $_["appRoleId"] })

    foreach ($perm in $permissionsNeeded) {
        $roleId = $roleMap[$perm]
        if ($existingRoleIds -contains $roleId) {
            Write-Log ("  [SKIP] " + $perm + " already granted")
        } elseif (-not $WhatIf) {
            $body = @{ principalId = $sp.id; resourceId = $graphSP["id"]; appRoleId = $roleId }
            Invoke-MgGraphRequest -Method POST `
                -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $sp.id + "/appRoleAssignments") `
                -Body $body -ContentType "application/json" -ErrorAction Stop | Out-Null
            Write-Log ("  [GRANTED] " + $perm) "ACTION"
        } else {
            Write-Log ("  Would grant: " + $perm) "WHATIF"
        }
    }
}

Disconnect-MgGraph | Out-Null

# ── Step 5: Disable Provisioner user account ──
Write-Log "Reconnecting as Leaver to disable Provisioner account"
Connect-MgGraph -TenantId $leaverConfig.TenantId -ClientSecretCredential $leaverCred -NoWelcome

if (-not $WhatIf) {
    Update-MgUser -UserId $provisionerObjId -AccountEnabled:$false -ErrorAction Stop
    Write-Log "Provisioner account disabled" "ACTION"
} else {
    Write-Log "Would disable Provisioner account" "WHATIF"
}
Disconnect-MgGraph | Out-Null

Write-Log "Done"
