param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadPath,
    [switch]$WhatIf
)

# Device lifecycle actions for the JML fleet. Payload (JSON):
#   { action, deviceId?, deviceName?, managedDeviceId?, newName?, ticketRef? }
# action one of: enable | disable | sync | retire | wipe | delete | rename
#   enable/disable/delete -> Entra device object (/devices/{id})
#   sync/retire/wipe/rename -> Intune managed device (/deviceManagement/managedDevices/{id})
# Required Graph scopes (write): Device.ReadWrite.All, Directory.ReadWrite.All,
# DeviceManagementManagedDevices.PrivilegedOperations.All (wipe/retire),
# DeviceManagementManagedDevices.ReadWrite.All (sync/rename).

$ErrorActionPreference = "Stop"

$runId   = (Get-Date -Format "yyyyMMdd-HHmmss")
$logsDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$script:logFile  = $null
$script:auditLog = @()

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    $entry = "[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message
    Write-Host $entry
    $script:auditLog += $entry
    if ($script:logFile) { Add-Content -Path $script:logFile -Value $entry }
}

$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

if (-not (Test-Path $PayloadPath)) { Write-Log ("Payload file not found: " + $PayloadPath) "ERROR"; exit 1 }
$payload = Get-Content $PayloadPath | ConvertFrom-Json

$action = ([string]$payload.action).ToLower()
$validActions = @("enable","disable","sync","retire","wipe","delete","rename","restart","lock","bitlocker")
if ($validActions -notcontains $action) { Write-Log ("Invalid action: " + $payload.action) "ERROR"; exit 1 }
if ($action -eq "rename" -and -not $payload.newName) { Write-Log "rename requires newName" "ERROR"; exit 1 }
if (-not ($payload.deviceId -or $payload.deviceName -or $payload.managedDeviceId)) {
    Write-Log "One of deviceId, deviceName, or managedDeviceId is required" "ERROR"; exit 1
}

$script:logFile = Join-Path $logsDir ($runId + "-device-" + $action + ".log")

Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config
Write-Log "Connected to Microsoft Graph (AppOnly)"
Test-CredentialExpiry

# ── Resolve the Entra device object + its Intune managed-device id ───────────────
$entra = $null
try {
    if ($payload.deviceId) {
        try { $entra = Invoke-GraphWithRetry -Method GET -Uri ("https://graph.microsoft.com/v1.0/devices/" + $payload.deviceId + "?`$select=id,deviceId,displayName,accountEnabled") } catch {}
        if (-not $entra) {
            $r = Invoke-GraphWithRetry -Method GET -Uri ("https://graph.microsoft.com/v1.0/devices?`$filter=" + [uri]::EscapeDataString("deviceId eq '" + $payload.deviceId + "'") + "&`$select=id,deviceId,displayName,accountEnabled")
            if ($r.value -and $r.value.Count -gt 0) { $entra = $r.value[0] }
        }
    } elseif ($payload.deviceName) {
        $r = Invoke-GraphWithRetry -Method GET -Uri ("https://graph.microsoft.com/v1.0/devices?`$filter=" + [uri]::EscapeDataString("displayName eq '" + $payload.deviceName + "'") + "&`$select=id,deviceId,displayName,accountEnabled&`$top=1")
        if ($r.value -and $r.value.Count -gt 0) { $entra = $r.value[0] }
    }
} catch { Write-Log ("Device resolution failed: " + $_.Exception.Message) "WARN" }

$managedDeviceId = $payload.managedDeviceId
if (-not $managedDeviceId -and $entra -and $entra["deviceId"]) {
    try {
        $r = Invoke-GraphWithRetry -Method GET -Uri ("https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?`$filter=" + [uri]::EscapeDataString("azureADDeviceId eq '" + $entra["deviceId"] + "'") + "&`$select=id,deviceName")
        if ($r.value -and $r.value.Count -gt 0) { $managedDeviceId = $r.value[0]["id"] }
    } catch {}
}

$label = if ($entra) { $entra["displayName"] } elseif ($payload.deviceName) { $payload.deviceName } else { $payload.deviceId }
if (-not $entra -and -not $managedDeviceId) {
    Write-Log ("Device not found: " + $label) "ERROR"
    Write-AuditEntry -Agent "enroller" -Action ("device." + $action) -Subject ([string]$label) -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = "device not found" }
    exit 1
}

