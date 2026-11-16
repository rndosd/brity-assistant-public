param(
    [switch]$ListOnly,          # read the inbox list only (no note is opened, nothing marked read)
    [switch]$Download,          # also save attachments from the dedicated GOE download folder
    [int]$Max = 20,             # open at most this many unread notes per run
    [int]$SinceDays = 7,        # look back this many days when no range is supplied; 0 scans all visible dates
    [int]$MaxPages = 10,        # PageDown at most this many times while looking for unread notes
    [switch]$Force,             # run even when the user is working in a GOE window
    [switch]$IncludeRead,       # also open notes that are already read (re-collect a date range)
    [switch]$AttachOnly,        # only open notes that show an attachment icon
    [switch]$DebugOcr,          # save the first list capture and its OCR lines to the inbox folder (contains names)
    [switch]$Inspect,           # check GOE is available without clicking or showing a window
    [switch]$RangeImport,       # mark notes as past imports for the calendar's review flow
    [switch]$ResultObject,
    [string]$From,
    [string]$To,
    [ValidatePattern('^goe_\d{12}_[a-f0-9]{8}$')][string]$RetryId,
    [AllowEmptyString()][string]$AttachmentFolder,
    [string]$Inbox = (Join-Path $PSScriptRoot 'inbox')
)
# GOE Messenger (ULTARI AtMessenger7) note collector.
# The note list and header fields are owner-drawn, so they are read with the built-in Windows OCR
# (local, nothing leaves the PC). The note body is a RichEdit control and is read exactly.
# Buttons and list rows are driven with window messages (no mouse, no focus change).
# The main window must be shown while the list is read: if it is minimized or in the tray,
# it is shown without activation and put back afterwards.
# Opening a note marks it as read in GOE.
# Keep this file ASCII only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
# All Korean UI labels live in labels.json.

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
    status = 'ok'; visible = 0; matched = 0; fresh = 0; unknown = 0
    remaining = 0; opened = 0; imported = 0; oldest = $null; attachStatus = 'not-found'; attached = 0
}

function Publish-Result([string]$Reason) {
    if ($ResultObject) { return [pscustomobject]$result }
    if ($Reason) { Write-Output "status=$($result.status) reason=$Reason"; return }
    if ($RetryId) { Write-Output "status=$($result.status) attachStatus=$($result.attachStatus) filesSaved=$($result.attached)"; return }
    Write-Output ("status={0} rowsSeen={1} opened={2} verified={3} filesSaved={4} timeUnchecked={5}" -f
        $result.status, $result.visible, $result.opened,
        @($opened | Where-Object { $_.verified }).Count,
        @($opened | ForEach-Object { $_.saved } | Where-Object { $_.path }).Count,
        @($opened | Where-Object { $_.datetimeCheck -and $_.datetimeCheck -ne 'match' }).Count)
    Write-Output ("latest: " + (Join-Path $Inbox 'latest.json'))
}

$calendar = [Globalization.CultureInfo]::InvariantCulture
$Inbox = [IO.Path]::GetFullPath($Inbox)
$notesDir = Join-Path $Inbox 'notes'
$retryNote = $null
if ($RetryId) {
    if ($ListOnly -or $Inspect -or $RangeImport -or $From -or $To) { throw 'incompatible-attachment-retry-options' }
    $retryPath = Join-Path $notesDir "$RetryId.json"
    try {
        $item = Get-Item -LiteralPath $retryPath
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid-note-file' }
        $retryNote = Get-Content -LiteralPath $retryPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($retryNote.id -cne $RetryId -or $retryNote.source -ne 'goe' -or $retryNote.verified -ne $true -or
            [string]::IsNullOrWhiteSpace($retryNote.body)) { throw 'invalid-note-file' }
        $retryTime = [datetime]::ParseExact($retryNote.datetime, 'yyyy-MM-dd HH:mm', $calendar)
        if ($retryNote.datetimeNote) {
            $savedTime = [datetime]::ParseExact($retryNote.datetimeNote, 'yyyy-MM-dd HH:mm', $calendar)
            if ($savedTime -lt $retryTime) { $retryTime = $savedTime }
        }
    } catch { Publish-Result ''; return }
    if ($retryTime -lt (Get-Date).AddDays(-7)) { $result.attachStatus = 'expired'; Publish-Result ''; return }
    $From = $To = $retryNote.datetime.Substring(0, 10)
    $Download = $IncludeRead = $true
    $Force = $false
}
$range = $RangeImport -or $From -or $To
foreach ($day in @($From, $To)) {
    if ($day) { [void][datetime]::ParseExact($day, 'yyyy-MM-dd', $calendar) }
}
$since = if ($From) { $From } elseif (-not $range -and $SinceDays -gt 0) { (Get-Date).Date.AddDays(-$SinceDays).ToString('yyyy-MM-dd', $calendar) }
if ($To -and $since -and $To -lt $since) { throw 'invalid-date-range' }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Runtime.WindowsRuntime
$L = Get-Content (Join-Path $PSScriptRoot 'labels.json') -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $PSBoundParameters.ContainsKey('AttachmentFolder')) {
    $AttachmentFolder = [Environment]::ExpandEnvironmentVariables($L.attachmentFolder)
}
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

Add-Type @'
using System; using System.IO; using System.Runtime.InteropServices; using System.Text;
using Microsoft.Win32.SafeHandles;
namespace GoeWin {
public static class W {
  public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint id, StringBuilder s, int n, uint f);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint id, uint f);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr m, int pos);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref byte info, uint size);
  public static FileStream OpenAttachment(string path) {
    var handle = CreateFile(path, 0x80010000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Unable to lock downloaded attachment."); }
    try { return new FileStream(handle, FileAccess.Read); }
    catch { handle.Dispose(); throw; }
  }
  public static bool RemoveAttachment(FileStream file) {
    byte delete = 1;
    return SetFileInformationByHandle(file.SafeFileHandle, 4, ref delete, 1);
  }
  public static string Text(IntPtr h) {
    int length = SendMessage(h, 0x000E, IntPtr.Zero, IntPtr.Zero).ToInt32();
    var sb = new StringBuilder(length + 1);
    SendMessage(h, 0x000D, (IntPtr)sb.Capacity, sb);
    return sb.ToString();
  }
  public static string MenuItem(IntPtr m, uint i) { var sb = new StringBuilder(256); GetMenuString(m, i, sb, 256, 0x400); return sb.ToString(); }
  public struct PT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr h, PT p, uint f);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref PT p);
  // deepest visible child under a screen point, and the point in its client coordinates
  public static IntPtr Deepest(IntPtr top, int sx, int sy, out int cx, out int cy) {
    IntPtr h = top;
    while (true) { PT p; p.X = sx; p.Y = sy; ScreenToClient(h, ref p); IntPtr c = ChildWindowFromPointEx(h, p, 5); if (c == IntPtr.Zero || c == h) break; h = c; }
    PT q; q.X = sx; q.Y = sy; ScreenToClient(h, ref q); cx = q.X; cy = q.Y; return h;
  }
}}
'@

