<#
.SYNOPSIS
    Launches Entra ID Governance access review campaigns for JML user group
    memberships and agent PIM eligibilities.

.DESCRIPTION
    Creates access review definition(s) via Microsoft Graph:
      - userGroupCampaign: reviews user membership in JML-provisioned security
        groups. Each user's manager is the reviewer; admin is the fallback.
      - agentPimCampaign: reviews service-principal eligible memberships in the
        three JML PIM groups. The configured admin is the reviewer.

    Prerequisites:
      1. Provisioner SP must have AccessReview.ReadWrite.All app permission.
         Run: provisioner\Grant-PIMPermissions.ps1 (includes this permission).
      2. shared/access-cert-config.json must be configured:
         - userGroupCampaign.groups         -- list of group object IDs to review
         - agentPimCampaign.reviewerObjectId -- your Entra admin user object ID
           (Get-MgUser -Filter "userPrincipalName eq 'you@domain.com'" | Select-Object Id)
      3. shared/pim-config.json must have group IDs populated (run New-PIMGroups.ps1).

    Uses the Provisioner SP cert (provisioner/config.json). No interactive auth needed.

.PARAMETER CampaignType
    Which campaign(s) to create: "all" | "user-groups" | "agent-pim". Default: "all"

.PARAMETER WhatIf
    Preview all actions without creating any reviews.

.EXAMPLE
    .\Invoke-CertificationCampaign.ps1
    .\Invoke-CertificationCampaign.ps1 -CampaignType agent-pim
    .\Invoke-CertificationCampaign.ps1 -WhatIf
