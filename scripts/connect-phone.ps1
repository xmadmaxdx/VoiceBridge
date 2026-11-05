# VoiceBridge — USB tunnel setup for PowerShell
# Usage: .\scripts\connect-phone.ps1 [-Port 8765]
param(
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Write-Error "adb not found. Install Android platform-tools and add it to PATH."
    exit 1
}

Write-Host "== devices =="
adb devices -l

$devices = @(adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\sdevice$" })
if ($devices.Count -eq 0) {
    Write-Host ""
    Write-Host "No authorized device. Plug in USB, enable Developer options," -ForegroundColor Yellow
    Write-Host "turn on USB debugging, and accept the RSA prompt on the phone." -ForegroundColor Yellow
    exit 1
}

try { adb reverse --remove-all | Out-Null } catch { }
adb reverse "tcp:$Port" "tcp:$Port"

Write-Host ""
Write-Host "Reverse tunnel up: phone 127.0.0.1:$Port -> PC 127.0.0.1:$Port"
Write-Host "In the app, host = 127.0.0.1, port = $Port"
Write-Host "Token: node pc/bin/vb.js token"
