$ErrorActionPreference = "Stop"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("altnoti-ssh-resolver-" + [guid]::NewGuid().ToString("N"))
try {
  $newDirectory = Join-Path $fixture ".ssh"
  $downloads = Join-Path $fixture "Downloads"
  New-Item -ItemType Directory -Path $newDirectory,$downloads -Force | Out-Null
  $newKey = Join-Path $newDirectory "alt-notify-oracle-ed25519"
  $oldKey = Join-Path $downloads "oraclessh-key-2026-09-21.key"
  [IO.File]::WriteAllText($newKey, "fixture-new")
  [IO.File]::WriteAllText($oldKey, "fixture-old")
  $resolved = & "$PSScriptRoot/../deploy/resolve-oracle-key.ps1" -ProfilePath $fixture
  if ($resolved -ne $newKey) { throw "Resolver did not prefer the OneDrive-independent key." }
  Write-Output "PASS SSH key resolver priority"
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
