<#
.SYNOPSIS
    Thin wrapper called by the Node.js worker to activate/deactivate PIM
    group memberships before and after each PS1 agent invocation.

.PARAMETER Action
    "Activate" or "Deactivate"

.PARAMETER AgentName
    Agent name (joiner, mover, leaver, enroller) - must match pim-config.json

.PARAMETER Justification
    Passed through to PIM request for audit trail (typically "JML <type> <ticketRef>")
#>
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("Activate","Deactivate")]
    [string]$Action,

    [Parameter(Mandatory=$true)]
    [string]$AgentName,

    [string]$Justification = "JML automated operation"
)

$ErrorActionPreference = "Stop"

# Write-Log must be defined before dot-sourcing Helpers.ps1 because Helpers.ps1
# uses it inside Request-PIMActivation / Remove-PIMActivation.
function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    $entry = "[" + (Get-Date -Format "HH:mm:ss") + "] [$Status] $Message"
    Write-Host $entry
}

$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

# Load the agent's own config to connect as that agent (not the provisioner)
$configPath = Join-Path $agentsRoot "$AgentName\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "[PIM] No config.json for '$AgentName' - skipping"
    exit 0
}
$config = Get-Content $configPath | ConvertFrom-Json
Connect-AgentGraph -Config $config

# PIM-for-Groups JIT activation only works for principals that can self-activate
# (users / role-assignable groups). App-only agents authenticate AS their service
# principal, and Azure does NOT support service principals as PIM-eligible group
# members. When activation is unavailable the agent proceeds on its app-registration
# permissions (User.ReadWrite.All, LicenseAssignment.ReadWrite.All, etc.), which are
# the actual least-privilege authorization for its operations. So a PIM failure here
# is logged as a warning and treated as non-fatal rather than aborting the operation.
try {
    if ($Action -eq "Activate") {
        Request-PIMActivation -AgentName $AgentName -Justification $Justification
    } else {
        Remove-PIMActivation -AgentName $AgentName -Justification $Justification
    }
} catch {
    $reason = $_.Exception.Message
    if ($reason -like "*not supported*" -or $reason -like "*RoleAssignmentDoesNotExist*" -or $reason -like "*does not allow*") {
        Write-Host "[PIM] JIT activation unavailable for app-only agent '$AgentName' (service principals cannot be PIM-eligible). Proceeding on app-registration permissions."
        exit 0
    }
    Write-Host "[PIM] Activation error for '$AgentName' (non-fatal): $reason"
    exit 0
}
