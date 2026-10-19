param(
  [int]$Port = 4321,
  [switch]$OpenFirewall
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
  Write-Host "Installing npm dependencies for first-time setup..." -ForegroundColor Cyan
  npm install --no-audit --no-fund
}

if ($OpenFirewall) {
  Write-Host "Configuring Windows Firewall rule for Remote Agent on TCP port $Port (Private/LAN)..." -ForegroundColor Cyan
  New-NetFirewallRule -DisplayName "GitHub Copilot Remote Agent (LAN)" `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null
}

$env:PORT = "$Port"
npm start
