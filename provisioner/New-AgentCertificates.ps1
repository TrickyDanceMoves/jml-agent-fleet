param([switch]$WhatIf)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message)
}

$agentsRoot       = Split-Path $PSScriptRoot -Parent
$provisionerObjId = "PROVISIONER-SP-OBJECT-ID-0000005a"

$targetAgents = @(
    @{ Name = "joiner";   AppClientId = "JOINER-APP-CLIENT-ID-00000000001"; CertSubject = "CN=JML-Joiner" },
    @{ Name = "mover";    AppClientId = "MOVER-APP-CLIENT-ID-000000000002"; CertSubject = "CN=JML-Mover" },
    @{ Name = "leaver";   AppClientId = "LEAVER-APP-CLIENT-ID-000000000003"; CertSubject = "CN=JML-Leaver" },
    @{ Name = "enroller"; AppClientId = "ENROLLER-APP-CLIENT-ID-00000000004"; CertSubject = "CN=JML-Enroller" },
    @{ Name = "approver"; AppClientId = "APPROVER-APP-CLIENT-ID-00000000005"; CertSubject = "CN=JML-Approver" },
    @{ Name = "auditor";  AppClientId = $null; CertSubject = "CN=JML-Auditor" }  # ClientId read from config.json
)

# ── Step 1: Enable Provisioner ────────────────────────────────────────────────
Import-Module Microsoft.Graph.Users -ErrorAction Stop
Write-Log "Connecting as Leaver to enable Provisioner"
$leaverConfig = Get-Content (Join-Path $agentsRoot "leaver\config.json") | ConvertFrom-Json
$leaverSecret  = ConvertTo-SecureString $leaverConfig.EncryptedSecret
$leaverCred    = New-Object System.Management.Automation.PSCredential($leaverConfig.ClientId, $leaverSecret)
Connect-MgGraph -TenantId $leaverConfig.TenantId -ClientSecretCredential $leaverCred -NoWelcome

if (-not $WhatIf) {
    Update-MgUser -UserId $provisionerObjId -AccountEnabled:$true -ErrorAction Stop
    Write-Log "Provisioner enabled" "ACTION"
} else {
    Write-Log "Would enable Provisioner" "WHATIF"
}
Disconnect-MgGraph | Out-Null

# ── Step 2: Connect as Provisioner ────────────────────────────────────────────
Write-Log "Connecting as Provisioner"
$provConfig = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$provSecret  = ConvertTo-SecureString $provConfig.EncryptedSecret
$provCred    = New-Object System.Management.Automation.PSCredential($provConfig.ClientId, $provSecret)
Connect-MgGraph -TenantId $provConfig.TenantId -ClientSecretCredential $provCred -NoWelcome
Write-Log "Connected as Provisioner"

# ── Step 3: Create/upload certs for each agent ────────────────────────────────
foreach ($agent in $targetAgents) {
    Write-Log ("Processing: " + $agent.Name)

    $configPath = Join-Path $agentsRoot ($agent.Name + "\config.json")
    if (-not (Test-Path $configPath)) {
        Write-Log ("  Config not found, skipping: " + $configPath) "WARN"
        continue
    }

    $agentConfig = Get-Content $configPath | ConvertFrom-Json
    $clientId    = if ($agent.AppClientId) { $agent.AppClientId } else { $agentConfig.ClientId }

    # Resolve app object ID
    $appResp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/applications?`$filter=appId eq '" + $clientId + "'&`$select=id,appId,displayName") `
        -ErrorAction Stop
    if ($appResp.value.Count -eq 0) {
        Write-Log ("  App registration not found for client ID: " + $clientId) "WARN"
        continue
    }
    $appObjectId = $appResp.value[0]["id"]
    Write-Log ("  App object ID: " + $appObjectId)

    if (-not $WhatIf) {
        # Remove any existing cert with same subject
        $existing = Get-ChildItem "Cert:\CurrentUser\My" | Where-Object { $_.Subject -eq $agent.CertSubject }
        foreach ($old in $existing) {
            Remove-Item -Path ("Cert:\CurrentUser\My\" + $old.Thumbprint) -ErrorAction SilentlyContinue
            Write-Log ("  Removed old cert: " + $old.Thumbprint)
        }

        # Create new self-signed cert
        $cert = New-SelfSignedCertificate `
            -Subject        $agent.CertSubject `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -KeyExportPolicy NonExportable `
            -KeySpec        Signature `
            -KeyAlgorithm   RSA `
            -KeyLength      2048 `
            -HashAlgorithm  SHA256 `
            -NotAfter       (Get-Date).AddYears(2)
        Write-Log ("  Certificate created: " + $cert.Thumbprint) "ACTION"

        # Upload public key to app registration
        $keyBase64 = [Convert]::ToBase64String($cert.RawData)
        $keyBody   = @{
            keyCredentials = @(@{
                type        = "AsymmetricX509Cert"
                usage       = "Verify"
                key         = $keyBase64
                displayName = ($agent.Name + "-cert-" + (Get-Date -Format "yyyyMMdd"))
                endDateTime = $cert.NotAfter.ToString("o")
            })
        }
        Invoke-MgGraphRequest -Method PATCH `
            -Uri ("https://graph.microsoft.com/v1.0/applications/" + $appObjectId) `
            -Body $keyBody -ContentType "application/json" -ErrorAction Stop | Out-Null
        Write-Log ("  Public key uploaded to app registration") "ACTION"

        # Update config.json: add CertThumbprint, keep EncryptedSecret as fallback
        $agentConfig | Add-Member -NotePropertyName "CertThumbprint" -NotePropertyValue $cert.Thumbprint -Force
        $agentConfig | Add-Member -NotePropertyName "CertExpiry" -NotePropertyValue $cert.NotAfter.ToString("yyyy-MM-dd") -Force
        $agentConfig | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
        Write-Log ("  Config updated with CertThumbprint") "ACTION"
    } else {
        Write-Log ("  Would create cert " + $agent.CertSubject + " and upload to app " + $appObjectId) "WHATIF"
    }
}

Disconnect-MgGraph | Out-Null

# ── Step 4: Disable Provisioner ───────────────────────────────────────────────
Write-Log "Reconnecting as Leaver to disable Provisioner"
Connect-MgGraph -TenantId $leaverConfig.TenantId -ClientSecretCredential $leaverCred -NoWelcome

if (-not $WhatIf) {
    Update-MgUser -UserId $provisionerObjId -AccountEnabled:$false -ErrorAction Stop
    Write-Log "Provisioner disabled" "ACTION"
} else {
    Write-Log "Would disable Provisioner" "WHATIF"
}
Disconnect-MgGraph | Out-Null

Write-Log "Done -- all agent certificates created and uploaded"
Write-Log "Agents will now authenticate via certificate when CertThumbprint is present in config.json"
