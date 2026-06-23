<#
.SYNOPSIS
    Populates all JML fleet features with realistic demo data.
    Run once to seed audit.jsonl, security reports, pending approvals, and scheduled ops.
#>
[CmdletBinding()]
param(
    [switch]$Reset   # Wipe existing audit.jsonl before seeding
)

$ErrorActionPreference = 'Stop'
$agentsRoot = Split-Path $PSScriptRoot -Parent
$domain     = 'contoso.onmicrosoft.com'

# ── Helpers ───────────────────────────────────────────────────────────────────
function sha256([string]$s) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $sha   = [System.Security.Cryptography.SHA256]::Create()
    [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLower()
}

function ts([int]$daysAgo, [int]$hour = 10, [int]$minute = 0) {
    (Get-Date).AddDays(-$daysAgo).Date.AddHours($hour).AddMinutes($minute).ToUniversalTime().ToString('o')
}

function new-guid { [System.Guid]::NewGuid().ToString() }

# ── Demo identities ───────────────────────────────────────────────────────────
$users = @{
    chen      = "sarah.chen@$domain"
    johnson   = "marcus.johnson@$domain"
    rodriguez = "emma.rodriguez@$domain"
    kim       = "david.kim@$domain"
    thompson  = "lisa.thompson@$domain"
    wilson    = "james.wilson@$domain"
    patel     = "priya.patel@$domain"
    martinez  = "robert.martinez@$domain"
    lee       = "jennifer.lee@$domain"
    turner    = "alex.turner@$domain"
}

# ── Audit log ─────────────────────────────────────────────────────────────────
$auditPath = Join-Path $agentsRoot 'audit.jsonl'
if ($Reset -and (Test-Path $auditPath)) { Remove-Item $auditPath -Force }

