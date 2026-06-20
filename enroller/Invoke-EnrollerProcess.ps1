param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadPath,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$runId   = (Get-Date -Format "yyyyMMdd-HHmmss")
$logsDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$script:logFile = $null
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

Write-Log ("Loading enroller payload from: " + $PayloadPath)
if (-not (Test-Path $PayloadPath)) {
    Write-Log ("Payload file not found: " + $PayloadPath) "ERROR"
    exit 1
}
$payload = Get-Content $PayloadPath | ConvertFrom-Json

if (-not $payload.userPrincipalName) {
    Write-Log "Missing required field: userPrincipalName" "ERROR"
    exit 1
}

$mailNickname   = $payload.userPrincipalName.Split("@")[0]
$script:logFile = Join-Path $logsDir ($runId + "-" + $mailNickname + ".log")

Import-Module Microsoft.Graph.Users
Write-Log "Loading enroller credentials"
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config
Write-Log "Connected to Microsoft Graph (AppOnly)"
Test-CredentialExpiry

# Step 1 - Verify user exists and is active (retry for propagation lag)
$retryMax = 6
$retryDelay = 10
$user = $null
for ($i = 1; $i -le $retryMax; $i++) {
    try {
        $user = Get-MgUser -UserId $payload.userPrincipalName `
            -Property "id,displayName,userPrincipalName,accountEnabled,department,jobTitle,usageLocation,createdDateTime" `
            -ErrorAction Stop
        break
    } catch {
        if ($i -eq $retryMax) {
            Write-Log ("User not found after " + $retryMax + " attempts: " + $payload.userPrincipalName) "ERROR"
            Write-AuditEntry -Agent "enroller" -Action "EnrollerProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = "User not found after retries" }
            exit 1
        }
        Write-Log ("User not yet visible in directory, retrying in " + $retryDelay + "s (attempt " + $i + "/" + $retryMax + ")") "WARN"
        Start-Sleep -Seconds $retryDelay
    }
}

Write-Log ("Found: " + $user.DisplayName + " | Enabled: " + $user.AccountEnabled + " | Created: " + $user.CreatedDateTime)

if (-not $user.AccountEnabled) {
    Write-Log ("Account is disabled - enrollment requires an active account") "ERROR"
    Write-AuditEntry -Agent "enroller" -Action "EnrollerProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = "Account disabled" }
    exit 1
}

$results = [ordered]@{
    RunId              = $runId
    WhatIf             = $WhatIf.IsPresent
    Timestamp          = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    User               = $user.DisplayName
    UPN                = $user.UserPrincipalName
    ObjectId           = $user.Id
    AccountVerified    = $true
    LicensesAdded      = @()
    LicensesFailed     = @()
    GroupsAdded        = @()
    GroupsFailed       = @()
    RegisteredDevices  = @()
    OwnedDevices       = @()
    Errors             = @()
}

# Step 2 - Assign enrollment-phase licenses
if ($payload.licenses -and $payload.licenses.Count -gt 0) {
    try {
        $allSkus   = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/subscribedSkus"
        $skuLookup = @{}
        foreach ($sku in $allSkus.value) { $skuLookup[$sku.skuPartNumber] = $sku.skuId }

        $currentLicenses = Get-MgUserLicenseDetail -UserId $user.Id -ErrorAction Stop
        $currentSkuIds   = @($currentLicenses | Select-Object -ExpandProperty SkuId)

        $toAdd = @()
        foreach ($licName in $payload.licenses) {
            if (-not $skuLookup.ContainsKey($licName)) {
                Write-Log ("License SKU not found in tenant: " + $licName) "WARN"
                $results.LicensesFailed += $licName
                $results.Errors += ("License not found: " + $licName)
                continue
            }
            $skuId = $skuLookup[$licName]
            if ($currentSkuIds -contains $skuId) {
                Write-Log ("License already assigned, skipping: " + $licName) "SKIP"
            } else {
                $toAdd += @{ skuId = $skuId }
            }
        }

        if ($toAdd.Count -gt 0) {
            $addNames = @($payload.licenses | Where-Object { $skuLookup.ContainsKey($_) -and ($currentSkuIds -notcontains $skuLookup[$_]) })
            if (-not $WhatIf) {
                Set-AgentUserLicense -UserId $user.Id -AddLicenses $toAdd
                Write-Log ("Assigned " + $toAdd.Count + " enrollment license(s): " + ($addNames -join ", ")) "ACTION"
                $results.LicensesAdded = $addNames
            } else {
                Write-Log ("Would assign enrollment license(s): " + ($addNames -join ", ")) "WHATIF"
            }
        }
    } catch {
        Write-Log ("License assignment failed: " + $_.Exception.Message) "ERROR"
        $results.Errors += "License assignment failed"
    }
}

