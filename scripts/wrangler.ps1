$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$nodeDir = Join-Path $root '.tools\node-v22.12.0-win-x64'
$wranglerCmd = Join-Path $root 'node_modules\.bin\wrangler.cmd'

if (-not (Test-Path $wranglerCmd)) {
  throw "Wrangler was not found at $wranglerCmd. Run .\scripts\npm.ps1 install first."
}

$env:PATH = "$nodeDir;$env:PATH"
& $wranglerCmd @args
exit $LASTEXITCODE