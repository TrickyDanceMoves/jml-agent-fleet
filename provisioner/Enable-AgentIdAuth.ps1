<#
.SYNOPSIS
    Prepares the FMI (Federated Managed Identity) auth path for the JML agent
    identities: adds a client secret to the blueprint and emits the per-agent
    config block (BlueprintAppId, DPAPI-encrypted BlueprintSecret, AgentAppId)
    to paste into each read agent's config.json alongside "AuthMode":"agentid".

.DESCRIPTION
    Agent ID auth = credentials on the blueprint, permissions on the agent identity,
    two-step FMI token exchange (implemented in shared/Helpers.ps1 Connect-AgentGraph).
    Only the READ agents (Auditor, Approver) can run as agent identities — the write
    agents need scopes Entra blocks for agent identities (see agent-identity-roadmap.md).

    Admin device-code sign-in (Application.ReadWrite.All / Agent ID Administrator).
    The emitted BlueprintSecret is DPAPI-encrypted for THIS user on THIS machine,
    matching the existing EncryptedSecret pattern.

.EXAMPLE
    .\Enable-AgentIdAuth.ps1 -BlueprintAppId 3a27400e-f5d0-4ca2-9658-853eaf4a15e2
#>
param(
    [string]$BlueprintAppId = "3a27400e-f5d0-4ca2-9658-853eaf4a15e2"
)

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

$tenantId = (Get-Content (Join-Path $agentsRoot "joiner\config.json") -Raw | ConvertFrom-Json).TenantId
$clientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
# Blueprint credential writes are governed by the agent-identity scope, not the
# generic application scope — Application.ReadWrite.All alone gets
# Authorization_RequestDenied on .../agentIdentityBlueprint/addPassword.
$scope    = "https://graph.microsoft.com/AgentIdentityBlueprint.ReadWrite.All https://graph.microsoft.com/Application.ReadWrite.All offline_access openid profile"

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

# Resolve the blueprint application object id from its appId
$bp = (Invoke-RestMethod -Method GET -Headers $headers -Uri ("https://graph.microsoft.com/v1.0/applications?`$filter=appId eq '" + $BlueprintAppId + "'&`$select=id,appId,displayName")).value[0]
if (-not $bp) { Write-Log "Blueprint app $BlueprintAppId not found." "ERROR"; exit 1 }
Write-Log ("Blueprint: " + $bp.displayName + " (objId " + $bp.id + ")")

# Add a client secret to the blueprint (addPassword). Try the typed endpoint, then plain.
$secretText = $null
$pwBody = '{"passwordCredential":{"displayName":"JML FMI auth secret"}}'
foreach ($ep in @(
    ("https://graph.microsoft.com/v1.0/applications/" + $bp.id + "/microsoft.graph.agentIdentityBlueprint/addPassword"),
    ("https://graph.microsoft.com/v1.0/applications/" + $bp.id + "/addPassword")
)) {
    try {
        $pw = Invoke-RestMethod -Method POST -Headers $headers -Uri $ep -Body $pwBody
        $secretText = $pw.secretText
        Write-Log ("Secret added via " + ($ep -replace '.*/applications/[^/]+/', '.../')) "ACTION"
        break
    } catch {
        Write-Log ("addPassword failed at " + ($ep -replace '.*/applications/[^/]+/', '.../') + " : " + (Get-RestError $_)) "WARN"
    }
}
if (-not $secretText) { Write-Log "Could not add a blueprint secret. See errors above." "ERROR"; exit 1 }

# DPAPI-encrypt the secret for this user/machine (matches existing EncryptedSecret pattern)
$encSecret = ConvertTo-SecureString $secretText -AsPlainText -Force | ConvertFrom-SecureString

# Resolve each READ agent identity's appId (only these can run as agent identities)
$readAgents = @("JML Auditor Agent", "JML Approver Agent")
Write-Host ""
Write-Log "Config blocks to paste into each read agent's config.json:" "ACTION"
foreach ($name in $readAgents) {
    $sp = (Invoke-RestMethod -Method GET -Headers $headers -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=displayName eq '" + $name + "'&`$select=appId,displayName")).value[0]
    if (-not $sp) { Write-Log ("Agent identity not found: " + $name) "WARN"; continue }
    Write-Host ""
    Write-Host ("# " + $name + "  ->  config.json (e.g. auditor/ or approver/):")
    Write-Host ('  "AuthMode": "agentid",')
    Write-Host ('  "TenantId": "' + $tenantId + '",')
    Write-Host ('  "BlueprintAppId": "' + $BlueprintAppId + '",')
    Write-Host ('  "AgentAppId": "' + $sp.appId + '",')
    Write-Host ('  "BlueprintSecret": "' + $encSecret + '"')
}
Write-Host ""
Write-Log "Then validate Auditor: it will authenticate via the FMI path and run read queries." "INFO"
Write-Log "Keep the existing cert fields too - remove them only after the agent-id path is validated." "INFO"
