# Shared helper functions for JML agent scripts.
# Dot-source this AFTER setting $agentsRoot in the calling script.

# ── Audit log (hash-chained) ───────────────────────────────────────────────────
$script:AuditLogPath = Join-Path $agentsRoot "audit.jsonl"

function Get-AuditEntryHash {
    param([string]$JsonEntry)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonEntry)
    $sha   = [System.Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLower()
}

function Write-AuditEntry {
    param(
        [string]$Agent,
        [string]$Action,
        [string]$Subject,
        [bool]$WhatIf,
        [string]$Outcome,
        [hashtable]$Details = @{},
        [bool]$Notify = $false
    )
    try {
        $prevHash = "genesis"
        if (Test-Path $script:AuditLogPath) {
            $last = Get-Content $script:AuditLogPath -Tail 1 -ErrorAction SilentlyContinue
            if ($last) { try { $prevHash = Get-AuditEntryHash $last } catch {} }
        }

        $entry = [ordered]@{
            timestamp = (Get-Date -Format "o")
            agent     = $Agent
            action    = $Action
            subject   = $Subject
            whatif    = $WhatIf
            outcome   = $Outcome
            operator  = if ($env:JML_CONSOLE_OPERATOR) { $env:JML_CONSOLE_OPERATOR } else { $null }
            details   = $Details
            prevHash  = $prevHash
        }
        $json          = $entry | ConvertTo-Json -Compress
        $entry["hash"] = Get-AuditEntryHash $json
        $finalJson     = $entry | ConvertTo-Json -Compress
        Add-Content -Path $script:AuditLogPath -Value ($finalJson + "`n") -NoNewline

        # Secondary sink: Windows Application Event Log
        if (-not $WhatIf) {
            try {
                $evtSrc = "JMLAgents"
                if (-not [System.Diagnostics.EventLog]::SourceExists($evtSrc)) {
                    New-EventLog -LogName Application -Source $evtSrc -ErrorAction Stop
                }
                $evtType = switch ($Outcome) { "failed" { "Error" } "partial" { "Warning" } default { "Information" } }
                $evtId   = switch ($Agent) { "joiner" { 1001 } "mover" { 1002 } "leaver" { 1003 } "enroller" { 1004 } default { 1000 } }
                Write-EventLog -LogName Application -Source $evtSrc -EventId $evtId `
                    -EntryType $evtType -Message $finalJson -ErrorAction Stop
            } catch {}
        }

        # Teams notification for high-signal events
        if ($Notify -and -not $WhatIf) {
            $evtColor   = switch ($Outcome) { "success" { "00B050" } "partial" { "FFC000" } "failed" { "FF0000" } default { "0078D4" } }
            $ticketInfo = if ($Details.ticketRef) { $Details.ticketRef } else { "N/A" }
            Send-TeamsNotification `
                -Title  ("JML: " + $Agent.ToUpper() + " -- " + $Action) `
                -Message ($Subject + " | " + $Outcome.ToUpper()) `
                -Color  $evtColor `
                -Facts  @{ Agent = $Agent; Subject = $Subject; Outcome = $Outcome; Ticket = $ticketInfo }
        }
    } catch {}
}

# ── Agent authentication (cert or secret) ─────────────────────────────────────
function Connect-AgentGraph {
    param([Parameter(Mandatory = $true)]$Config)

    # ── Entra Agent ID (FMI) auth — opt-in, parallel path ────────────────────────
    # Selected only when config.json sets "AuthMode":"agentid". Credentials live on the
    # blueprint; the agent identity holds the Graph permissions. Two-step FMI exchange:
    #   1) blueprint authenticates (client_secret) for an exchange token scoped to the
    #      agent identity via fmi_path;
    #   2) that token is used as a client_assertion to mint the agent's Graph token.
    # The resulting token is handed to Connect-MgGraph -AccessToken. The cert/secret
    # paths below are untouched, so the working SP fleet is unaffected.
    if ($Config.AuthMode -eq 'agentid') {
        $tokenUri = "https://login.microsoftonline.com/$($Config.TenantId)/oauth2/v2.0/token"
        $bpSecure = ConvertTo-SecureString $Config.BlueprintSecret   # DPAPI-encrypted
        $bpPlain  = [System.Net.NetworkCredential]::new('', $bpSecure).Password

        $bpTok = Invoke-RestMethod -Method POST -Uri $tokenUri -Body @{
            client_id     = $Config.BlueprintAppId
            scope         = 'api://AzureADTokenExchange/.default'
            grant_type    = 'client_credentials'
            client_secret = $bpPlain
            fmi_path      = $Config.AgentAppId
        }
        $agTok = Invoke-RestMethod -Method POST -Uri $tokenUri -Body @{
            client_id             = $Config.AgentAppId
            scope                 = 'https://graph.microsoft.com/.default'
            grant_type            = 'client_credentials'
            client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
            client_assertion      = $bpTok.access_token
        }
        $graphToken = ConvertTo-SecureString $agTok.access_token -AsPlainText -Force
        Connect-MgGraph -AccessToken $graphToken -NoWelcome
        return
    }

    if ($Config.CertThumbprint) {
        Connect-MgGraph -TenantId $Config.TenantId -ClientId $Config.ClientId `
            -CertificateThumbprint $Config.CertThumbprint -NoWelcome
    } else {
        $secret = ConvertTo-SecureString $Config.EncryptedSecret
        $cred   = New-Object System.Management.Automation.PSCredential($Config.ClientId, $secret)
        Connect-MgGraph -TenantId $Config.TenantId -ClientSecretCredential $cred -NoWelcome
    }
}

# ── Circuit breaker ────────────────────────────────────────────────────────────
$script:CB_Failures  = 0
$script:CB_Threshold = 3
$script:CB_Open      = $false

function Invoke-WithCircuitBreaker {
    param([scriptblock]$Action, [string]$OperationName = "operation")
    if ($script:CB_Open) {
        Write-Log ("CIRCUIT OPEN: halting after " + $script:CB_Threshold + " consecutive failures") "ERROR"
        exit 2
    }
    try {
        $result = & $Action
        $script:CB_Failures = 0
        return $result
    } catch {
        $script:CB_Failures++
        Write-Log ("'" + $OperationName + "' failed (" + $script:CB_Failures + "/" + $script:CB_Threshold + "): " + $_.Exception.Message) "ERROR"
        if ($script:CB_Failures -ge $script:CB_Threshold) {
            $script:CB_Open = $true
            Write-Log "CIRCUIT BREAKER TRIPPED -- next failure will halt the process" "ERROR"
        }
        throw
    }
}

# ── Teams notifications ────────────────────────────────────────────────────────
function Send-TeamsNotification {
    param(
        [string]$Title,
        [string]$Message,
        [string]$Color  = "0078D4",
        [hashtable]$Facts = @{}
    )
    $cfgPath = Join-Path $agentsRoot "shared\notifications.json"
    if (-not (Test-Path $cfgPath)) { return }
    try {
        $cfg = Get-Content $cfgPath | ConvertFrom-Json
        if (-not $cfg.teamsWebhookUrl) { return }
        $body = @{
            "@type"    = "MessageCard"
            "@context" = "https://schema.org/extensions"
            themeColor = $Color
            summary    = $Title
            sections   = @(@{
                activityTitle = $Title
                activityText  = $Message
                facts         = @($Facts.GetEnumerator() | ForEach-Object { @{ name = $_.Key; value = [string]$_.Value } })
            })
        } | ConvertTo-Json -Depth 5
        Invoke-RestMethod -Uri $cfg.teamsWebhookUrl -Method POST -Body $body `
            -ContentType "application/json" -TimeoutSec 10 -ErrorAction Stop | Out-Null
    } catch {}  # Never let notification failure break the agent
}

# ── Credential expiry check ────────────────────────────────────────────────────
function Test-CredentialExpiry {
    param([int]$WarnDays = 60)
    $dirs = @("joiner","mover","leaver","enroller","approver","auditor","provisioner")
    foreach ($dir in $dirs) {
        $cfgPath = Join-Path $agentsRoot ($dir + "\config.json")
        if (-not (Test-Path $cfgPath)) { continue }
        try {
            $cfg = Get-Content $cfgPath | ConvertFrom-Json
            if ($cfg.SecretExpiry) {
                $days = ([datetime]$cfg.SecretExpiry - (Get-Date)).Days
                if ($days -le $WarnDays) {
                    Write-Log ("[EXPIRY] " + $dir + " credential expires in " + $days + " days (" + $cfg.SecretExpiry + ")") "WARN"
                }
            }
        } catch {}
    }
}

# ── Purview IRM HR Connector ───────────────────────────────────────────────────
function Submit-PurviewHREvent {
    param(
        [string]$UPN,
        [datetime]$EffectiveDate,
        [bool]$WhatIf = $false
    )
    $cfgPath = Join-Path $agentsRoot "purview\config.json"
    if (-not (Test-Path $cfgPath)) { return }

    try {
        $cfg = Get-Content $cfgPath | ConvertFrom-Json
        if (-not $cfg.JobId -or $cfg.JobId -eq "<paste-job-id-from-compliance-portal>") {
            Write-Log "Purview config has no JobId - skipping IRM submission. Run New-PurviewHRConnector.ps1 to complete setup." "WARN"
            return
        }
        if (-not $cfg.ClientId -or -not $cfg.TenantId -or -not $cfg.EncryptedSecret) {
            Write-Log "Purview config incomplete - skipping IRM submission" "WARN"
            return
        }

        if ($WhatIf) {
            Write-Log ("Would submit Purview IRM termination record for: " + $UPN + " (effective: " + $EffectiveDate.ToString("yyyy-MM-dd") + ")") "WHATIF"
            return
        }

        $plainSecret = [System.Net.NetworkCredential]::new("", (ConvertTo-SecureString $cfg.EncryptedSecret)).Password
        $tokenResp = Invoke-RestMethod `
            -Uri ("https://login.windows.net/" + $cfg.TenantId + "/oauth2/token?api-version=1.0") `
            -Method POST `
            -ContentType "application/x-www-form-urlencoded" `
            -Body @{
                grant_type    = "client_credentials"
                client_id     = $cfg.ClientId
                client_secret = $plainSecret
                resource      = "https://microsoft.onmicrosoft.com/86dfdabb-5089-4a0c-880a-cfa5a790c5b1"
                tenant_id     = $cfg.TenantId
            } -ErrorAction Stop

        $dateStr = $EffectiveDate.ToString("yyyy-MM-ddT00:00:00Z")
        $csvBody  = "EmailAddress,ResignationDate,LastWorkingDate`n" + $UPN + "," + $dateStr + "," + $dateStr
        $csvBytes = [System.Text.Encoding]::UTF8.GetBytes($csvBody)
        $csvFile  = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.csv'
        [System.IO.File]::WriteAllBytes($csvFile, $csvBytes)

        try {
            Add-Type -AssemblyName System.Net.Http
            $client  = New-Object System.Net.Http.HttpClient
            $client.DefaultRequestHeaders.Add("Authorization", "Bearer " + $tokenResp.access_token)
            $client.Timeout = New-Object System.TimeSpan(0, 0, 120)

            $content  = New-Object System.Net.Http.MultipartFormDataContent
            $stream   = [System.IO.File]::OpenRead($csvFile)
            $fileContent = New-Object System.Net.Http.StreamContent($stream)
            $content.Add($fileContent, "file", [System.IO.Path]::GetFileName($csvFile))

            $uri    = "https://webhook.ingestion.office.com/api/signals?jobid=" + $cfg.JobId
            $result = $client.PostAsync($uri, $content).Result

            $stream.Dispose()
            $client.Dispose()

            if (-not $result.IsSuccessStatusCode) {
                $body = $result.Content.ReadAsStringAsync().Result
                throw ("HTTP " + [int]$result.StatusCode + " - " + $result.ReasonPhrase + ": " + $body)
            }
        } finally {
            Remove-Item $csvFile -ErrorAction SilentlyContinue
        }

        Write-Log ("Purview IRM termination record submitted for: " + $UPN) "ACTION"
    } catch {
        # Never let Purview submission break the leaver process
        Write-Log ("Purview IRM submission failed (non-fatal): " + $_.Exception.Message) "WARN"
    }
}

# ── Graph with retry ───────────────────────────────────────────────────────────
function Invoke-GraphWithRetry {
    param(
        [string]$Method,
        [string]$Uri,
        $Body                = $null,
        [string]$ContentType = "application/json",
        [int]$MaxRetries     = 3
    )
    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            if ($null -ne $Body) {
                return Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body $Body -ContentType $ContentType -ErrorAction Stop
            } else {
                return Invoke-MgGraphRequest -Method $Method -Uri $Uri -ErrorAction Stop
            }
        } catch {
            $msg         = $_.Exception.Message
            $isRetryable = ($msg -match "429|TooManyRequests|throttl|503|504|ServiceUnavailable|GatewayTimeout")
            if ($attempt -ge $MaxRetries -or -not $isRetryable) { throw }
            $delay = [int][Math]::Pow(2, $attempt)
            Write-Log ("Graph transient error, retry in " + $delay + "s [" + $attempt + "/" + $MaxRetries + "]") "WARN"
            Start-Sleep -Seconds $delay
        }
    }
}

