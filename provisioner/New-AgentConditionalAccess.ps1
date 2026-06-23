param(
    [Parameter(Mandatory = $true)]
    [string]$AllowedCidr,   # e.g. "203.0.113.0/24" or "198.51.100.45/32"
    [switch]$ReportOnly,    # Create policy in report-only mode (default: enabled)
    [switch]$WhatIf
)

# ── Requirements ──────────────────────────────────────────────────────────────
# Requires Global Administrator or Conditional Access Administrator role.
# Requires Azure AD Premium P2 for workload identity Conditional Access policies.
# This script uses interactive auth - run it as a human admin, not a service principal.

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    $color = switch ($Status) { "OK" { "Green" } "ACTION" { "Cyan" } "WARN" { "Yellow" } "ERROR" { "Red" } default { "White" } }
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message) -ForegroundColor $color
}

$agentsRoot = Split-Path $PSScriptRoot -Parent

# ── Agent client IDs to protect ───────────────────────────────────────────────
$agentClientIds = @(
    "<JOINER-APP-CLIENT-ID>",  # Joiner
    "<MOVER-APP-CLIENT-ID>",  # Mover
    "<LEAVER-APP-CLIENT-ID>",  # Leaver
    "<ENROLLER-APP-CLIENT-ID>",  # Enroller
    "<APPROVER-APP-CLIENT-ID>",  # Approver
    "<PROVISIONER-APP-CLIENT-ID>"   # Provisioner
)

# Read Auditor client ID if configured
$auditorConfig = Join-Path $agentsRoot "auditor\config.json"
if (Test-Path $auditorConfig) {
    $audCfg = Get-Content $auditorConfig | ConvertFrom-Json
    $agentClientIds += $audCfg.ClientId
}

Write-Log ("Protecting " + $agentClientIds.Count + " agent identities")
Write-Log ("Allowed CIDR: " + $AllowedCidr)
if ($ReportOnly) { Write-Log "Policy will be created in REPORT-ONLY mode" "WARN" }
if ($WhatIf)     { Write-Log "WhatIf mode -- no changes will be made" "WARN" }

# ── Interactive auth as admin ─────────────────────────────────────────────────
$provConfig = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Write-Log "Connecting interactively -- a browser window will open (sign in with your admin work account)"
Set-MgGraphOption -DisableLoginByWAM $true
Connect-MgGraph `
    -TenantId $provConfig.TenantId `
    -Scopes "Policy.ReadWrite.ConditionalAccess","Policy.Read.All","Application.Read.All" `
    -NoWelcome
Write-Log "Connected" "OK"

# ── Resolve service principal object IDs ─────────────────────────────────────
Write-Log "Resolving service principal object IDs"
$spIds = @()
foreach ($cid in $agentClientIds) {
    $spResp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '" + $cid + "'&`$select=id,appId,displayName") `
        -ErrorAction Stop
    if ($spResp.value.Count -eq 0) {
        Write-Log ("  SP not found for appId: " + $cid) "WARN"
        continue
    }
    $sp = $spResp.value[0]
    $spIds += $sp["id"]
    Write-Log ("  " + $sp["displayName"] + " -> " + $sp["id"])
}

if ($spIds.Count -eq 0) {
    Write-Log "No service principals found. Check app registrations." "ERROR"
    Disconnect-MgGraph | Out-Null
    exit 1
}

