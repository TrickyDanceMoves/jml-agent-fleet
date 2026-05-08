param(
    [switch]$WhatIf
)

# ── Requirements ──────────────────────────────────────────────────────────────
# Requires Global Administrator or Application Administrator role.
# Run as a human admin (interactive auth). One-time setup.
#
# After this script completes you must do ONE manual step in the portal:
#   1. Go to https://compliance.microsoft.com
#   2. Data connectors → HR → Set up connector
#   3. Enter the ClientId and TenantId printed by this script
#   4. Complete the wizard — it shows a Job ID at the end
#   5. Paste the Job ID into agents/purview/config.json (JobId field)
#
# Reference: https://learn.microsoft.com/en-us/purview/import-hr-data

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    $color = switch ($Status) { "OK" { "Green" } "ACTION" { "Cyan" } "WARN" { "Yellow" } "ERROR" { "Red" } default { "White" } }
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message) -ForegroundColor $color
}

$agentsRoot  = Split-Path $PSScriptRoot -Parent
$purviewDir  = Join-Path $agentsRoot "purview"
$cfgPath     = Join-Path $purviewDir "config.json"
$provCfgPath = Join-Path $PSScriptRoot "config.json"

if ($WhatIf) { Write-Log "WhatIf mode -- no changes will be made" "WARN" }

# ── Connect as admin ──────────────────────────────────────────────────────────
$provConfig = Get-Content $provCfgPath | ConvertFrom-Json
Write-Log "Connecting interactively -- sign in with your Global Admin account"
Connect-MgGraph `
    -TenantId $provConfig.TenantId `
    -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All" `
    -NoWelcome
Write-Log "Connected" "OK"

# ── Create app registration ───────────────────────────────────────────────────
$appName = "JML-PurviewHRConnector"
Write-Log ("Checking for existing app registration: " + $appName)

$existing = Invoke-MgGraphRequest -Method GET `
    -Uri ("https://graph.microsoft.com/v1.0/applications?`$filter=displayName eq '" + $appName + "'&`$select=id,appId,displayName") `
    -ErrorAction Stop

$appId   = $null
$appObjId = $null

if ($existing.value.Count -gt 0) {
    $appObjId = $existing.value[0]["id"]
    $appId    = $existing.value[0]["appId"]
    Write-Log ("Reusing existing app: " + $appId) "WARN"
} else {
    if (-not $WhatIf) {
        $newApp = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/applications" `
            -Body (@{ displayName = $appName; signInAudience = "AzureADMyOrg" } | ConvertTo-Json) `
            -ContentType "application/json" -ErrorAction Stop
        $appObjId = $newApp["id"]
        $appId    = $newApp["appId"]
        Write-Log ("App registration created: " + $appId) "ACTION"
        Start-Sleep -Seconds 5  # propagation
    } else {
        Write-Log ("Would create app registration: " + $appName) "WARN"
        $appId = "<would-be-created>"
    }
}

# ── Create client secret ──────────────────────────────────────────────────────
$plainSecret = $null
if (-not $WhatIf -and $appObjId) {
    $secretResp = Invoke-MgGraphRequest -Method POST `
        -Uri ("https://graph.microsoft.com/v1.0/applications/" + $appObjId + "/addPassword") `
        -Body (@{
            passwordCredential = @{
                displayName = "JML HR Connector Secret"
                endDateTime = (Get-Date).AddYears(1).ToString("o")
            }
        } | ConvertTo-Json -Depth 3) `
        -ContentType "application/json" -ErrorAction Stop
    $plainSecret = $secretResp["secretText"]
    Write-Log "Client secret created (1 year expiry)" "ACTION"
}

# ── Create service principal ──────────────────────────────────────────────────
if (-not $WhatIf -and $appId -ne "<would-be-created>") {
    $spCheck = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '" + $appId + "'") `
        -ErrorAction Stop
    if ($spCheck.value.Count -eq 0) {
        Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/servicePrincipals" `
            -Body (@{ appId = $appId } | ConvertTo-Json) `
            -ContentType "application/json" -ErrorAction Stop | Out-Null
        Write-Log "Service principal created" "ACTION"
        Start-Sleep -Seconds 5
    } else {
        Write-Log "Service principal already exists" "OK"
    }
}

# ── Write purview/config.json ─────────────────────────────────────────────────
if (-not $WhatIf) {
    New-Item -ItemType Directory -Path $purviewDir -Force | Out-Null

    $encryptedSecret = $null
    if ($plainSecret) {
        $encryptedSecret = ConvertTo-SecureString $plainSecret -AsPlainText -Force |
            ConvertFrom-SecureString
    }

    $cfg = [ordered]@{
        TenantId        = $provConfig.TenantId
        ClientId        = $appId
        EncryptedSecret = $encryptedSecret
        SecretExpiry    = (Get-Date).AddYears(1).ToString("yyyy-MM-dd")
        JobId           = "<paste-job-id-from-compliance-portal>"
    }
    $cfg | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
    Write-Log ("Config written to: " + $cfgPath) "ACTION"
} else {
    Write-Log ("Would write config to: " + $cfgPath) "WARN"
}

Disconnect-MgGraph | Out-Null

# ── Next steps ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  App registration ready. One manual step remains:" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Open: https://compliance.microsoft.com" -ForegroundColor White
Write-Host "     Data connectors --> HR --> Set up connector" -ForegroundColor White
Write-Host ""
if (-not $WhatIf) {
    Write-Host ("  2. When prompted for app details, enter:") -ForegroundColor White
    Write-Host ("       Client ID  : " + $appId) -ForegroundColor Yellow
    Write-Host ("       Tenant ID  : " + $provConfig.TenantId) -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  3. Complete the wizard. At the end it shows a Job ID." -ForegroundColor White
Write-Host ("     Paste it into: " + $cfgPath) -ForegroundColor White
Write-Host "     (replace the <paste-job-id-from-compliance-portal> placeholder)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  4. Grant admin consent for the app in Entra:" -ForegroundColor White
Write-Host "     Entra Admin Center --> App registrations --> JML-PurviewHRConnector" -ForegroundColor White
Write-Host "     --> API permissions --> Grant admin consent" -ForegroundColor White
Write-Host ""
Write-Host "  Once the Job ID is set, the leaver agent will automatically" -ForegroundColor Green
Write-Host "  submit a Purview IRM termination record on every leaver run." -ForegroundColor Green
Write-Host ""