# ── License assignment (REST) ────────────────────────────────────────────────
# Uses the Graph /users/{id}/assignLicense action via Invoke-GraphWithRetry so
# the agents don't depend on the Microsoft.Graph.Users.Actions module (which
# provides Set-MgUserLicense and isn't always installed).
#   AddLicenses  : array of @{ skuId = <guid> } (disabledPlans optional)
#   RemoveSkuIds : array of skuId GUID strings
function Set-AgentUserLicense {
    param(
        [Parameter(Mandatory=$true)][string]$UserId,
        [array]$AddLicenses  = @(),
        [array]$RemoveSkuIds = @()
    )
    $add = @($AddLicenses | ForEach-Object {
        @{ skuId = $_.skuId; disabledPlans = @(if ($_.disabledPlans) { $_.disabledPlans } else { @() }) }
    })
    $body = @{ addLicenses = $add; removeLicenses = @($RemoveSkuIds) }
    Invoke-GraphWithRetry -Method POST `
        -Uri ("https://graph.microsoft.com/v1.0/users/" + $UserId + "/assignLicense") `
        -Body $body | Out-Null
}

# ── PIM for Groups -JIT role activation ──────────────────────────────────────

function Request-PIMActivation {
    <#
    .SYNOPSIS
        Activates the calling agent's eligible PIM group memberships before an operation.
    .PARAMETER AgentName
        Name of the agent (joiner, mover, leaver, enroller). Must match a key in pim-config.json.
    .PARAMETER Justification
        Human-readable reason, typically "JML <eventType> <ticketRef>".
    .PARAMETER DurationHours
        How long to hold the activation. Defaults to value in pim-config.json (1 hour).
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$AgentName,
        [string]$Justification = "JML automated operation",
        [int]$DurationHours = 0
    )

    $pimConfigPath = Join-Path $agentsRoot "shared\pim-config.json"
    if (-not (Test-Path $pimConfigPath)) {
        Write-Log "[PIM] pim-config.json not found -skipping PIM activation (permanent roles in use)" "WARN"
        return
    }

    $pimCfg   = Get-Content $pimConfigPath | ConvertFrom-Json
    $agentCfg = $pimCfg.agents.$AgentName
    if (-not $agentCfg) {
        Write-Log "[PIM] No PIM config entry for agent '$AgentName' -skipping" "WARN"
        return
    }

    $hours = if ($DurationHours -gt 0) { $DurationHours } else { $pimCfg.activationDurationHours }

    foreach ($groupName in $agentCfg.requiredGroups) {
        $groupId = $pimCfg.groups.$groupName.groupId
        if (-not $groupId) {
            Write-Log "[PIM] Group '$groupName' has no groupId -run New-PIMGroups.ps1 first" "WARN"
            continue
        }

        # Check if already actively assigned (avoid duplicate activation)
        $active = Invoke-MgGraphRequest -Method GET `
            -Uri "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentSchedules?`$filter=groupId eq '$groupId' and principalId eq '$($agentCfg.objectId)' and status eq 'Provisioned'"
        if ($active.value.Count -gt 0) {
            Write-Log "[PIM] Already active in '$groupName' -skipping activation" "INFO"
            continue
        }

        $body = @{
            accessId      = "member"
            principalId   = $agentCfg.objectId
            groupId       = $groupId
            action        = "selfActivate"
            justification = $Justification
            scheduleInfo  = @{
                startDateTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                expiration    = @{ type = "afterDuration"; duration = "PT${hours}H" }
            }
        }

        try {
            Invoke-MgGraphRequest -Method POST `
                -Uri "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests" `
                -Body ($body | ConvertTo-Json -Depth 5) | Out-Null
            Write-Log "[PIM] Activated '$groupName' for $hours hour(s) -$Justification" "INFO"
        } catch {
            Write-Log "[PIM] Failed to activate '$groupName': $($_.Exception.Message)" "ERROR"
            throw
        }
    }
}

