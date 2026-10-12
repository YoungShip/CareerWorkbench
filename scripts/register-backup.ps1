#requires -Version 7.0
# One independent task: backup at 20:00 and logon, without notifications.
$ErrorActionPreference = 'Stop'
$vbs = Join-Path $PSScriptRoot 'run-backup-silent.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { throw "Missing backup launcher: $vbs" }
$work = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$me = "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $work
$triggers = @((New-ScheduledTaskTrigger -Daily -At '20:00'), (New-ScheduledTaskTrigger -AtLogOn -User $me))
Register-ScheduledTask -TaskName '秋招备份' -Description '每日 20:00 和登录时备份求职主表与证据，不发送通知' `
  -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
# Remove only the three retired tasks, after the replacement is registered.
foreach ($name in @('秋招提醒-开机检查', '秋招提醒-每日汇总', '秋招提醒-门槛检查')) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
}
Get-ScheduledTask -TaskName '秋招备份' | Select-Object TaskName, State
