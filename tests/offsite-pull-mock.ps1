param(
  [ValidateSet("success", "transfer_failure", "hash_mismatch", "sqlite_invalid", "failure_ssh_down")]
  [string]$Scenario,
  [string]$FixtureDirectory
)

$ErrorActionPreference = "Stop"
function Get-FileHash {
  param([string]$LiteralPath, [string]$Algorithm)
  $stream = [IO.File]::OpenRead($LiteralPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [PSCustomObject]@{ Hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") } }
  finally { $sha.Dispose(); $stream.Dispose() }
}
$key = Join-Path $FixtureDirectory "fixture.key"
$source = Join-Path $FixtureDirectory "source.sqlite"
$destination = Join-Path $FixtureDirectory "backups"
[IO.File]::WriteAllText($key, "fixture")
[IO.File]::WriteAllText($source, "verified-copy-fixture")
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$name = "discord-alt-notify-20261005-060000.sqlite"
$global:LASTEXITCODE = 0
$global:successMarks = 0
$global:failureMarks = @()
$global:verifierCalls = 0
$global:earlySuccessMark = $false

function ssh {
  $remoteCommand = [string]$args[-1]
  if ($remoteCommand -match ' mark-success ') {
    $global:successMarks++
    if (-not (Test-Path -LiteralPath (Join-Path $destination $name)) -or $global:verifierCalls -ne 1) { $global:earlySuccessMark = $true }
    $global:LASTEXITCODE = 0
    return
  }
  if ($remoteCommand -match ' mark-failure ([a-z_]+)$') {
    $global:failureMarks += $Matches[1]
    $global:LASTEXITCODE = if ($Scenario -eq "failure_ssh_down") { 255 } else { 0 }
    return
  }
  if ($remoteCommand -match ' cleanup ') { $global:LASTEXITCODE = 0; return }
  $global:LASTEXITCODE = 0
  return "$name $hash"
}

function scp {
  if ($Scenario -in @("transfer_failure", "failure_ssh_down")) { $global:LASTEXITCODE = 1; return }
  $target = [string]$args[-1]
  if ($Scenario -eq "hash_mismatch") { [IO.File]::WriteAllText($target, "bad-copy") }
  else { Copy-Item -LiteralPath $source -Destination $target }
  $global:LASTEXITCODE = 0
}

function node {
  $global:verifierCalls++
  $global:LASTEXITCODE = if ($Scenario -eq "sqlite_invalid") { 1 } else { 0 }
}

$succeeded = $true
$message = $null
try { & "$PSScriptRoot/../deploy/pull-offsite-backup.ps1" -KeyPath $key -Destination $destination > $null }
catch { $succeeded = $false; $message = $_.Exception.Message }

[PSCustomObject]@{
  succeeded = $succeeded
  message = $message
  successMarks = $global:successMarks
  failureMarks = $global:failureMarks
  verifierCalls = $global:verifierCalls
  earlySuccessMark = $global:earlySuccessMark
  finalExists = Test-Path -LiteralPath (Join-Path $destination $name)
} | ConvertTo-Json -Compress
if (-not $succeeded) { exit 1 }
