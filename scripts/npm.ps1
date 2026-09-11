$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$nodeDir = Join-Path $root '.tools\node-v22.12.0-win-x64'
$npmCmd = Join-Path $nodeDir 'npm.cmd'

if (-not (Test-Path $npmCmd)) {
  throw "Portable npm was not found at $npmCmd. Install Node.js 22+ globally or restore the .tools folder."
}

$env:PATH = "$nodeDir;$env:PATH"
& $npmCmd @args
exit $LASTEXITCODE