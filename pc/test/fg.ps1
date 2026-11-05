Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VBFg {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@

$h = [VBFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][VBFg]::GetWindowTextW($h, $sb, 512)
Write-Output $sb.ToString()
