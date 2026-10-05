param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'AltNotify/offsite-backups'))
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { exit 2 }
$scriptPath = Join-Path $PSScriptRoot 'pull-offsite-backup.mjs'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { exit 2 }
& node $scriptPath $Destination
exit $LASTEXITCODE
