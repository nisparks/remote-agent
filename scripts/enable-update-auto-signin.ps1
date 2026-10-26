# Enables "sign in automatically after Windows Update restarts" (ARSO) so the Remote Agent tray
# supervisor comes back after unattended update reboots, and removes legacy Remote Agent scheduled
# tasks that could start competing server instances. Run elevated (the tray menu item requests UAC).

$ErrorActionPreference = "Stop"

try {
    foreach ($taskName in @("CopilotRemoteAgent-BootServer", "CopilotRemoteAgent-LogonServer")) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Host "Removed legacy scheduled task $taskName"
        }
    }

    # Stop any legacy watchdog loop (and the server it spawned) that was started by the removed tasks.
    $legacyWatchers = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -match 'watch-remote-agent\.ps1' }
    foreach ($watcher in $legacyWatchers) {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($watcher.ProcessId)" |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $watcher.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped legacy watchdog process $($watcher.ProcessId)"
    }

    # Stop an orphaned bridge server left behind by a legacy watchdog. Servers owned by the current
    # tray app are left alone; the tray app restarts the bridge as soon as the port is free.
    $listener = Get-NetTCPConnection -LocalPort 4321 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener -and $listener.OwningProcess -gt 0) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        $parent = if ($owner) { Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ParentProcessId)" } else { $null }
        if ($owner -and $owner.Name -eq "node.exe" -and (-not $parent -or $parent.Name -ne "RemoteAgentDesktop.exe")) {
            Stop-Process -Id $owner.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped orphaned bridge server process $($owner.ProcessId)"
        }
    }

    $systemPolicyPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
    if (Test-Path $systemPolicyPath) {
        Set-ItemProperty -Path $systemPolicyPath -Name "DisableAutomaticRestartSignOn" -Value 0 -Type DWord -Force
        Set-ItemProperty -Path $systemPolicyPath -Name "EnableAutomaticRestartSignOn" -Value 1 -Type DWord -Force
    }
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name "RestartApps" -Value 1 -Type DWord -Force

    Write-Host "Windows Update auto sign-in is enabled. The Remote Agent tray app restarts the bridge after reboots." -ForegroundColor Green
    Start-Sleep -Seconds 4
} catch {
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    Start-Sleep -Seconds 20
    exit 1
}
