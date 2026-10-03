param(
  [string]$KeyPath,
  [string]$RemoteHost = "151.145.66.148"
)

$ErrorActionPreference = "Stop"
if ($PSBoundParameters.ContainsKey("KeyPath")) {
  $KeyPath = & "$PSScriptRoot/resolve-oracle-key.ps1" -KeyPath $KeyPath
} else {
  $KeyPath = & "$PSScriptRoot/resolve-oracle-key.ps1"
}

$secureUrl = Read-Host "Healthchecks.ioの秘密heartbeat URLを入力してください" -AsSecureString
$urlPointer = [IntPtr]::Zero
$plainUrl = $null
try {
  $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
  $plainUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
  if ($plainUrl -notmatch '^https://') { throw "HTTPSのHealthchecks URLが必要です" }
  $sshArgs = @("-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", $KeyPath, "ubuntu@$RemoteHost", "sudo /usr/local/sbin/altnoti-configure-healthcheck")
  $plainUrl | & ssh @sshArgs
  if ($LASTEXITCODE -ne 0) { throw "Oracle側のHealthchecks設定に失敗しました" }
}
finally {
  if ($urlPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer) }
  $plainUrl = $null
  $secureUrl = $null
}
