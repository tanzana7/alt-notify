param([string]$KeyPath, [string]$ProfilePath = $env:USERPROFILE)

$ErrorActionPreference = "Stop"
if ($PSBoundParameters.ContainsKey("KeyPath")) {
  if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH秘密鍵が見つかりません。-KeyPathを確認してください。" }
  return (Resolve-Path -LiteralPath $KeyPath).Path
}

# unattended backup uses one explicit key outside OneDrive; do not fall back to
# a stale downloaded key after rotation because that would hide revocation.
$candidates = @(
  (Join-Path $ProfilePath ".ssh\alt-notify-oracle-ed25519")
)
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
}
throw "SSH秘密鍵が見つかりません。-KeyPathで指定してください。"
