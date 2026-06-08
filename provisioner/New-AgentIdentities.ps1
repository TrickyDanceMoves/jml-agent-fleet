<#
.SYNOPSIS
    Creates a Microsoft Entra Agent ID for each JML agent, so they can be compared
    against (and eventually replace) the current app-registration service principals.

.DESCRIPTION
    Entra Agent ID is GA (2026) and available to all Entra customers. Per Microsoft
    Learn, agent identities are a distinct service-principal subtype created NEW via
    Microsoft Graph — existing app registrations are NOT converted in place. Creation
    requires an agent identity blueprint + a human sponsor, and the caller needs the
    AgentIdentity.Create.All (or AgentIdentity.CreateAsManager) permission.

    This script uses an admin device-code sign-in (raw OAuth + Invoke-RestMethod, which
    avoids the Graph SDK device-code token bug) and prints the full Graph error body on
    failure, so if your tenant's schema differs from the documented surface the real
    response guides the next step. Run with -WhatIf first.

    NOTE: This performs privileged directory changes. Review with -WhatIf, then run for
    real with an account holding Global Administrator (or the Agent ID admin role).

.EXAMPLE
    .\New-AgentIdentities.ps1 -WhatIf
    .\New-AgentIdentities.ps1 -SponsorUpn admin@contoso.onmicrosoft.com
#>
param(
    [string]$SponsorUpn = "",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$agentsRoot = Split-Path $PSScriptRoot -Parent

function Write-Log { param([string]$m, [string]$s = "INFO") Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [$s] $m") }

function Get-RestError {
    param($e)
    if ($e.ErrorDetails -and $e.ErrorDetails.Message) { return $e.ErrorDetails.Message }
    try {
        $resp = $e.Exception.Response
        if ($resp) { $r = New-Object System.IO.StreamReader($resp.GetResponseStream()); $r.BaseStream.Position = 0; $r.DiscardBufferedData(); return $r.ReadToEnd() }
    } catch {}
    return $e.Exception.Message
}

$joinerCfg = Get-Content (Join-Path $agentsRoot "joiner\config.json") -Raw | ConvertFrom-Json
$tenantId  = $joinerCfg.TenantId
$clientId  = "14d82eec-204b-4c2f-b7e8-296a70dab67e"  # Microsoft Graph Command Line Tools
# Request the specific Agent ID scope so the admin consents to it at sign-in.
# (.default only yields already-consented scopes; the new AgentIdentity scope is not
#  pre-consented on the Graph CLI client, which is why creation returned
#  Authorization_RequestDenied even though the endpoint exists.)
$scope     = "https://graph.microsoft.com/AgentIdentity.Create.All https://graph.microsoft.com/User.Read.All offline_access openid profile"

# JML agents to mint Agent IDs for (display names + a stable tag)
$agents = @(
    @{ name = "JML Joiner Agent";   tag = "jml-joiner" },
    @{ name = "JML Mover Agent";    tag = "jml-mover" },
    @{ name = "JML Leaver Agent";   tag = "jml-leaver" },
    @{ name = "JML Enroller Agent"; tag = "jml-enroller" },
    @{ name = "JML Approver Agent"; tag = "jml-approver" },
    @{ name = "JML Auditor Agent";  tag = "jml-auditor" }
)

if ($WhatIf) {
    Write-Log "[WHATIF] Would create $($agents.Count) Entra Agent IDs:" "WHATIF"
    $agents | ForEach-Object { Write-Log ("  - " + $_.name + " (" + $_.tag + ")") "WHATIF" }
    Write-Log "[WHATIF] Each needs: agent identity blueprint + sponsor ($SponsorUpn). No changes made." "WHATIF"
    return
}

# ── Device-code admin sign-in (raw OAuth) ────────────────────────────────────
Write-Log "Requesting device code..."
$dc = Invoke-RestMethod -Method POST -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/devicecode" -Body @{ client_id = $clientId; scope = $scope }
Write-Host ""; Write-Host "================================================================"
Write-Host " $($dc.message)"
Write-Host "================================================================"; Write-Host ""

$token = $null; $interval = [Math]::Max(5, [int]$dc.interval); $deadline = (Get-Date).AddSeconds([int]$dc.expires_in)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $interval
    try {
        $tok = Invoke-RestMethod -Method POST -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token" -Body @{
            grant_type = "urn:ietf:params:oauth:grant-type:device_code"; client_id = $clientId; device_code = $dc.device_code
        } -ErrorAction Stop
        $token = $tok.access_token; break
    } catch {
        $c = $null; try { $c = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
        if ($c -eq "authorization_pending") { continue } elseif ($c -eq "slow_down") { $interval += 5; continue } else { throw }
    }
}
if (-not $token) { Write-Log "Device code expired." "ERROR"; exit 1 }
Write-Log "Authenticated."
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

# ── Resolve sponsor object id ────────────────────────────────────────────────
$sponsorId = $null
if ($SponsorUpn) {
    try {
        $sponsorUri = 'https://graph.microsoft.com/v1.0/users/' + $SponsorUpn + '?$select=id,displayName'
        $u = Invoke-RestMethod -Method GET -Headers $headers -Uri $sponsorUri
        $sponsorId = $u.id
        Write-Log "Sponsor: $($u.displayName) ($sponsorId)"
    } catch { Write-Log "Could not resolve sponsor '$SponsorUpn': $(Get-RestError $_)" "WARN" }
}

# ── Ensure an agent identity blueprint exists ────────────────────────────────
# The blueprint resource governs what the agent identity may do. Schema/endpoint may
# vary by tenant rollout; we attempt the documented surface and report the real error.
$blueprintId = $null
try {
    $bps = Invoke-RestMethod -Method GET -Headers $headers -Uri "https://graph.microsoft.com/beta/directory/agentIdentityBlueprints"
    if ($bps.value.Count -gt 0) { $blueprintId = $bps.value[0].id; Write-Log "Using existing blueprint $blueprintId" }
} catch {
    Write-Log ("Blueprint list endpoint returned: " + (Get-RestError $_)) "WARN"
    Write-Log "If this is a 'resource not found' error, your tenant may expose Agent ID under a different path or require portal-side blueprint creation first." "WARN"
}

# ── Create an Agent ID per JML agent ─────────────────────────────────────────
$created = 0; $failed = 0
foreach ($a in $agents) {
    Write-Log ("Creating Agent ID: " + $a.name + " ...")
    $body = @{ displayName = $a.name }
    if ($blueprintId) { $body.agentIdentityBlueprintId = $blueprintId }
    if ($sponsorId)   { $body.sponsors = @(@{ "@odata.id" = "https://graph.microsoft.com/v1.0/directoryObjects/$sponsorId" }) }
    try {
        $resp = Invoke-RestMethod -Method POST -Headers $headers `
            -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentity" `
            -Body ($body | ConvertTo-Json -Depth 5)
        Write-Log ("  CREATED: " + $a.name + " (id " + $resp.id + ")") "ACTION"
        $created++
    } catch {
        Write-Log ("  FAILED: " + (Get-RestError $_)) "ERROR"
        $failed++
    }
}

Write-Host ""
Write-Log "Summary: $created created, $failed failed." "ACTION"
if ($failed -gt 0) {
    Write-Log "If failures cite a permission, grant AgentIdentity.Create.All to the signed-in app and admin-consent it." "WARN"
    Write-Log "If failures cite an unknown segment, verify the current Agent ID Graph path on Microsoft Learn for your tenant's rollout." "WARN"
}
