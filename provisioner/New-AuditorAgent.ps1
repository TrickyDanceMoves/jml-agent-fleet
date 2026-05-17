param([switch]$WhatIf)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message)
}

$agentsRoot       = Split-Path $PSScriptRoot -Parent
$provisionerObjId = "<PROVISIONER-SP-OBJECT-ID>"
$tenantId         = "<YOUR-TENANT-ID>"
$appName          = "Claude IAM Agent Auditor"

$permissionsNeeded = @(
    "User.Read.All",
    "Group.Read.All",
    "Directory.Read.All",
    "AuditLog.Read.All",
    "Reports.Read.All"
)

# ── Step 1: Enable Provisioner via Leaver ──────────────────────────────────────
Import-Module Microsoft.Graph.Users -ErrorAction Stop
Write-Log "Connecting as Leaver to enable Provisioner"
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

# ── Step 2: Connect as Provisioner ────────────────────────────────────────────
Write-Log "Connecting as Provisioner"
$provConfig = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$provSecret  = ConvertTo-SecureString $provConfig.EncryptedSecret
$provCred    = New-Object System.Management.Automation.PSCredential($provConfig.ClientId, $provSecret)
Connect-MgGraph -TenantId $provConfig.TenantId -ClientSecretCredential $provCred -NoWelcome
Write-Log "Connected as Provisioner (AppOnly)"

# ── Step 3: Create app registration ───────────────────────────────────────────
$existingApps = Invoke-MgGraphRequest -Method GET `
    -Uri ("https://graph.microsoft.com/v1.0/applications?`$filter=displayName eq '" + $appName + "'&`$select=id,appId,displayName") `
    -ErrorAction Stop

if ($existingApps.value.Count -gt 0) {
    Write-Log ("App registration already exists: " + $existingApps.value[0]["appId"]) "WARN"
    $appObjectId = $existingApps.value[0]["id"]
    $appClientId = $existingApps.value[0]["appId"]
} elseif (-not $WhatIf) {
    $appBody = @{
        displayName     = $appName
        signInAudience  = "AzureADMyOrg"
        description     = "JML Audit Agent - read-only directory observer"
    }
    $newApp   = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/applications" `
        -Body $appBody -ContentType "application/json" -ErrorAction Stop
    $appObjectId = $newApp["id"]
    $appClientId = $newApp["appId"]
    Write-Log ("App registration created: " + $appClientId) "ACTION"
    Start-Sleep -Seconds 3
} else {
    Write-Log ("Would create app registration: " + $appName) "WHATIF"
    $appObjectId = "<new-object-id>"
    $appClientId = "<new-client-id>"
}

# ── Step 4: Create service principal ──────────────────────────────────────────
if (-not $WhatIf -and $appClientId -ne "<new-client-id>") {
    $existingSp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '" + $appClientId + "'&`$select=id") `
        -ErrorAction Stop

    if ($existingSp.value.Count -eq 0) {
        $sp = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/servicePrincipals" `
            -Body @{ appId = $appClientId } -ContentType "application/json" -ErrorAction Stop
        $spId = $sp["id"]
        Write-Log ("Service principal created: " + $spId) "ACTION"
        # Wait for SP to propagate before querying it
        Write-Log "Waiting for service principal to propagate..."
        for ($i = 1; $i -le 12; $i++) {
            Start-Sleep -Seconds 5
            try {
                Invoke-MgGraphRequest -Method GET `
                    -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $spId + "?`$select=id") `
                    -ErrorAction Stop | Out-Null
                Write-Log ("Service principal is accessible (attempt " + $i + ")") "INFO"
                break
            } catch {
                Write-Log ("Not yet accessible, retrying... (" + $i + "/12)") "INFO"
            }
        }
    } else {
        $spId = $existingSp.value[0]["id"]
        Write-Log ("Service principal already exists: " + $spId) "SKIP"
    }
} else {
    Write-Log "Would create service principal" "WHATIF"
    $spId = "<new-sp-id>"
}