$entraId = if ($entra) { $entra["id"] } else { $null }
$entraActions = @("enable","disable","delete")
$intuneActions = @("sync","retire","wipe","rename","restart","lock","bitlocker")
if ($entraActions -contains $action -and -not $entraId) {
    Write-Log ("Action '" + $action + "' needs the Entra device object, which was not found for " + $label) "ERROR"; exit 1
}
if ($intuneActions -contains $action -and -not $managedDeviceId) {
    Write-Log ("Action '" + $action + "' needs an Intune managed device; '" + $label + "' is not Intune-managed") "ERROR"
    Write-AuditEntry -Agent "enroller" -Action ("device." + $action) -Subject ([string]$label) -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = "not Intune-managed" }
    exit 1
}

$result = [ordered]@{
    RunId           = $runId
    WhatIf          = $WhatIf.IsPresent
    Action          = $action
    Device          = $label
    DeviceId        = $entraId
    ManagedDeviceId = $managedDeviceId
    Outcome         = "pending"
    Errors          = @()
}

function Invoke-DeviceCall {
    param([string]$Method, [string]$Uri, $Body = $null)
    if ($WhatIf) { Write-Log ("Would call " + $Method + " " + $Uri) "WHATIF"; return }
    if ($null -ne $Body) { Invoke-GraphWithRetry -Method $Method -Uri $Uri -Body ($Body | ConvertTo-Json -Depth 4) | Out-Null }
    else { Invoke-GraphWithRetry -Method $Method -Uri $Uri | Out-Null }
}

$base   = "https://graph.microsoft.com/v1.0/devices/"
$mdBase = "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/"

try {
    switch ($action) {
        "enable"  { Invoke-DeviceCall -Method PATCH  -Uri ($base + $entraId) -Body @{ accountEnabled = $true };  Write-Log ("Enabled device: " + $label) "ACTION" }
        "disable" { Invoke-DeviceCall -Method PATCH  -Uri ($base + $entraId) -Body @{ accountEnabled = $false }; Write-Log ("Disabled device: " + $label) "ACTION" }
        "delete"  { Invoke-DeviceCall -Method DELETE -Uri ($base + $entraId); Write-Log ("Deleted device object: " + $label) "ACTION" }
        "sync"    { Invoke-DeviceCall -Method POST -Uri ($mdBase + $managedDeviceId + "/syncDevice"); Write-Log ("Sync requested: " + $label) "ACTION" }
        "restart" { Invoke-DeviceCall -Method POST -Uri ($mdBase + $managedDeviceId + "/rebootNow"); Write-Log ("Restart requested: " + $label) "ACTION" }
        "lock"    { Invoke-DeviceCall -Method POST -Uri ($mdBase + $managedDeviceId + "/remoteLock"); Write-Log ("Remote lock requested: " + $label) "ACTION" }
        "bitlocker" { Invoke-DeviceCall -Method POST -Uri ($mdBase + $managedDeviceId + "/rotateBitLockerKeys"); Write-Log ("BitLocker key rotation requested: " + $label) "ACTION" }
        "retire"  { Invoke-DeviceCall -Method POST -Uri ($mdBase + $managedDeviceId + "/retire");     Write-Log ("Retire (remove company data) requested: " + $label) "ACTION" }
        "wipe"    { Invoke-DeviceCall -Method POST -Uri ($mdBase + $managedDeviceId + "/wipe") -Body @{ keepEnrollmentData = $false; keepUserData = $false }; Write-Log ("Wipe (factory reset) requested: " + $label) "ACTION" }
        "rename"  { Invoke-DeviceCall -Method POST -Uri ($mdBase + $managedDeviceId + "/setDeviceName") -Body @{ deviceName = [string]$payload.newName }; Write-Log ("Rename requested: " + $label + " -> " + $payload.newName) "ACTION" }
    }
    $result.Outcome = if ($WhatIf) { "simulated" } else { "success" }
} catch {
    $result.Outcome = "failed"
    $result.Errors += $_.Exception.Message
    Write-Log ("Device action failed: " + $_.Exception.Message) "ERROR"
}

Write-AuditEntry -Agent "enroller" -Action ("device." + $action) -Subject ([string]$label) -WhatIf $WhatIf.IsPresent -Outcome $result.Outcome -Notify ($action -in @("wipe","delete","retire")) -Details @{
    ticketRef       = if ($payload.ticketRef) { $payload.ticketRef } else { "" }
    deviceId        = $entraId
    managedDeviceId = $managedDeviceId
    newName         = if ($payload.newName) { $payload.newName } else { $null }
    errors          = $result.Errors
}

$jsonOutput = $result | ConvertTo-Json -Depth 4
Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host $jsonOutput

if ($result.Outcome -eq "failed") { exit 1 }
exit 0
