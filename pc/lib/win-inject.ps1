param(
    [ValidateSet('list', 'type')] [string]$Mode = 'list',
    [string]$Title = '',
    [string]$TextFile = '',
    [switch]$StealFocus,
    [switch]$RestoreFocus
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VBNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

function Focus-Window([IntPtr]$handle) {
    if ([VBNative]::GetForegroundWindow() -eq $handle) { return $true }

    $procId = [uint32]0
    $foreground = [VBNative]::GetForegroundWindow()
    $foregroundThread = [VBNative]::GetWindowThreadProcessId($foreground, [ref]$procId)
    $currentThread = [VBNative]::GetCurrentThreadId()

    try { [void][VBNative]::AttachThreadInput($currentThread, $foregroundThread, $true) } catch { }
    try {
        if ([VBNative]::IsIconic($handle)) { [void][VBNative]::ShowWindow($handle, 9) }
        [void][VBNative]::BringWindowToTop($handle)
        [void][VBNative]::SetForegroundWindow($handle)
    } finally {
        try { [void][VBNative]::AttachThreadInput($currentThread, $foregroundThread, $false) } catch { }
    }

    Start-Sleep -Milliseconds 180
    return ([VBNative]::GetForegroundWindow() -eq $handle)
}

$found = New-Object System.Collections.ArrayList

$callback = [VBNative+EnumWindowsProc] {
    param($hWnd, $lParam)
    if ([VBNative]::IsWindowVisible($hWnd)) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][VBNative]::GetWindowTextW($hWnd, $sb, 512)
        $text = $sb.ToString()
        if ($text) {
            $procId = [uint32]0
            [void][VBNative]::GetWindowThreadProcessId($hWnd, [ref]$procId)
            [void]$found.Add([pscustomobject]@{
                Handle = $hWnd.ToInt64()
                Pid    = $procId
                Title  = $text
            })
        }
    }
    return $true
}

[void][VBNative]::EnumWindows($callback, [IntPtr]::Zero)

if ($Mode -eq 'list') {
    foreach ($w in $found) {
        Write-Output ("{0}`t{1}`t{2}" -f $w.Handle, $w.Pid, $w.Title)
    }
    exit 0
}

$candidates = @($found | Where-Object { $_.Title -like "*$Title*" })
if ($candidates.Count -eq 0) {
    Write-Output "ERROR: no_visible_window_matching:$Title"
    exit 2
}

$consoleHosts = @('WindowsTerminal', 'conhost', 'OpenConsole', 'cmd', 'powershell', 'pwsh', 'mintty', 'alacritty', 'wezterm-gui')
$browserHosts = @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi')

foreach ($c in $candidates) {
    $procName = ''
    try { $procName = (Get-Process -Id $c.Pid -ErrorAction Stop).ProcessName } catch { }
    $c | Add-Member -NotePropertyName ProcName -NotePropertyValue $procName -Force
}

# Rank instead of taking the first hit: a substring match can otherwise select
# a neighbouring window whose title merely contains the query.
$ranked = $candidates | Where-Object { $consoleHosts -contains $_.ProcName } | ForEach-Object {
    if ($_.Title -eq $Title) { $score = 100 }
    elseif ($_.Title.StartsWith($Title)) { $score = 50 }
    else { $score = 10 }
    $_ | Add-Member -NotePropertyName Score -NotePropertyValue $score -Force -PassThru
}
$target = $ranked | Sort-Object Score -Descending | Select-Object -First 1
if (-not $target) {
    $browser = $candidates | Where-Object { $browserHosts -contains $_.ProcName } | Select-Object -First 1
    if ($browser) {
        Write-Output "ERROR: refused_browser_window:$($browser.ProcName):$($browser.Title)"
        exit 4
    }
    $target = $candidates | Select-Object -First 1
}

$targetHandle = [IntPtr]$target.Handle
$previousForeground = [VBNative]::GetForegroundWindow()

if ([VBNative]::GetForegroundWindow() -ne $targetHandle) {
    if (-not $StealFocus) {
        Write-Output "ERROR: not_focused:$($target.Title)"
        exit 3
    }
    if (-not (Focus-Window $targetHandle)) {
        Write-Output "ERROR: focus_failed:$($target.Title)"
        exit 5
    }
}

$text = (Get-Content -Raw -Encoding UTF8 -LiteralPath $TextFile)
$text = $text.TrimEnd([char]13, [char]10)

$escaped = New-Object System.Text.StringBuilder
foreach ($ch in $text.ToCharArray()) {
    switch ($ch) {
        '+' { [void]$escaped.Append('{+}') }
        '^' { [void]$escaped.Append('{^}') }
        '%' { [void]$escaped.Append('{%}') }
        '~' { [void]$escaped.Append('{~}') }
        '(' { [void]$escaped.Append('{(}') }
        ')' { [void]$escaped.Append('{)}') }
        '{' { [void]$escaped.Append('{{}') }
        '}' { [void]$escaped.Append('{}}') }
        '[' { [void]$escaped.Append('{[}') }
        ']' { [void]$escaped.Append('{]}') }
        default { [void]$escaped.Append($ch) }
    }
}

[System.Windows.Forms.SendKeys]::SendWait($escaped.ToString())
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

if ($RestoreFocus -and $previousForeground -ne $targetHandle -and $previousForeground -ne [IntPtr]::Zero) {
    [void](Focus-Window $previousForeground)
}

Write-Output ("typed:{0}:{1}" -f $target.ProcName, $target.Title)
exit 0
