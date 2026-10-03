param([string]$KeyPath)

$ErrorActionPreference = "Stop"
if ($PSBoundParameters.ContainsKey("KeyPath")) {
  if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH秘密鍵が見つかりません。-KeyPathを確認してください。" }
  return (Resolve-Path -LiteralPath $KeyPath).Path
}

# Known Folderに任せることで、OneDriveや日本語名へのDesktop移動にも追従する。
$desktop = [Environment]::GetFolderPath("Desktop")
$downloads = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads"
$candidates = @(
  (Join-Path $desktop "oraclessh-key-2026-09-21.key"),
  (Join-Path $downloads "oraclessh-key-2026-09-21.key"),
  (Join-Path $downloads "ssh-key-2026-09-21.key")
)
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
}
throw "SSH秘密鍵が見つかりません。-KeyPathで指定してください。"