# Work in physical pixels. GOE is DPI aware but draws at fixed pixel sizes; a DPI-virtualized caller
# (PowerShell is system aware) gets rects divided by the scale and PrintWindow then crops the window.
[void][GoeWin.W]::SetThreadDpiAwarenessContext([IntPtr](-4))   # PER_MONITOR_AWARE_V2

# ---------- OCR (Windows.Media.Ocr, Korean) ----------
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
$ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ko'))
if (-not $ocr) { $result.status = 'error'; Publish-Result 'no-korean-ocr'; return }

function Get-Rect($h) { $r = New-Object GoeWin.W+R; [void][GoeWin.W]::GetWindowRect([IntPtr]$h, [ref]$r); $r }

# Capture a window (works behind other windows, not when minimized), returns @{ bmp; lines }
# lines: x,y in 1x window pixels, t = text. Scale 3 makes small Korean text readable.
function Read-Window($h, [int]$k = 3) {
    $r = Get-Rect $h; $w = $r.Rt - $r.L; $hh = $r.B - $r.T
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
    [void][GoeWin.W]::PrintWindow([IntPtr]$h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
    $big = New-Object System.Drawing.Bitmap ($w * $k), ($hh * $k)
    $g2 = [System.Drawing.Graphics]::FromImage($big); $g2.InterpolationMode = 'HighQualityBicubic'
    $g2.DrawImage($bmp, 0, 0, $w * $k, $hh * $k); $g2.Dispose()
    $png = Join-Path ([IO.Path]::GetTempPath()) ('goe-collector-' + [guid]::NewGuid().ToString() + '.png')
    try {
        try { $big.Save($png) } finally { $big.Dispose() }
        $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
        $s = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $sb = Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $res = Await ($ocr.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
        $s.Dispose()
    } finally { Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue }
    $lines = @($res.Lines | ForEach-Object {
        $b = @($_.Words)[0].BoundingRect
        [pscustomobject]@{ x = [int]($b.X / $k); y = [int]($b.Y / $k); t = $_.Text } } | Sort-Object y, x)
    @{ bmp = $bmp; lines = $lines }
}

function Count-Yellow($bmp, $x0, $x1, $y0, $y1) {
    $n = 0
    for ($x = [Math]::Max(0,$x0); $x -lt [Math]::Min($bmp.Width,$x1); $x++) {
        for ($y = [Math]::Max(0,$y0); $y -lt [Math]::Min($bmp.Height,$y1); $y++) {
            $c = $bmp.GetPixel($x, $y)
            if ($c.R -gt 220 -and $c.G -gt 150 -and $c.G -lt 215 -and $c.B -lt 90) { $n++ } } }
    $n
}
function Avg-Bright($bmp, $x0, $x1, $y0, $y1) {
    $s = 0; $n = 0
    for ($x = $x0; $x -lt $x1; $x += 2) { for ($y = $y0; $y -lt $y1; $y += 2) {
        if ($x -ge 0 -and $y -ge 0 -and $x -lt $bmp.Width -and $y -lt $bmp.Height) { $c = $bmp.GetPixel($x, $y); $s += $c.R + $c.G + $c.B; $n++ } } }
    if ($n) { $s / $n } else { 0 }
}

# "2026-11-16 <am> 09:56" (OCR may drop or garble the colon) -> "2026-11-16 09:56"
function Parse-ListTime([string]$t) {
    $m = [regex]::Match($t, '(\d{4})-(\d{2})-(\d{2})\s*(' + $L.am + '|' + $L.pm + ')\s*(\d{1,2})\D?(\d{2})')
    if (-not $m.Success) { return $null }
    $h = [int]$m.Groups[5].Value; if ($m.Groups[4].Value -eq $L.pm -and $h -lt 12) { $h += 12 }; if ($m.Groups[4].Value -eq $L.am -and $h -eq 12) { $h = 0 }
    if ($h -gt 23 -or [int]$m.Groups[6].Value -gt 59) { return $null }
    $value = '{0}-{1}-{2} {3:D2}:{4}' -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value, $h, $m.Groups[6].Value
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParseExact($value, 'yyyy-MM-dd HH:mm', $calendar, [Globalization.DateTimeStyles]::None, [ref]$parsed)) { $value }
}
# note window: "<sent> : 2026<y> 11<m> 16<d> <am> 09:56" -> "2026-11-16 09:56"
function Parse-SentTime([string]$t) {
    $m = [regex]::Match($t, '(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(' + $L.am + '|' + $L.pm + ')\s*(\d{1,2})\D?(\d{2})')
    if (-not $m.Success) { return $null }
    $h = [int]$m.Groups[5].Value; if ($m.Groups[4].Value -eq $L.pm -and $h -lt 12) { $h += 12 }; if ($m.Groups[4].Value -eq $L.am -and $h -eq 12) { $h = 0 }
    if ($h -gt 23 -or [int]$m.Groups[6].Value -gt 59) { return $null }
    $value = '{0}-{1:D2}-{2:D2} {3:D2}:{4}' -f $m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value, $h, $m.Groups[6].Value
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParseExact($value, 'yyyy-MM-dd HH:mm', $calendar, [Globalization.DateTimeStyles]::None, [ref]$parsed)) { $value }
}
function Clean-Sender([string]$s) {
    if (-not $s) { return '' }
    $s = $s.Trim()
    # the green arrow icon before the name is sometimes read as a one-letter word
    if ($s -match '^\S\s+\S+\s+\S+') { $s = $s -replace '^\S\s+', '' }
    $s
}

# ---------- GOE windows ----------
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$proc = Get-Process -Name $L.processName -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session | Select-Object -First 1
if (-not $proc) { $result.status = 'offline'; Publish-Result 'goe-not-running'; return }
$pidCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $proc.Id)
$mainEl = $AE::RootElement.FindAll($TS::Children, $pidCond) | Where-Object { $_.Current.ClassName -eq $L.mainClass } | Select-Object -First 1
if (-not $mainEl) { $result.status = 'offline'; Publish-Result 'main-window-not-found'; return }
$main = [IntPtr]$mainEl.Current.NativeWindowHandle

$H = @{}
foreach ($e in $mainEl.FindAll($TS::Descendants, $TRUE_COND)) {
    $c = $e.Current
    if ($c.ClassName -eq 'Button' -and $c.Name -in @($L.noteTab, $L.inboxButton, $L.sentButton) -and -not $H[$c.Name]) { $H[$c.Name] = [IntPtr]$c.NativeWindowHandle }
    if ($c.ClassName -eq 'UltariListScrollView' -and -not $H.list) { $H.list = [IntPtr]$c.NativeWindowHandle }
    if ($c.ClassName -eq 'UListScrollBar' -and -not $H.scroll) { $H.scroll = [IntPtr]$c.NativeWindowHandle }
}
foreach ($k in @($L.noteTab, $L.inboxButton, $L.sentButton, 'list', 'scroll')) {
    if (-not $H[$k]) { $result.status = 'error'; Publish-Result "control-not-found:$k"; return }
}
if ($Inspect) {
    [IO.Directory]::CreateDirectory((Join-Path $Inbox 'notes')) | Out-Null
    Publish-Result 'available'
    return
}

