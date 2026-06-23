<#
.SYNOPSIS
    Provisions the Certifier agent: its own app registration, service principal,
    least-privilege Graph permissions, client secret, and certifier/config.json.

.DESCRIPTION
    The Certifier (access review campaigns) historically borrowed the
    Provisioner's credential - which carries Application.ReadWrite.All and is
    far more privilege than campaign management needs. This script gives the
    Certifier its own identity with only:

      AccessReview.ReadWrite.All  - create/manage access review definitions
      Group.Read.All              - resolve reviewed groups
      User.Read.All               - resolve reviewer object IDs

    Connects as the Provisioner SP (cert-first via Connect-AgentGraph). The
    Provisioner already holds Application.ReadWrite.All +
    AppRoleAssignment.ReadWrite.All, so no interactive consent is needed.

.PARAMETER WhatIf
    Preview all actions without creating anything.

.EXAMPLE
    .\New-CertifierAgent.ps1 -WhatIf
    .\New-CertifierAgent.ps1
#>
param([switch]$WhatIf)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message)
}

$agentsRoot = Split-Path $PSScriptRoot -Parent
$appName    = "Claude IAM Agent Certifier"

$permissionsNeeded = @(
    "AccessReview.ReadWrite.All",
    "Group.Read.All",
    "User.Read.All"
)

# ── Step 1: Connect as Provisioner (cert-first) ───────────────────────────────
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
$provConfig = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
. (Join-Path $agentsRoot "shared\Helpers.ps1")
Connect-AgentGraph -Config $provConfig
Write-Log "Connected as Provisioner (AppOnly)"

# ── Step 2: Create app registration ───────────────────────────────────────────
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
        description     = "JML Certifier Agent - access review campaign manager"
    }
    $newApp = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/applications" `
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

# ── Step 3: Create service principal ──────────────────────────────────────────
if (-not $WhatIf -and $appClientId -ne "<new-client-id>") {
    $existingSp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '" + $appClientId + "'&`$select=id") `
        -ErrorAction Stop

    if ($existingSp.value.Count -eq 0) {
        $sp = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/servicePrincipals" `
            -Body @{ appId = $appClientId } -ContentType "application/json" -ErrorAction Stop
        $spId = $sp["id"]
        Write-Log ("Service principal created: " + $spId) "ACTION"
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

# ── Step 4: Resolve Microsoft Graph permission IDs ────────────────────────────
$graphResp = Invoke-MgGraphRequest -Method GET `
    -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles" `
    -ErrorAction Stop
$graphSP   = $graphResp.value[0]
$graphSpId = $graphSP["id"]

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

# ── Step 5: Grant permissions ──────────────────────────────────────────────────
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

# ── Step 6: Create client secret ──────────────────────────────────────────────
$plainSecret = $null
if (-not $WhatIf -and $appObjectId -ne "<new-object-id>") {
    $expiry     = (Get-Date).AddYears(1).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $secretResp = Invoke-MgGraphRequest -Method POST `
        -Uri ("https://graph.microsoft.com/v1.0/applications/" + $appObjectId + "/addPassword") `
        -Body @{ passwordCredential = @{ displayName = "JML-Certifier-Key"; endDateTime = $expiry } } `
        -ContentType "application/json" -ErrorAction Stop
    $plainSecret = $secretResp["secretText"]
    $secretExpiry = $expiry
    Write-Log "Client secret created (expires $expiry)" "ACTION"
} else {
    Write-Log "Would create client secret" "WHATIF"
}

Disconnect-MgGraph | Out-Null

# ── Step 7: Encrypt secret and write config.json ──────────────────────────────
if (-not $WhatIf -and $plainSecret) {
    $encrypted = ConvertFrom-SecureString (ConvertTo-SecureString $plainSecret -AsPlainText -Force)
    $config = [ordered]@{
        TenantId        = $provConfig.TenantId
        ClientId        = $appClientId
        EncryptedSecret = $encrypted
        SecretExpiry    = $secretExpiry
        AppName         = $appName
        CreatedDate     = (Get-Date).ToString("yyyy-MM-dd")
    }
    if ($provConfig.PrimaryDomain) { $config.PrimaryDomain = $provConfig.PrimaryDomain }
    if ($provConfig.Region)        { $config.Region        = $provConfig.Region }
    $configPath = Join-Path $agentsRoot "certifier\config.json"
    $config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
    Write-Log ("Config written to: " + $configPath) "ACTION"
}

Write-Log "Done -- Certifier agent provisioned with its own least-privilege identity"
