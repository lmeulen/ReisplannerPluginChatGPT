[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://')]
  [string]$WorkerUrl,

  [ValidatePattern('^[A-Za-z0-9]{2,10}$')]
  [string]$StationCode = 'ASD',

  [switch]$CheckRateLimit,

  [ValidateRange(1, 10000)]
  [int]$RateLimit = 45
)

$ErrorActionPreference = 'Stop'
$baseUrl = $WorkerUrl.TrimEnd('/')
$mcpUrl = "$baseUrl/mcp"
$protocolVersion = '2025-06-18'

function Get-McpPayload {
  param([Parameter(Mandatory = $true)]$Response)

  $contentType = $Response.Headers['Content-Type']
  $body = $Response.Content
  if ($contentType -match 'text/event-stream') {
    $dataLine = $body -split "`n" | Where-Object { $_.Trim().StartsWith('data:') } | Select-Object -First 1
    if (-not $dataLine) {
      throw 'MCP response did not contain an SSE data line.'
    }
    $body = $dataLine.Trim().Substring(5).Trim()
  }

  return $body | ConvertFrom-Json
}

function Invoke-McpRpc {
  param(
    [Parameter(Mandatory = $true)]$Body,
    [hashtable]$Headers = @{}
  )

  $requestHeaders = @{
    Accept = 'application/json, text/event-stream'
    'MCP-Protocol-Version' = $protocolVersion
  }
  foreach ($key in $Headers.Keys) {
    $requestHeaders[$key] = $Headers[$key]
  }

  $response = Invoke-WebRequest -Uri $mcpUrl -Method Post -Headers $requestHeaders -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 20) -UseBasicParsing -SkipHttpErrorCheck
  $payload = Get-McpPayload $response
  return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Payload = $payload }
}

function Assert-HttpSuccess {
  param([Parameter(Mandatory = $true)]$Result, [Parameter(Mandatory = $true)][string]$Step)
  if ($Result.StatusCode -lt 200 -or $Result.StatusCode -ge 300) {
    throw "$Step failed with HTTP $($Result.StatusCode): $($Result.Payload | ConvertTo-Json -Compress -Depth 8)"
  }
}

$health = Invoke-WebRequest -Uri "$baseUrl/health" -Method Get -UseBasicParsing -SkipHttpErrorCheck
if ($health.StatusCode -ne 200) {
  throw "/health failed with HTTP $($health.StatusCode)."
}
$healthPayload = $health.Content | ConvertFrom-Json
if ($healthPayload.status -ne 'ok') {
  throw "/health did not return status=ok."
}
Write-Host 'PASS /health'

$initialize = Invoke-McpRpc @{
  jsonrpc = '2.0'
  id = 1
  method = 'initialize'
  params = @{
    protocolVersion = $protocolVersion
    capabilities = @{}
    clientInfo = @{ name = 'mcp-smoke-test'; version = '1.0.0' }
  }
}
Assert-HttpSuccess $initialize 'initialize'
if (-not $initialize.Payload.result.serverInfo) {
  throw 'initialize did not return serverInfo.'
}
Write-Host 'PASS initialize'

$ping = Invoke-McpRpc @{ jsonrpc = '2.0'; id = 2; method = 'ping' }
Assert-HttpSuccess $ping 'ping'
if ($null -eq $ping.Payload.result) {
  throw 'ping did not return a result.'
}
Write-Host 'PASS ping'

$tools = Invoke-McpRpc @{ jsonrpc = '2.0'; id = 3; method = 'tools/list' }
Assert-HttpSuccess $tools 'tools/list'
if (-not $tools.Payload.result.tools -or $tools.Payload.result.tools.Count -eq 0) {
  throw 'tools/list returned no tools.'
}
Write-Host "PASS tools/list ($($tools.Payload.result.tools.Count) tools)"

if ($CheckRateLimit) {
  Write-Host "Checking rate limit with $($RateLimit + 1) invalid tool calls..."
  for ($index = 1; $index -le $RateLimit; $index++) {
    $probe = Invoke-McpRpc @{ jsonrpc = '2.0'; id = 1000 + $index; method = 'tools/call'; params = @{ name = '__rate_limit_probe__'; arguments = @{} } }
    if ($probe.StatusCode -eq 429) {
      throw "Rate limit triggered before configured limit ($index/$RateLimit)."
    }
  }

  $limited = Invoke-McpRpc @{ jsonrpc = '2.0'; id = 2000; method = 'tools/call'; params = @{ name = '__rate_limit_probe__'; arguments = @{} } }
  if ($limited.StatusCode -ne 429) {
    throw "Expected HTTP 429 after $RateLimit calls, received HTTP $($limited.StatusCode)."
  }
  Write-Host 'PASS rate limit (HTTP 429)'
}

$toolCall = Invoke-McpRpc @{
  jsonrpc = '2.0'
  id = 4
  method = 'tools/call'
  params = @{
    name = 'resolve_station'
    arguments = @{ station = $StationCode; language = 'nl' }
  }
}
Assert-HttpSuccess $toolCall 'tools/call resolve_station'
if (-not $toolCall.Payload.result) {
  throw 'tools/call did not return a result.'
}
Write-Host "PASS tools/call resolve_station ($StationCode)"

Write-Host 'MCP smoke test completed successfully.'
