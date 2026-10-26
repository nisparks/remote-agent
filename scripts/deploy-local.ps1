# Installs or updates this checkout as the always-on Remote Agent runtime for the current user.
# The runtime lives outside Copilot session worktrees, so archiving a session never breaks the bridge.
#   npm run deploy:local
param(
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    [string]$Target = (Join-Path $env:LOCALAPPDATA "CopilotRemoteAgent\runtime"),
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$Source = (Resolve-Path $Source).Path
$port = 4321

if (-not (Test-Path (Join-Path $Source "node_modules"))) {
    throw "Run 'npm install' in $Source before deploying."
}
if (-not (Test-Path (Join-Path $Source "releases\desktop-app\RemoteAgentDesktop.exe"))) {
    throw "Run 'npm run build:desktop' before deploying."
}

function Stop-RemoteAgentRuntime {
    # Stop tray supervisors (they own the server) and then whatever still listens on the bridge port.
    foreach ($desktop in Get-CimInstance Win32_Process -Filter "Name='RemoteAgentDesktop.exe'") {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktop.ProcessId)" |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $desktop.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener -and $listener.OwningProcess -gt 0) {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($listener.OwningProcess)"
        try {
            Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
        } catch {
            # The new tray app waits for the port and takes over as soon as the old process exits.
            Write-Warning ("Port $port is owned by PID $($listener.OwningProcess), which needs administrator rights to stop. " +
                "Run scripts\enable-update-auto-signin.ps1 from an Administrator PowerShell; the new runtime then starts automatically.")
            return
        }
        $children | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host "Stopping the current Remote Agent runtime..."
Stop-RemoteAgentRuntime
Start-Sleep -Milliseconds 800

Write-Host "Copying runtime to $Target ..."
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$excludeDirs = @(".git", "android\build", "desktop\bin", "desktop\obj", "desktop\Setup\bin", "desktop\Setup\obj", "test") |
    ForEach-Object { Join-Path $Source $_ }
& robocopy $Source $Target /MIR /XD @excludeDirs /XF ".git" "*.log" "*.keystore" /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

$exe = Join-Path $Target "releases\desktop-app\RemoteAgentDesktop.exe"
$copilotDir = Join-Path $env:USERPROFILE ".copilot"
New-Item -ItemType Directory -Force -Path $copilotDir | Out-Null
Set-Content -Path (Join-Path $copilotDir "remote-agent-repo-path.txt") -Value $Target -Encoding UTF8 -NoNewline
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "CopilotRemoteAgent" -Value "`"$exe`" --minimized `"$Target`""
Write-Host "Auto-start now points at $exe"

if (-not $NoStart) {
    Start-Process -FilePath $exe -ArgumentList @("--minimized", "`"$Target`"") -WorkingDirectory $Target
    $deadline = (Get-Date).AddSeconds(60)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
            if ($health.ok) {
                $healthy = $true
                break
            }
        } catch {
            # Still starting
        }
        Start-Sleep -Seconds 1
    }
    if ($healthy) {
        Write-Host "Remote Agent is running from $Target" -ForegroundColor Green
    } else {
        Write-Warning "The tray app is running but the bridge is not answering yet. If another process still owns port $port, it takes over when that process exits. See ~\.copilot\logs\remote-agent-server.log"
    }
}
exit 0
