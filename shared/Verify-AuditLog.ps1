param([string]$AuditLogPath)

if (-not $AuditLogPath) {
    $AuditLogPath = Join-Path (Split-Path $PSScriptRoot -Parent) "audit.jsonl"
}

if (-not (Test-Path $AuditLogPath)) {
    Write-Host "Audit log not found: $AuditLogPath" -ForegroundColor Red
    exit 1
}

function Get-Hash([string]$s) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $sha   = [System.Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLower()
}

$lines   = Get-Content $AuditLogPath
$ok      = 0
$broken  = 0
$prevRaw = $null

Write-Host ("Verifying " + $lines.Count + " audit entries...") -ForegroundColor Cyan

for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i].Trim()
    if (-not $line) { continue }

    try {
        $entry = $line | ConvertFrom-Json
    } catch {
        Write-Host ("[Line " + ($i+1) + "] INVALID JSON") -ForegroundColor Red
        $broken++
        $prevRaw = $null
        continue
    }

    # Verify prevHash
    if ($i -eq 0 -or $prevRaw -eq $null) {
        if ($entry.prevHash -ne "genesis") {
            Write-Host ("[Line " + ($i+1) + "] BAD prevHash: expected 'genesis', got '" + $entry.prevHash + "'") -ForegroundColor Red
            $broken++
        }
    } else {
        $expected = Get-Hash $prevRaw
        if ($entry.prevHash -ne $expected) {
            Write-Host ("[Line " + ($i+1) + "] CHAIN BROKEN: prevHash mismatch at entry " + $entry.timestamp) -ForegroundColor Red
            $broken++
        }
    }

    # Verify self-hash
    $storedHash = $entry.hash
    $entryWithoutHash = $entry | Select-Object * -ExcludeProperty hash | ConvertTo-Json -Compress
    # Rebuild ordered to match write order
    $rebuilt = [ordered]@{
        timestamp = $entry.timestamp; agent = $entry.agent; action = $entry.action
        subject   = $entry.subject;   whatif = $entry.whatif; outcome = $entry.outcome
        details   = $entry.details;   prevHash = $entry.prevHash
    }
    $rebuiltJson  = $rebuilt | ConvertTo-Json -Compress
    $expectedHash = Get-Hash $rebuiltJson

    if ($storedHash -ne $expectedHash) {
        Write-Host ("[Line " + ($i+1) + "] TAMPERED: self-hash mismatch at entry " + $entry.timestamp) -ForegroundColor Red
        $broken++
    } else {
        $ok++
    }

    $prevRaw = $line
}

Write-Host ""
if ($broken -eq 0) {
    Write-Host ("PASS -- " + $ok + " entries verified, chain intact") -ForegroundColor Green
} else {
    Write-Host ("FAIL -- " + $broken + " integrity violation(s) detected in " + $ok + " entries") -ForegroundColor Red
    exit 1
}
