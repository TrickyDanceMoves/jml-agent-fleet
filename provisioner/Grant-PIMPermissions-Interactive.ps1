<#
.SYNOPSIS
    Grants PIM permissions using interactive (device code) sign-in, then
    generates a certificate for the Provisioner app so DPAPI is never needed again.

    Run once. The signed-in account must be Application Administrator or Global Admin.
#>

$ErrorActionPreference = "Stop"
$agentsRoot = Split-Path $PSScriptRoot -Parent
$provisionerConfig = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json

# ── Step 1: Device code flow via raw OAuth 2.0 (no MSAL dependency) ──────────
Write-Host "`n[Setup] Requesting device code..." -ForegroundColor Cyan

$tenantId  = $provisionerConfig.TenantId
$clientId  = "14d82eec-204b-4c2f-b7e8-296a70dab67e"   # Microsoft Graph PowerShell — pre-consented in tenant
$scope     = "https://graph.microsoft.com/Application.ReadWrite.All " +
             "https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All " +
             "https://graph.microsoft.com/RoleManagement.ReadWrite.Directory"

$dcResponse = Invoke-RestMethod -Method POST `
    -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/devicecode" `
    -ContentType "application/x-www-form-urlencoded" `
    -Body "client_id=$clientId&scope=$([System.Uri]::EscapeDataString($scope))"

Write-Host "`n$($dcResponse.message)" -ForegroundColor Cyan

# Poll for token
$tokenUri    = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token"
$tokenBody   = "grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=$clientId&device_code=$($dcResponse.device_code)"
$pollSeconds = [int]$dcResponse.interval
$expires     = (Get-Date).AddSeconds([int]$dcResponse.expires_in)
$accessToken = $null

Write-Host "[Setup] Waiting for you to authenticate in the browser..." -ForegroundColor DarkGray

while ((Get-Date) -lt $expires) {
    Start-Sleep -Seconds $pollSeconds
    try {
        # Use HttpWebRequest directly — Invoke-RestMethod eats the response body on 400 in PS 5.1
        $req = [System.Net.HttpWebRequest]::Create($tokenUri)
        $req.Method = "POST"
        $req.ContentType = "application/x-www-form-urlencoded"
        $bodyBytes = [System.Text.Encoding]::ASCII.GetBytes($tokenBody)
        $req.ContentLength = $bodyBytes.Length
        $reqStream = $req.GetRequestStream()
        $reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
        $reqStream.Close()

        $resp    = $req.GetResponse()
        $reader  = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $result  = $reader.ReadToEnd() | ConvertFrom-Json
        $reader.Close(); $resp.Close()

        $accessToken = $result.access_token
        Write-Host "[Setup] Authenticated." -ForegroundColor Green
        break

    } catch [System.Net.WebException] {
        $httpResp = $_.Exception.Response -as [System.Net.HttpWebResponse]
        if ($httpResp) {
            $reader  = New-Object System.IO.StreamReader($httpResp.GetResponseStream())
            $errBody = $reader.ReadToEnd() | ConvertFrom-Json
            $reader.Close(); $httpResp.Close()
            if ($errBody.error -eq "authorization_pending") { continue }
            if ($errBody.error -eq "slow_down") { $pollSeconds += 5; continue }
            throw "Authentication failed: $($errBody.error) - $($errBody.error_description)"
        }
        throw
    }
}
if (-not $accessToken) { throw "[Setup] Authentication timed out." }

