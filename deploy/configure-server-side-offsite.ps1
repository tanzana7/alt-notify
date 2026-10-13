param(
  [string]$RemoteHost = "151.145.66.148",
  [string]$RemoteUser = "ubuntu",
  [string]$Bucket = "altnotify",
  [string]$RecoveryPath = "C:\Users\user\CodexRecovery\altnoti-offsite-key.dpapi"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-SshCapture {
  param(
    [Parameter(Mandatory)] [string]$KeyPath,
    [Parameter(Mandatory)] [string]$RemoteCommand
  )
  $output = & ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i $KeyPath "$RemoteUser@$RemoteHost" $RemoteCommand 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Oracle SSH operation failed (exit $LASTEXITCODE)."
  }
  return (($output | Out-String).Trim())
}

function Send-SshText {
  param(
    [Parameter(Mandatory)] [string]$KeyPath,
    [Parameter(Mandatory)] [string]$RemoteCommand,
    [Parameter(Mandatory)] [string]$Text
  )
  $Text | & ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i $KeyPath "$RemoteUser@$RemoteHost" $RemoteCommand 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Oracle secret configuration failed (exit $LASTEXITCODE)."
  }
}

function Assert-SafeValue {
  param([Parameter(Mandatory)] [string]$Name, [Parameter(Mandatory)] [string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match "[\r\n\x00]") {
    throw "$Name is empty or contains an unsupported control character."
  }
}

$keyPath = (& "$PSScriptRoot\resolve-oracle-key.ps1" | Select-Object -Last 1).Trim()
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw "SSH key resolver returned no usable key." }

$wranglerOutput = & npx --yes wrangler whoami 2>$null | Out-String
if ($LASTEXITCODE -ne 0) { throw "Wrangler authentication is unavailable." }
$accountId = [regex]::Match($wranglerOutput, "\b[0-9a-fA-F]{32}\b").Value.ToLowerInvariant()
if ($accountId -notmatch "^[0-9a-f]{32}$") { throw "Cloudflare Account ID could not be resolved from Wrangler authentication." }

$accessKeyId = Read-Host "R2 Access Key ID"
$secretSecure = Read-Host "R2 Secret Access Key" -AsSecureString
$secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure)
try {
  $secretAccessKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr)
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr)
}
Assert-SafeValue -Name "R2 Access Key ID" -Value $accessKeyId
Assert-SafeValue -Name "R2 Secret Access Key" -Value $secretAccessKey

$endpoint = "https://$accountId.r2.cloudflarestorage.com"
$envText = @(
  "ALTN_R2_ENDPOINT=$endpoint"
  "ALTN_R2_BUCKET=$Bucket"
  "ALTN_R2_ACCESS_KEY_ID=$accessKeyId"
  "ALTN_R2_SECRET_ACCESS_KEY=$secretAccessKey"
  "ALTN_R2_REGION=auto"
  "ALTN_R2_PREFIX=backups"
  "ALTN_OFFSITE_KEY_FILE=/etc/altnoti-offsite/backup.key"
) -join "`n"

try {
  Invoke-SshCapture -KeyPath $keyPath -RemoteCommand "sudo -n install -d -o root -g root -m 700 /etc/altnoti-offsite" | Out-Null
  Send-SshText -KeyPath $keyPath -RemoteCommand "sudo -n bash -c 'umask 077; tee /etc/altnoti-offsite/r2.env >/dev/null; chown root:root /etc/altnoti-offsite/r2.env; chmod 600 /etc/altnoti-offsite/r2.env'" -Text $envText

  $keySetupScript = @'
set -eu
if [ -f /etc/altnoti-offsite/backup.key ]; then
  exit 0
fi
tmp=$(mktemp /etc/altnoti-offsite/.backup.key.XXXXXX)
trap 'rm -f "$tmp"' EXIT
umask 077
openssl rand 32 >"$tmp"
chown root:root "$tmp"
chmod 600 "$tmp"
mv "$tmp" /etc/altnoti-offsite/backup.key
trap - EXIT
'@
  Send-SshText -KeyPath $keyPath -RemoteCommand "sudo -n bash -s" -Text $keySetupScript

  if (Test-Path -LiteralPath $RecoveryPath -PathType Leaf) {
    if ([string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $RecoveryPath -Raw))) {
      throw "Existing recovery escrow file is empty; refusing to overwrite it."
    }
  }
  else {
    $keyBase64 = Invoke-SshCapture -KeyPath $keyPath -RemoteCommand "sudo -n base64 -w0 /etc/altnoti-offsite/backup.key"
    if ($keyBase64 -notmatch "^[A-Za-z0-9+/]{43}=$") { throw "Oracle encryption key retrieval validation failed." }
    $protected = ConvertFrom-SecureString (ConvertTo-SecureString -String $keyBase64 -AsPlainText -Force)
    $recoveryDirectory = Split-Path -Parent $RecoveryPath
    New-Item -ItemType Directory -Path $recoveryDirectory -Force | Out-Null
    Set-Content -LiteralPath $RecoveryPath -Value $protected -Encoding ascii -NoNewline
  }
  $recoveryPrincipal = "{0}\{1}:(F)" -f $env:USERDOMAIN, $env:USERNAME
  & icacls $RecoveryPath /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Recovery escrow ACL inheritance removal failed." }
  & icacls $RecoveryPath /grant:r $recoveryPrincipal "NT AUTHORITY\SYSTEM:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Recovery escrow ACL setup failed." }
}
finally {
  $secretAccessKey = $null
  $envText = $null
  $keyBase64 = $null
  $protected = $null
  $secretSecure = $null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

Write-Output "R2 credentials installed on Oracle and recovery escrow created locally. Secret values were not displayed."