$entries = @(
    # ── Week 2 ago: Joiners ───────────────────────────────────────────────────
    @{ d=14; h=9;  m=5;  agent='joiner';  action='JoinerProcess'; subject=$users.chen;      outcome='success'; op='admin'; details=@{ ticketRef='INC-1001'; department='Engineering'; jobTitle='Engineering Manager'; licenses=@('ENTERPRISEPACK'); groups=@('Engineering-All','M365-E3-Users') } }
    @{ d=14; h=9;  m=22; agent='joiner';  action='JoinerProcess'; subject=$users.johnson;   outcome='success'; op='admin'; details=@{ ticketRef='INC-1002'; department='Sales'; jobTitle='Sales Representative'; licenses=@('ENTERPRISEPACK'); groups=@('Sales-All','M365-E3-Users') } }
    @{ d=13; h=10; m=10; agent='joiner';  action='JoinerProcess'; subject=$users.rodriguez; outcome='success'; op='admin'; details=@{ ticketRef='INC-1003'; department='HR'; jobTitle='HR Specialist'; licenses=@('ENTERPRISEPACK','POWER_BI_STANDARD'); groups=@('HR-All','M365-E3-Users') } }
    @{ d=13; h=10; m=30; agent='enroller';action='EnrollerProcess';subject=$users.rodriguez;outcome='success'; op='admin'; details=@{ ticketRef='INC-1003'; deviceAction='compliance-group-assigned' } }
    @{ d=12; h=11; m=0;  agent='joiner';  action='JoinerProcess'; subject=$users.kim;       outcome='success'; op='helpdesk'; details=@{ ticketRef='INC-1004'; department='Finance'; jobTitle='Finance Analyst'; licenses=@('ENTERPRISEPACK'); groups=@('Finance-All','M365-E3-Users') } }
    @{ d=12; h=11; m=15; agent='joiner';  action='JoinerProcess'; subject=$users.thompson;  outcome='success'; op='admin'; details=@{ ticketRef='INC-1005'; department='IT'; jobTitle='IT Engineer'; licenses=@('ENTERPRISEPACK','INTUNE_A_D'); groups=@('IT-All','Intune-Licensed','M365-E3-Users') } }
    @{ d=11; h=9;  m=45; agent='joiner';  action='JoinerProcess'; subject=$users.wilson;    outcome='success'; op='admin'; details=@{ ticketRef='INC-1006'; department='Engineering'; jobTitle='Senior Software Developer'; licenses=@('ENTERPRISEPACK','VISIOCLIENT'); groups=@('Engineering-All','Dev-Team','M365-E3-Users') } }
    @{ d=11; h=10; m=5;  agent='enroller';action='EnrollerProcess';subject=$users.wilson;   outcome='success'; op='admin'; details=@{ ticketRef='INC-1006'; deviceAction='compliance-group-assigned' } }

    # ── Week 1 ago: More joiners + UEBA seeds ────────────────────────────────
    @{ d=9;  h=10; m=0;  agent='joiner';  action='JoinerProcess'; subject=$users.patel;     outcome='success'; op='helpdesk'; details=@{ ticketRef='INC-1007'; department='Marketing'; jobTitle='Marketing Manager'; licenses=@('ENTERPRISEPACK'); groups=@('Marketing-All','M365-E3-Users') } }
    @{ d=9;  h=10; m=20; agent='joiner';  action='JoinerProcess'; subject=$users.lee;       outcome='success'; op='admin'; details=@{ ticketRef='INC-1008'; department='Finance'; jobTitle='Finance Director'; licenses=@('ENTERPRISEPACK','POWER_BI_PRO'); groups=@('Finance-All','Finance-Leads','M365-E3-Users') } }
    @{ d=8;  h=9;  m=30; agent='joiner';  action='JoinerProcess'; subject=$users.turner;    outcome='success'; op='admin'; details=@{ ticketRef='INC-1009'; department='Engineering'; jobTitle='DevOps Engineer'; licenses=@('ENTERPRISEPACK','AZURE_DEVOPS'); groups=@('Engineering-All','DevOps-Team','M365-E3-Users') } }

    # Mover: Marcus Johnson promoted to Sales Lead
    @{ d=7;  h=11; m=0;  agent='mover';   action='MoverProcess';  subject=$users.johnson;   outcome='success'; op='admin'; details=@{ ticketRef='INC-1010'; oldDept='Sales'; newDept='Sales'; oldTitle='Sales Representative'; newTitle='Sales Lead'; groupsAdded=@('Sales-Leads'); groupsRemoved=@() } }

    # Failed enroll attempt (UEBA: repeated-failures seed)
    @{ d=6;  h=14; m=5;  agent='enroller';action='EnrollerProcess';subject=$users.patel;    outcome='failed';  op='helpdesk'; details=@{ ticketRef='INC-1011'; error='Device not found in Intune' } }
    @{ d=6;  h=14; m=12; agent='enroller';action='EnrollerProcess';subject=$users.patel;    outcome='failed';  op='helpdesk'; details=@{ ticketRef='INC-1011'; error='Device not found in Intune' } }
    @{ d=6;  h=14; m=20; agent='enroller';action='EnrollerProcess';subject=$users.patel;    outcome='partial'; op='helpdesk'; details=@{ ticketRef='INC-1011'; deviceAction='compliance-group-assigned'; warning='Device serial unconfirmed' } }

    # UEBA: off-hours leaver (Robert Martinez terminated at 2am)
    @{ d=5;  h=2;  m=14; agent='leaver';  action='LeaverProcess';  subject=$users.martinez; outcome='success'; op='admin'; details=@{ ticketRef='INC-1020'; stage='Soft'; accountDisabled=$true; sessionsRevoked=$true } }
    @{ d=5;  h=2;  m=18; agent='leaver';  action='LeaverProcess';  subject=$users.martinez; outcome='success'; op='admin'; details=@{ ticketRef='INC-1020'; stage='Hard'; licensesRemoved=1; groupsRemoved=3 } }

    # UEBA: leaver-then-group-add (suspicious: james.wilson offboarded, then re-added)
    @{ d=4;  h=9;  m=0;  agent='leaver';  action='LeaverProcess';  subject=$users.wilson;   outcome='success'; op='admin'; details=@{ ticketRef='INC-1021'; stage='Soft'; accountDisabled=$true; sessionsRevoked=$true } }
    @{ d=4;  h=9;  m=4;  agent='leaver';  action='LeaverProcess';  subject=$users.wilson;   outcome='success'; op='admin'; details=@{ ticketRef='INC-1021'; stage='Hard'; licensesRemoved=2; groupsRemoved=4 } }
    @{ d=4;  h=11; m=30; agent='mover';   action='MoverProcess';   subject=$users.wilson;   outcome='success'; op='helpdesk'; details=@{ ticketRef='INC-1022'; groupsAdded=@('Contractors-External'); note='Re-engaged as contractor' } }

    # Auditor scheduled runs
    @{ d=3;  h=7;  m=2;  agent='auditor'; action='UEBAAnalysis';   subject='audit.jsonl';   outcome='success'; op=$null; details=@{ runId=(new-guid); windowDays=30; entriesAnalyzed=22; critical=2; warning=3; info=1; report='ueba-report.json' } }
    @{ d=3;  h=6;  m=0;  agent='auditor'; action='DriftDetection'; subject='tenant';         outcome='success'; op=$null; details=@{ runId=(new-guid); checksRun=4; critical=1; warning=2; report='drift-report.json' } }
    @{ d=2;  h=18; m=0;  agent='auditor'; action='RiskyUserScan';  subject='tenant';         outcome='success'; op=$null; details=@{ runId=(new-guid); riskyUsersFound=2; revokedSessions=1; critical=1; warning=1 } }

    # Export runs
    @{ d=2;  h=6;  m=5;  agent='auditor'; action='BlobExport';     subject='audit.jsonl';   outcome='success'; op=$null; details=@{ entriesExported=22; container='jml-audit-logs' } }
    @{ d=2;  h=6;  m=7;  agent='auditor'; action='SentinelIngest'; subject='audit.jsonl';   outcome='success'; op=$null; details=@{ auditEntries=22; secFindings=6; workspaceId='f3a7...workspace' } }

    # Drift detected: Mover fix attempt (access cert result)
    @{ d=1;  h=9;  m=30; agent='certifier';action='AccessCertification';subject='Engineering-All'; outcome='success'; op='admin'; details=@{ campaignType='group-members'; reviewersNotified=3; membersInScope=4 } }

    # Recent activity today
    @{ d=0;  h=9;  m=0;  agent='joiner';  action='JoinerProcess'; subject="temp.contractor@$domain"; outcome='success'; op='helpdesk'; details=@{ ticketRef='INC-1030'; department='Engineering'; jobTitle='Contract Developer'; licenses=@('ENTERPRISEPACK'); groups=@('Contractors-External') } }
    @{ d=0;  h=9;  m=45; agent='auditor'; action='RiskyUserScan'; subject='tenant';          outcome='success'; op=$null; details=@{ runId=(new-guid); riskyUsersFound=2; revokedSessions=0; critical=1; warning=1 } }
)

