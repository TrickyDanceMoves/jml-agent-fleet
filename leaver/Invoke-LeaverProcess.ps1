param(
    [Parameter(Mandatory = $true)]
    [string]$UserPrincipalName,
    [ValidateSet("Both", "Soft", "Hard")]
    [string]$Stage = "Both",
    [string]$TicketRef = "",
    [string]$OperatorRole = "admin",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$runId   = (Get-Date -Format "yyyyMMdd-HHmmss")
$logsDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$logFile = Join-Path $logsDir ($runId + "-" + $UserPrincipalName.Split("@")[0] + ".log")
$script:auditLog = @()

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    $entry = "[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message
    Write-Host $entry
    $script:auditLog += $entry
    Add-Content -Path $logFile -Value $entry
}

$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

Import-Module Microsoft.Graph.Users
Write-Log "Loading leaver credentials"
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config
Write-Log "Connected to Microsoft Graph (AppOnly)"
Test-CredentialExpiry

if ($TicketRef) { Write-Log ("Ticket reference: " + $TicketRef) "INFO" }
else { Write-Log "No ticket reference provided" "WARN" }

Write-Log ("Looking up user: " + $UserPrincipalName)
try {
    $user = Get-MgUser -UserId $UserPrincipalName `
        -Property "id,displayName,userPrincipalName,accountEnabled,department,jobTitle" `
        -ErrorAction Stop
} catch {
    Write-Log ("User not found: " + $UserPrincipalName) "ERROR"
    Write-AuditEntry -Agent "leaver" -Action "LeaverProcess" -Subject $UserPrincipalName -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = "User not found" }
    exit 1
}
Write-Log ("Found: " + $user.DisplayName + " | Enabled: " + $user.AccountEnabled)

$memberOf       = Invoke-GraphWithRetry -Method GET -Uri ("https://graph.microsoft.com/v1.0/users/" + $user.Id + "/memberOf")
$directoryRoles = @($memberOf.value | Where-Object { $_."@odata.type" -eq "#microsoft.graph.directoryRole" })
if ($directoryRoles.Count -gt 0) {
    $roleRefs = ($directoryRoles | ForEach-Object { if ($_["roleTemplateId"]) { $_["roleTemplateId"] } else { $_["id"] } }) -join ", "
    Write-Log ("User holds " + $directoryRoles.Count + " directory role(s) [" + $roleRefs + "]") "WARN"
    if ($OperatorRole -ne "admin") {
        $roleNames = ($directoryRoles | ForEach-Object { $_.displayName }) -join ", "
        Write-Log ("BLOCKED: Operator role '" + $OperatorRole + "' cannot offboard a directory role holder (" + $roleNames + "). Escalate to an admin operator.") "ERROR"
        Write-AuditEntry -Agent "leaver" -Action "LeaverBlocked" -Subject $UserPrincipalName -WhatIf $WhatIf.IsPresent -Outcome "blocked" -Details @{ reason = "Non-admin operator attempted offboard of directory role holder"; roles = $roleNames; operatorRole = $OperatorRole }
        exit 1
    }
}

$results = [ordered]@{
    RunId             = $runId
    WhatIf            = $WhatIf.IsPresent
    Stage             = $Stage
    Timestamp         = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    User              = $user.DisplayName
    UPN               = $user.UserPrincipalName
    ObjectId          = $user.Id
    HasDirectoryRoles = ($directoryRoles.Count -gt 0)
    AccountDisabled   = $false
    SessionsRevoked   = $false
    LicensesRemoved   = @()
    LicensesSkipped   = @()
    GroupsRemoved     = @()
    GroupsFailed      = @()
    Errors            = @()
}

