#requires -Version 7.0
if ($PSVersionTable.PSVersion.Major -ne 7) { throw "请使用 PowerShell 7。" }
# 注册秋招提醒计划任务（幂等：已存在则覆盖）
#
# 动作必须走 wscript.exe + run-reminder-silent.vbs，不能直接执行 node.exe。
# node.exe 是控制台子系统程序，由任务计划在交互会话里拉起时必然闪一个黑窗；
# 「门槛检查」每小时一次，实测表现为整点过 5 分弹一次黑色终端（2026-09-27 反馈）。
# VBS 用 shell.Run(command, 0, True) 以隐藏窗口启动 node，并原样透传参数与退出码。
$ErrorActionPreference = 'Stop'
$vbs = Join-Path $PSScriptRoot 'run-reminder-silent.vbs'
if (-not (Test-Path $vbs)) { throw "缺少静默启动器：$vbs" }
$project = Split-Path $PSScriptRoot -Parent
$work = Split-Path $project -Parent
$me = "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

function Register-One {
  param($Name, $Desc, $Arg, $Trigger)
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument "`"$vbs`" $Arg" -WorkingDirectory $work
  Register-ScheduledTask -TaskName $Name -Description $Desc -Action $action -Trigger $Trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Output "OK: $Name"
}

# 1) 每晚 20:00 汇总（已过期 + 72h 内到期）：桌面通知 + 微信推送
Register-One -Name '秋招提醒-每日汇总' -Desc '每晚 20:00 汇总已过期与 72 小时内到期的秋招事项（桌面通知 + 微信推送）' `
  -Arg '--all' -Trigger (New-ScheduledTaskTrigger -Daily -At '20:00')

# 2) 每小时检查是否跨过 24h / 2h 门槛，只提醒一次
#    注意：New-ScheduledTaskTrigger -Once 默认 Duration=PT10M 且 StopAtDurationEnd=true，
#    那样重复只持续 10 分钟就永久停止（实测踩过）。必须显式指定长 Duration 并关掉该开关。
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Hours 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$hourly.Repetition.StopAtDurationEnd = $false

Register-One -Name '秋招提醒-门槛检查' -Desc '每小时检查是否新跨过 24 小时 / 2 小时到期门槛，跨过即推送（同一门槛只提醒一次）' `
  -Arg '--due --wechat' -Trigger $hourly

# 3) 开机（登录）时检查一次，避免关机期间错过
Register-One -Name '秋招提醒-开机检查' -Desc '登录时检查一次到期与即将到期事项（桌面通知 + 微信推送）' `
  -Arg '--all' -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me)

Write-Output ''
Write-Output '=== 已注册任务 ==='
Get-ScheduledTask -TaskName '秋招提醒-*' | Select-Object TaskName, State | Format-Table -AutoSize
