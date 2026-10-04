param(
  [string]$KeyPath,
  [string]$RemoteHost = "151.145.66.148",
  [string]$Destination = (Join-Path $env:LOCALAPPDATA "AltNotify/offsite-backups")
)

$ErrorActionPreference = "Stop"
if ($PSBoundParameters.ContainsKey("KeyPath")) {
  $KeyPath = & "$PSScriptRoot/resolve-oracle-key.ps1" -KeyPath $KeyPath
} else {
  $KeyPath = & "$PSScriptRoot/resolve-oracle-key.ps1"
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $Destination /inheritance:r /grant:r "${account}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" > $null
if ($LASTEXITCODE -ne 0) { throw "バックアップ保存先のアクセス制限に失敗しました" }

$sshArgs = @("-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", $KeyPath, "ubuntu@$RemoteHost")
$metadata = & ssh @sshArgs "sudo /usr/local/sbin/altnoti-offsite-prepare"
if ($LASTEXITCODE -ne 0 -or $metadata.Count -ne 1 -or $metadata -notmatch '^discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite [0-9a-f]{64}$') {
  throw "Oracle側のバックアップ準備に失敗しました"
}
$backupName, $remoteHash = $metadata -split ' '
$temporaryPath = Join-Path $Destination "$backupName.partial"
$finalPath = Join-Path $Destination $backupName
try {
  if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  & scp -B -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i $KeyPath "ubuntu@${RemoteHost}:/home/ubuntu/.altnoti-offsite-staging/$backupName" $temporaryPath
  if ($LASTEXITCODE -ne 0) { throw "バックアップ転送に失敗しました" }
  $localHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($localHash -ne $remoteHash) { throw "バックアップのハッシュが一致しません" }
  & node "$PSScriptRoot/verify-offsite-backup.mjs" $temporaryPath
  if ($LASTEXITCODE -ne 0) { throw "Windows側のバックアップ整合性確認に失敗しました" }
  if (Test-Path -LiteralPath $finalPath) { throw "同名のバックアップが既に存在します" }
  Move-Item -LiteralPath $temporaryPath -Destination $finalPath
  $backups = Get-ChildItem -LiteralPath $Destination -File | Where-Object { $_.Name -match '^discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite$' } | Sort-Object Name -Descending
  $backups | Select-Object -Skip 14 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
  Write-Output "VM外バックアップ成功: $backupName (SHA-256一致、SQLite整合性OK)"
} finally {
  if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  & ssh @sshArgs "sudo /usr/local/sbin/altnoti-offsite-prepare cleanup $backupName" > $null
}
