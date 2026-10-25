# Keeps the Remote Agent server alive and restarts it automatically when port 4321 stops responding.
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Continue"
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  $nodeExe = "node.exe"
}

while ($true) {
  $healthy = $false
  try {
    $response = Invoke-WebRequest `
      -Uri "http://127.0.0.1:4321/api/health" `
      -UseBasicParsing `
      -TimeoutSec 4 `
      -ErrorAction Stop
    $healthy = $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    $healthy = $false
  }

  if (-not $healthy) {
    $listeners = Get-NetTCPConnection -LocalPort 4321 -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
      if ($listener.OwningProcess -gt 0) {
        try { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
      }
    }

    Start-Process `
      -FilePath $nodeExe `
      -ArgumentList "--no-warnings --import tsx src/server.ts" `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden
  }

  $desktopExecutable = Join-Path $RepoRoot "releases\desktop-app\RemoteAgentDesktop.exe"
  $desktopRunning = Get-Process -Name "RemoteAgentDesktop" -ErrorAction SilentlyContinue
  if (-not $desktopRunning -and (Test-Path $desktopExecutable)) {
    Start-Process `
      -FilePath $desktopExecutable `
      -ArgumentList "--minimized `"$RepoRoot`"" `
      -WindowStyle Hidden
  }

  Start-Sleep -Seconds 10
}
