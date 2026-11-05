#!/usr/bin/env pwsh
# VoiceBridge launcher for PowerShell.
# Usage: .\vb.ps1 say "text"   |   .\vb.ps1 start --wrap freebuff
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $root 'pc\bin\vb.js'
if (-not (Test-Path $entry)) {
    Write-Error "vociebridge entry not found: $entry"
    exit 1
}
& node $entry @args
exit $LASTEXITCODE
