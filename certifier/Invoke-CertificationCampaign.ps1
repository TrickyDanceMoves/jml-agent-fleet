<#
.SYNOPSIS
    Launches Entra ID Governance access review campaigns for JML user group
    memberships and agent PIM group memberships.

.DESCRIPTION
    Creates access review definition(s) via Microsoft Graph:
      - userGroupCampaign: reviews user membership in JML-provisioned security
        groups. Admin is the reviewer (manager reviewer requires P2 + principalResourceMembershipsScope).
      - agentPimCampaign: reviews active membership in the JML PIM groups
        (JML-UserAdmin, JML-LicenseAdmin, JML-CloudDeviceAdmin). This catches
        unexpected permanent additions or lingering active PIM sessions.
        NOTE: Reviewing PIM *eligible* memberships (eligibility schedules) requires
        Microsoft Entra ID Governance license and is not supported in all tenants.
        The admin reviewer is notified of any active members found.

    Prerequisites:
      1. Provisioner SP must have AccessReview.ReadWrite.All app permission.
         Run: provisioner\Grant-PIMPermissions.ps1
      2. shared/access-cert-config.json:
         - userGroupCampaign.groups         -- group object IDs to review
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
# Certifier's own least-privilege identity (New-CertifierAgent.ps1); falls back
# to the legacy Provisioner credential if certifier has not been provisioned yet.
$ownConfig  = Join-Path $PSScriptRoot "config.json"
$config     = if (Test-Path $ownConfig) { Get-Content $ownConfig | ConvertFrom-Json }
              else { Get-Content (Join-Path $agentsRoot "provisioner\config.json") | ConvertFrom-Json }
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
        [string]$GroupId,
        [string]$ReviewerObjectId,
        [int]$DurationDays,
        [string]$DefaultDecision,
        [bool]$AutoApply
    )

    $endDate = $today.AddDays($DurationDays + 1).ToString("yyyy-MM-dd")

    $body = @{
        displayName             = $DisplayName
        descriptionForAdmins    = "JML access certification - created by Invoke-CertificationCampaign.ps1"
        descriptionForReviewers = "Review each member's access. No decision = access removed after $DurationDays days."
        scope                   = @{
            "@odata.type" = "#microsoft.graph.accessReviewQueryScope"
            query         = "/groups/$GroupId/members"
            queryType     = "MicrosoftGraph"
        }
        reviewers               = @(@{
            query     = "/users/$ReviewerObjectId"
            queryType = "MicrosoftGraph"
            queryRoot = $null
        })
        fallbackReviewers       = @()
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
$adminId  = $certCfg.agentPimCampaign.reviewerObjectId

# -- User Group Campaign -------------------------------------------------------
if ($CampaignType -in @("all","user-groups")) {
    $ugCfg = $certCfg.userGroupCampaign

    if (-not $ugCfg.groups -or $ugCfg.groups.Count -eq 0) {
        Write-Host "`n[Certifier] userGroupCampaign.groups is empty - skipping user group campaign" -ForegroundColor Yellow
        Write-Host "            Populate shared/access-cert-config.json to enable this campaign" -ForegroundColor Yellow
    } elseif (-not $adminId) {
        Write-Host "`n[Certifier] reviewerObjectId not set - skipping user group campaign" -ForegroundColor Yellow
    } else {
        Write-Host "`n[Certifier] User group campaign - $($ugCfg.groups.Count) group(s)..." -ForegroundColor Cyan
        foreach ($groupId in $ugCfg.groups) {
            $name = "$($ugCfg.displayNamePrefix) - $startDate - $groupId"
            $rev  = New-AccessReviewDefinition `
                -DisplayName      $name `
                -GroupId          $groupId `
                -ReviewerObjectId $adminId `
                -DurationDays     $ugCfg.durationDays `
                -DefaultDecision  $ugCfg.defaultDecision `
                -AutoApply        ([bool]$ugCfg.autoApply)

            $results.Add([PSCustomObject]@{ campaign = "user-groups"; groupId = $groupId; reviewId = $rev.id; name = $name })

            Write-AuditEntry -Agent "certifier" -Action "StartAccessReview" -Subject $groupId `
                -WhatIf ([bool]$WhatIf) -Outcome $(if ($WhatIf) { "whatif" } else { "success" }) `
                -Details @{ campaignType = "user-groups"; reviewId = $rev.id }
        }
    }
}

# -- Agent PIM Campaign --------------------------------------------------------
if ($CampaignType -in @("all","agent-pim")) {
    $apCfg = $certCfg.agentPimCampaign

    if (-not $adminId) {
        Write-Host "`n[Certifier] agentPimCampaign.reviewerObjectId not set - skipping agent PIM campaign" -ForegroundColor Yellow
        Write-Host "            Set it in shared/access-cert-config.json" -ForegroundColor Yellow
    } else {
        $pimGroups = @($pimCfg.groups.PSObject.Properties)
        Write-Host "`n[Certifier] Agent PIM campaign - $($pimGroups.Count) group(s) (reviews active members)..." -ForegroundColor Cyan

        foreach ($prop in $pimGroups) {
            $groupName = $prop.Name
            $groupId   = $prop.Value.groupId
            if (-not $groupId) {
                Write-Host "[Certifier]   Skipping $groupName - no groupId (run New-PIMGroups.ps1)" -ForegroundColor Yellow
                continue
            }

            $name = "$($apCfg.displayNamePrefix) - $startDate - $groupName"
            $rev  = New-AccessReviewDefinition `
                -DisplayName      $name `
                -GroupId          $groupId `
                -ReviewerObjectId $adminId `
                -DurationDays     $apCfg.durationDays `
                -DefaultDecision  $apCfg.defaultDecision `
                -AutoApply        ([bool]$apCfg.autoApply)

            $results.Add([PSCustomObject]@{ campaign = "agent-pim"; groupId = $groupId; groupName = $groupName; reviewId = $rev.id; name = $name })

            Write-AuditEntry -Agent "certifier" -Action "StartAccessReview" -Subject $groupName `
                -WhatIf ([bool]$WhatIf) -Outcome $(if ($WhatIf) { "whatif" } else { "success" }) `
                -Details @{ campaignType = "agent-pim"; groupId = $groupId; reviewId = $rev.id }
        }
    }
}

Write-Host "`n[Certifier] Done$(if ($WhatIf) { ' (WHATIF - no changes made)' })." -ForegroundColor Cyan
$results | ConvertTo-Json -Depth 5
