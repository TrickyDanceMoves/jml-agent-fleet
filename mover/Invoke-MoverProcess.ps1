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

Write-Log ("Loading mover payload from: " + $PayloadPath)
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
Write-Log "Loading mover credentials"
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config
Write-Log "Connected to Microsoft Graph (AppOnly)"
Test-CredentialExpiry

Write-Log ("Looking up user: " + $payload.userPrincipalName)
try {
    $user = Get-MgUser -UserId $payload.userPrincipalName `
        -Property "id,displayName,userPrincipalName,accountEnabled,department,jobTitle,officeLocation" `
        -ErrorAction Stop
} catch {
    Write-Log ("User not found: " + $payload.userPrincipalName) "ERROR"
    Write-AuditEntry -Agent "mover" -Action "MoverProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = "User not found" }
    exit 1
}
Write-Log ("Found: " + $user.DisplayName + " | Dept: " + $user.Department + " | Title: " + $user.JobTitle)

$results = [ordered]@{
    RunId             = $runId
    WhatIf            = $WhatIf.IsPresent
    Timestamp         = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    User              = $user.DisplayName
    UPN               = $user.UserPrincipalName
    ObjectId          = $user.Id
    AttributesUpdated = [ordered]@{}
    ManagerSet        = $false
    LicensesAdded     = @()
    LicensesRemoved   = @()
    LicensesFailed    = @()
    GroupsAdded       = @()
    GroupsRemoved     = @()
    GroupsFailed      = @()
    Errors            = @()
}

# Step 1 - Update user attributes
$updateParams = @{}
if ($payload.department)    { $updateParams["Department"]    = $payload.department }
if ($payload.jobTitle)      { $updateParams["JobTitle"]      = $payload.jobTitle }
if ($payload.officeLocation){ $updateParams["OfficeLocation"]= $payload.officeLocation }
if ($payload.mobilePhone)   { $updateParams["MobilePhone"]   = $payload.mobilePhone }
if ($payload.usageLocation) { $updateParams["UsageLocation"] = $payload.usageLocation }

if ($updateParams.Count -gt 0) {
    if (-not $WhatIf) {
        try {
            Update-MgUser -UserId $user.Id @updateParams -ErrorAction Stop
            foreach ($k in $updateParams.Keys) {
                Write-Log ("Updated " + $k + ": " + $updateParams[$k]) "ACTION"
                $results.AttributesUpdated[$k] = $updateParams[$k]
            }
        } catch {
            Write-Log ("Attribute update failed: " + $_.Exception.Message) "ERROR"
            $results.Errors += "Attribute update failed"
        }
    } else {
        foreach ($k in $updateParams.Keys) {
            Write-Log ("Would update " + $k + ": " + $updateParams[$k]) "WHATIF"
        }
    }
} else {
    Write-Log "No attribute updates specified - skipping"
}

# Step 2 - Set manager
if ($payload.manager) {
    if (-not $WhatIf) {
        try {
            $manager    = Get-MgUser -UserId $payload.manager -Property "id" -ErrorAction Stop
            $managerRef = @{ "@odata.id" = "https://graph.microsoft.com/v1.0/users/" + $manager.Id }
            Invoke-GraphWithRetry -Method PUT `
                -Uri ("https://graph.microsoft.com/v1.0/users/" + $user.Id + "/manager/`$ref") `
                -Body $managerRef | Out-Null
            Write-Log ("Manager updated: " + $payload.manager) "ACTION"
            $results.ManagerSet = $true
        } catch {
            Write-Log ("Manager update failed: " + $_.Exception.Message) "WARN"
            $results.Errors += "Manager update failed"
        }
    } else {
        Write-Log ("Would set manager: " + $payload.manager) "WHATIF"
    }
}

# Step 3 - Remove licenses
if ($payload.licensesToRemove -and $payload.licensesToRemove.Count -gt 0) {
    try {
        $currentLicenses = Get-MgUserLicenseDetail -UserId $user.Id -ErrorAction Stop
        $allSkus         = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/subscribedSkus"
        $skuLookup       = @{}
        foreach ($sku in $allSkus.value) { $skuLookup[$sku.skuPartNumber] = $sku.skuId }

        $toRemove = @()
        foreach ($licName in $payload.licensesToRemove) {
            if (-not $skuLookup.ContainsKey($licName)) {
                Write-Log ("License SKU not found in tenant: " + $licName) "WARN"
                $results.LicensesFailed += ("remove:" + $licName)
                continue
            }
            $skuId = $skuLookup[$licName]
            if ($currentLicenses | Where-Object { $_.SkuId -eq $skuId }) {
                $toRemove += $skuId
            } else {
                Write-Log ("License not assigned, skipping remove: " + $licName) "SKIP"
            }
        }

        if ($toRemove.Count -gt 0) {
            $removeNames = @($payload.licensesToRemove | Where-Object { $skuLookup.ContainsKey($_) -and ($toRemove -contains $skuLookup[$_]) })
            if (-not $WhatIf) {
                Set-MgUserLicense -UserId $user.Id -AddLicenses @() -RemoveLicenses $toRemove -ErrorAction Stop | Out-Null
                Write-Log ("Removed license(s): " + ($removeNames -join ", ")) "ACTION"
                $results.LicensesRemoved = $removeNames
            } else {
                Write-Log ("Would remove license(s): " + ($removeNames -join ", ")) "WHATIF"
            }
        }
    } catch {
        Write-Log ("License removal failed: " + $_.Exception.Message) "ERROR"
        $results.Errors += "License removal failed"
    }
}

