# Enables Pre-Login OS Boot startup (AtStartup) + Windows Update Automatic Restart Sign-On (ARSO)
# Run from an elevated PowerShell prompt or via the "Enable Pre-Login Boot Service" tray menu item in RemoteAgentDesktop.exe.

param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$nodeExe = (Get-Command node).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "Registering Pre-Login OS Boot Task (CopilotRemoteAgent-BootServer) for $user..." -ForegroundColor Cyan

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "dist\server.js --port=4321" -WorkingDirectory $RepoRoot
$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName "CopilotRemoteAgent-BootServer" `
    -Action $action `
    -Trigger @($triggerBoot, $triggerLogon) `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts GitHub Copilot Remote Agent Bridge on port 4321 at OS boot (even before login) and logon" `
    -Force | Out-Null

# Enable Windows Automatic Restart Sign-On (ARSO) so Windows Update reboots automatically sign in the user session behind the lock screen
$systemPolicyPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
if (Test-Path $systemPolicyPath) {
    Set-ItemProperty -Path $systemPolicyPath -Name "DisableAutomaticRestartSignOn" -Value 0 -Type DWord -Force
    Set-ItemProperty -Path $systemPolicyPath -Name "EnableAutomaticRestartSignOn" -Value 1 -Type DWord -Force
}

Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name "RestartApps" -Value 1 -Type DWord -Force

Write-Host "✅ Pre-Login Boot Task & Windows Update Auto-Restart Sign-On (ARSO) enabled!" -ForegroundColor Green