function Remove-PIMActivation {
    <#
    .SYNOPSIS
        Explicitly deactivates the agent's PIM group memberships after an operation.
        Optional -activations also expire automatically per DurationHours.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$AgentName,
        [string]$Justification = "JML operation complete -self-deactivating"
    )

    $pimConfigPath = Join-Path $agentsRoot "shared\pim-config.json"
    if (-not (Test-Path $pimConfigPath)) { return }

    $pimCfg   = Get-Content $pimConfigPath | ConvertFrom-Json
    $agentCfg = $pimCfg.agents.$AgentName
    if (-not $agentCfg) { return }

    foreach ($groupName in $agentCfg.requiredGroups) {
        $groupId = $pimCfg.groups.$groupName.groupId
        if (-not $groupId) { continue }

        $body = @{
            accessId      = "member"
            principalId   = $agentCfg.objectId
            groupId       = $groupId
            action        = "selfDeactivate"
            justification = $Justification
        }

        try {
            Invoke-MgGraphRequest -Method POST `
                -Uri "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests" `
                -Body ($body | ConvertTo-Json -Depth 5) | Out-Null
            Write-Log "[PIM] Deactivated '$groupName'" "INFO"
        } catch {
            # Non-fatal -activation will expire on its own
            Write-Log "[PIM] Could not deactivate '$groupName' (will expire automatically): $($_.Exception.Message)" "WARN"
        }
    }
}
