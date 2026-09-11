$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$nodeDir = Join-Path $root '.tools\node-v22.12.0-win-x64'
$nodeExe = Join-Path $nodeDir 'node.exe'

if (-not (Test-Path $nodeExe)) {
  throw "Portable Node.js was not found at $nodeExe. Install Node.js 22+ globally or restore the .tools folder."
}

& $nodeExe @args
exit $LASTEXITCODE