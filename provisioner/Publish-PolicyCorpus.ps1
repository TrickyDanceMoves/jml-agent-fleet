<#
.SYNOPSIS
    Publishes the JML policy corpus to an Azure AI Search index that backs the
    Foundry IQ knowledge agent used to ground risk/approval decisions.

.DESCRIPTION
    Microsoft Agents League — Enterprise Agents track requires a Microsoft IQ
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

# 2. Build documents from the corpus (one record per H2 section for finer grounding)
$docs = @()
Get-ChildItem -Path $corpusDir -Filter *.md | ForEach-Object {
    $file = $_
    $text = Get-Content $file.FullName -Raw
    $title = ($text -split "`n" | Where-Object { $_ -match '^#\s' } | Select-Object -First 1) -replace '^#\s*', ''
    if (-not $title) { $title = $file.BaseName }
    # Whole-file record (keeps cross-section context)
    $docs += @{
        id      = ($file.BaseName -replace '[^a-zA-Z0-9_-]', '-')
        title   = $title
        content = $text
        url     = "shared/policy-corpus/$($file.Name)"
    }
}

Log ("Uploading " + $docs.Count + " policy documents...")
$payload = @{ value = @($docs | ForEach-Object { $_ + @{ '@search.action' = 'mergeOrUpload' } }) } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method POST -Headers $headers `
    -Uri "$endpoint/indexes/$IndexName/docs/index?api-version=$ApiVersion" -Body $payload | Out-Null

Log "Done. Policy corpus published to '$IndexName'."
Log "Next: set approver/foundry-iq.json -> enabled:true, mode 'search', index '$IndexName' (or point a Foundry knowledge agent at this index and use mode 'retrieve')."
