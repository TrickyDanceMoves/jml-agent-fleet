<#
.SYNOPSIS
    Kill switch / containment for a JML agent identity. Disables the agent's
    service principal (blocks all token issuance immediately), optionally revokes
    its credentials, and writes a high-severity audit entry.

.DESCRIPTION
    Runs as the Provisioner (the only agent with Application.ReadWrite.All).
    Resolves the target agent's service principal by appId (from its config.json)
    and sets accountEnabled = false, which immediately blocks the agent from
    acquiring tokens. With -Revoke, also removes the SP's key/password credentials
    for a hard containment that survives re-enable until creds are re-provisioned.

.PARAMETER AgentName
    joiner | mover | leaver | enroller | approver | auditor | certifier | provisioner

.PARAMETER Reason
    Human-readable containment justification (recorded in the audit chain).

.PARAMETER Revoke
    Also strip credentials (hard kill), not just disable sign-in.

.PARAMETER WhatIf
    Report the action without performing it.

.EXAMPLE
    .\Invoke-AgentQuarantine.ps1 -AgentName leaver -Reason "anomalous bulk offboarding" -WhatIf
#>
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("joiner","mover","leaver","enroller","approver","auditor","certifier","provisioner")]
    [string]$AgentName,

    [string]$Reason = "Manual quarantine via JML Console",
    [switch]$Revoke,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

# Write-Log defined before dot-sourcing Helpers.ps1 (Helpers uses it).
function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [$Status] $Message")
}

$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }

# Resolve the target agent's appId from its config
$agentConfigPath = Join-Path $agentsRoot "$AgentName\config.json"
if (-not (Test-Path $agentConfigPath)) {
    Out-Result @{ ok = $false; error = "No config.json for agent '$AgentName'" }
    exit 1
}
$agentCfg = Get-Content $agentConfigPath -Raw | ConvertFrom-Json
$targetAppId = $agentCfg.ClientId
if (-not $targetAppId) {
    Out-Result @{ ok = $false; error = "Agent '$AgentName' config has no ClientId" }
    exit 1
}

if ($WhatIf) {
    Write-Log "[WHATIF] Would disable service principal for '$AgentName' (appId $targetAppId)" "WHATIF"
    if ($Revoke) { Write-Log "[WHATIF] Would also revoke all key/password credentials" "WHATIF" }
    Write-AuditEntry -Agent "provisioner" -Action "quarantine-agent" -Subject $AgentName `
        -WhatIf $true -Outcome "whatif" -Details @{ targetAgent = $AgentName; appId = $targetAppId; reason = $Reason; revoke = [bool]$Revoke }
    Out-Result @{ ok = $true; whatif = $true; agent = $AgentName; appId = $targetAppId; action = "would-disable"; revoke = [bool]$Revoke }
    exit 0
}

# Connect as Provisioner (must be enabled for the session — zero-trust at-rest disable)
$provCfg = Get-Content (Join-Path $agentsRoot "provisioner\config.json") -Raw | ConvertFrom-Json
try {
    Connect-AgentGraph -Config $provCfg
} catch {
    Out-Result @{ ok = $false; error = "Provisioner connect failed (is it enabled?): $($_.Exception.Message)" }
    exit 1
}

try {
    # Resolve the service principal by appId
    $spResp = Invoke-GraphWithRetry -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$targetAppId'&`$select=id,displayName,accountEnabled"
    $sp = $spResp.value | Select-Object -First 1
    if (-not $sp) {
        Out-Result @{ ok = $false; error = "No service principal found for appId $targetAppId" }
        exit 1
    }

    # Disable sign-in — blocks token issuance immediately
    Invoke-GraphWithRetry -Method PATCH `
        -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)" `
        -Body (@{ accountEnabled = $false } | ConvertTo-Json) | Out-Null
    Write-Log "Disabled service principal '$($sp.displayName)' ($($sp.id))" "ACTION"

    $revoked = $false
    if ($Revoke) {
        # Hard kill: remove credentials so a re-enable alone can't restore the agent
        Invoke-GraphWithRetry -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/removeKey" `
            -Body (@{ keyId = "00000000-0000-0000-0000-000000000000" } | ConvertTo-Json) -ErrorAction SilentlyContinue | Out-Null
        $revoked = $true
        Write-Log "Credential revocation requested for '$($sp.displayName)'" "ACTION"
    }

    # High-severity audit + Teams/Event Log notification
    Write-AuditEntry -Agent "provisioner" -Action "quarantine-agent" -Subject $AgentName `
        -WhatIf $false -Outcome "success" -Notify $true `
        -Details @{ targetAgent = $AgentName; appId = $targetAppId; spObjectId = $sp.id; reason = $Reason; revoked = $revoked }

    Out-Result @{ ok = $true; agent = $AgentName; appId = $targetAppId; spObjectId = $sp.id; disabled = $true; revoked = $revoked }
} catch {
    Write-AuditEntry -Agent "provisioner" -Action "quarantine-agent" -Subject $AgentName `
        -WhatIf $false -Outcome "failed" -Notify $true `
        -Details @{ targetAgent = $AgentName; appId = $targetAppId; reason = $Reason; error = $_.Exception.Message }
    Out-Result @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
