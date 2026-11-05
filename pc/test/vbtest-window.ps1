$host.UI.RawUI.WindowTitle = 'VBTEST'

$out = Join-Path $PSScriptRoot '..\data\keys.txt'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }

Write-Host 'VBTEST ready - recording every submitted line to pc/data/keys.txt'

while ($true) {
    $line = Read-Host
    Add-Content -LiteralPath $out -Value $line
}
