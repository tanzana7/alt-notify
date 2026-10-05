param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][ValidateSet('Directory','File')][string]$Kind)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Path -Force
if (($Kind -eq 'Directory' -and -not $item.PSIsContainer) -or ($Kind -eq 'File' -and $item.PSIsContainer) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ACL_INVALID_PATH' }
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
if ($LASTEXITCODE -ne 0) { throw 'ACL_APPLY_FAILED' }
$rules = @()
$aclOutput = @(& icacls.exe $Path)
if ($LASTEXITCODE -ne 0) { throw 'ACL_QUERY_FAILED' }
foreach ($line in $aclOutput) {
  $entry = [string]$line
  if ($entry.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase)) { $entry = $entry.Substring($Path.Length).Trim() }
  else { $entry = $entry.Trim() }
  if ($entry -match '^(?<identity>.+?):(?<rights>\(.+\))$') { $rules += [PSCustomObject]@{ Identity=$Matches.identity; Rights=$Matches.rights } }
}
$expectedRights = if ($Kind -eq 'Directory') { '(OI)(CI)(F)' } else { '(F)' }
$expected = @($ownerName, $systemName)
$ownerSidValue = $owner.Value
$systemSidValue = 'S-1-5-18'
$categories = @($rules | ForEach-Object {
  try {
    $identity = $_.Identity
    if ($identity -match '^\*?(S-1-[0-9-]+)$') { $sidValue = $Matches[1] }
    else { $sidValue = (New-Object Security.Principal.NTAccount($identity)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($sidValue -eq $ownerSidValue) { 'OWNER' }
    elseif ($sidValue -eq $systemSidValue) { 'SYSTEM' }
    else { 'OTHER' }
  } catch { 'UNRESOLVED' }
})
if ($rules.Count -ne 2) {
  $kindCategory = $Kind.ToUpperInvariant()
  $ownerCount = @($categories | Where-Object { $_ -eq 'OWNER' }).Count
  $systemCount = @($categories | Where-Object { $_ -eq 'SYSTEM' }).Count
  $otherCount = @($categories | Where-Object { $_ -ne 'OWNER' -and $_ -ne 'SYSTEM' }).Count
  throw ("ACL_{0}_RULE_COUNTS_{1}_OWNER_{2}_SYSTEM_{3}_OTHER" -f $kindCategory, $rules.Count, $ownerCount, $systemCount, $otherCount)
}
if (@($rules | Where-Object { $_.Identity -notin $expected -or $_.Rights -ne $expectedRights }).Count -ne 0) { throw 'ACL_RULE_MISMATCH' }
if (@($rules | Select-Object -ExpandProperty Identity -Unique).Count -ne 2) { throw 'ACL_DUPLICATE_PRINCIPAL' }