# Steps 2-3: Soft stage (disable + revoke) — skipped when Stage = "Hard"
if ($Stage -ne "Hard") {

# Step 2 - Disable account
if ($user.AccountEnabled) {
    if (-not $WhatIf) {
        try {
            Update-MgUser -UserId $user.Id -AccountEnabled:$false -ErrorAction Stop
            Write-Log "Account disabled" "ACTION"
            $results.AccountDisabled = $true
        } catch {
            if ($directoryRoles.Count -gt 0) {
                Write-Log ("Account disable skipped - user holds privileged directory role(s): " + (($directoryRoles | ForEach-Object { $_.displayName }) -join ", ")) "WARN"
                $results.Errors += "SKIPPED: Account disable - privileged role holder requires manual intervention"
            } else {
                Write-Log ("Account disable failed: " + $_.Exception.Message) "ERROR"
                $results.Errors += "Account disable failed - manual intervention required"
            }
        }
    } else {
        Write-Log "Would disable account" "WHATIF"
    }
} else {
    Write-Log "Account already disabled - skipping" "SKIP"
    $results.AccountDisabled = $true
}

# Step 3 - Revoke sessions
if (-not $WhatIf) {
    try {
        Invoke-GraphWithRetry -Method POST `
            -Uri ("https://graph.microsoft.com/v1.0/users/" + $user.Id + "/revokeSignInSessions") | Out-Null
        Write-Log "All sign-in sessions revoked" "ACTION"
        $results.SessionsRevoked = $true
    } catch {
        Write-Log ("Session revocation failed: " + $_.Exception.Message) "ERROR"
        $results.Errors += "Session revocation failed"
    }
} else {
    Write-Log "Would revoke all sign-in sessions" "WHATIF"
}

} # end Stage -ne "Hard"

# Steps 4-5: Hard stage (licenses + groups) — skipped when Stage = "Soft"
if ($Stage -ne "Soft") {

# Step 4 - Remove licenses
try {
    $licenses = Get-MgUserLicenseDetail -UserId $user.Id -ErrorAction Stop
    if ($licenses.Count -gt 0) {
        $stateResp = Invoke-GraphWithRetry -Method GET `
            -Uri ("https://graph.microsoft.com/v1.0/users/" + $user.Id + "?`$select=licenseAssignmentStates")

        $removableSkuIds = @()
        foreach ($lic in $licenses) {
            $state = $stateResp.licenseAssignmentStates | Where-Object { $_.skuId -eq $lic.SkuId }
            if ($state -and $state.assignedByGroup) {
                Write-Log ("Skipping group-assigned license: " + $lic.SkuPartNumber + " (revoked on group removal)") "SKIP"
                $results.LicensesSkipped += $lic.SkuPartNumber
            } else {
                $removableSkuIds += $lic.SkuId
            }
        }

        if ($removableSkuIds.Count -gt 0) {
            $removableNames = @($licenses | Where-Object { $removableSkuIds -contains $_.SkuId } | Select-Object -ExpandProperty SkuPartNumber)
            if (-not $WhatIf) {
                try {
                    Set-MgUserLicense -UserId $user.Id -AddLicenses @() -RemoveLicenses $removableSkuIds -ErrorAction Stop | Out-Null
                    Write-Log ("Removed " + $removableSkuIds.Count + " directly-assigned license(s): " + ($removableNames -join ", ")) "ACTION"
                    $results.LicensesRemoved = $removableNames
                } catch {
                    Write-Log ("License removal failed: " + $_.Exception.Message) "ERROR"
                    $results.Errors += "License removal failed"
                }
            } else {
                Write-Log ("Would remove " + $removableSkuIds.Count + " directly-assigned license(s): " + ($removableNames -join ", ")) "WHATIF"
            }
        } else {
            Write-Log "No directly-assigned licenses to remove" "SKIP"
        }
    } else {
        Write-Log "No licenses assigned - skipping" "SKIP"
    }
} catch {
    Write-Log ("License lookup failed: " + $_.Exception.Message) "ERROR"
    $results.Errors += "License lookup failed"
}

# Step 5 - Remove from groups
try {
    $groupResp = Invoke-GraphWithRetry -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/users/" + $user.Id + "/memberOf/microsoft.graph.group?`$select=id,displayName")
    $groups = @($groupResp.value)
    Write-Log ("Found " + $groups.Count + " group membership(s)")

    foreach ($group in $groups) {
        if (-not $WhatIf) {
            try {
                Invoke-GraphWithRetry -Method DELETE `
                    -Uri ("https://graph.microsoft.com/v1.0/groups/" + $group.id + "/members/" + $user.Id + "/`$ref")
                Write-Log ("Removed from group: " + $group.displayName) "ACTION"
                $results.GroupsRemoved += $group.displayName
            } catch {
                Write-Log ("Could not remove from group " + $group.displayName + ": " + $_.Exception.Message) "WARN"
                $results.GroupsFailed += $group.displayName
            }
        } else {
            Write-Log ("Would remove from group: " + $group.displayName) "WHATIF"
        }
    }
} catch {
    Write-Log ("Group lookup failed: " + $_.Exception.Message) "ERROR"
    $results.Errors += "Group lookup failed"
}

} # end Stage -ne "Soft"

Write-Log "Leaver process complete"
$outcome = if ($results.Errors.Count -eq 0) { "success" } else { "partial" }
Write-AuditEntry -Agent "leaver" -Action "LeaverProcess" -Subject $UserPrincipalName -WhatIf $WhatIf.IsPresent -Outcome $outcome -Notify $true -Details @{
    ticketRef       = $TicketRef
    objectId        = $user.Id
    stage           = $Stage
    accountDisabled = $results.AccountDisabled
    sessionsRevoked = $results.SessionsRevoked
    licensesRemoved = $results.LicensesRemoved
    groupsRemoved   = $results.GroupsRemoved
    errors          = $results.Errors
}

# Step 6 - Submit Purview IRM termination record (non-fatal; skipped silently if purview/config.json absent)
Submit-PurviewHREvent -UPN $UserPrincipalName -EffectiveDate (Get-Date) -WhatIf $WhatIf.IsPresent

$jsonOutput = $results | ConvertTo-Json -Depth 3
$jsonOutput | Set-Content -Path (Join-Path $logsDir ($runId + "-" + $UserPrincipalName.Split("@")[0] + ".json"))

Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host $jsonOutput
Write-Host ("Log: " + $logFile) -ForegroundColor DarkGray

if ($results.HasDirectoryRoles -and (-not $results.AccountDisabled) -and (-not $WhatIf)) {
    Write-Host ""
    Write-Host "ACTION REQUIRED" -ForegroundColor Red
    Write-Host ("Completed, but skipped Privileged Role Holders.") -ForegroundColor Yellow
    Write-Host ("User '" + $results.User + "' holds directory roles that prevent automated disable.") -ForegroundColor Yellow
    Write-Host "Manually disable the account in Entra ID admin portal or via a Privileged Authentication Administrator." -ForegroundColor Yellow
    $roleRefs = ($directoryRoles | ForEach-Object { if ($_["roleTemplateId"]) { $_["roleTemplateId"] } else { $_["id"] } }) -join ", "
    Write-Host ("Role template IDs: " + $roleRefs) -ForegroundColor Yellow
    Write-Host "Look up these IDs in the Entra ID admin portal under Roles and Administrators." -ForegroundColor DarkGray
}

if ($results.Errors.Count -gt 0) {
    Write-Host ("Completed with " + $results.Errors.Count + " error(s)") -ForegroundColor Yellow
    exit 2
}
exit 0
