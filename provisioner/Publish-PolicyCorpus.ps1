<#
.SYNOPSIS
    Publishes the JML policy corpus to an Azure AI Search index that backs the
    Foundry IQ knowledge agent used to ground risk/approval decisions.

.DESCRIPTION
    Microsoft Agents League - Enterprise Agents track requires a Microsoft IQ
    layer. JML uses Foundry IQ (Azure AI Foundry knowledge retrieval) grounded on
    this repo's shared/policy-corpus/*.md files: SoD rules, offboarding playbook,
    approved access patterns, and freeze windows.

    This script creates (or updates) a simple search index and uploads each policy
    document as a chunked record. Point the Foundry knowledge agent (or the app's
    direct 'search' mode in approver/foundry-iq.json) at the resulting index.

    Requires an Azure AI Search service. Needs the admin key (create/upload).

.EXAMPLE
    .\Publish-PolicyCorpus.ps1 -SearchEndpoint https://my-search.search.windows.net `
        -AdminKey <key> -IndexName jml-policy-index
#>
param(
    [Parameter(Mandatory)][string]$SearchEndpoint,
    [Parameter(Mandatory)][string]$AdminKey,
    [string]$IndexName  = "jml-policy-index",
    [string]$ApiVersion = "2024-07-01"
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 defaults to TLS 1.0; Azure AI Search requires TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# PS 5.1 sends "Expect: 100-continue"; Azure Search drops larger POSTs that use
# it ("unexpected error occurred on a send"). Disable it for document uploads.
[Net.ServicePointManager]::Expect100Continue = $false
$agentsRoot = Split-Path $PSScriptRoot -Parent
$corpusDir  = Join-Path $agentsRoot "shared\policy-corpus"
$endpoint   = $SearchEndpoint.TrimEnd('/')
$headers    = @{ "api-key" = $AdminKey; "Content-Type" = "application/json" }

function Log($m) { Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) }

# 1. Create / update the index schema
$indexSchema = @{
    name   = $IndexName
    fields = @(
        @{ name = "id";      type = "Edm.String"; key = $true;  searchable = $false },
        @{ name = "title";   type = "Edm.String"; searchable = $true },
        @{ name = "content"; type = "Edm.String"; searchable = $true },
        @{ name = "url";     type = "Edm.String"; searchable = $false }
    )
} | ConvertTo-Json -Depth 6

Log "Creating/updating index '$IndexName'..."
Invoke-RestMethod -Method PUT -Headers $headers `
    -Uri "$endpoint/indexes/$IndexName`?api-version=$ApiVersion" -Body $indexSchema | Out-Null
Log "Index ready."

# 2. Build documents: one record per H2 (##) section, so each upload stays small
#    (some networks run a TLS-inspection appliance that 413s multi-KB POSTs).
$docs = @()
Get-ChildItem -Path $corpusDir -Filter *.md | ForEach-Object {
    $file = $_
    $text = Get-Content $file.FullName -Raw
    $fileTitle = ($text -split "`n" | Where-Object { $_ -match '^#\s' } | Select-Object -First 1) -replace '^#\s*', ''
    if (-not $fileTitle) { $fileTitle = $file.BaseName }
    $base = ($file.BaseName -replace '[^a-zA-Z0-9_-]', '-')

    # Split on "## " headings; the preamble before the first ## becomes section 0.
    $sections = [regex]::Split($text, '(?m)^(?=##\s)')
    $n = 0
    foreach ($sec in $sections) {
        $secText = $sec.Trim()
        if (-not $secText) { continue }
        $secTitle = ($secText -split "`n" | Where-Object { $_ -match '^#{1,2}\s' } | Select-Object -First 1) -replace '^#{1,2}\s*', ''
        if (-not $secTitle) { $secTitle = $fileTitle }
        $docs += @{
            id      = "$base-$n"
            title   = "$fileTitle - $secTitle"
            content = $secText
            url     = "shared/policy-corpus/$($file.Name)"
        }
        $n++
    }
}

Log ("Uploading " + $docs.Count + " policy sections (one request each)...")
$uploadUri = "$endpoint/indexes/$IndexName/docs/index?api-version=$ApiVersion"
$uploaded = 0
foreach ($doc in $docs) {
    $payload = @{ value = @($doc + @{ '@search.action' = 'mergeOrUpload' }) } | ConvertTo-Json -Depth 8
    $tmp = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($tmp, $payload, (New-Object System.Text.UTF8Encoding($false)))
    # curl.exe (bundled) is robust where PS 5.1 Invoke-RestMethod is not.
    $curlOut = & curl.exe --silent --show-error --fail-with-body -X POST $uploadUri `
        -H "api-key: $AdminKey" -H "Content-Type: application/json; charset=utf-8" `
        --data-binary "@$tmp" 2>&1
    $curlExit = $LASTEXITCODE
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if ($curlExit -ne 0) { Log ("Section '" + $doc.id + "' failed (curl " + $curlExit + "): " + $curlOut) "ERROR"; exit 1 }
    $uploaded++
}

Log ("Done. " + $uploaded + " sections published to '$IndexName'.")
Log "Next: set approver/foundry-iq.json -> enabled:true, mode 'search', index '$IndexName' (or point a Foundry knowledge agent at this index and use mode 'retrieve')."