Write-Host "Generating audit.jsonl ($($entries.Count) entries)..." -ForegroundColor Cyan

$prevHash = 'genesis'
foreach ($e in $entries) {
    $entry = [ordered]@{
        timestamp = ts $e.d $e.h $e.m
        agent     = $e.agent
        action    = $e.action
        subject   = $e.subject
        whatif    = $false
        outcome   = $e.outcome
        operator  = $e.op
        details   = $e.details
        prevHash  = $prevHash
    }
    $json          = $entry | ConvertTo-Json -Compress -Depth 10
    $entry['hash'] = sha256 $json
    $finalJson     = $entry | ConvertTo-Json -Compress -Depth 10
    Add-Content -Path $auditPath -Value $finalJson -NoNewline
    Add-Content -Path $auditPath -Value "`n" -NoNewline
    $prevHash      = sha256 $finalJson
}
Write-Host "  Written: $auditPath" -ForegroundColor Green

# ── Security reports ──────────────────────────────────────────────────────────
$reportsDir = Join-Path $agentsRoot 'auditor\reports'
if (-not (Test-Path $reportsDir)) { New-Item -ItemType Directory -Path $reportsDir | Out-Null }
$now = (Get-Date).ToUniversalTime()
$stamp = $now.ToString('yyyy-MM-dd-HHmmss')