# ── Helper: all Graph calls use Invoke-RestMethod with bearer token ───────────
function Invoke-Graph {
    param([string]$Method, [string]$Uri, [object]$Body)
    $headers = @{ Authorization = "Bearer $accessToken"; "Content-Type" = "application/json" }
    $params  = @{ Method = $Method; Uri = $Uri; Headers = $headers; ErrorAction = "Stop" }
    if ($Body) { $params["Body"] = ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod @params
}

# ── Step 2: Resolve Microsoft Graph SP and role IDs ──────────────────────────
$graphSP   = (Invoke-Graph -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles").value[0]
$graphSpId = $graphSP.id

$neededPermissions = @(
    "RoleManagement.ReadWrite.Directory",
    "PrivilegedAccess.ReadWrite.AzureADGroup",
    "Group.ReadWrite.All"
)
$roleMap = @{}
foreach ($role in $graphSP.appRoles) {
    if ($neededPermissions -contains $role.value) { $roleMap[$role.value] = $role.id }
}
Write-Host "[Setup] Resolved Graph SP: $graphSpId"
$roleMap.GetEnumerator() | ForEach-Object { Write-Host "  $($_.Key) = $($_.Value)" }

function Grant-AppPermission {
    param([string]$SpObjectId, [string]$AppName, [string]$Permission)
    $appRoleId = $roleMap[$Permission]
    if (-not $appRoleId) { Write-Host "  SKIP $AppName - could not resolve $Permission" -ForegroundColor Yellow; return }
    $existing = (Invoke-Graph -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignments").value
    if ($existing | Where-Object { $_.appRoleId -eq $appRoleId -and $_.resourceId -eq $graphSpId }) {
        Write-Host "  $AppName already has $Permission" -ForegroundColor Yellow; return
    }
    $body = @{ principalId = $SpObjectId; resourceId = $graphSpId; appRoleId = $appRoleId }
    Invoke-Graph -Method POST -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignments" -Body $body | Out-Null
    Write-Host "  Granted $Permission to $AppName" -ForegroundColor Green
}

# ── Step 3: Grant permissions ─────────────────────────────────────────────────
$provisionerSpId = "dd691809-c93e-4fd7-8475-6e98b35e776d"
Write-Host "`n[Setup] Granting permissions to Provisioner..."
Grant-AppPermission $provisionerSpId "Provisioner" "RoleManagement.ReadWrite.Directory"
Grant-AppPermission $provisionerSpId "Provisioner" "PrivilegedAccess.ReadWrite.AzureADGroup"
Grant-AppPermission $provisionerSpId "Provisioner" "Group.ReadWrite.All"

$agents = @{
    Joiner   = "<JOINER-SP-OBJECT-ID>"
    Mover    = "<MOVER-SP-OBJECT-ID>"
    Leaver   = "<LEAVER-SP-OBJECT-ID>"
    Enroller = "<ENROLLER-SP-OBJECT-ID>"
}
foreach ($a in $agents.GetEnumerator()) {
    Write-Host "`n[Setup] Granting PIM self-activation to $($a.Key)..."
    Grant-AppPermission $a.Value $a.Key "PrivilegedAccess.ReadWrite.AzureADGroup"
}

# ── Step 4: Generate cert for Provisioner, upload to app reg ─────────────────
Write-Host "`n[Setup] Generating certificate for Provisioner..." -ForegroundColor Cyan
$cert = New-SelfSignedCertificate `
    -Subject "CN=ClaudeAgentProvisioner" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyExportPolicy NonExportable `
    -KeySpec Signature `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(2)
Write-Host "[Setup] Certificate created: $($cert.Thumbprint)"

$certBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$certB64   = [System.Convert]::ToBase64String($certBytes)

$appReg   = (Invoke-Graph -Method GET -Uri "https://graph.microsoft.com/v1.0/applications?`$filter=appId eq '$($provisionerConfig.ClientId)'&`$select=id,displayName").value[0]
$appRegId = $appReg.id
Write-Host "[Setup] App registration object ID: $appRegId"

$keyPayload = @{
    keyCredentials = @(
        @{
            type        = "AsymmetricX509Cert"
            usage       = "Verify"
            displayName = "ClaudeAgentProvisioner-$((Get-Date -Format 'yyyy-MM-dd'))"
            key         = $certB64
        }
    )
}
Invoke-Graph -Method PATCH -Uri "https://graph.microsoft.com/v1.0/applications/$appRegId" -Body $keyPayload | Out-Null
Write-Host "[Setup] Certificate uploaded to app registration." -ForegroundColor Green

# ── Step 5: Update config.json with thumbprint, remove EncryptedSecret ────────
$updatedConfig = @{
    TenantId       = $provisionerConfig.TenantId
    ClientId       = $provisionerConfig.ClientId
    AppName        = $provisionerConfig.AppName
    CreatedDate    = $provisionerConfig.CreatedDate
    CertThumbprint = $cert.Thumbprint
}
$updatedConfig | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot "config.json") -Encoding UTF8
Write-Host "[Setup] config.json updated with CertThumbprint: $($cert.Thumbprint)" -ForegroundColor Green

Write-Host "`n[Setup] All done. Now run New-PIMGroups.ps1 -WhatIf" -ForegroundColor Cyan
