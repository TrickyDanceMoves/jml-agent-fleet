param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("UserSummary","LicenseReport","RecentJoins","RecentLeavers","RecentHardLeavers","AdminRoles","GroupSummary","JMLActivity","StaleAccounts","GuestUsers")]
    [string]$QueryType,
    [int]$Days = 30,
    [int]$TopN  = 20
)

$ErrorActionPreference = "Stop"

$agentsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $agentsRoot "shared\Helpers.ps1")

Import-Module Microsoft.Graph.Users -ErrorAction Stop
$config = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
Connect-AgentGraph -Config $config 2>$null

function Get-AllPages {
    param([string]$Uri)
    $all = @()
    $resp = Invoke-MgGraphRequest -Method GET -Uri $Uri
    $all += $resp.value
    while ($resp."@odata.nextLink") {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $resp."@odata.nextLink"
        $all += $resp.value
    }
    return ,$all
}

$result = $null

switch ($QueryType) {

    "UserSummary" {
        $users = Get-AllPages "https://graph.microsoft.com/v1.0/users?`$select=id,accountEnabled,userType&`$top=999"
        $result = @{
            total    = $users.Count
            enabled  = @($users | Where-Object { $_.accountEnabled -eq $true }).Count
            disabled = @($users | Where-Object { $_.accountEnabled -eq $false }).Count
            members  = @($users | Where-Object { $_["userType"] -eq "Member" }).Count
            guests   = @($users | Where-Object { $_["userType"] -eq "Guest" }).Count
        }
    }

    "LicenseReport" {
        $skus = Invoke-MgGraphRequest -Method GET `
            -Uri "https://graph.microsoft.com/v1.0/subscribedSkus?`$select=skuPartNumber,consumedUnits,prepaidUnits"
        $result = @{
            licenses = @($skus.value | ForEach-Object {
                @{
                    sku       = $_["skuPartNumber"]
                    assigned  = [int]$_["consumedUnits"]
                    total     = [int]$_["prepaidUnits"]["enabled"]
                    available = ([int]$_["prepaidUnits"]["enabled"] - [int]$_["consumedUnits"])
                }
            })
        }
    }

    "RecentJoins" {
        $since = (Get-Date).AddDays(-$Days)
        $users = Get-AllPages "https://graph.microsoft.com/v1.0/users?`$select=displayName,userPrincipalName,createdDateTime,accountEnabled&`$top=999"
        $recent = @($users | Where-Object {
            $_["createdDateTime"] -and ([datetime]$_["createdDateTime"]) -ge $since
        } | Sort-Object { [datetime]$_["createdDateTime"] } -Descending | Select-Object -First $TopN)
        $result = @{
            days  = $Days
            count = $recent.Count
            users = @($recent | ForEach-Object {
                @{
                    displayName       = $_["displayName"]
                    userPrincipalName = $_["userPrincipalName"]
                    createdDateTime   = $_["createdDateTime"]
                    accountEnabled    = $_["accountEnabled"]
                }
            })
        }
    }

    "RecentLeavers" {
        $since = (Get-Date).AddDays(-$Days).ToString("yyyy-MM-ddTHH:mm:ssZ")
        try {
            # $orderby conflicts with $filter on audit logs and silently drops the date filter -- sort client-side instead
            $resp = Invoke-MgGraphRequest -Method GET `
                -Uri ("https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?`$filter=activityDisplayName eq 'Disable account' and activityDateTime ge " + $since + "&`$top=100")
            $sorted = @($resp.value | Sort-Object { [datetime]$_["activityDateTime"] } -Descending | Select-Object -First $TopN)
            $result = @{
                days   = $Days
                count  = $sorted.Count
                events = @($sorted | ForEach-Object {
                    $target    = if ($_["targetResources"] -and $_["targetResources"].Count -gt 0) { $_["targetResources"][0]["userPrincipalName"] } else { "unknown" }
                    $initiator = if ($_["initiatedBy"]["app"]) { $_["initiatedBy"]["app"]["displayName"] } else { $_["initiatedBy"]["user"]["userPrincipalName"] }
                    @{ target = $target; time = $_["activityDateTime"]; initiatedBy = $initiator }
                })
            }
        } catch {
            $result = @{ error = "AuditLog.Read.All permission required"; details = $_.Exception.Message }
        }
    }

    "RecentHardLeavers" {
        # Hard-stage leavers (license + group removal) are recorded only in the
        # JML audit chain with details.stage = "Hard". Entra's directory audit log
        # has no notion of leaver "stage", so read the local chain rather than
        # guessing hard-vs-soft from raw Graph events.
        $auditPath = Join-Path $agentsRoot "audit.jsonl"
        if (-not (Test-Path $auditPath)) {
            $result = @{ error = "JML audit log not found"; path = $auditPath }
        } else {
            $since   = (Get-Date).AddDays(-$Days)
            $entries = @()
            foreach ($line in (Get-Content $auditPath -ErrorAction Stop)) {
                try { $entries += ($line | ConvertFrom-Json) } catch {}
            }
            $hard = @($entries | Where-Object {
                $_.action -eq "LeaverProcess" -and $_.details -and
                $_.details.stage -eq "Hard" -and (-not $_.whatif) -and
                $_.timestamp -and ([datetime]$_.timestamp) -ge $since
            } | Sort-Object { [datetime]$_.timestamp } -Descending | Select-Object -First $TopN)
            $result = @{
                days   = $Days
                count  = $hard.Count
                events = @($hard | ForEach-Object {
                    @{
                        target          = $_.subject
                        time            = $_.timestamp
                        outcome         = $_.outcome
                        operator        = $_.operator
                        licensesRemoved = @($_.details.licensesRemoved)
                        groupsRemoved   = @($_.details.groupsRemoved)
                    }
                })
            }
        }
    }

    "AdminRoles" {
        $rolesResp = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directoryRoles?`$select=displayName,id"
        $roles = @()
        foreach ($role in $rolesResp.value) {
            try {
                $membersResp = Invoke-MgGraphRequest -Method GET `
                    -Uri ("https://graph.microsoft.com/v1.0/directoryRoles/" + $role["id"] + "/members?`$select=displayName,userPrincipalName,accountEnabled")
                if ($membersResp.value.Count -gt 0) {
                    $roles += @{
                        role    = $role["displayName"]
                        count   = $membersResp.value.Count
                        members = @($membersResp.value | ForEach-Object {
                            @{
                                displayName       = $_["displayName"]
                                userPrincipalName = $_["userPrincipalName"]
                                accountEnabled    = $_["accountEnabled"]
                            }
                        })
                    }
                }
            } catch {}
        }
        $result = @{ roles = $roles; totalPopulated = $roles.Count }
    }

    "GroupSummary" {
        $groups = Get-AllPages "https://graph.microsoft.com/v1.0/groups?`$select=id,displayName,groupTypes,membershipRule&`$top=999"
        $result = @{
            total    = $groups.Count
            unified  = @($groups | Where-Object { $_["groupTypes"] -contains "Unified" }).Count
            dynamic  = @($groups | Where-Object { $_["membershipRule"] }).Count
            security = @($groups | Where-Object { (-not ($_["groupTypes"] -contains "Unified")) -and (-not $_["membershipRule"]) }).Count
            sample   = @($groups | Select-Object -First 10 | ForEach-Object { $_["displayName"] })
        }
    }

    "JMLActivity" {
        $auditPath = Join-Path $agentsRoot "audit.jsonl"
        if (-not (Test-Path $auditPath)) {
            $result = @{ error = "Audit log not found"; path = $auditPath }
        } else {
            $lines   = Get-Content $auditPath -ErrorAction Stop
            $entries = @()
            foreach ($line in $lines) {
                try { $entries += ($line | ConvertFrom-Json) } catch {}
            }
            $recent  = @($entries | Sort-Object timestamp -Descending | Select-Object -First $TopN)
            $summary = @{}
            foreach ($e in $entries) {
                $key = $e.agent + "/" + $e.action
                if (-not $summary[$key]) { $summary[$key] = 0 }
                $summary[$key]++
            }
            $result = @{ totalEntries = $entries.Count; recentEntries = $recent; actionSummary = $summary }
        }
    }

    "StaleAccounts" {
        try {
            $resp = Invoke-MgGraphRequest -Method GET `
                -Uri ("https://graph.microsoft.com/v1.0/users?`$filter=accountEnabled eq true&`$select=displayName,userPrincipalName,signInActivity&`$top=999") `
                -Headers @{ ConsistencyLevel = "eventual" }
            $stale = @($resp.value | Where-Object {
                -not $_["signInActivity"] -or
                -not $_["signInActivity"]["lastSignInDateTime"] -or
                ([datetime]$_["signInActivity"]["lastSignInDateTime"]) -lt (Get-Date).AddDays(-$Days)
            } | Select-Object -First $TopN)
            $result = @{
                days  = $Days
                count = $stale.Count
                users = @($stale | ForEach-Object {
                    @{
                        displayName       = $_["displayName"]
                        userPrincipalName = $_["userPrincipalName"]
                        lastSignIn        = if ($_["signInActivity"] -and $_["signInActivity"]["lastSignInDateTime"]) { $_["signInActivity"]["lastSignInDateTime"] } else { "Never" }
                    }
                })
            }
        } catch {
            $result = @{ error = "signInActivity requires AuditLog.Read.All and Azure AD P1/P2"; details = $_.Exception.Message }
        }
    }

    "GuestUsers" {
        try {
            $resp = Invoke-MgGraphRequest -Method GET `
                -Uri ("https://graph.microsoft.com/v1.0/users?`$filter=userType eq 'Guest'&`$select=displayName,userPrincipalName,accountEnabled,createdDateTime&`$count=true&`$top=" + $TopN) `
                -Headers @{ ConsistencyLevel = "eventual" }
            $result = @{
                count = if ($resp."@odata.count") { [int]$resp."@odata.count" } else { $resp.value.Count }
                users = @($resp.value | ForEach-Object {
                    @{
                        displayName       = $_["displayName"]
                        userPrincipalName = $_["userPrincipalName"]
                        accountEnabled    = $_["accountEnabled"]
                        createdDateTime   = $_["createdDateTime"]
                    }
                })
            }
        } catch {
            $result = @{ error = $_.Exception.Message }
        }
    }
}

Disconnect-MgGraph 2>$null | Out-Null
Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
