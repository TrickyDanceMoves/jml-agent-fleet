<#
.SYNOPSIS
    Behavioral anomaly detection over the JML audit log.

.DESCRIPTION
    Reads audit.jsonl and runs six anomaly rules. Produces a JSON report in
    auditor/reports/ueba-YYYY-MM-DD-HHmmss.json and sends a Teams notification
    for critical findings if notifications.json is configured.

    Rules (all configurable via shared/ueba-config.json):

    off-hours           (warning)  Non-whatif operations outside business hours.
                                   Default window: 07:00-19:00 local time.

    high-volume-burst   (critical) Single agent processes >= burstCountPerAgent
                                   operations within burstWindowMinutes. Indicates
                                   runaway automation or compromised agent credential.

    repeated-subject    (warning)  Same subject appears in >= repeatedSubjectThreshold
                                   operations in the analysis window. Could indicate
                                   a loop, repeated failure, or targeted access changes.

    repeated-failures   (critical) Same agent+subject combination produces >= 2
                                   failed/partial outcomes. Potential targeted
                                   attack, broken config, or bypass attempt.

    bulk-termination    (critical) Leaver agent processes >= bulkTerminationPerDay
                                   distinct subjects in a single calendar day.

    outcome-degradation (warning)  Failure+partial rate across all operational
                                   entries exceeds outcomeFailureRateThreshold.

.PARAMETER WindowDays
    How many days of audit history to analyse. Default: from ueba-config.json (7).

.PARAMETER WhatIf
    Run analysis and print findings without writing a report or sending notifications.

.EXAMPLE
    .\Invoke-UEBAAnalysis.ps1
    .\Invoke-UEBAAnalysis.ps1 -WindowDays 30
    .\Invoke-UEBAAnalysis.ps1 -WhatIf
