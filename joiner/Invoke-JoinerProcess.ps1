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

# Load payload
Write-Log ("Loading joiner payload from: " + $PayloadPath)
if (-not (Test-Path $PayloadPath)) {
    Write-Log ("Payload file not found: " + $PayloadPath) "ERROR"
    exit 1
}
$payload = Get-Content $PayloadPath | ConvertFrom-Json

# Validate required fields
$required = @("givenName", "surname", "userPrincipalName", "department", "jobTitle", "usageLocation")
$missing  = @()
foreach ($field in $required) {
    if (-not $payload.$field) { $missing += $field }
}
if ($missing.Count -gt 0) {
    Write-Log ("Missing required fields: " + ($missing -join ", ")) "ERROR"
    Write-Host ""
    Write-Host "ACTION REQUIRED: Provide the following before re-submitting:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host ("  - " + $m) -ForegroundColor Yellow }
    exit 1
}

$mailNickname   = $payload.userPrincipalName.Split("@")[0]
$script:logFile = Join-Path $logsDir ($runId + "-" + $mailNickname + ".log")

# Connect
Import-Module Microsoft.Graph.Users
Write-Log "Loading joiner credentials"
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config
Write-Log "Connected to Microsoft Graph (AppOnly)"
Test-CredentialExpiry

# SoD check — validate incoming groups don't conflict with each other
$incomingGroups = @($payload.groups | Where-Object { $_ })
Write-Log "Running SoD check for incoming groups: $(if ($incomingGroups.Count) { $incomingGroups -join ', ' } else { '(none)' })"
$sodResult = & (Join-Path $agentsRoot "shared\Invoke-SoDCheck.ps1") `
    -UserPrincipalName $payload.userPrincipalName `
    -IncomingGroups $incomingGroups `
    -NewUser `
    -WhatIf:$WhatIf.IsPresent
Write-AuditEntry -Agent "joiner" -Action "SoDCheck" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent `
    -Outcome $(if ($sodResult.Passed) { "passed" } else { "blocked" }) `
    -Details @{ blocks = $sodResult.Blocks; warnings = $sodResult.Warnings; detail = $sodResult.Details }
if (-not $sodResult.Passed) {
    Write-Log ("SoD check BLOCKED provisioning: " + ($sodResult.Details -join "; ")) "ERROR"
    exit 1
}
if ($sodResult.Warnings.Count -gt 0) {
    Write-Log ("SoD warnings (proceeding): " + ($sodResult.Details -join "; ")) "WARN"
}

# Check user does not already exist
Write-Log ("Checking if user already exists: " + $payload.userPrincipalName)
$existingUser = $null
try { $existingUser = Get-MgUser -UserId $payload.userPrincipalName -ErrorAction Stop } catch { }
if ($existingUser) {
    Write-Log ("User already exists: " + $payload.userPrincipalName) "ERROR"
    Write-AuditEntry -Agent "joiner" -Action "JoinerProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = "User already exists" }
    exit 1
}
Write-Log "User does not exist - proceeding with creation"

$tempPassword = "Tmp!" + [System.Guid]::NewGuid().ToString("N").Substring(0, 10) + "1"
$displayName  = $payload.givenName + " " + $payload.surname

$results = [ordered]@{
    RunId          = $runId
    WhatIf         = $WhatIf.IsPresent
    Timestamp      = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    DisplayName    = $displayName
    UPN            = $payload.userPrincipalName
    ObjectId       = $null
    AccountCreated = $false
    ManagerSet     = $false
    LicensesAdded  = @()
    LicensesFailed = @()
    GroupsAdded    = @()
    GroupsFailed   = @()
    TempPassword   = $null
    Errors         = @()
}

# Step 1 - Create user
if (-not $WhatIf) {
    try {
        $newUserParams = @{
            DisplayName       = $displayName
            GivenName         = $payload.givenName
            Surname           = $payload.surname
            UserPrincipalName = $payload.userPrincipalName
            MailNickname      = $mailNickname
            Department        = $payload.department
            JobTitle          = $payload.jobTitle
            UsageLocation     = $payload.usageLocation
            AccountEnabled    = $true
            PasswordProfile   = @{
                Password                      = $tempPassword
                ForceChangePasswordNextSignIn = $true
            }
        }
        if ($payload.mobilePhone)    { $newUserParams["MobilePhone"]    = $payload.mobilePhone }
        if ($payload.officeLocation) { $newUserParams["OfficeLocation"] = $payload.officeLocation }

        $newUser = New-MgUser @newUserParams -ErrorAction Stop
        Write-Log ("User created: " + $displayName + " | ObjectId: " + $newUser.Id) "ACTION"
        $results.AccountCreated = $true
        $results.ObjectId       = $newUser.Id
        $results.TempPassword   = $tempPassword
    } catch {
        Write-Log ("User creation failed: " + $_.Exception.Message) "ERROR"
        $results.Errors += "User creation failed"
        Write-AuditEntry -Agent "joiner" -Action "JoinerProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome "failed" -Details @{ error = $_.Exception.Message }
        ($results | ConvertTo-Json -Depth 3) | Set-Content -Path (Join-Path $logsDir ($runId + "-" + $mailNickname + ".json"))
        exit 2
    }
} else {
    Write-Log ("Would create user: " + $displayName + " | UPN: " + $payload.userPrincipalName) "WHATIF"
    Write-Log ("Department: " + $payload.department + " | JobTitle: " + $payload.jobTitle + " | UsageLocation: " + $payload.usageLocation) "WHATIF"
}