#>
param(
    [ValidateSet("all","user-groups","agent-pim")]
    [string]$CampaignType = "all",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$agentsRoot = Split-Path $PSScriptRoot -Parent
$config     = Get-Content (Join-Path $agentsRoot "provisioner\config.json") | ConvertFrom-Json
$certCfg    = Get-Content (Join-Path $agentsRoot "shared\access-cert-config.json") | ConvertFrom-Json
$pimCfg     = Get-Content (Join-Path $agentsRoot "shared\pim-config.json") | ConvertFrom-Json

. (Join-Path $agentsRoot "shared\Helpers.ps1")
Connect-AgentGraph -Config $config
Write-Host "[Certifier] Connected to Microsoft Graph" -ForegroundColor Cyan

$today     = (Get-Date).ToUniversalTime()
$startDate = $today.ToString("yyyy-MM-dd")

function New-AccessReviewDefinition {
    param(
        [string]$DisplayName,
        [hashtable]$Scope,
        [array]$Reviewers,
        [array]$FallbackReviewers = @(),
        [int]$DurationDays,
        [string]$DefaultDecision,
        [bool]$AutoApply
    )

    $endDate = $today.AddDays($DurationDays + 1).ToString("yyyy-MM-dd")

    $body = @{
        displayName             = $DisplayName
        descriptionForAdmins    = "JML access certification - created by Invoke-CertificationCampaign.ps1"
        descriptionForReviewers = "Review each principal's access. No decision = access removed after $DurationDays days."
        scope                   = $Scope
        reviewers               = $Reviewers
        fallbackReviewers       = $FallbackReviewers
        settings                = @{
            mailNotificationsEnabled        = $true
            reminderNotificationsEnabled    = $true
            justificationRequiredOnApproval = $false
            defaultDecisionEnabled          = $true
            defaultDecision                 = $DefaultDecision
            instanceDurationInDays          = $DurationDays
            autoApplyDecisionsEnabled       = $AutoApply
            recommendationsEnabled          = $true
            recurrence                      = @{
                pattern = $null
                range   = @{
                    type      = "endDate"
                    startDate = $startDate
                    endDate   = $endDate
                }
            }
        }
    }

    if ($WhatIf) {
        Write-Host "[Certifier]   WHATIF: Would create review '$DisplayName'" -ForegroundColor DarkCyan
        return [PSCustomObject]@{ id = "whatif-$(New-Guid)"; displayName = $DisplayName }
    }

    $resp = Invoke-GraphWithRetry -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/identityGovernance/accessReviews/definitions" `
        -Body ($body | ConvertTo-Json -Depth 10)
    Write-Host "[Certifier]   Created '$DisplayName' (id: $($resp.id))" -ForegroundColor Green
    return $resp
}

$results = [System.Collections.Generic.List[object]]::new()

# -- User Group Campaign -------------------------------------------------------
if ($CampaignType -in @("all","user-groups")) {
    $ugCfg   = $certCfg.userGroupCampaign
    $adminId = $certCfg.agentPimCampaign.reviewerObjectId

    if (-not $ugCfg.groups -or $ugCfg.groups.Count -eq 0) {
        Write-Host "`n[Certifier] userGroupCampaign.groups is empty - skipping user group campaign" -ForegroundColor Yellow
        Write-Host "            Populate shared/access-cert-config.json to enable this campaign" -ForegroundColor Yellow
    } else {
        Write-Host "`n[Certifier] User group campaign - $($ugCfg.groups.Count) group(s)..." -ForegroundColor Cyan
        foreach ($groupId in $ugCfg.groups) {
            $name = "$($ugCfg.displayNamePrefix) - $startDate - $groupId"

            $scope = @{
                "@odata.type"   = "#microsoft.graph.principalResourceMembershipsScope"
                principalScopes = @(@{
                    "@odata.type" = "#microsoft.graph.accessReviewQueryScope"
                    query         = "/users"
                    queryType     = "MicrosoftGraph"
                })
                resourceScopes  = @(@{
                    "@odata.type" = "#microsoft.graph.accessReviewQueryScope"
                    query         = "/groups/$groupId/transitiveMembers/microsoft.graph.user"
                    queryType     = "MicrosoftGraph"
                })
            }

            $reviewers = @(@{
                query     = "./manager"
                queryType = "MicrosoftGraph"
                queryRoot = "decisions"
            })

            $fallback = if ($adminId) {
                @(@{ query = "/users/$adminId"; queryType = "MicrosoftGraph"; queryRoot = $null })
            } else { @() }

            $rev = New-AccessReviewDefinition `
                -DisplayName       $name `
                -Scope             $scope `
                -Reviewers         $reviewers `
                -FallbackReviewers $fallback `
                -DurationDays      $ugCfg.durationDays `
                -DefaultDecision   $ugCfg.defaultDecision `
                -AutoApply         ([bool]$ugCfg.autoApply)

            $results.Add([PSCustomObject]@{
                campaign = "user-groups"
                groupId  = $groupId
                reviewId = $rev.id
                name     = $name
            })

            Write-AuditEntry -Agent "certifier" -Action "StartAccessReview" -Subject $groupId `
                -WhatIf ([bool]$WhatIf) -Outcome $(if ($WhatIf) { "whatif" } else { "success" }) `
                -Details @{ campaignType = "user-groups"; reviewId = $rev.id }
        }
    }
}

# -- Agent PIM Campaign --------------------------------------------------------
if ($CampaignType -in @("all","agent-pim")) {
    $apCfg   = $certCfg.agentPimCampaign
    $adminId = $apCfg.reviewerObjectId

    if (-not $adminId) {
        Write-Host "`n[Certifier] agentPimCampaign.reviewerObjectId not set - skipping agent PIM campaign" -ForegroundColor Yellow
        Write-Host "            Set it in shared/access-cert-config.json" -ForegroundColor Yellow
    } else {
        $pimGroups = @($pimCfg.groups.PSObject.Properties)
        Write-Host "`n[Certifier] Agent PIM campaign - $($pimGroups.Count) group(s)..." -ForegroundColor Cyan

        foreach ($prop in $pimGroups) {
            $groupName = $prop.Name
            $groupId   = $prop.Value.groupId
            if (-not $groupId) {
                Write-Host "[Certifier]   Skipping $groupName - no groupId (run New-PIMGroups.ps1)" -ForegroundColor Yellow
                continue
            }

            $name = "$($apCfg.displayNamePrefix) - $startDate - $groupName"

            $scope = @{
                "@odata.type"   = "#microsoft.graph.principalResourceMembershipsScope"
                principalScopes = @(@{
                    "@odata.type" = "#microsoft.graph.accessReviewQueryScope"
                    query         = "/v2/identityGovernance/privilegedAccess/group/eligibilitySchedules?`$filter=groupId+eq+'$groupId'&`$count=true"
                    queryType     = "MicrosoftGraph"
                    queryRoot     = $null
                })
                resourceScopes  = @(@{
                    "@odata.type" = "#microsoft.graph.accessReviewQueryScope"
                    query         = "/groups/$groupId"
                    queryType     = "MicrosoftGraph"
                    queryRoot     = $null
                })
            }

            $reviewers = @(@{
                query     = "/users/$adminId"
                queryType = "MicrosoftGraph"
                queryRoot = $null
            })

            $rev = New-AccessReviewDefinition `
                -DisplayName       $name `
                -Scope             $scope `
                -Reviewers         $reviewers `
                -FallbackReviewers @() `
                -DurationDays      $apCfg.durationDays `
                -DefaultDecision   $apCfg.defaultDecision `
                -AutoApply         ([bool]$apCfg.autoApply)

            $results.Add([PSCustomObject]@{
                campaign  = "agent-pim"
                groupId   = $groupId
                groupName = $groupName
                reviewId  = $rev.id
                name      = $name
            })

            Write-AuditEntry -Agent "certifier" -Action "StartAccessReview" -Subject $groupName `
                -WhatIf ([bool]$WhatIf) -Outcome $(if ($WhatIf) { "whatif" } else { "success" }) `
                -Details @{ campaignType = "agent-pim"; groupId = $groupId; reviewId = $rev.id }
        }
    }
}

Write-Host "`n[Certifier] Done$(if ($WhatIf) { ' (WHATIF - no changes made)' })." -ForegroundColor Cyan
$results | ConvertTo-Json -Depth 5