function Goe-IsForeground {
    $fgPid = 0
    [void][GoeWin.W]::GetWindowThreadProcessId([GoeWin.W]::GetForegroundWindow(), [ref]$fgPid)
    $fgPid -eq $proc.Id
}

function Click($h) { [void][GoeWin.W]::SendMessage([IntPtr]$h, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
function Key($h, $vk) { [void][GoeWin.W]::PostMessage([IntPtr]$h, 0x0100, [IntPtr]$vk, [IntPtr]1); [void][GoeWin.W]::PostMessage([IntPtr]$h, 0x0101, [IntPtr]$vk, [IntPtr]0xC0000001) }
function DoubleClick($h, $x, $y) {
    $lp = [IntPtr]($y * 65536 + $x)
    foreach ($m in 0x0201, 0x0202, 0x0203, 0x0202) { [void][GoeWin.W]::PostMessage([IntPtr]$h, $m, [IntPtr]([int]($m -ne 0x0202)), $lp) }
}
function Get-NoteWindow {
    $AE::RootElement.FindAll($TS::Children, $pidCond) | Where-Object { $_.Current.ClassName -eq $L.childClass -and $_.Current.Name -eq $L.noteWindow } | Select-Object -First 1
}
function Close-Note($n) {
    if (-not $n) { return }
    $handle = [IntPtr]$n.Current.NativeWindowHandle
    $b = $n.FindAll($TS::Descendants, $TRUE_COND) | Where-Object { $_.Current.ClassName -eq 'Button' -and $_.Current.Name -eq $L.closeButton } | Select-Object -Last 1
    if ($b) { Click $b.Current.NativeWindowHandle }
    $t0 = Get-Date; while ([GoeWin.W]::IsWindow($handle) -and ((Get-Date) - $t0).TotalSeconds -lt 3) { Start-Sleep -Milliseconds 100 }
}

if ((-not $Force -and (Goe-IsForeground)) -or (Get-NoteWindow)) {
    $result.status = 'busy'
    Publish-Result 'user-is-in-goe'
    return
}

# GOE keeps the attachment folder in its (encrypted) settings, not in the registry or ini files.
# Read it from the settings window (tab "chat/note", the lower of the two folder boxes), then Cancel.
function Read-DownloadDir {
    $existing = $AE::RootElement.FindAll($TS::Children, $pidCond) | Where-Object { $_.Current.Name -eq $L.settingsWindow -and $_.Current.ClassName -eq $L.childClass }
    if ($existing) { return $null }
    $btn = $mainEl.FindAll($TS::Descendants, $TRUE_COND) | Where-Object { $_.Current.ClassName -eq 'Button' -and $_.Current.Name -eq $L.settingsButton } | Select-Object -First 1
    if (-not $btn) { return $null }
    Click $btn.Current.NativeWindowHandle
    $sw = $null; $t0 = Get-Date
    while (-not $sw -and ((Get-Date) - $t0).TotalSeconds -lt 3) { Start-Sleep -Milliseconds 100
        $sw = $AE::RootElement.FindAll($TS::Children, $pidCond) | Where-Object { $_.Current.Name -eq $L.settingsWindow -and $_.Current.ClassName -eq $L.childClass } | Select-Object -First 1 }
    if (-not $sw) { return $null }
    $dir = $null
    try {
        $sh = [IntPtr]$sw.Current.NativeWindowHandle; Start-Sleep -Milliseconds 300
        $cap = Read-Window $sh; $cap.bmp.Dispose()
        $tab = $cap.lines | Where-Object { $_.y -lt 70 -and $_.t.Contains($L.settingsNoteTabMark) } | Select-Object -First 1
        if ($tab) {
            $r = Get-Rect $sh; $cx = 0; $cy = 0
            $target = [GoeWin.W]::Deepest($sh, $r.L + $tab.x + 20, $r.T + $tab.y + 8, [ref]$cx, [ref]$cy)
            $lp = [IntPtr]($cy * 65536 + $cx)
            [void][GoeWin.W]::PostMessage($target, 0x0201, [IntPtr]1, $lp); Start-Sleep -Milliseconds 60; [void][GoeWin.W]::PostMessage($target, 0x0202, [IntPtr]0, $lp)
            Start-Sleep -Milliseconds 800
            $boxes = @($sw.FindAll($TS::Descendants, $TRUE_COND) | Where-Object { $_.Current.ClassName -eq 'UltariChildEdit' } |
                ForEach-Object { [pscustomobject]@{ y = $_.Current.BoundingRectangle.Y; t = [GoeWin.W]::Text([IntPtr]$_.Current.NativeWindowHandle) } } |
                Where-Object { $_.t -match '^(?:[a-zA-Z]:\\|\\\\[^\\?]+\\[^\\]+)' } | Sort-Object y)
            if ($boxes.Count) { $dir = $boxes[-1].t }
        }
    } finally {
        $cancel = $sw.FindAll($TS::Descendants, $TRUE_COND) | Where-Object { $_.Current.ClassName -eq 'Button' -and $_.Current.Name -eq $L.cancelButton } | Select-Object -First 1
        if ($cancel) { Click $cancel.Current.NativeWindowHandle }
    }
    $dir
}

function Find-GoeMenu {
    $menu = [IntPtr]::Zero
    while ($true) {
        $menu = [GoeWin.W]::FindWindowEx([IntPtr]::Zero, $menu, '#32768', $null)
        if ($menu -eq [IntPtr]::Zero) { return $menu }
        $menuPid = 0
        [void][GoeWin.W]::GetWindowThreadProcessId($menu, [ref]$menuPid)
        if ($menuPid -eq $proc.Id -and [GoeWin.W]::IsWindowVisible($menu)) { return $menu }
    }
}

function Get-PhysicalDirectory([string]$Path) {
    if ($Path -notmatch '^(?:[a-zA-Z]:\\|\\\\[^\\?]+\\[^\\]+)') { return $null }
    $directory = [IO.DirectoryInfo]::new($Path)
    for ($current = $directory; $current; $current = $current.Parent) {
        if (!$current.Exists -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
    }
    $directory.FullName.TrimEnd('\')
}

# Use whatever folder the teacher set in GOE (often Downloads). $Expected is kept for older callers.
function Get-GoeAttachmentFolder([string]$Expected) {
    try { Get-PhysicalDirectory (Read-DownloadDir) } catch {}
}

function Download-State([string]$Directory) {
    $state = @{}
    foreach ($file in Get-ChildItem -LiteralPath $Directory -Force -File) {
        $state[$file.Name] = [pscustomobject]@{
            Name = $file.Name; FullName = $file.FullName; Extension = $file.Extension; Length = $file.Length
            Attributes = $file.Attributes; LastWriteTimeUtc = $file.LastWriteTimeUtc; CreationTimeUtc = $file.CreationTimeUtc
        }
    }
    $state
}

function Test-SameDownloadFile($Left, $Right) {
    $Left -and $Right -and $Left.Length -eq $Right.Length -and $Left.Attributes -eq $Right.Attributes -and
        $Left.LastWriteTimeUtc -eq $Right.LastWriteTimeUtc -and $Left.CreationTimeUtc -eq $Right.CreationTimeUtc
}

# Files a browser saved carry the "downloaded from the internet" mark; GOE attachments are told apart by it
# only when a name alone is not enough.
function Test-FromInternet($File) {
    [bool](Get-Item -LiteralPath $File.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue)
}

function Test-AttachmentPrefix([string]$Label, [string]$FileName, [double]$ErrorRate = 0.15) {
    $prefix = ($Label -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant()
    $stem = ([IO.Path]::GetFileNameWithoutExtension($FileName) -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant()
    if ($prefix.Length -lt 12) { return $false }
    if ($stem.StartsWith($prefix, [StringComparison]::Ordinal)) { return $true }
    # Longer OCR labels can identify a file even with a few wrong characters.
    $limit = [int][Math]::Floor($prefix.Length * $ErrorRate)
    if ($prefix.Length -lt 24 -or $stem.Length -lt $prefix.Length - $limit) { return $false }
    $length = [Math]::Min($stem.Length, $prefix.Length + $limit)
    $previous = 0..$length
    for ($i = 1; $i -le $prefix.Length; $i++) {
        $row = [int[]]::new($length + 1)
        $row[0] = $i
        for ($j = 1; $j -le $length; $j++) {
            $cost = [int]($prefix[$i - 1] -ne $stem[$j - 1])
            $row[$j] = [Math]::Min([Math]::Min($previous[$j] + 1, $row[$j - 1] + 1), $previous[$j - 1] + $cost)
        }
        $previous = $row
    }
    foreach ($j in ($prefix.Length - $limit)..$length) {
        if ($previous[$j] -le $limit) { return $true }
    }
    $false
}

# Match the attachment names read from the note window to new or changed files. A name matches one file
# or none: exact name, the same name with "(1)" added by GOE, or the start of a name GOE clipped with "...".
function Select-Attachments($Candidates, [string[]]$Names) {
    $picked = [ordered]@{}
    foreach ($label in $Names) {
        $pool = @($Candidates | Where-Object { !$picked.Contains($_.Name) })
        $expected = $label -replace '\s+', ''
        if ($expected.EndsWith('...')) {
            $found = @($pool | Where-Object { Test-AttachmentPrefix $expected $_.Name })
        } else {
            # the exact name and GOE's "(1)" copy are weighed together, so a browser file of the same name never wins
            $found = @($pool | Where-Object { ($_.Name -replace '\s+|\(\d+\)(?=\.[^.]+$)', '') -eq $expected })
            $extension = [IO.Path]::GetExtension($expected)
            if (!$found.Count -and $extension) {
                $stem = [IO.Path]::GetFileNameWithoutExtension($expected)
                $found = @($pool | Where-Object { $_.Extension -eq $extension -and (Test-AttachmentPrefix $stem $_.Name 0.25) })
            }
        }
        if ($found.Count -gt 1) { $found = @($found | Where-Object { !(Test-FromInternet $_) }) }
        if ($found.Count -eq 1) { $picked[$found[0].Name] = $found[0] }
    }
    @($picked.Values)
}

# The GOE folder may be a busy one such as Downloads, so files the note does not name are ignored.
function Get-DownloadBatch($Before, $After, $Previous, [int]$Count, [string[]]$Names) {
    $changed = @($After.Values | Where-Object { !(Test-SameDownloadFile $Before[$_.Name] $_) })
    $partial = @($changed | Where-Object { $_.Extension -in '.tmp', '.part', '.partial', '.crdownload', '.download' })
    $candidates = @($changed | Where-Object {
        $_ -notin $partial -and $_.Length -gt 0 -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    })
    $files = @(Select-Attachments $candidates $Names)
    if ($files.Count -lt $Count -and !$partial.Count) {
        # Names unreadable: accept only when exactly the expected number of files appeared and nothing else changed.
        $plain = @($candidates | Where-Object { !(Test-FromInternet $_) })
        if ($plain.Count -eq $Count -and $changed.Count -eq $Count) { $files = $plain }
    }
    if ($Count -gt 0 -and $files.Count -eq $Count -and !($files | Where-Object { !(Test-SameDownloadFile $_ $Previous[$_.Name]) })) {
        return @{ status = 'complete'; files = $files }
    }
    @{ status = 'waiting'; files = @(); activity = $changed.Count -gt 0 }
}

function Get-SavedAttachmentCount($Note) {
    $folder = Get-PhysicalDirectory (Join-Path (Join-Path $Inbox 'files') $Note.id)
    if (!$folder) { return 0 }
    $paths = @{}
    foreach ($entry in @($Note.saved)) {
        try {
            if (!$entry.path -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($entry.path)) -ne $folder) { continue }
            $item = Get-Item -LiteralPath $entry.path -Force
            if ($item -is [IO.FileInfo] -and $item.Length -gt 0 -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                ($null -eq $entry.size -or $item.Length -eq $entry.size)) { $paths[$item.FullName] = $true }
        } catch {}
    }
    $paths.Count
}

function Read-AttachmentNames($Lines, $Header, [int]$Count) {
    if (-not $Header) { return }
    $sizeSuffix = '\s*[\(\[]?\s*[\d.,]+\s*(?:KB|MB|GB|B)\s*[\)\]]?\s*$'
    $lastY = $Header.y + 50 + 32 * [Math]::Max(0, $Count - 1)
    foreach ($line in $Lines | Where-Object { $_.y -ge $Header.y + 20 -and $_.y -le $lastY -and $_.x -lt 110 }) {
        if ($line.t -match $sizeSuffix) {
            $name = ($line.t -replace $sizeSuffix, '').Trim()
            if ($name) { $name }
        } elseif ($line.t -match '(?:\.{3,}|\u2026)\s*$') {
            # GOE clips long attachment labels with an ellipsis.
            $name = ($line.t -replace '(?:\.{3,}|\u2026)\s*$', '...').Trim()
            if (($name -replace '\s+', '').Length -ge 15) { $name }
        } elseif ($line.t -match '\.[a-z][a-z0-9]{1,7}\s*$') {
            $line.t.Trim()
        }
    }
}

# Sizes shown next to each attachment ("... .hwp 173 KB"), with how far the rounding may be off.
function Read-AttachmentSizes($Lines, $Header, [int]$Count) {
    if (-not $Header) { return }
    $lastY = $Header.y + 50 + 32 * [Math]::Max(0, $Count - 1)
    foreach ($line in $Lines | Where-Object { $_.y -ge $Header.y + 20 -and $_.y -le $lastY -and $_.x -lt 110 }) {
        if ($line.t -notmatch '^(?<name>.+?)\s*[\(\[]?\s*(?<value>\d[\d,]*(?:\.(?<dec>\d+))?)\s*(?<unit>KB|MB|GB|B)\s*[\)\]]?\s*$') { continue }
        $unit = @{ B = 1; KB = 1024; MB = 1048576; GB = 1073741824 }[$Matches.unit.ToUpperInvariant()]
        $step = [Math]::Pow(10, -$Matches.dec.Length) * $unit
        [pscustomobject]@{
            name = $Matches.name.Trim()
            size = [double]::Parse(($Matches.value -replace ',', ''), [Globalization.CultureInfo]::InvariantCulture) * $unit
            tolerance = $step + 1
        }
    }
}

function Get-EditDistance([string]$A, [string]$B) {
    $previous = 0..$B.Length
    for ($i = 1; $i -le $A.Length; $i++) {
        $row = [int[]]::new($B.Length + 1)
        $row[0] = $i
        for ($j = 1; $j -le $B.Length; $j++) {
            $cost = [int]($A[$i - 1] -ne $B[$j - 1])
            $row[$j] = [Math]::Min([Math]::Min($previous[$j] + 1, $row[$j - 1] + 1), $previous[$j - 1] + $cost)
        }
        $previous = $row
    }
    $previous[$B.Length]
}

# OCR may misread a letter or two (e.g. "20272.28" for "2027.2.28", or one Hangul syllable).
function Test-SimilarName([string]$Label, [string]$FileName) {
    $expected = $Label -replace '\s+', ''
    if ($expected.EndsWith('...')) { return Test-AttachmentPrefix $expected $FileName }
    if ([IO.Path]::GetExtension($expected) -ne [IO.Path]::GetExtension($FileName)) { return $false }
    $a = ([IO.Path]::GetFileNameWithoutExtension($expected) -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant()
    $b = ([IO.Path]::GetFileNameWithoutExtension($FileName) -replace '\(\d+\)$' -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant()
    if (!$a -or !$b) { return $false }
    (Get-EditDistance $a $b) -le [Math]::Max(1, [Math]::Floor($a.Length * 0.2))
}

# GOE silently skips an attachment whose file name already exists in its folder (seen 2026-11-16), which is
# common when the folder is Downloads. Use the existing file only when exactly one file there has a similar
# name and the size shown in the note window.
function Find-ExistingAttachments($State, $Sizes, [string[]]$Taken) {
    $picked = [ordered]@{}
    foreach ($entry in $Sizes) {
        $found = @($State.Values | Where-Object {
            $_.Name -notin $Taken -and !$picked.Contains($_.Name) -and $_.Length -gt 0 -and
            !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            [Math]::Abs($_.Length - $entry.size) -le $entry.tolerance -and (Test-SimilarName $entry.name $_.Name)
        })
        if ($found.Count -gt 1) { $found = @($found | Where-Object { !(Test-FromInternet $_) }) }
        if ($found.Count -ne 1) { return @() }
        $picked[$found[0].Name] = $found[0]
    }
    @($picked.Values)
}

function Receive-Downloads($Elements, [string]$Directory, [int]$Count, [string[]]$Names, $Sizes) {
    if (!$Directory) { return @{ status = 'folder-not-configured' } }
    $Names = @($Names | Where-Object { $_ })
    if ($Count -le 0) { $Count = $Names.Count }
    if ($Count -le 0 -or (Goe-IsForeground)) { return @{ status = 'review' } }
    $button = $Elements | Where-Object { $_.Current.Name -eq $L.downloadAll } | Select-Object -First 1
    if (!$button -or (Find-GoeMenu) -ne [IntPtr]::Zero) { return @{ status = 'failed' } }
    [void][GoeWin.W]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
    $t0 = Get-Date
    do {
        Start-Sleep -Milliseconds 80
        $menu = Find-GoeMenu
    } while ($menu -eq [IntPtr]::Zero -and ((Get-Date) - $t0).TotalSeconds -lt 3)
    if ($menu -eq [IntPtr]::Zero) { return @{ status = 'failed' } }
    if (Goe-IsForeground) { return @{ status = 'review' } }
    $menuHandle = [GoeWin.W]::SendMessage($menu, 0x01E1, [IntPtr]::Zero, [IntPtr]::Zero)
    if ([GoeWin.W]::MenuItem($menuHandle, 0) -ne $L.menuDefault) { Key $menu 0x1B; return @{ status = 'failed' } }

    Start-Sleep -Milliseconds 300
    [void][GoeWin.W]::SendMessage($menu, 0x01E5, [IntPtr]0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    if (Goe-IsForeground) { return @{ status = 'review' } }
    if ((Get-PhysicalDirectory $Directory) -ne $Directory) { Key $menu 0x1B; return @{ status = 'folder-not-configured' } }
    try { $before = Download-State $Directory } catch { Key $menu 0x1B; throw }
    [void][GoeWin.W]::PostMessage($menu, 0x0100, [IntPtr]0x0D, [IntPtr]1)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $previous = @{}
    $stableSince = -1
    do {
        Start-Sleep -Milliseconds 300
        if (Goe-IsForeground) { return @{ status = 'review' } }
        if ((Get-PhysicalDirectory $Directory) -ne $Directory) { return @{ status = 'review' } }
        $current = Download-State $Directory
        $batch = Get-DownloadBatch $before $current $previous $Count $Names
        if ($batch.status -eq 'complete') {
            if ($stableSince -lt 0) { $stableSince = $timer.ElapsedMilliseconds }
            if ($timer.ElapsedMilliseconds - $stableSince -ge 900) {
                return @{ status = 'complete'; files = $batch.files; directory = $Directory }
            }
        } else { $stableSince = -1 }
        $previous = $current
    } while ($timer.Elapsed.TotalSeconds -lt 15)
    $Sizes = @($Sizes | Where-Object { $_ })
    if ($Sizes.Count -eq $Count) {
        # some or all attachments were skipped because a file of that name was already there
        $changed = @($current.Values | Where-Object {
            !(Test-SameDownloadFile $before[$_.Name] $_) -and $_.Length -gt 0 -and
            $_.Extension -notin '.tmp', '.part', '.partial', '.crdownload', '.download'
        })
        $new = @(Select-Attachments $changed $Names | Where-Object { Test-SameDownloadFile $_ $previous[$_.Name] })
        $rest = @($Sizes | Where-Object { $entry = $_; !($new | Where-Object { Test-SimilarName $entry.name $_.Name }) })
        $old = @(Find-ExistingAttachments $current $rest @($changed | ForEach-Object Name))
        if ($rest.Count -and $new.Count + $old.Count -eq $Count) {
            return @{ status = 'complete'; files = @($new) + @($old); directory = $Directory }
        }
    }
    @{ status = $(if ($batch.activity -or $stableSince -ge 0) { 'review' } else { 'failed' }) }
}

function Save-DownloadBatch($Batch, $Note, [string]$NotePath, [bool]$Retry) {
    $locked = [Collections.Generic.List[object]]::new()
    $written = [Collections.Generic.List[string]]::new()
    $committed = $false
    $review = @{ status = 'review' }
    try {
        if (!(Get-PhysicalDirectory $Inbox) -or !(Get-PhysicalDirectory $notesDir) -or
            (Get-PhysicalDirectory $Batch.directory) -ne $Batch.directory) { return $review }
        $root = Get-PhysicalDirectory ([IO.Directory]::CreateDirectory((Join-Path $Inbox 'files')).FullName)
        if (!$root) { return $review }
        $folder = Get-PhysicalDirectory ([IO.Directory]::CreateDirectory((Join-Path $root $Note.id)).FullName)
        if (!$folder) { return $review }
        $saved = foreach ($file in $Batch.files) {
            if (Goe-IsForeground) { return $review }
            $source = [GoeWin.W]::OpenAttachment($file.FullName)
            $locked.Add($source)
            $current = Get-Item -LiteralPath $file.FullName -Force
            if (!(Test-SameDownloadFile $file $current) -or $source.Length -ne $file.Length) { return $review }
            $target = Join-Path $folder $file.Name
            if ([IO.File]::Exists($target)) {
                $existing = Get-Item -LiteralPath $target -Force
                $identical = $false
                if (!($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $existing.Length -eq $file.Length) {
                    $reader = [IO.File]::OpenRead($target)
                    $hash = [Security.Cryptography.SHA256]::Create()
                    try {
                        $identical = [Convert]::ToBase64String($hash.ComputeHash($reader)) -ceq
                            [Convert]::ToBase64String($hash.ComputeHash($source))
                    } finally {
                        $hash.Dispose()
                        $reader.Dispose()
                        $source.Position = 0
                    }
                }
                if (!$identical) { $target = Join-Path $folder ([guid]::NewGuid().ToString('N') + $file.Extension) }
            }
            if (![IO.File]::Exists($target)) {
                $temporary = Join-Path $folder ([guid]::NewGuid().ToString('N') + '.tmp')
                try {
                    $out = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
                    try { $source.CopyTo($out) }
                    finally { $out.Dispose() }
                    [IO.File]::Move($temporary, $target)
                    $written.Add($target)
                } finally { [IO.File]::Delete($temporary) }
            }
            # originalPath lets the calendar skip its own copy when the original already sits in its download folder
            [pscustomobject]@{ name = $file.Name; path = $target; size = $file.Length; originalPath = $file.FullName }
        }
        if ((Get-PhysicalDirectory $Batch.directory) -ne $Batch.directory -or (Goe-IsForeground)) { return $review }
        foreach ($file in $Batch.files) {
            if (!(Test-SameDownloadFile $file (Get-Item -LiteralPath $file.FullName -Force))) { return $review }
        }
        $updated = [ordered]@{}
        foreach ($prop in $Note.PSObject.Properties) { $updated[$prop.Name] = $prop.Value }
        $updated.saved = @($saved)
        $updated.files = @()
        $updated.attachCount = $Batch.files.Count
        $updated.attachStatus = 'saved'
        Write-Note ([pscustomobject]$updated) $NotePath $Retry
        $committed = $true
        # The originals stay in the teacher's GOE folder, as if they had pressed download themselves.
        return @{ status = 'saved'; note = [pscustomobject]$updated }
    } catch { return $review }
    finally {
        foreach ($source in $locked) { $source.Dispose() }
        if (!$committed) {
            foreach ($target in $written) { try { [IO.File]::Delete($target) } catch {} }
        }
    }
}

function Collect-NoteAttachments($Elements, [string]$Directory, [int]$Count, [string[]]$Names, $Sizes, $Note, [string]$NotePath, [bool]$Retry) {
    try {
        $batch = Receive-Downloads $Elements $Directory $Count $Names $Sizes
        if ($batch.status -ne 'complete') { return $batch }
        Save-DownloadBatch $batch $Note $NotePath $Retry
    } catch { return @{ status = 'review' } }
}

$rowKeys = @{}
function Row-Key($Row) {
    $Row.datetime + '|' + ($Row.sender -replace '\s+', '') + '|' + ($Row.titleOcr -replace '\s+', '')
}
function Known-Row($Row, [string]$Key) {
    if (-not $rowKeys.ContainsKey($Row.datetime)) {
        $known = @{}
        $stamp = $Row.datetime -replace '\D', ''
        foreach ($file in Get-ChildItem -LiteralPath $notesDir -Filter "goe_${stamp}_*.json" -File -ErrorAction SilentlyContinue) {
            try {
                $note = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json
                if ($note.datetime -and $note.ocr.listTitle) {
                    $savedRow = [pscustomobject]@{ datetime = $note.datetime; sender = $note.sender; titleOcr = $note.ocr.listTitle }
                    $known[(Row-Key $savedRow)] = $true
                }
            } catch {}
        }
        $rowKeys[$Row.datetime] = $known
    }
    $rowKeys[$Row.datetime].ContainsKey($Key)
}
function Write-Note($Note, [string]$Target, [bool]$Replace = $false) {
    $temporary = $Target + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Note | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
        if ($Replace) { [IO.File]::Replace($temporary, $Target, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Target) }
    } finally {
        [IO.File]::Delete($temporary)
    }
}

# show the main window without activating it (put back at the end)
$wasMin = [GoeWin.W]::IsIconic($main); $wasHidden = -not [GoeWin.W]::IsWindowVisible($main)
function Restore-Main {
    if (Goe-IsForeground) { return }
    if ($wasHidden) { [void][GoeWin.W]::ShowWindow($main, 0) } elseif ($wasMin) { [void][GoeWin.W]::ShowWindow($main, 7) }
}

# read the visible inbox rows: time, title, sender, unread, attachment, click y (list client)
function Read-Rows {
    $cap = Read-Window $main
    $o = $cap.lines; $bmp = $cap.bmp
    if ($DebugOcr -and -not $script:debugSaved) {
        New-Item -ItemType Directory -Force $Inbox | Out-Null
        $bmp.Save((Join-Path $Inbox 'debug-list.png'))
        @("main=$($mr.L),$($mr.T),$($mr.Rt),$($mr.B) list=$($lr.L),$($lr.T),$($lr.Rt),$($lr.B) listTop=$listTop listRight=$listRight timeMinX=$timeMinX bmp=$($bmp.Width)x$($bmp.Height)") +
            @($o | ForEach-Object { '{0} {1} {2}' -f $_.y, $_.x, $_.t }) | Set-Content (Join-Path $Inbox 'debug-list.txt') -Encoding utf8
        $script:debugSaved = $true
    }
    $isInbox = [bool]($o | Where-Object { $_.t -like ('*' + $L.unreadHeader + '*') })
    # the selected box button is darker than the other one
    $bIn = Avg-Bright $bmp ($ir.L - $mr.L + 5) ($ir.Rt - $mr.L - 5) ($ir.T - $mr.T + 3) ($ir.B - $mr.T - 3)
    $bSent = Avg-Bright $bmp ($sr.L - $mr.L + 5) ($sr.Rt - $mr.L - 5) ($sr.T - $mr.T + 3) ($sr.B - $mr.T - 3)
    $timeLines = @($o | Where-Object { $_.y -ge $listTop + 5 -and $_.y -lt $listBottom - 50 -and $_.x -ge $timeMinX -and (Parse-ListTime $_.t) })
    # Pixel offsets below were measured at a 70 px row. If GOE draws larger rows (display scaling),
    # scale them by the measured row pitch.
    $k = 1.0
    if ($timeLines.Count -ge 2) {
        $gaps = @(); for ($i = 1; $i -lt $timeLines.Count; $i++) { $gaps += $timeLines[$i].y - $timeLines[$i - 1].y }
        $pitch = ($gaps | Sort-Object)[[int][Math]::Floor($gaps.Count / 2)]
        if ($pitch -gt 50 -and $pitch -lt 200) { $k = $pitch / 70.0 }
    }
    $script:rowScale = $k
    function S([double]$v) { [int][Math]::Round($v * $k) }
    $rows = @(foreach ($t in $timeLines) {
        $dt = Parse-ListTime $t.t
        $top = $t.y - (S 16)
        # title and sender sit left of this row's own time text
        $title = ($o | Where-Object { [Math]::Abs($_.y - $t.y) -lt (S 6) -and $_.x -lt $t.x } | Select-Object -First 1).t
        $sender = ($o | Where-Object { $_.y -gt $t.y + (S 10) -and $_.y -lt $t.y + (S 35) -and $_.x -lt $t.x } | Select-Object -First 1).t
        [pscustomobject]@{
            datetime = $dt; titleOcr = $title; sender = (Clean-Sender $sender)
            unread = ((Count-Yellow $bmp ($listRight - (S 56)) ($listRight - (S 29)) ($top + (S 40)) ($top + (S 64))) -gt (40 * $k * $k))
            attach = ((Count-Yellow $bmp ($listRight - (S 82)) ($listRight - (S 58)) ($top + (S 40)) ($top + (S 64))) -gt (20 * $k * $k))
            clickY = $top + (S 35) - $listTop
        }
    })
    $bmp.Dispose()
    @{ inbox = ($isInbox -and $bIn -lt $bSent - 30); rows = @($rows) }
}

# ---------- go to the inbox ----------
$seen = @{}
$seenRows = [Collections.Generic.List[object]]::new()
$opened = [Collections.Generic.List[object]]::new()
$ownedNote = $null
try {
    if ($wasMin -or $wasHidden) {
        [void][GoeWin.W]::ShowWindow($main, 4)
        $t0 = Get-Date
        while ([GoeWin.W]::IsIconic($main) -and ((Get-Date) - $t0).TotalSeconds -lt 3) { Start-Sleep -Milliseconds 100 }
        Start-Sleep -Milliseconds 300
    }

    $mr = Get-Rect $main; $lr = Get-Rect $H.list; $ir = Get-Rect $H[$L.inboxButton]; $sr = Get-Rect $H[$L.sentButton]
    $listTop = $lr.T - $mr.T; $listBottom = $lr.B - $mr.T; $listLeft = $lr.L - $mr.L; $listRight = $lr.Rt - $mr.L
    # In a narrow GOE window the time text starts just left of 60% of the list (x=201 of 340, 2026-11-16),
    # so the cut is 40%; a time is also recognised by its date pattern, so titles never pass for one.
    $timeMinX = $listLeft + [int](($listRight - $listLeft) * 0.4)

    Click $H[$L.noteTab]; Start-Sleep -Milliseconds 300; Click $H[$L.inboxButton]; Start-Sleep -Milliseconds 300
    # the list keeps its scroll position between visits, and Home/PageUp/wheel do not scroll it up.
    # Clicking the scrollbar track just under the top arrow pages up: do it until the top is reached.
    $lp = [IntPtr](22 * 65536 + 9)
    for ($i = 0; $i -lt 40; $i++) { [void][GoeWin.W]::PostMessage($H.scroll, 0x0201, [IntPtr]1, $lp); [void][GoeWin.W]::PostMessage($H.scroll, 0x0202, [IntPtr]0, $lp); Start-Sleep -Milliseconds 30 }
    $view = $null; $t0 = Get-Date
    do { Start-Sleep -Milliseconds 300; $view = Read-Rows } while (-not ($view.inbox -and $view.rows.Count) -and ((Get-Date) - $t0).TotalSeconds -lt 4)
    if (-not $view.inbox) { throw 'inbox-not-confirmed' }

    if (-not $ListOnly) { [void][IO.Directory]::CreateDirectory($notesDir) }
    $dlDir = $null
    $checkedDownloadDir = $false

    $page = 0; $stop = $false; $prevBody = ''
    while (-not $stop) {
        foreach ($r in $view.rows) {
            $key = Row-Key $r
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $seenRows.Add($r)
            $result.visible++
            $day = $r.datetime.Substring(0, 10)
            if (-not $result.oldest -or $day -lt $result.oldest) { $result.oldest = $day }
            # GOE can sort unread notes as a group before read notes, so an old row does not end the date range.
            if (($since -and $day -lt $since) -or ($To -and $day -gt $To)) { continue }
            if ($retryNote) {
                if ($r.datetime -ne $retryNote.datetime -or $r.unread -or
                    ($r.sender -replace '\s+', '') -cne ($retryNote.sender -replace '\s+', '')) { continue }
            } elseif ((-not $r.unread -and -not $IncludeRead) -or ($AttachOnly -and -not $r.attach)) { continue }
            $result.matched++
            if (!$retryNote -and $IncludeRead -and (Known-Row $r $key)) { continue }
            $result.fresh++
            if ($ListOnly) { continue }
            if ($result.opened -ge $Max) { $result.remaining++; $stop = $true; break }
            if ((-not $Force -and (Goe-IsForeground)) -or (Get-NoteWindow)) {
                $result.status = 'busy'
                $stop = $true
                break
            }

            $attachmentCutoff = (Get-Date).AddDays(-7)
            $expired = ([datetime]::ParseExact($r.datetime, 'yyyy-MM-dd HH:mm', $calendar) -lt $attachmentCutoff)
            if ($Download -and !$expired -and !$checkedDownloadDir) {
                $dlDir = Get-GoeAttachmentFolder $AttachmentFolder
                $checkedDownloadDir = $true
            }

            DoubleClick $H.list 150 $r.clickY
            $n = $null; $t0 = Get-Date
            while (-not $n -and ((Get-Date) - $t0).TotalSeconds -lt 4) { Start-Sleep -Milliseconds 100; $n = Get-NoteWindow }
            $result.opened++
            if (-not $n) { $result.unknown++; continue }
            $ownedNote = $n
            $nh = [IntPtr]$n.Current.NativeWindowHandle
            $els = $n.FindAll($TS::Descendants, $TRUE_COND)
            $re = $els | Where-Object { $_.Current.ClassName -eq 'RICHEDIT50W' } | Select-Object -First 1
            if (-not $re) {
                $result.unknown++
                Close-Note $ownedNote
                $ownedNote = $null
                continue
            }
            $body = ''; $t0 = Get-Date
            do { $body = [GoeWin.W]::Text([IntPtr]$re.Current.NativeWindowHandle); if ($body -and $body -ne $prevBody) { break }; Start-Sleep -Milliseconds 80 } while (((Get-Date) - $t0).TotalSeconds -lt 2)
            $prevBody = $body

            $cap = Read-Window $nh; $nl = $cap.lines
            if ($DebugOcr) {
                $cap.bmp.Save((Join-Path $Inbox 'debug-note.png'))
                @($nl | ForEach-Object { '{0} {1} {2}' -f $_.y, $_.x, $_.t }) | Set-Content (Join-Path $Inbox 'debug-note.txt') -Encoding utf8
            }
            $cap.bmp.Dispose()
            $sentRow = $nl | Where-Object { $_.t -match $L.sentTimeWord -and $_.y -lt 150 } | Select-Object -First 1
            $sentLine = $sentRow.t
            # the title line sits between the window caption and the sent-time line
            $title = ''
            if ($sentRow) { $title = ($nl | Where-Object { $_.y -gt 35 -and $_.y -lt $sentRow.y - 15 -and $_.x -lt 300 } | Select-Object -First 1).t }
            if (-not $title) { $title = $r.titleOcr }
            $recLine = ($nl | Where-Object { $_.t -match $L.recipientHeader } | Select-Object -First 1).t
            if ($recLine) { $recLine = $recLine.Substring($recLine.IndexOf($L.recipientHeader)) }
            $attachHeader = $nl | Where-Object { $_.t -match $L.attachHeader } | Select-Object -First 1
            $attLine = $attachHeader.t
            $attCount = 0
            if ($attLine -match '\(\s*(\d{1,3})\s*\)') { $attCount = [int]$Matches[1] }
            $fileNames = @(Read-AttachmentNames $nl $attachHeader $attCount)
            $fileSizes = @(Read-AttachmentSizes $nl $attachHeader $attCount)
            $hasAttachments = $attCount -gt 0 -or $fileNames.Count -gt 0 -or $r.attach -or
                [bool]($els | Where-Object { $_.Current.Name -eq $L.downloadAll } | Select-Object -First 1)

            $hash = [Security.Cryptography.SHA1]::Create()
            try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($r.sender + '|' + $body))) }
            finally { $hash.Dispose() }
            $id = 'goe_' + ($r.datetime -replace '\D', '') + '_' + ($digest -replace '-', '').Substring(0, 8).ToLowerInvariant()
            $notePath = Join-Path $notesDir ($id + '.json')

            # the time is read twice (list row and note window); both are OCR, so flag when they disagree
            $sentDt = Parse-SentTime $sentLine
            $dtCheck = if (-not $sentDt) { 'note-time-unread' } elseif ($sentDt -eq $r.datetime) { 'match' } else { 'mismatch' }
            if ($sentDt -and [datetime]::ParseExact($sentDt, 'yyyy-MM-dd HH:mm', $calendar) -lt $attachmentCutoff) { $expired = $true }
            $attachStatus = if (!$hasAttachments) { 'none' } elseif ($expired) { 'expired' } else { 'not-requested' }
            $note = [pscustomobject]@{
                id = $id; source = 'goe'; verified = [bool]($body -and $r.datetime -and $title)
                datetimeCheck = $dtCheck; datetimeNote = $sentDt; attachCount = $attCount; attachStatus = $attachStatus
                wasUnread = $r.unread; openedByAssistant = $true; collectedAt = (Get-Date).ToString('s')
                title = $title; sender = $r.sender; org = ''; datetime = $r.datetime
                recipients = $recLine; files = $fileNames; saved = @(); body = $body
                ocr = [pscustomobject]@{ sentLine = $sentLine; attachLine = $attLine; listTitle = $r.titleOcr }
            }
            if ($retryNote -and $id -ceq $RetryId -and $note.verified -and $body -ceq $retryNote.body) {
                $result.attached = Get-SavedAttachmentCount $retryNote
                if ($expired) { $result.attachStatus = 'expired' }
                elseif (!$hasAttachments) { $result.attachStatus = 'review' }
                elseif ($attCount -gt 0 -and $result.attached -eq $attCount) { $result.attachStatus = 'already-saved' }
                else {
                    # OCR of the note window can miss the attachment list; fall back to what the first import read
                    $retryNames = if ($fileNames.Count) { $fileNames } else { @($retryNote.files | Where-Object { $_ }) }
                    $retryCount = if ($attCount -gt 0) { $attCount } else { [int]$retryNote.attachCount }
                    $savedBatch = Collect-NoteAttachments $els $dlDir $retryCount $retryNames $fileSizes $retryNote $notePath $true
                    $result.attachStatus = $savedBatch.status
                    if ($savedBatch.status -eq 'saved') { $result.attached = @($savedBatch.note.saved).Count }
                }
                $stop = $true
            } elseif (!$retryNote -and ![IO.File]::Exists($notePath)) {
                if ($RangeImport) { $note | Add-Member -NotePropertyName imported -NotePropertyValue 'range' }
                if ($Download -and $hasAttachments -and !$expired) {
                    if (!$note.verified) { $note.attachStatus = 'review' }
                    else {
                        $savedBatch = Collect-NoteAttachments $els $dlDir $attCount $fileNames $fileSizes $note $notePath $false
                        if ($savedBatch.status -eq 'saved') { $note = $savedBatch.note }
                        else { $note.attachStatus = $savedBatch.status }
                    }
                }
                if ($note.attachStatus -ne 'saved') { Write-Note $note $notePath }
                $result.imported++
                $opened.Add($note)
            }
            if ([GoeWin.W]::IsWindow($nh)) { Close-Note $ownedNote }
            $ownedNote = $null
            if ($stop) { break }
        }
        if ($stop -or $page -ge $MaxPages) { break }
        if (-not $Force -and (Goe-IsForeground)) { $result.status = 'busy'; break }
        # PageDown leaves a half-cut row at the top that OCR misses: scroll ~4 rows with the wheel so pages overlap
        $before = ($view.rows | ForEach-Object { Row-Key $_ }) -join [Environment]::NewLine
        $wlp = [IntPtr](($lr.T + 100) * 65536 + ($lr.L + 150))
        for ($i = 0; $i -lt 6; $i++) { [void][GoeWin.W]::PostMessage($H.list, 0x020A, [IntPtr]((-120 -band 0xFFFF) -shl 16), $wlp); Start-Sleep -Milliseconds 60 }
        Start-Sleep -Milliseconds 600; $page++
        $view = Read-Rows
        if (-not $view.inbox) { throw 'inbox-lost-while-paging' }
        if ((($view.rows | ForEach-Object { Row-Key $_ }) -join [Environment]::NewLine) -eq $before) { break }
    }
} catch {
    $result.status = 'error'
    $reason = 'collection-failed line=' + $_.InvocationInfo.ScriptLineNumber
} finally {
    try {
        try { if ($ownedNote) { Close-Note $ownedNote } }
        finally { Restore-Main }
    } catch {
        $result.status = 'error'
        $reason = 'restore-failed'
    }
}

if (-not $ResultObject -and (Test-Path -LiteralPath $Inbox)) {
    [pscustomobject]@{ collectedAt = (Get-Date).ToString('s'); list = $seenRows.ToArray(); opened = $opened.ToArray() } |
        ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Inbox 'latest.json') -Encoding utf8
}
Publish-Result $reason
