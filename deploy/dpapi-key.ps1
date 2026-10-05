param([Parameter(Mandatory=$true)][ValidateSet('protect','unprotect')][string]$Operation)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadLine()
if ([string]::IsNullOrWhiteSpace($encoded)) { exit 2 }
$inputBytes = [Convert]::FromBase64String($encoded)
if ($Operation -eq 'protect') {
  $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.WriteLine([Convert]::ToBase64String($outputBytes))
[Array]::Clear($inputBytes, 0, $inputBytes.Length)
[Array]::Clear($outputBytes, 0, $outputBytes.Length)
