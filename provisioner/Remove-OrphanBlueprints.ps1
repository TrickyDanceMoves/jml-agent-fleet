<#
.SYNOPSIS
    Deletes orphan "JML Agent Fleet Blueprint" applications left by failed
    New-AgentIdentities.ps1 runs, keeping the one that backs the live agent
    identities. Admin device-code sign-in (needs Agent ID Administrator role).

.EXAMPLE
    .\Remove-OrphanBlueprints.ps1            # WhatIf: lists what would be deleted
    .\Remove-OrphanBlueprints.ps1 -Execute   # actually delete orphans
#>
param(
    [string]$KeepAppId   = "3a27400e-f5d0-4ca2-9658-853eaf4a15e2",
    [string]$DisplayName = "JML Agent Fleet Blueprint",
    [switch]$Execute
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
        $r.BaseStream.Position = 0
        $r.DiscardBufferedData()
        return $r.ReadToEnd()
    } catch {}
    return $e.Exception.Message
}

$tenantId = (Get-Content (Join-Path $agentsRoot "joiner\config.json") -Raw | ConvertFrom-Json).TenantId
$clientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
$scope    = "https://graph.microsoft.com/Application.ReadWrite.All offline_access openid profile"

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

$filter = [uri]::EscapeDataString("displayName eq '$DisplayName'")
$uri    = "https://graph.microsoft.com/v1.0/applications?`$filter=$filter&`$select=id,appId,displayName,createdDateTime"
$apps   = (Invoke-RestMethod -Method GET -Headers $headers -Uri $uri).value
Write-Log ("Found " + $apps.Count + " '" + $DisplayName + "' app(s). Keeping appId " + $KeepAppId + ".")

$deleted = 0; $failed = 0
foreach ($a in $apps) {
    if ($a.appId -eq $KeepAppId) { Write-Log ("  KEEP   " + $a.appId); continue }
    if (-not $Execute) {
        Write-Log ("  WOULD DELETE  objId=" + $a.id + " appId=" + $a.appId + " (created " + $a.createdDateTime + ")") "WHATIF"
        continue
    }
    try {
        Invoke-RestMethod -Method DELETE -Headers $headers -Uri ("https://graph.microsoft.com/v1.0/applications/" + $a.id) | Out-Null
        Write-Log ("  DELETED  appId=" + $a.appId) "ACTION"
        $deleted++
    } catch {
        Write-Log ("  FAILED  appId=" + $a.appId + " : " + (Get-RestError $_)) "ERROR"
        $failed++
    }
}
if (-not $Execute) { Write-Log "WhatIf only - re-run with -Execute to delete." "WARN" }
else { Write-Log ("Done. $deleted deleted, $failed failed.") "ACTION" }
