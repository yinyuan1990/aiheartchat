# 注册 Windows 计划任务：登录后自动后台运行发布机（pythonw，无窗口；退出后 1 分钟自动重启）。再运行一次会覆盖。
# 查看：Get-ScheduledTask PeiwanPublisher   停止：Stop-ScheduledTask PeiwanPublisher   卸载：Unregister-ScheduledTask PeiwanPublisher -Confirm:$false
$ErrorActionPreference = 'Stop'
$pyw = Join-Path $PSScriptRoot '.venv\Scripts\pythonw.exe'
if (-not (Test-Path $pyw)) { throw '没找到 .venv\Scripts\pythonw.exe，先运行 setup.ps1' }
$action = New-ScheduledTaskAction -Execute $pyw -Argument 'publisher.py run' -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PeiwanPublisher' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host '已注册计划任务 PeiwanPublisher（登录后自动后台运行）。现在立刻启动…'
Start-ScheduledTask -TaskName 'PeiwanPublisher'
Start-Sleep 3
Write-Host ('状态：' + (Get-ScheduledTask -TaskName 'PeiwanPublisher').State + '（Running = 在跑）')
Write-Host '没有窗口，日志看 logs\publisher.log；后台「内容分发」页能看到它的心跳。'
Write-Host '提醒：电源设置里把「睡眠」改为「从不」，否则电脑睡了就不发了。'
