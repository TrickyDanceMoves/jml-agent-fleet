param([switch]$Fix)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Status = "INFO")
    $color = switch ($Status) { "OK" { "Green" } "DRIFT" { "Yellow" } "ERROR" { "Red" } default { "White" } }
    Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] [" + $Status + "] " + $Message) -ForegroundColor $color
}

$agentsRoot = Split-Path $PSScriptRoot -Parent

# Expected permission manifest
$manifest = @{
    "JOINER-APP-CLIENT-ID-00000000001" = @{
        Name = "Claude IAM Agent Joiner"
        Permissions = @("User.ReadWrite.All","Group.Read.All","GroupMember.ReadWrite.All","LicenseAssignment.ReadWrite.All")
    }
    "MOVER-APP-CLIENT-ID-000000000002" = @{
        Name = "Claude IAM Agent Mover"
        Permissions = @("User.ReadWrite.All","Group.Read.All","GroupMember.ReadWrite.All","LicenseAssignment.ReadWrite.All")
    }
    "LEAVER-APP-CLIENT-ID-000000000003" = @{
        Name = "Claude IAM Agent Leaver"
        Permissions = @("User.ReadWrite.All","LicenseAssignment.ReadWrite.All","GroupMember.ReadWrite.All")
    }
    "ENROLLER-APP-CLIENT-ID-00000000004" = @{
        Name = "Claude IAM Agent Enroller"
        Permissions = @("User.ReadWrite.All","Group.Read.All","GroupMember.ReadWrite.All","LicenseAssignment.ReadWrite.All")
    }
    "APPROVER-APP-CLIENT-ID-00000000005" = @{
        Name = "Claude IAM Agent Approver"
        Permissions = @("User.Read.All","Group.Read.All")
    }
    "PROVISIONER-APP-CLIENT-ID-0000006" = @{
        Name = "Claude IAM Agent Provisioner"
        Permissions = @("Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All")
    }
}

# Read auditor ClientId from config if present
$auditorConfig = Join-Path $agentsRoot "auditor\config.json"
if (Test-Path $auditorConfig) {
    $audCfg = Get-Content $auditorConfig | ConvertFrom-Json
    $manifest[$audCfg.ClientId] = @{
        Name = "Claude IAM Agent Auditor"
        Permissions = @("User.Read.All","Group.Read.All","Directory.Read.All","AuditLog.Read.All","Reports.Read.All")
    }
}

# Connect as Provisioner
Write-Log "Connecting as Provisioner for permission audit"
$provConfig = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$provSecret  = ConvertTo-SecureString $provConfig.EncryptedSecret
$provCred    = New-Object System.Management.Automation.PSCredential($provConfig.ClientId, $provSecret)

# Enable Provisioner first
Import-Module Microsoft.Graph.Users -ErrorAction Stop
$leaverConfig = Get-Content (Join-Path $agentsRoot "leaver\config.json") | ConvertFrom-Json
$leaverSecret  = ConvertTo-SecureString $leaverConfig.EncryptedSecret
$leaverCred    = New-Object System.Management.Automation.PSCredential($leaverConfig.ClientId, $leaverSecret)
Connect-MgGraph -TenantId $leaverConfig.TenantId -ClientSecretCredential $leaverCred -NoWelcome
Update-MgUser -UserId "PROVISIONER-SP-OBJECT-ID-0000005a" -AccountEnabled:$true -ErrorAction Stop
Disconnect-MgGraph | Out-Null

Connect-MgGraph -TenantId $provConfig.TenantId -ClientSecretCredential $provCred -NoWelcome

# Resolve Graph SP
$graphSP = (Invoke-MgGraphRequest -Method GET `
    -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles" `
    -ErrorAction Stop).value[0]

$roleValueToId = @{}
$roleIdToValue = @{}
foreach ($r in $graphSP["appRoles"]) {
    $roleValueToId[$r["value"]] = $r["id"]
    $roleIdToValue[$r["id"]]    = $r["value"]
}

$driftCount = 0

foreach ($clientId in $manifest.Keys) {
    $expected = $manifest[$clientId]
    Write-Log ("Checking: " + $expected.Name)

    $spResp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '" + $clientId + "'&`$select=id") `
        -ErrorAction Stop
    if ($spResp.value.Count -eq 0) {
        Write-Log ("  Service principal not found") "ERROR"
        continue
    }
    $spId = $spResp.value[0]["id"]

    $assignedResp = Invoke-MgGraphRequest -Method GET `
        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $spId + "/appRoleAssignments") `
        -ErrorAction Stop
    $actualPermNames = @($assignedResp.value | Where-Object { $_["resourceId"] -eq $graphSP["id"] } |
        ForEach-Object { $roleIdToValue[$_["appRoleId"]] } | Where-Object { $_ })

    $missing = @($expected.Permissions | Where-Object { $_ -notin $actualPermNames })
    $extra   = @($actualPermNames      | Where-Object { $_ -notin $expected.Permissions })

    if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
        Write-Log ("  OK -- " + $actualPermNames.Count + " permissions match manifest") "OK"
    } else {
        $driftCount++
        foreach ($m in $missing) { Write-Log ("  MISSING: " + $m) "DRIFT" }
        foreach ($e in $extra)   { Write-Log ("  EXTRA:   " + $e) "DRIFT" }

        if ($Fix) {
            foreach ($m in $missing) {
                if ($roleValueToId.ContainsKey($m)) {
                    $body = @{ principalId = $spId; resourceId = $graphSP["id"]; appRoleId = $roleValueToId[$m] }
                    Invoke-MgGraphRequest -Method POST `
                        -Uri ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $spId + "/appRoleAssignments") `
                        -Body $body -ContentType "application/json" -ErrorAction Stop | Out-Null
                    Write-Log ("  FIXED: granted " + $m) "OK"
                }
            }
        }
    }
}

Disconnect-MgGraph | Out-Null

# Disable Provisioner
Connect-MgGraph -TenantId $leaverConfig.TenantId -ClientSecretCredential $leaverCred -NoWelcome
Update-MgUser -UserId "PROVISIONER-SP-OBJECT-ID-0000005a" -AccountEnabled:$false -ErrorAction Stop
Disconnect-MgGraph | Out-Null

Write-Log ""
if ($driftCount -eq 0) {
    Write-Log "PASS -- all agent permissions match manifest" "OK"
} else {
    Write-Log ($driftCount.ToString() + " agent(s) have permission drift. Re-run with -Fix to remediate.") "DRIFT"
    if (-not $Fix) { exit 1 }
}