# ── Step 5: Resolve Microsoft Graph permission IDs ────────────────────────────
$graphResp = Invoke-MgGraphRequest -Method GET `
    -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles" `
    -ErrorAction Stop
$graphSP  = $graphResp.value[0]
$graphSpId = $graphSP["id"]
Write-Log ("Microsoft Graph SP: " + $graphSpId)

$roleMap = @{}
foreach ($role in $graphSP["appRoles"]) {
    if ($permissionsNeeded -contains $role["value"]) {
        $roleMap[$role["value"]] = $role["id"]
        Write-Log ("  Resolved " + $role["value"] + " -> " + $role["id"])
    }
}
foreach ($perm in $permissionsNeeded) {
    if (-not $roleMap.ContainsKey($perm)) {
        Write-Log ("Could not resolve permission: " + $perm) "ERROR"
        exit 1
    }
}

# ── Step 6: Grant permissions ──────────────────────────────────────────────────
if (-not $WhatIf -and $spId -ne "<new-sp-id>") {
    $existingResp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $spId + "/appRoleAssignments") `
        -ErrorAction Stop
    $existingRoleIds = @($existingResp.value | Where-Object { $_["resourceId"] -eq $graphSpId } | ForEach-Object { $_["appRoleId"] })

    foreach ($perm in $permissionsNeeded) {
        $roleId = $roleMap[$perm]
        if ($existingRoleIds -contains $roleId) {
            Write-Log ("  [SKIP] " + $perm + " already granted")
        } else {
            $body = @{ principalId = $spId; resourceId = $graphSpId; appRoleId = $roleId }
            Invoke-MgGraphRequest -Method POST `
                -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $spId + "/appRoleAssignments") `
                -Body $body -ContentType "application/json" -ErrorAction Stop | Out-Null
            Write-Log ("  [GRANTED] " + $perm) "ACTION"
        }
    }
} else {
    foreach ($perm in $permissionsNeeded) {
        Write-Log ("  Would grant: " + $perm) "WHATIF"
    }
}

# ── Step 7: Create client secret ──────────────────────────────────────────────
$plainSecret = $null
if (-not $WhatIf -and $appObjectId -ne "<new-object-id>") {
    $expiry    = (Get-Date).AddYears(1).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $secretResp = Invoke-MgGraphRequest -Method POST `
        -Uri ("https://graph.microsoft.com/v1.0/applications/" + $appObjectId + "/addPassword") `
        -Body @{ passwordCredential = @{ displayName = "JML-Auditor-Key"; endDateTime = $expiry } } `
        -ContentType "application/json" -ErrorAction Stop
    $plainSecret = $secretResp["secretText"]
    Write-Log "Client secret created (expires $expiry)" "ACTION"
} else {
    Write-Log "Would create client secret" "WHATIF"
}

Disconnect-MgGraph | Out-Null

# ── Step 8: Encrypt secret and write config.json ──────────────────────────────
if (-not $WhatIf -and $plainSecret) {
    $encrypted = ConvertFrom-SecureString (ConvertTo-SecureString $plainSecret -AsPlainText -Force)
    $config = [ordered]@{
        TenantId        = $tenantId
        ClientId        = $appClientId
        EncryptedSecret = $encrypted
    }
    $configPath = Join-Path $agentsRoot "auditor\config.json"
    $config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
    Write-Log ("Config written to: " + $configPath) "ACTION"
}

# ── Step 9: Disable Provisioner ───────────────────────────────────────────────
Write-Log "Reconnecting as Leaver to disable Provisioner"
Connect-MgGraph -TenantId $leaverConfig.TenantId -ClientSecretCredential $leaverCred -NoWelcome

if (-not $WhatIf) {
    Update-MgUser -UserId $provisionerObjId -AccountEnabled:$false -ErrorAction Stop
    Write-Log "Provisioner account disabled" "ACTION"
} else {
    Write-Log "Would disable Provisioner account" "WHATIF"
}
Disconnect-MgGraph | Out-Null

Write-Log "Done -- Auditor agent provisioned and config.json written"