# Step 4 - Add licenses
if ($payload.licensesToAdd -and $payload.licensesToAdd.Count -gt 0) {
    try {
        $allSkus   = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/subscribedSkus"
        $skuLookup = @{}
        foreach ($sku in $allSkus.value) { $skuLookup[$sku.skuPartNumber] = $sku.skuId }

        $toAdd = @()
        foreach ($licName in $payload.licensesToAdd) {
            if ($skuLookup.ContainsKey($licName)) {
                $toAdd += @{ skuId = $skuLookup[$licName] }
            } else {
                Write-Log ("License SKU not found in tenant: " + $licName) "WARN"
                $results.LicensesFailed += ("add:" + $licName)
                $results.Errors += ("License not found: " + $licName)
            }
        }

        if ($toAdd.Count -gt 0) {
            $addNames = @($payload.licensesToAdd | Where-Object { $skuLookup.ContainsKey($_) })
            if (-not $WhatIf) {
                Set-MgUserLicense -UserId $user.Id -AddLicenses $toAdd -RemoveLicenses @() -ErrorAction Stop | Out-Null
                Write-Log ("Added license(s): " + ($addNames -join ", ")) "ACTION"
                $results.LicensesAdded = $addNames
            } else {
                Write-Log ("Would add license(s): " + ($addNames -join ", ")) "WHATIF"
            }
        }
    } catch {
        Write-Log ("License assignment failed: " + $_.Exception.Message) "ERROR"
        $results.Errors += "License assignment failed"
    }
}

# Step 5 - Remove from groups
if ($payload.groupsToRemove -and $payload.groupsToRemove.Count -gt 0) {
    foreach ($groupName in $payload.groupsToRemove) {
        try {
            $groupResp = Invoke-GraphWithRetry -Method GET `
                -Uri ("https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq '" + $groupName + "'&`$select=id,displayName")
            if ($groupResp.value.Count -eq 0) {
                Write-Log ("Group not found: " + $groupName) "WARN"
                $results.GroupsFailed += ("remove:" + $groupName)
            } else {
                $group = $groupResp.value[0]
                if (-not $WhatIf) {
                    try {
                        Invoke-GraphWithRetry -Method DELETE `
                            -Uri ("https://graph.microsoft.com/v1.0/groups/" + $group["id"] + "/members/" + $user.Id + "/`$ref")
                        Write-Log ("Removed from group: " + $groupName) "ACTION"
                        $results.GroupsRemoved += $groupName
                    } catch {
                        Write-Log ("Could not remove from group " + $groupName + ": " + $_.Exception.Message) "WARN"
                        $results.GroupsFailed += ("remove:" + $groupName)
                    }
                } else {
                    Write-Log ("Would remove from group: " + $groupName) "WHATIF"
                }
            }
        } catch {
            Write-Log ("Group lookup failed for " + $groupName + ": " + $_.Exception.Message) "ERROR"
            $results.Errors += ("Group lookup failed: " + $groupName)
        }
    }
}

# Step 6 - Add to groups
if ($payload.groupsToAdd -and $payload.groupsToAdd.Count -gt 0) {
    foreach ($groupName in $payload.groupsToAdd) {
        try {
            $groupResp = Invoke-GraphWithRetry -Method GET `
                -Uri ("https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq '" + $groupName + "'&`$select=id,displayName")
            if ($groupResp.value.Count -eq 0) {
                Write-Log ("Group not found: " + $groupName) "WARN"
                $results.GroupsFailed += ("add:" + $groupName)
                $results.Errors += ("Group not found: " + $groupName)
            } else {
                $group     = $groupResp.value[0]
                $memberRef = @{ "@odata.id" = "https://graph.microsoft.com/v1.0/directoryObjects/" + $user.Id }
                if (-not $WhatIf) {
                    try {
                        Invoke-GraphWithRetry -Method POST `
                            -Uri ("https://graph.microsoft.com/v1.0/groups/" + $group["id"] + "/members/`$ref") `
                            -Body $memberRef | Out-Null
                        Write-Log ("Added to group: " + $groupName) "ACTION"
                        $results.GroupsAdded += $groupName
                    } catch {
                        Write-Log ("Could not add to group " + $groupName + ": " + $_.Exception.Message) "WARN"
                        $results.GroupsFailed += ("add:" + $groupName)
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

Write-Log "Mover process complete"
$outcome = if ($results.Errors.Count -eq 0) { "success" } else { "partial" }
Write-AuditEntry -Agent "mover" -Action "MoverProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome $outcome -Notify $true -Details @{
    ticketRef         = if ($payload.ticketRef) { $payload.ticketRef } else { "" }
    objectId          = $user.Id
    attributesUpdated = $results.AttributesUpdated
    licensesAdded     = $results.LicensesAdded
    licensesRemoved   = $results.LicensesRemoved
    groupsAdded       = $results.GroupsAdded
    groupsRemoved     = $results.GroupsRemoved
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
