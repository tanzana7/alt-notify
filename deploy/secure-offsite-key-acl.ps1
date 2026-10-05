param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][ValidateSet('Directory','File')][string]$Kind)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Path -Force
if (($Kind -eq 'Directory' -and -not $item.PSIsContainer) -or ($Kind -eq 'File' -and $item.PSIsContainer) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid key path' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$ownerName = $owner.Translate([Security.Principal.NTAccount]).Value
$systemName = $system.Translate([Security.Principal.NTAccount]).Value
if ($Kind -eq 'Directory') {
  $ownerGrant = "*$($owner.Value):(OI)(CI)F"
  $systemGrant = '*S-1-5-18:(OI)(CI)F'
} else {
  $ownerGrant = "*$($owner.Value):F"
  $systemGrant = '*S-1-5-18:F'
}
& icacls.exe $Path '/inheritance:r' '/grant:r' $ownerGrant $systemGrant | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'key ACL update failed' }
$rules = @()
$aclOutput = @(& icacls.exe $Path)
if ($LASTEXITCODE -ne 0) { throw 'key ACL validation failed' }
foreach ($line in $aclOutput) {
  $entry = [string]$line
  if ($entry.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase)) { $entry = $entry.Substring($Path.Length).Trim() }
  else { $entry = $entry.Trim() }
  if ($entry -match '^(?<identity>.+?):(?<rights>\(.+\))$') { $rules += [PSCustomObject]@{ Identity=$Matches.identity; Rights=$Matches.rights } }
}
$expectedRights = if ($Kind -eq 'Directory') { '(OI)(CI)(F)' } else { '(F)' }
$expected = @($ownerName, $systemName)
if ($rules.Count -ne 2 -or @($rules | Where-Object { $_.Identity -notin $expected -or $_.Rights -ne $expectedRights }).Count -ne 0 -or @($rules | Select-Object -ExpandProperty Identity -Unique).Count -ne 2) { throw 'key ACL validation failed' }