# Step 2 - Set manager
if ($payload.manager) {
    if (-not $WhatIf) {
        try {
            $manager    = Get-MgUser -UserId $payload.manager -Property "id" -ErrorAction Stop
            $managerRef = @{ "@odata.id" = "https://graph.microsoft.com/v1.0/users/" + $manager.Id }
            Invoke-GraphWithRetry -Method PUT `
                -Uri ("https://graph.microsoft.com/v1.0/users/" + $results.ObjectId + "/manager/`$ref") `
                -Body $managerRef | Out-Null
            Write-Log ("Manager set: " + $payload.manager) "ACTION"
            $results.ManagerSet = $true
        } catch {
            Write-Log ("Manager assignment failed: " + $_.Exception.Message) "WARN"
            $results.Errors += "Manager assignment failed"
        }
    } else {
        Write-Log ("Would set manager: " + $payload.manager) "WHATIF"
    }
}

# Step 3 - Assign licenses
if ($payload.licenses -and $payload.licenses.Count -gt 0) {
    if (-not $WhatIf) {
        try {
            $allSkus   = Invoke-GraphWithRetry -Method GET -Uri "https://graph.microsoft.com/v1.0/subscribedSkus"
            $skuLookup = @{}
            foreach ($sku in $allSkus.value) { $skuLookup[$sku.skuPartNumber] = $sku.skuId }

            $toAdd = @()
            foreach ($licName in $payload.licenses) {
                if ($skuLookup.ContainsKey($licName)) {
                    $toAdd += @{ skuId = $skuLookup[$licName] }
                } else {
                    Write-Log ("License SKU not found in tenant: " + $licName) "WARN"
                    $results.LicensesFailed += $licName
                    $results.Errors += ("License not found: " + $licName)
                }
            }
            if ($toAdd.Count -gt 0) {
                Set-AgentUserLicense -UserId $results.ObjectId -AddLicenses $toAdd
                $assigned = @($payload.licenses | Where-Object { $skuLookup.ContainsKey($_) })
                Write-Log ("Assigned " + $toAdd.Count + " license(s): " + ($assigned -join ", ")) "ACTION"
                $results.LicensesAdded = $assigned
            }
        } catch {
            Write-Log ("License assignment failed: " + $_.Exception.Message) "ERROR"
            $results.Errors += "License assignment failed"
        }
    } else {
        Write-Log ("Would assign licenses: " + ($payload.licenses -join ", ")) "WHATIF"
    }
}

# Step 4 - Add to groups
if ($payload.groups -and $payload.groups.Count -gt 0) {
    foreach ($groupName in $payload.groups) {
        if (-not $WhatIf) {
            try {
                $groupResp = Invoke-GraphWithRetry -Method GET `
                    -Uri ("https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq '" + $groupName + "'&`$select=id,displayName")
                if ($groupResp.value.Count -eq 0) {
                    Write-Log ("Group not found: " + $groupName) "WARN"
                    $results.GroupsFailed += $groupName
                    $results.Errors += ("Group not found: " + $groupName)
                } else {
                    $group = $groupResp.value[0]
                    # Idempotent add — a resumed joiner won't fail on a group the
                    # user is already in.
                    $st = Add-AgentGroupMember -GroupId $group["id"] -UserId $results.ObjectId
                    if ($st -eq 'already') { Write-Log ("Already a member, skipping: " + $groupName) "SKIP" }
                    else { Write-Log ("Added to group: " + $groupName) "ACTION" }
                    $results.GroupsAdded += $groupName
                }
            } catch {
                Write-Log ("Could not add to group " + $groupName + ": " + $_.Exception.Message) "WARN"
                $results.GroupsFailed += $groupName
            }
        } else {
            Write-Log ("Would add to group: " + $groupName) "WHATIF"
        }
    }
}

Write-Log "Joiner process complete"
$outcome = if ($results.Errors.Count -eq 0) { "success" } else { "partial" }
Write-AuditEntry -Agent "joiner" -Action "JoinerProcess" -Subject $payload.userPrincipalName -WhatIf $WhatIf.IsPresent -Outcome $outcome -Notify $true -Details @{
    ticketRef      = if ($payload.ticketRef) { $payload.ticketRef } else { "" }
    objectId       = $results.ObjectId
    accountCreated = $results.AccountCreated
    licensesAdded  = $results.LicensesAdded
    groupsAdded    = $results.GroupsAdded
    errors         = $results.Errors
}

$jsonOutput = $results | ConvertTo-Json -Depth 3
$jsonOutput | Set-Content -Path (Join-Path $logsDir ($runId + "-" + $mailNickname + ".json"))

Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host $jsonOutput
if ($results.TempPassword) {
    Write-Host ""
    Write-Host "Temp password written to log file only - deliver via secure channel." -ForegroundColor DarkGray
    Write-Host ("Log: " + $script:logFile) -ForegroundColor DarkGray
}

if ($results.Errors.Count -gt 0) {
    Write-Host ("Completed with " + $results.Errors.Count + " error(s)") -ForegroundColor Yellow
    exit 2
}
exit 0
