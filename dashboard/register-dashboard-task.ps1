#requires -Version 7.0
if ($PSVersionTable.PSVersion.Major -ne 7) { throw "请使用 PowerShell 7。" }
$ErrorActionPreference = 'Stop'
$taskName = 'CareerWorkbench Dashboard'
$scriptDir = $PSScriptRoot
$vbs = Join-Path $scriptDir 'start-dashboard-silent.vbs'
$me = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path -LiteralPath $vbs -PathType Leaf)) {
  throw "Missing dashboard launcher: $vbs"
}

$action = New-ScheduledTaskAction `
  -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') `
  -Argument "`"$vbs`"" `
  -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Description 'Run the local CareerWorkbench dashboard after logon.' `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "OK: $taskName"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State