# ── Step 1: Create (or reuse) Named Location ──────────────────────────────────
$locationId = $null
if (-not $WhatIf) {
    # Check for existing location with same name to stay idempotent
    $existingLoc = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations?`$filter=displayName eq 'JML Agent Execution Host'" `
        -ErrorAction Stop
    if ($existingLoc.value.Count -gt 0) {
        $locationId = $existingLoc.value[0]["id"]
        Write-Log ("Reusing existing Named Location: " + $locationId) "WARN"
        # Update CIDR in case it changed
        $patchBody = @{
            "@odata.type" = "#microsoft.graph.ipNamedLocation"
            ipRanges      = @(@{ "@odata.type" = "#microsoft.graph.iPv4CidrRange"; cidrAddress = $AllowedCidr })
        }
        Invoke-MgGraphRequest -Method PATCH `
            -Uri ("https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations/" + $locationId) `
            -Body $patchBody -ContentType "application/json" -ErrorAction Stop | Out-Null
        Write-Log ("Updated CIDR to " + $AllowedCidr) "ACTION"
    } else {
        Write-Log ("Creating Named Location for CIDR: " + $AllowedCidr)
        $locationBody = @{
            "@odata.type" = "#microsoft.graph.ipNamedLocation"
            displayName   = "JML Agent Execution Host"
            isTrusted     = $true
            ipRanges      = @(@{ "@odata.type" = "#microsoft.graph.iPv4CidrRange"; cidrAddress = $AllowedCidr })
        }
        $locResp = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations" `
            -Body $locationBody -ContentType "application/json" -ErrorAction Stop
        $locationId = $locResp["id"]
        Write-Log ("Named Location created: " + $locationId) "ACTION"
    }
    # Allow replication before creating the policy
    Write-Log "Waiting 15s for Named Location to replicate..."
    Start-Sleep -Seconds 15
} else {
    Write-Log ("Would create/reuse Named Location 'JML Agent Execution Host' for " + $AllowedCidr) "WARN"
    $locationId = "<would-be-created>"
}

# ── Step 2: Create Conditional Access Policy ──────────────────────────────────
$policyState = if ($ReportOnly) { "enabledForReportingButNotEnforced" } else { "enabled" }
Write-Log ("Creating CA policy in state: " + $policyState)

# Build JSON as a raw string - PowerShell 5.1 ConvertTo-Json unwraps single-element
# arrays which breaks schema validation. Workload identity CA policies use
# clientApplications.includeServicePrincipals. The applications condition must use
# "All" (not "none") - "none" causes a 1007 schema validation error.
$spIdsJsonItems = @($spIds | ForEach-Object { '"' + $_ + '"' })
$spIdsJsonArray = '[' + ($spIdsJsonItems -join ',') + ']'
$caBodyJson = '{"displayName":"JML Agent Identity Restrictions","state":"' + $policyState + '","conditions":{"applications":{"includeApplications":["All"]},"clientApplications":{"includeServicePrincipals":' + $spIdsJsonArray + '},"locations":{"includeLocations":["All"],"excludeLocations":["' + $locationId + '"]}},"grantControls":{"operator":"OR","builtInControls":["block"]}}'
Write-Log ("Policy JSON: " + $caBodyJson)

if (-not $WhatIf) {
    # Workload identity CA policies require the beta endpoint
    $policyResp = Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/beta/identity/conditionalAccess/policies" `
        -Body $caBodyJson -ContentType "application/json" -ErrorAction Stop
    $policyId = $policyResp["id"]
    Write-Log ("CA Policy created: " + $policyId) "ACTION"
    Write-Log ("Policy state: " + $policyState) "OK"
} else {
    Write-Log ("Would create CA policy 'JML Agent Identity Restrictions'") "WARN"
    Write-Log ("  Targets: " + $spIds.Count + " service principals") "WARN"
    Write-Log ("  Blocks sign-ins from outside: " + $AllowedCidr) "WARN"
    Write-Log ("  State would be: " + $policyState) "WARN"
}

Disconnect-MgGraph | Out-Null

Write-Log ""
if (-not $WhatIf) {
    Write-Log "DONE -- Conditional Access policy is active" "OK"
    if ($ReportOnly) {
        Write-Log "Policy is in REPORT-ONLY mode." "WARN"
        Write-Log "Review the Sign-in logs in Entra ID to verify no false positives before switching to 'enabled'." "WARN"
        Write-Log "Switch to enabled: Entra Admin Center -> Security -> Conditional Access -> JML Agent Identity Restrictions" "WARN"
    } else {
        Write-Log "Policy is ENFORCED. Agent sign-ins outside $AllowedCidr will be blocked." "OK"
    }
    Write-Log ""
    Write-Log "To delete: Entra Admin Center -> Security -> Conditional Access -> Policies -> JML Agent Identity Restrictions -> Delete" "WARN"
} else {
    Write-Log "WhatIf complete -- no changes made" "OK"
    Write-Log "Re-run without -WhatIf to apply. Add -ReportOnly to create in audit-only mode first." "WARN"
}
