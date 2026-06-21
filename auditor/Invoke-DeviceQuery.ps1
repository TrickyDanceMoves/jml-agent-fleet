param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("UserDevices","DeviceDetail","StaleDevices")]
    [string]$QueryType,
    [string]$UpnOrName  = "",
    [string]$DeviceId   = "",
    [string]$DeviceName = "",
    [int]$Days = 90,
    [int]$TopN = 50
)

# Read-only device intelligence for the JML chat agents. Pairs an Entra device
# object (registered/owned) with its Intune managed-device record (compliance,
# last sync) so the agents can answer device-posture questions and resolve the
# right identifiers before a management action.
# Required Graph scopes (read): Device.Read.All, Directory.Read.All,
# DeviceManagementManagedDevices.Read.All.

$ErrorActionPreference = "Stop"

$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config 2>$null

function Get-AllPages {
    param([string]$Uri)
    $all = @()
    $resp = Invoke-MgGraphRequest -Method GET -Uri $Uri
    $all += $resp.value
    while ($resp."@odata.nextLink") {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $resp."@odata.nextLink"
        $all += $resp.value
    }
    return ,$all
}

# Snapshot Intune managed devices keyed by Azure AD device id so an Entra device
# can be enriched with compliance + sync state in one pass. Tolerates a tenant
# without Intune (returns an empty map instead of throwing).
function Get-ManagedDeviceMap {
    $map = @{}
    try {
        $mds = Get-AllPages "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?`$select=id,azureADDeviceId,deviceName,complianceState,managementAgent,operatingSystem,osVersion,lastSyncDateTime,enrolledDateTime,manufacturer,model,userPrincipalName,isEncrypted"
        foreach ($m in $mds) { if ($m["azureADDeviceId"]) { $map[$m["azureADDeviceId"]] = $m } }
    } catch {}
    return $map
}

function ConvertTo-DeviceRecord {
    param($Dev, $ManagedMap)
    $managed = $null
    if ($Dev["deviceId"] -and $ManagedMap.ContainsKey($Dev["deviceId"])) { $managed = $ManagedMap[$Dev["deviceId"]] }
    return @{
        id                  = $Dev["id"]            # Entra device object id (enable/disable/delete)
        deviceId            = $Dev["deviceId"]      # Azure AD device id
        managedDeviceId     = if ($managed) { $managed["id"] } else { $null }  # Intune id (retire/wipe/sync/rename)
        displayName         = $Dev["displayName"]
        operatingSystem     = $Dev["operatingSystem"]
        operatingSystemVersion = $Dev["operatingSystemVersion"]
        trustType           = $Dev["trustType"]
        accountEnabled      = $Dev["accountEnabled"]
        isManaged           = [bool]$managed
        isCompliant         = $Dev["isCompliant"]
        complianceState     = if ($managed) { $managed["complianceState"] } else { $null }
        managementAgent     = if ($managed) { $managed["managementAgent"] } else { $null }
        manufacturer        = if ($managed) { $managed["manufacturer"] } else { $null }
        model               = if ($managed) { $managed["model"] } else { $null }
        isEncrypted         = if ($managed) { $managed["isEncrypted"] } else { $null }
        lastSyncDateTime    = if ($managed) { $managed["lastSyncDateTime"] } else { $null }
        enrolledDateTime    = if ($managed) { $managed["enrolledDateTime"] } else { $null }
        approximateLastSignIn = $Dev["approximateLastSignInDateTime"]
        registrationDateTime  = $Dev["registrationDateTime"]
    }
}

$deviceSelect = "id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,accountEnabled,isCompliant,approximateLastSignInDateTime,registrationDateTime"

$result = $null

