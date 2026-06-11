param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$AgentsRoot
)
# Persistent Graph query worker for the JML Console.
# Holds one authenticated Graph connection and executes query snippets sent
# as JSON lines on stdin: { "id": n, "script": "..." }.
# Replies one JSON line per request: { "id": n, "ok": bool, "output"|"error": "..." }.
# Connection happens lazily on the first request and is re-established after
# auth-shaped failures. Each snippet runs in a child scope so no variables
# leak between requests.

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding  = New-Object System.Text.UTF8Encoding $false

Import-Module Microsoft.Graph.Authentication -ErrorAction SilentlyContinue
$cfg = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
. (Join-Path $AgentsRoot 'shared\Helpers.ps1')

$script:connected = $false
function Ensure-Graph {
  if (-not $script:connected) {
    Connect-AgentGraph -Config $cfg
    $script:connected = $true
  }
}

[Console]::Out.WriteLine('{"ready":true}')

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $reply = @{ id = $req.id }
  try {
    Ensure-Graph
    $out = & ([scriptblock]::Create($req.script)) 2>&1 | Out-String
    $reply.ok = $true
    $reply.output = $out
  } catch {
    $reply.ok = $false
    $reply.error = $_.Exception.Message
    if ($_.Exception.Message -match 'auth|token|connect|unauthorized|401') {
      $script:connected = $false
    }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 4))
}
