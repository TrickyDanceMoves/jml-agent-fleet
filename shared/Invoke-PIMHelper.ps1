<#
.SYNOPSIS
    Thin wrapper called by the Node.js worker to activate/deactivate PIM
    group memberships before and after each PS1 agent invocation.

.PARAMETER Action
    "Activate" or "Deactivate"

.PARAMETER AgentName
    Agent name (joiner, mover, leaver, enroller) — must match pim-config.json

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
$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

# Load the agent's own config to connect as that agent (not the provisioner)
$configPath = Join-Path $agentsRoot "$AgentName\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "[PIM] No config.json for '$AgentName' — skipping"
    exit 0
}
$config = Get-Content $configPath | ConvertFrom-Json
Connect-AgentGraph -Config $config

if ($Action -eq "Activate") {
    Request-PIMActivation -AgentName $AgentName -Justification $Justification
} else {
    Remove-PIMActivation -AgentName $AgentName -Justification $Justification
}