switch ($QueryType) {

    "UserDevices" {
        try {
            if (-not $UpnOrName) { throw "UpnOrName is required for UserDevices" }
            # Resolve the user (exact UPN, else display-name prefix).
            $uResp = Invoke-MgGraphRequest -Method GET `
                -Uri ("https://graph.microsoft.com/v1.0/users?`$filter=" + [uri]::EscapeDataString("userPrincipalName eq '" + $UpnOrName + "' or startswith(displayName,'" + $UpnOrName + "')") + "&`$select=id,displayName,userPrincipalName&`$top=1") `
                -Headers @{ ConsistencyLevel = "eventual" }
            if (-not $uResp.value -or $uResp.value.Count -eq 0) { throw ("User not found: " + $UpnOrName) }
            $u = $uResp.value[0]
            $managedMap = Get-ManagedDeviceMap

            $owned = Get-AllPages ("https://graph.microsoft.com/v1.0/users/" + $u["id"] + "/ownedDevices?`$select=" + $deviceSelect)
            $reg   = Get-AllPages ("https://graph.microsoft.com/v1.0/users/" + $u["id"] + "/registeredDevices?`$select=" + $deviceSelect)
            $seen  = @{}
            $devices = @()
            foreach ($d in (@($owned) + @($reg))) {
                if (-not $d -or -not $d["id"] -or $seen.ContainsKey($d["id"])) { continue }
                $seen[$d["id"]] = $true
                $devices += (ConvertTo-DeviceRecord -Dev $d -ManagedMap $managedMap)
            }
            $result = @{
                user        = @{ id = $u["id"]; displayName = $u["displayName"]; userPrincipalName = $u["userPrincipalName"] }
                count       = $devices.Count
                compliant   = @($devices | Where-Object { $_.complianceState -eq 'compliant' -or $_.isCompliant -eq $true }).Count
                noncompliant= @($devices | Where-Object { $_.complianceState -eq 'noncompliant' }).Count
                managed     = @($devices | Where-Object { $_.isManaged }).Count
                devices     = $devices
            }
        } catch { $result = @{ error = $_.Exception.Message } }
    }

    "DeviceDetail" {
        try {
            $managedMap = Get-ManagedDeviceMap
            $dev = $null
            if ($DeviceId) {
                # Accept either the Entra object id or the Azure AD deviceId.
                try { $dev = Invoke-MgGraphRequest -Method GET -Uri ("https://graph.microsoft.com/v1.0/devices/" + $DeviceId + "?`$select=" + $deviceSelect) } catch {}
                if (-not $dev) {
                    $r = Invoke-MgGraphRequest -Method GET -Uri ("https://graph.microsoft.com/v1.0/devices?`$filter=" + [uri]::EscapeDataString("deviceId eq '" + $DeviceId + "'") + "&`$select=" + $deviceSelect)
                    if ($r.value -and $r.value.Count -gt 0) { $dev = $r.value[0] }
                }
            } elseif ($DeviceName) {
                $r = Invoke-MgGraphRequest -Method GET -Uri ("https://graph.microsoft.com/v1.0/devices?`$filter=" + [uri]::EscapeDataString("displayName eq '" + $DeviceName + "'") + "&`$select=" + $deviceSelect + "&`$top=1")
                if ($r.value -and $r.value.Count -gt 0) { $dev = $r.value[0] }
            } else { throw "DeviceId or DeviceName is required for DeviceDetail" }
            if (-not $dev) { throw "Device not found" }
            $result = @{ device = (ConvertTo-DeviceRecord -Dev $dev -ManagedMap $managedMap) }
        } catch { $result = @{ error = $_.Exception.Message } }
    }

    "StaleDevices" {
        try {
            $cutoff = (Get-Date).AddDays(-$Days)
            $managedMap = Get-ManagedDeviceMap
            $all = Get-AllPages ("https://graph.microsoft.com/v1.0/devices?`$select=" + $deviceSelect + "&`$top=999")
            $stale = @($all | Where-Object {
                $_["approximateLastSignInDateTime"] -and ([datetime]$_["approximateLastSignInDateTime"]) -lt $cutoff
            } | Sort-Object { [datetime]$_["approximateLastSignInDateTime"] } | Select-Object -First $TopN)
            $result = @{
                days    = $Days
                count   = $stale.Count
                devices = @($stale | ForEach-Object { ConvertTo-DeviceRecord -Dev $_ -ManagedMap $managedMap })
            }
        } catch { $result = @{ error = $_.Exception.Message } }
    }
}

Disconnect-MgGraph 2>$null | Out-Null
Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