# UEBA report
$uebaReport = [ordered]@{
    runId            = new-guid
    timestamp        = $now.ToString('o')
    durationSeconds  = 4
    windowDays       = 30
    windowStart      = $now.AddDays(-30).ToString('o')
    entriesAnalyzed  = 28
    entriesFiltered  = 0
    summary          = @{ total=6; critical=2; warning=3; info=1 }
    findings         = @(
        [ordered]@{
            ruleId   = 'off-hours'
            severity = 'critical'
            title    = 'After-hours leaver operation detected'
            count    = 2
            events   = @(
                @{ timestamp=(ts 5 2 14); agent='leaver'; action='LeaverProcess'; subject=$users.martinez; outcome='success'; whatif=$false }
                @{ timestamp=(ts 5 2 18); agent='leaver'; action='LeaverProcess'; subject=$users.martinez; outcome='success'; whatif=$false }
            )
        }
        [ordered]@{
            ruleId   = 'leaver-then-group-add'
            severity = 'critical'
            title    = 'Group membership added within 4 hours of offboarding'
            count    = 1
            events   = @(
                @{ timestamp=(ts 4 9 4);  agent='leaver'; action='LeaverProcess'; subject=$users.wilson; outcome='success'; whatif=$false }
                @{ timestamp=(ts 4 11 30);agent='mover';  action='MoverProcess';  subject=$users.wilson; outcome='success'; whatif=$false }
            )
        }
        [ordered]@{
            ruleId   = 'repeated-failures'
            severity = 'warning'
            title    = 'Repeated failures on same subject within 1 hour'
            count    = 2
            events   = @(
                @{ timestamp=(ts 6 14 5);  agent='enroller'; action='EnrollerProcess'; subject=$users.patel; outcome='failed';  whatif=$false }
                @{ timestamp=(ts 6 14 12); agent='enroller'; action='EnrollerProcess'; subject=$users.patel; outcome='failed';  whatif=$false }
                @{ timestamp=(ts 6 14 20); agent='enroller'; action='EnrollerProcess'; subject=$users.patel; outcome='partial'; whatif=$false }
            )
        }
        [ordered]@{
            ruleId   = 'bulk-termination'
            severity = 'warning'
            title    = '2 leaver operations within 24 hours'
            count    = 2
            events   = @(
                @{ timestamp=(ts 5 2 14); agent='leaver'; action='LeaverProcess'; subject=$users.martinez; outcome='success'; whatif=$false }
                @{ timestamp=(ts 4 9 0);  agent='leaver'; action='LeaverProcess'; subject=$users.wilson;   outcome='success'; whatif=$false }
            )
        }
        [ordered]@{
            ruleId   = 'outcome-degradation'
            severity = 'warning'
            title    = 'Increasing partial/failed ratio for enroller agent'
            count    = 3
            events   = @(
                @{ timestamp=(ts 6 14 5);  agent='enroller'; action='EnrollerProcess'; subject=$users.patel; outcome='failed';  whatif=$false }
                @{ timestamp=(ts 6 14 12); agent='enroller'; action='EnrollerProcess'; subject=$users.patel; outcome='failed';  whatif=$false }
                @{ timestamp=(ts 6 14 20); agent='enroller'; action='EnrollerProcess'; subject=$users.patel; outcome='partial'; whatif=$false }
            )
        }
        [ordered]@{
            ruleId   = 'high-volume-burst'
            severity = 'info'
            title    = '5 joiner operations in a single day'
            count    = 5
            events   = @(
                @{ timestamp=(ts 14 9 5);  agent='joiner'; action='JoinerProcess'; subject=$users.chen;    outcome='success'; whatif=$false }
                @{ timestamp=(ts 14 9 22); agent='joiner'; action='JoinerProcess'; subject=$users.johnson; outcome='success'; whatif=$false }
            )
        }
    )
}
$uebaReport | ConvertTo-Json -Depth 10 -Compress |
    Set-Content (Join-Path $reportsDir "ueba-$stamp.json") -Encoding UTF8
Write-Host "  Written: ueba-$stamp.json" -ForegroundColor Green

