<#
.SYNOPSIS
    Creates permanent eligible PIM group member assignments for all JML agent
    service principals.

.DESCRIPTION
    Uses a raw OAuth 2.0 device-code flow + Invoke-RestMethod instead of the
    Graph PowerShell SDK. The SDK's Invoke-MgGraphRequest throws a NullReference
    when silently refreshing a device-code token in some module versions; the
    raw bearer-token path avoids that entirely.

    Run with an account holding Privileged Role Administrator (or Global Admin).

.EXAMPLE
    .\New-PIMEligibilityAssignments.ps1
#>

$ErrorActionPreference = "Stop"
$agentsRoot = Split-Path $PSScriptRoot -Parent

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [$Status] $Message")
}

$pimCfg    = Get-Content (Join-Path $agentsRoot "shared\pim-config.json") | ConvertFrom-Json
$joinerCfg = Get-Content (Join-Path $agentsRoot "joiner\config.json") | ConvertFrom-Json
$tenantId  = $joinerCfg.TenantId

# Microsoft Graph Command Line Tools - well-known public client that supports
# device code flow and the PrivilegedAccess delegated scopes.
$clientId  = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
$scope     = "https://graph.microsoft.com/.default offline_access"

# ── Device code request ──────────────────────────────────────────────────────
Write-Log "Requesting device code..."
$dc = Invoke-RestMethod -Method POST `
    -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/devicecode" `
    -Body @{ client_id = $clientId; scope = $scope }

Write-Host ""
Write-Host "================================================================"
Write-Host " $($dc.message)"
Write-Host "================================================================"
Write-Host ""

# ── Poll for token ───────────────────────────────────────────────────────────
$token   = $null
$interval = [int]$dc.interval
if ($interval -lt 5) { $interval = 5 }
$deadline = (Get-Date).AddSeconds([int]$dc.expires_in)

Write-Log "Waiting for you to authenticate in the browser..."
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $interval
    try {
        $tok = Invoke-RestMethod -Method POST `
            -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token" `
            -Body @{
                grant_type  = "urn:ietf:params:oauth:grant-type:device_code"
                client_id   = $clientId
                device_code = $dc.device_code
            } -ErrorAction Stop
        $token = $tok.access_token
        break
    } catch {
        $detail = $null
        try { $detail = $_.ErrorDetails.Message | ConvertFrom-Json } catch {}
        $code = if ($detail) { $detail.error } else { "" }
        if ($code -eq "authorization_pending") { continue }
        elseif ($code -eq "slow_down")          { $interval += 5; continue }
        else { Write-Log ("Auth error: " + $code + " - " + ($detail.error_description)) "ERROR"; throw }
    }
}

if (-not $token) { Write-Log "Device code expired before authentication. Re-run." "ERROR"; exit 1 }
Write-Log "Authenticated. Access token acquired."

$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$base    = "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group"

# PS 5.1 puts the HTTP error body in the response stream, not ErrorDetails.Message.
# This helper reads it back so failures show the real Graph error instead of a
# misleading "InputObject is null" from ConvertFrom-Json choking on $null.
function Get-RestError {
    param($ErrorRecord)
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return $ErrorRecord.ErrorDetails.Message
    }
    try {
        $resp = $ErrorRecord.Exception.Response
        if ($resp) {
            $stream = $resp.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $reader.BaseStream.Position = 0
            $reader.DiscardBufferedData()
            return $reader.ReadToEnd()
        }
    } catch {}
    return $ErrorRecord.Exception.Message
}

# ── Create eligible assignments ──────────────────────────────────────────────
$created = 0; $existed = 0; $failed = 0

foreach ($agentName in @("joiner","mover","leaver","enroller")) {
    $agentCfg = $pimCfg.agents.$agentName
    if (-not $agentCfg) { continue }
    $principalId = $agentCfg.objectId

    foreach ($groupName in $agentCfg.requiredGroups) {
        $groupId = $pimCfg.groups.$groupName.groupId
        if (-not $groupId) { continue }

        # Skip if an eligibility schedule already exists
        $exists = $false
        try {
            $filter = "groupId eq '$groupId' and principalId eq '$principalId' and accessId eq 'member'"
            $r = Invoke-RestMethod -Method GET -Headers $headers -Uri "$base/eligibilitySchedules?`$filter=$filter"
            if ($r.value.Count -gt 0) { $exists = $true }
        } catch { }

        if ($exists) {
            Write-Log "  $agentName -> $groupName : already eligible" "INFO"
            $existed++
            continue
        }

        $body = @{
            accessId      = "member"
            principalId   = $principalId
            groupId       = $groupId
            action        = "adminAssign"
            justification = "JML agent permanent eligible PIM assignment"
            scheduleInfo  = @{ startDateTime = $null; expiration = @{ type = "noExpiration" } }
        } | ConvertTo-Json -Depth 5

        try {
            $resp = Invoke-RestMethod -Method POST -Headers $headers `
                -Uri "$base/eligibilityScheduleRequests" -Body $body
            Write-Log "  $agentName -> $groupName : CREATED (status=$($resp.status))" "ACTION"
            $created++
        } catch {
            $raw = Get-RestError $_
            $msg = $raw
            try { $msg = ($raw | ConvertFrom-Json).error.message } catch {}
            if ($msg -like "*already*" -or $msg -like "*AlreadyExists*") {
                Write-Log "  $agentName -> $groupName : already eligible" "INFO"; $existed++
            } else {
                Write-Log "  $agentName -> $groupName : FAILED - $msg" "ERROR"; $failed++
            }
        }
    }
}

Write-Host ""
Write-Log "Summary: $created created, $existed already existed, $failed failed." "ACTION"
if ($failed -gt 0) { exit 1 }
Write-Log "All agent PIM eligibility assignments are in place."