# Step 3 - Add to enrollment groups
if ($payload.groups -and $payload.groups.Count -gt 0) {
    foreach ($groupName in $payload.groups) {
        try {
            $groupResp = Invoke-GraphWithRetry -Method GET `
                -Uri ("https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq '" + $groupName + "'&`$select=id,displayName")
            if ($groupResp.value.Count -eq 0) {
                Write-Log ("Group not found: " + $groupName) "WARN"
                $results.GroupsFailed += $groupName
                $results.Errors += ("Group not found: " + $groupName)
            } else {
                $group = $groupResp.value[0]
                if (-not $WhatIf) {
                    try {
                        # Idempotent add — a re-run of enrollment converges
                        # instead of failing on an existing membership.
                        $st = Add-AgentGroupMember -GroupId $group["id"] -UserId $user.Id
                        if ($st -eq 'already') { Write-Log ("Already a member, skipping: " + $groupName) "SKIP" }
                        else { Write-Log ("Added to group: " + $groupName) "ACTION" }
                        $results.GroupsAdded += $groupName
                    } catch {
                        Write-Log ("Could not add to group " + $groupName + ": " + $_.Exception.Message) "WARN"
                        $results.GroupsFailed += $groupName
                    }
                } else {
                    Write-Log ("Would add to group: " + $groupName) "WHATIF"
                }
            }
        } catch {
            Write-Log ("Group lookup failed for " + $groupName + ": " + $_.Exception.Message) "ERROR"
            $results.Errors += ("Group lookup failed: " + $groupName)
        }
    }
}

# Step 4 - Inventory registered and owned devices
try {
    $regResp = Invoke-GraphWithRetry -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/users/" + $user.Id + "/registeredDevices?`$select=id,displayName,operatingSystem,operatingSystemVersion,trustType,approximateLastSignInDateTime")
    $regDevices = @($regResp.value)
    if ($regDevices.Count -gt 0) {
        Write-Log ("Registered devices found: " + $regDevices.Count)
        foreach ($dev in $regDevices) {
            $devSummary = $dev["displayName"] + " (" + $dev["operatingSystem"] + " " + $dev["operatingSystemVersion"] + ") [" + $dev["trustType"] + "]"
            Write-Log ("  - " + $devSummary)
            $results.RegisteredDevices += $devSummary
        }
    } else {
        Write-Log "No registered devices found (user may not have signed in yet)"
    }
} catch {
    Write-Log ("Registered device lookup failed: " + $_.Exception.Message) "WARN"
}

try {
    $ownedResp = Invoke-GraphWithRetry -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/users/" + $user.Id + "/ownedDevices?`$select=id,displayName,operatingSystem,operatingSystemVersion,trustType")
    $ownedDevices = @($ownedResp.value)
    if ($ownedDevices.Count -gt 0) {
        Write-Log ("Owned devices found: " + $ownedDevices.Count)
        foreach ($dev in $ownedDevices) {
            $devSummary = $dev["displayName"] + " (" + $dev["operatingSystem"] + " " + $dev["operatingSystemVersion"] + ") [" + $dev["trustType"] + "]"
            Write-Log ("  - " + $devSummary)
            $results.OwnedDevices += $devSummary
        }
    } else {
        Write-Log "No owned devices found"
    }
} catch {
    Write-Log ("Owned device lookup failed: " + $_.Exception.Message) "WARN"
}

Write-Log "Enroller process complete"
$outcome = if ($results.Errors.Count -eq 0) { "success" } else { "partial" }
Write-AuditEntry -Agent "enroller" -Action "EnrollerProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome $outcome -Details @{
    ticketRef         = if ($payload.ticketRef) { $payload.ticketRef } else { "" }
    objectId          = $user.Id
    licensesAdded     = $results.LicensesAdded
    groupsAdded       = $results.GroupsAdded
    registeredDevices = $results.RegisteredDevices.Count
    ownedDevices      = $results.OwnedDevices.Count
    errors            = $results.Errors
}

$jsonOutput = $results | ConvertTo-Json -Depth 3
$jsonOutput | Set-Content -Path (Join-Path $logsDir ($runId + "-" + $mailNickname + ".json"))

Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host $jsonOutput
Write-Host ("Log: " + $script:logFile) -ForegroundColor DarkGray

if ($results.Errors.Count -gt 0) {
    Write-Host ("Completed with " + $results.Errors.Count + " error(s)") -ForegroundColor Yellow
    exit 2
}
exit 0