# Drift report
$driftReport = [ordered]@{
    runId           = new-guid
    timestamp       = $now.ToString('o')
    durationSeconds = 6
    checksRun       = @('disabled-licensed','pim-group-drift','agent-role-drift','stale-accounts','orphaned-disabled')
    summary         = @{ total=5; critical=1; warning=3; info=1 }
    findings        = @(
        [ordered]@{
            checkId  = 'disabled-licensed'
            severity = 'critical'
            title    = 'Disabled user still holds active licenses'
            count    = 1
            items    = @(
                @{ userPrincipalName=$users.martinez; displayName='Robert Martinez'; licenseCount=1 }
            )
        }
        [ordered]@{
            checkId  = 'stale-accounts'
            severity = 'warning'
            title    = 'Enabled accounts with no sign-in in 90+ days'
            count    = 2
            items    = @(
                @{ userPrincipalName="svc.legacy@$domain"; displayName='Legacy Service Account'; lastSignIn='Never'; createdDateTime=$now.AddDays(-180).ToString('o') }
                @{ userPrincipalName="ext.vendor2023@$domain"; displayName='Vendor Temp 2023'; lastSignIn=$now.AddDays(-112).ToString('o'); createdDateTime=$now.AddDays(-140).ToString('o') }
            )
        }
        [ordered]@{
            checkId  = 'orphaned-disabled'
            severity = 'warning'
            title    = 'Disabled accounts still in active groups'
            count    = 1
            items    = @(
                @{ userPrincipalName=$users.wilson; displayName='James Wilson'; group='Dev-Team'; createdDateTime=$now.AddDays(-11).ToString('o') }
            )
        }
        [ordered]@{
            checkId  = 'agent-role-drift'
            severity = 'warning'
            title    = 'Agent role assignment changed since last baseline'
            count    = 1
            items    = @(
                @{ agent='ClaudeAgentJoiner'; objectId='<JOINER-USER-OBJECT-ID>'; role='User Administrator'; assignmentId='drift-detected'; note='Assignment scope changed to tenant-wide' }
            )
        }
        [ordered]@{
            checkId  = 'pim-group-drift'
            severity = 'info'
            title    = 'PIM eligible assignment approaching expiry'
            count    = 1
            items    = @(
                @{ id='pim-001'; appId='<JOINER-APP-CLIENT-ID>'; group='Engineering-All'; note='Eligible assignment expires in 14 days' }
            )
        }
    )
}
$driftReport | ConvertTo-Json -Depth 10 -Compress |
    Set-Content (Join-Path $reportsDir "drift-$stamp.json") -Encoding UTF8
Write-Host "  Written: drift-$stamp.json" -ForegroundColor Green

# Risky users report
$riskyReport = [ordered]@{
    runId           = new-guid
    timestamp       = $now.ToString('o')
    durationSeconds = 3
    summary         = @{ total=2; critical=1; warning=1; info=0; riskyUsersFound=2; revokedSessions=1 }
    findings        = @(
        [ordered]@{
            severity = 'critical'
            title    = 'Confirmed compromised user - sessions revoked'
            count    = 1
            items    = @(
                @{ userPrincipalName=$users.martinez; displayName='Robert Martinez'; riskLevel='high'; riskState='confirmedCompromised'; riskDetail='userPerformedSecuredPasswordChange'; riskLastUpdated=$now.AddDays(-5).ToString('o') }
            )
        }
        [ordered]@{
            severity = 'warning'
            title    = 'User flagged at-risk by Identity Protection'
            count    = 1
            items    = @(
                @{ userPrincipalName=$users.wilson; displayName='James Wilson'; riskLevel='medium'; riskState='atRisk'; riskDetail='anonymizedIPAddress'; riskLastUpdated=$now.AddDays(-2).ToString('o') }
            )
        }
    )
}
$riskyReport | ConvertTo-Json -Depth 10 -Compress |
    Set-Content (Join-Path $reportsDir "risky-users-$stamp.json") -Encoding UTF8
Write-Host "  Written: risky-users-$stamp.json" -ForegroundColor Green

# Blob export status
@{
    configured      = $true
    lastRun         = $now.AddDays(-2).AddHours(-6).ToString('o')
    entriesExported = 22
    lastBlobName    = "audit-$($now.AddDays(-2).ToString('yyyy-MM-dd'))-060500.jsonl"
    storageAccount  = 'jmlagentlogs'
    container       = 'jml-audit-logs'
} | ConvertTo-Json -Compress |
    Set-Content (Join-Path $reportsDir 'blob-export-status.json') -Encoding UTF8
Write-Host "  Written: blob-export-status.json" -ForegroundColor Green

# Sentinel ingest status
@{
    configured     = $true
    lastRun        = $now.AddDays(-2).AddHours(-6).ToString('o')
    eventsIngested = 28
    auditEntries   = 22
    secFindings    = 6
    workspaceId    = '<WORKSPACE-ID>'
} | ConvertTo-Json -Compress |
    Set-Content (Join-Path $reportsDir 'sentinel-ingest-status.json') -Encoding UTF8
Write-Host "  Written: sentinel-ingest-status.json" -ForegroundColor Green

# ── Pending dual-approval tokens ──────────────────────────────────────────────
$pendingDir = Join-Path $agentsRoot 'approver\pending'
if (-not (Test-Path $pendingDir)) { New-Item -ItemType Directory -Path $pendingDir | Out-Null }

# Remove any existing expired tokens
Get-ChildItem $pendingDir -Filter '*.json' -ErrorAction SilentlyContinue | Remove-Item -Force

