param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
  [string]$At
)

$ErrorActionPreference = "Stop"
$taskName = "AltNotifyOffsiteBackup"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  throw "同名のタスクが既に存在します。設定を確認してください。"
}

$scriptPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "pull-offsite-backup.ps1")).Path
$powershellPath = (Get-Command powershell.exe).Source
$runAt = [datetime]::Today.Add([TimeSpan]::ParseExact($At, "hh\:mm", [Globalization.CultureInfo]::InvariantCulture))
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument "-NoProfile -NonInteractive -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At $runAt
# The operator PC may be on battery at the scheduled time. Keep the pull
# eligible then; otherwise Task Scheduler silently leaves a manual run queued.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Write-Output "VM外バックアップの定期タスクを毎日 $At に設定しました。PCが起動・ログオン中のみ実行されます。"
