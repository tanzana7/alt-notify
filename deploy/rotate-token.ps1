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

$secureToken = Read-Host "新しいDiscord Bot Tokenを入力してください" -AsSecureString
$tokenPointer = [IntPtr]::Zero
$plainToken = $null
try {
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  if ([string]::IsNullOrWhiteSpace($plainToken)) { throw "Tokenが空です" }
  $sshArgs = @("-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", $KeyPath, "ubuntu@$RemoteHost", "sudo /usr/local/sbin/altnoti-rotate-token")
  $plainToken | & ssh @sshArgs
  if ($LASTEXITCODE -ne 0) { throw "Oracle側のToken更新に失敗しました" }
}
finally {
  if ($tokenPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
  $plainToken = $null
  $secureToken = $null
}