$token1 = 'A3F9C1'
@{
    token       = $token1
    created     = $now.AddMinutes(-8).ToString('o')
    expiresAt   = $now.AddMinutes(22).ToString('o')
    tool        = 'submit_leaver_hard'
    input       = @{
        userPrincipalName = $users.martinez
        ticketRef         = 'INC-1020'
        stage             = 'Hard'
    }
    requestedBy = 'helpdesk'
} | ConvertTo-Json -Compress |
    Set-Content (Join-Path $pendingDir "$token1.json") -Encoding UTF8

$token2 = 'B7D2E5'
@{
    token       = $token2
    created     = $now.AddMinutes(-3).ToString('o')
    expiresAt   = $now.AddMinutes(27).ToString('o')
    tool        = 'submit_joiner'
    input       = @{
        givenName         = 'Daniel'
        surname           = 'Okafor'
        userPrincipalName = "daniel.okafor@$domain"
        department        = 'Engineering'
        jobTitle          = 'Staff Software Engineer'
        usageLocation     = 'US'
        licenses          = @('ENTERPRISEPACK')
        groups            = @('Engineering-All','Dev-Team','M365-E3-Users')
        ticketRef         = 'INC-1031'
    }
    requestedBy = 'helpdesk'
} | ConvertTo-Json -Compress |
    Set-Content (Join-Path $pendingDir "$token2.json") -Encoding UTF8

Write-Host "  Written: $token1.json, $token2.json (pending approvals)" -ForegroundColor Green

# ── Scheduled operations ──────────────────────────────────────────────────────
$scheduledPath = Join-Path $agentsRoot 'approver\scheduled.json'
@(
    @{
        id          = 'sched-001'
        operation   = 'leaver'
        status      = 'pending'
        whatif      = $false
        scheduledFor= $now.AddDays(2).Date.AddHours(9).ToString('o')
        requestedBy = 'admin'
        ticketRef   = 'INC-1025'
        payload     = @{
            userPrincipalName = $users.rodriguez
            stage             = 'Soft'
            ticketRef         = 'INC-1025'
        }
        note        = 'End of contract - agreed last day'
    }
    @{
        id          = 'sched-002'
        operation   = 'mover'
        status      = 'pending'
        whatif      = $false
        scheduledFor= $now.AddDays(1).Date.AddHours(8).ToString('o')
        requestedBy = 'helpdesk'
        ticketRef   = 'INC-1026'
        payload     = @{
            userPrincipalName = $users.kim
            department        = 'Finance'
            jobTitle          = 'Senior Finance Analyst'
        }
        note        = 'Promotion effective start of next business day'
    }
    @{
        id          = 'sched-003'
        operation   = 'joiner'
        status      = 'pending'
        whatif      = $false
        scheduledFor= $now.AddDays(3).Date.AddHours(8).ToString('o')
        requestedBy = 'admin'
        ticketRef   = 'INC-1032'
        payload     = @{
            givenName         = 'Jamie'
            surname           = 'Smith'
            userPrincipalName = "jamie.smith@$domain"
            department        = 'Marketing'
            jobTitle          = 'Digital Marketing Specialist'
            usageLocation     = 'US'
            licenses          = @('ENTERPRISEPACK')
            groups            = @('Marketing-All','M365-E3-Users')
        }
        note        = 'New hire start date'
    }
) | ConvertTo-Json -Depth 10 -Compress |
    Set-Content $scheduledPath -Encoding UTF8
Write-Host "  Written: scheduled.json (3 pending ops)" -ForegroundColor Green

Write-Host "`nSimulation complete." -ForegroundColor Cyan
Write-Host "  Audit entries : $($entries.Count)" -ForegroundColor White
Write-Host "  UEBA findings : 6 (2 critical, 3 warning, 1 info)" -ForegroundColor White
Write-Host "  Drift findings: 5 (1 critical, 3 warning, 1 info)" -ForegroundColor White
Write-Host "  Risky users   : 2 (1 critical, 1 warning)" -ForegroundColor White
Write-Host "  Pending approvals: 2 tokens (active)" -ForegroundColor White
Write-Host "  Scheduled ops : 3 (leaver, mover, joiner)" -ForegroundColor White
Write-Host "`nRun 'npm run capture' in electron-app/ to refresh screenshots." -ForegroundColor Yellow