#>
param(
    [int]$WindowDays = 0,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$startTime  = Get-Date

$agentsRoot = Split-Path $PSScriptRoot -Parent
$config     = Get-Content (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$uebaCfg    = Get-Content (Join-Path $agentsRoot "shared\ueba-config.json") | ConvertFrom-Json

. (Join-Path $agentsRoot "shared\Helpers.ps1")

$auditPath = Join-Path $agentsRoot "audit.jsonl"
if (-not (Test-Path $auditPath)) {
    Write-Host "[UEBA] audit.jsonl not found at $auditPath" -ForegroundColor Red
    exit 1
}

$days           = if ($WindowDays -gt 0) { $WindowDays } else { $uebaCfg.windowDays }
$windowStart    = (Get-Date).AddDays(-$days).ToUniversalTime()
$excludeAgents  = @($uebaCfg.excludeAgents)
$excludeWhatif  = [bool]$uebaCfg.excludeWhatif

Write-Host "[UEBA] Analysing audit log - window: last $days day(s)" -ForegroundColor Cyan

# -- Parse audit log -----------------------------------------------------------
$raw     = Get-Content $auditPath
$entries = [System.Collections.Generic.List[object]]::new()

foreach ($line in $raw) {
    if (-not $line.Trim()) { continue }
    try {
        $obj = $line | ConvertFrom-Json
        # Normalise: both formats use 'timestamp'; agent field may be 'source' in approver entries
        if (-not $obj.agent -and $obj.source) {
            Add-Member -InputObject $obj -NotePropertyName "agent" -NotePropertyValue $obj.source -Force
        }
        if (-not $obj.action -and $obj.tool) {
            Add-Member -InputObject $obj -NotePropertyName "action" -NotePropertyValue $obj.tool -Force
        }
        # Filter to analysis window
        if ($obj.timestamp) {
            try {
                $ts = [datetime]$obj.timestamp
                if ($ts.ToUniversalTime() -lt $windowStart) { continue }
            } catch { continue }
        }
        $entries.Add($obj)
    } catch {}
}

Write-Host "[UEBA] Parsed $($entries.Count) entries in window" -ForegroundColor Cyan

# Filter for operational entries (exclude admin/reporting agents and optional whatif)
$opEntries = [System.Collections.Generic.List[object]]::new()
foreach ($e in $entries) {
    if ($excludeAgents -contains $e.agent) { continue }
    if ($excludeWhatif -and $e.whatif -eq $true) { continue }
    $opEntries.Add($e)
}

Write-Host "[UEBA] $($opEntries.Count) operational entries after filtering" -ForegroundColor Cyan

# -- Helper: summarise an entry for report output -----------------------------
function Get-EntrySummary {
    param($Entry)
    @{
        timestamp = $Entry.timestamp
        agent     = $Entry.agent
        action    = $Entry.action
        subject   = $Entry.subject
        outcome   = $Entry.outcome
        whatif    = $Entry.whatif
    }
}

$findings = [System.Collections.Generic.List[object]]::new()

function Add-Finding {
    param([string]$RuleId, [string]$Severity, [string]$Title, [array]$Events)
    $findings.Add([PSCustomObject]@{
        ruleId   = $RuleId
        severity = $Severity
        title    = $Title
        count    = $Events.Count
        events   = $Events
    })
    $color  = switch ($Severity) { "critical" { "Red" } "warning" { "Yellow" } default { "Cyan" } }
    $plural = if ($Events.Count -ne 1) { "s" } else { "" }
    Write-Host ("[UEBA] [{0}] {1} ({2} event{3})" -f $Severity.ToUpper(), $Title, $Events.Count, $plural) -ForegroundColor $color
}

# -- Rule 1: off-hours ---------------------------------------------------------
Write-Host "`n[UEBA] Rule: off-hours..." -ForegroundColor Cyan
$bizStart     = [int]$uebaCfg.businessHoursStart
$bizEnd       = [int]$uebaCfg.businessHoursEnd
$offHours     = [System.Collections.Generic.List[object]]::new()

foreach ($e in $opEntries) {
    if (-not $e.timestamp) { continue }
    try {
        $localHour = ([datetime]$e.timestamp).ToLocalTime().Hour
        if ($localHour -lt $bizStart -or $localHour -ge $bizEnd) {
            $offHours.Add((Get-EntrySummary $e))
        }
    } catch {}
}

if ($offHours.Count -gt 0) {
    Add-Finding -RuleId "off-hours" -Severity "warning" `
        -Title ($offHours.Count.ToString() + " operation(s) outside business hours " + $bizStart + ":00-" + $bizEnd + ":00 local") `
        -Events @($offHours)
} else {
    Write-Host "[UEBA]   OK - all operations within business hours" -ForegroundColor Green
}

# -- Rule 2: high-volume-burst -------------------------------------------------
Write-Host "`n[UEBA] Rule: high-volume-burst..." -ForegroundColor Cyan
$burstThreshold = [int]$uebaCfg.burstCountPerAgent
$burstWindow    = [int]$uebaCfg.burstWindowMinutes
$burstFound     = $false

$agentGroups = $opEntries | Group-Object agent
foreach ($ag in $agentGroups) {
    $sorted = @($ag.Group | Sort-Object { [datetime]$_.timestamp })
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $wStart = [datetime]$sorted[$i].timestamp
        $wEnd   = $wStart.AddMinutes($burstWindow)
        $inWin  = @($sorted | Where-Object {
            $ts = [datetime]$_.timestamp
            $ts -ge $wStart -and $ts -lt $wEnd
        })
        if ($inWin.Count -ge $burstThreshold) {
            Add-Finding -RuleId "high-volume-burst" -Severity "critical" `
                -Title "Agent '$($ag.Name)' processed $($inWin.Count) operations in $burstWindow min (threshold: $burstThreshold)" `
                -Events @($inWin | ForEach-Object { Get-EntrySummary $_ })
            $burstFound = $true
            break  # one finding per agent per run is enough
        }
    }
}
if (-not $burstFound) {
    Write-Host "[UEBA]   OK - no burst activity detected" -ForegroundColor Green
}

# -- Rule 3: repeated-subject --------------------------------------------------
Write-Host "`n[UEBA] Rule: repeated-subject..." -ForegroundColor Cyan
$repeatThreshold = [int]$uebaCfg.repeatedSubjectThreshold
$subjectGroups   = $opEntries | Group-Object subject
$repeatFound     = $false

foreach ($sg in $subjectGroups) {
    if (-not $sg.Name -or $sg.Count -lt $repeatThreshold) { continue }
    Add-Finding -RuleId "repeated-subject" -Severity "warning" `
        -Title "Subject '$($sg.Name)' appeared in $($sg.Count) operations (threshold: $repeatThreshold)" `
        -Events @($sg.Group | ForEach-Object { Get-EntrySummary $_ })
    $repeatFound = $true
}
if (-not $repeatFound) {
    Write-Host "[UEBA]   OK - no subjects exceed repeat threshold" -ForegroundColor Green
}

# -- Rule 4: repeated-failures -------------------------------------------------
Write-Host "`n[UEBA] Rule: repeated-failures..." -ForegroundColor Cyan
$failThreshold = [int]$uebaCfg.repeatedFailureThreshold
$failEntries   = @($opEntries | Where-Object { $_.outcome -eq "failed" -or $_.outcome -eq "partial" })
$failGroups    = $failEntries | Group-Object { "$($_.agent)|$($_.subject)" }
$failFound     = $false

foreach ($fg in $failGroups) {
    if ($fg.Count -lt $failThreshold) { continue }
    $parts = $fg.Name -split "\|"
    Add-Finding -RuleId "repeated-failures" -Severity "critical" `
        -Title "Agent '$($parts[0])' had $($fg.Count) failed/partial outcomes on '$($parts[1])' (threshold: $failThreshold)" `
        -Events @($fg.Group | ForEach-Object { Get-EntrySummary $_ })
    $failFound = $true
}
if (-not $failFound) {
    Write-Host "[UEBA]   OK - no repeated failure patterns" -ForegroundColor Green
}

# -- Rule 5: bulk-termination --------------------------------------------------
Write-Host "`n[UEBA] Rule: bulk-termination..." -ForegroundColor Cyan
$bulkThreshold = [int]$uebaCfg.bulkTerminationPerDay
$leaverEntries = @($opEntries | Where-Object { $_.agent -eq "leaver" -and $_.outcome -ne "failed" })
$bulkFound     = $false

if ($leaverEntries.Count -gt 0) {
    $byDay = $leaverEntries | Group-Object { ([datetime]$_.timestamp).ToString("yyyy-MM-dd") }
    foreach ($day in $byDay) {
        $distinctSubjects = @($day.Group | Select-Object -ExpandProperty subject | Select-Object -Unique)
        if ($distinctSubjects.Count -ge $bulkThreshold) {
            Add-Finding -RuleId "bulk-termination" -Severity "critical" `
                -Title "Leaver processed $($distinctSubjects.Count) distinct subject(s) on $($day.Name) (threshold: $bulkThreshold)" `
                -Events @($day.Group | ForEach-Object { Get-EntrySummary $_ })
            $bulkFound = $true
        }
    }
}
if (-not $bulkFound) {
    Write-Host "[UEBA]   OK - no bulk termination patterns" -ForegroundColor Green
}

# -- Rule 6: outcome-degradation -----------------------------------------------
Write-Host "`n[UEBA] Rule: outcome-degradation..." -ForegroundColor Cyan
$rateThreshold = [double]$uebaCfg.outcomeFailureRateThreshold

if ($opEntries.Count -gt 0) {
    $failCount  = @($opEntries | Where-Object { $_.outcome -eq "failed" -or $_.outcome -eq "partial" }).Count
    $rate       = [Math]::Round($failCount / $opEntries.Count, 3)
    $pct        = [Math]::Round($rate * 100, 1)

    if ($rate -gt $rateThreshold) {
        Add-Finding -RuleId "outcome-degradation" -Severity "warning" `
            -Title "Failure/partial rate is $pct% ($failCount/$($opEntries.Count) operations, threshold: $([Math]::Round($rateThreshold*100))%)" `
            -Events @($opEntries | Where-Object { $_.outcome -eq "failed" -or $_.outcome -eq "partial" } | ForEach-Object { Get-EntrySummary $_ })
    } else {
        Write-Host "[UEBA]   OK - outcome rate $pct% is within threshold ($([Math]::Round($rateThreshold*100))%)" -ForegroundColor Green
    }
} else {
    Write-Host "[UEBA]   SKIP - no operational entries to evaluate" -ForegroundColor Yellow
}

# -- Build and write report ----------------------------------------------------
$duration = [int]((Get-Date) - $startTime).TotalSeconds
$runId    = [System.Guid]::NewGuid().ToString()

$summary = @{
    total    = $findings.Count
    critical = @($findings | Where-Object { $_.severity -eq "critical" }).Count
    warning  = @($findings | Where-Object { $_.severity -eq "warning"  }).Count
    info     = @($findings | Where-Object { $_.severity -eq "info"     }).Count
}

$report = [ordered]@{
    runId           = $runId
    timestamp       = (Get-Date -Format "o")
    durationSeconds = $duration
    windowDays      = $days
    windowStart     = $windowStart.ToString("o")
    entriesAnalyzed = $entries.Count
    entriesFiltered = $opEntries.Count
    summary         = $summary
    findings        = @($findings)
}

$reportJson = $report | ConvertTo-Json -Depth 10

Write-Host "`n[UEBA] Summary: $($summary.critical) critical / $($summary.warning) warning / $($summary.info) info" -ForegroundColor Cyan

if (-not $WhatIf) {
    $reportsDir = Join-Path $PSScriptRoot "reports"
    if (-not (Test-Path $reportsDir)) { New-Item -ItemType Directory -Path $reportsDir | Out-Null }
    $reportPath = Join-Path $reportsDir "ueba-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').json"
    $reportJson | Set-Content $reportPath -Encoding UTF8
    Write-Host "[UEBA] Report written: $reportPath" -ForegroundColor Cyan

    # Connect for audit + notification
    Connect-AgentGraph -Config $config 2>$null
    $outcome = if ($summary.critical -gt 0) { "failed" } elseif ($summary.warning -gt 0) { "partial" } else { "success" }
    Write-AuditEntry -Agent "auditor" -Action "UEBAAnalysis" -Subject "tenant" `
        -WhatIf $false -Outcome $outcome `
        -Details @{ runId = $runId; critical = $summary.critical; warning = $summary.warning; entriesAnalyzed = $entries.Count; report = $reportPath } `
        -Notify ([bool]($uebaCfg.notifyOnCritical -and $summary.critical -gt 0))
} else {
    Write-Host "[UEBA] WHATIF - report not written" -ForegroundColor DarkCyan
}

Write-Host "[UEBA] Done (${duration}s)." -ForegroundColor Cyan
Write-Output $reportJson
