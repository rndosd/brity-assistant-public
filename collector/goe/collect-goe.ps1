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
    [switch]$Reply,             # with -RetryId: open that note in GOE and press its reply button (nothing is saved)
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
    remaining = 0; opened = 0; imported = 0; placeholders = 0; oldest = $null; attachStatus = 'not-found'; attached = 0; reply = 'not-found'; busyReason = ''; reason = ''
}

function Publish-Result([string]$Reason) {
    if ($ResultObject) { return [pscustomobject]$result }
    if ($Reason) { Write-Output "status=$($result.status) reason=$Reason"; return }
    if ($RetryId -and $Reply) { Write-Output "status=$($result.status) reply=$($result.reply)"; return }
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
    if (!$Reply -and $retryTime -lt (Get-Date).AddDays(-7)) { $result.attachStatus = 'expired'; Publish-Result ''; return }
    $From = $To = $retryNote.datetime.Substring(0, 10)
    $IncludeRead = $true
    $Download = -not $Reply
    # an old note sits further down the list
    if ($Reply -and $MaxPages -lt 60) { $MaxPages = 60 }
    $Force = $false
}
$range = $RangeImport -or $From -or $To
foreach ($day in @($From, $To)) {
    if ($day) { [void][datetime]::ParseExact($day, 'yyyy-MM-dd', $calendar) }
}
$since = if ($From) { $From } elseif (-not $range -and $SinceDays -gt 0) { (Get-Date).Date.AddDays(-$SinceDays).ToString('yyyy-MM-dd', $calendar) }
if ($To -and $since -and $To -lt $since) { throw 'invalid-date-range' }

# Notes the teacher already read in GOE before the calendar got to them (2026-11-17): a plain run remembers
# the newest list time it saw on its last complete pass (tick-state.json), and next time also opens read rows
# from that minute on that are not saved yet. With no remembered time (first connection) read rows are left
# alone; "load past notes" brings old ones.
$tickStatePath = Join-Path $Inbox 'tick-state.json'
$watchRead = -not ($range -or $RetryId -or $IncludeRead -or $ListOnly -or $Inspect -or $AttachOnly)
$readSince = $null
if ($watchRead -and [IO.File]::Exists($tickStatePath)) {
    try {
        $remembered = (Get-Content -LiteralPath $tickStatePath -Raw -Encoding utf8 | ConvertFrom-Json).readSince
        if ($remembered -match '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$') { $readSince = $remembered }
    } catch {}
}
$newestRow = $null
# OCR can misread a digit; a list time later than now would hide newer read notes, so it is not remembered
$latestPlausible = (Get-Date).AddMinutes(5).ToString('yyyy-MM-dd HH:mm', $calendar)

# GOE_TIMING=1 prints how long each step took (to stderr; for measuring, off in normal runs)
$markClock = [Diagnostics.Stopwatch]::StartNew()
function Mark([string]$What) { if ($env:GOE_TIMING) { [Console]::Error.WriteLine(('{0,6} ms  {1}' -f $markClock.ElapsedMilliseconds, $What)) } }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
. (Join-Path $PSScriptRoot 'goe-folder-state.ps1')
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
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  public static void BringReplyToFront(IntPtr h) {
    uint pid;
    uint front = GetWindowThreadProcessId(GetForegroundWindow(), out pid), me = GetCurrentThreadId();
    bool joined = front != 0 && front != me && AttachThreadInput(me, front, true);
    try { if (IsIconic(h)) ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h); }
    finally { if (joined) AttachThreadInput(me, front, false); }
  }
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
}
// Top-level windows by class, hidden ones too (a GOE window closed to the tray is not a UI Automation child).
public static class Top {
  delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static System.Collections.Generic.List<IntPtr> ByClass(string cls) {
    var r = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256); if (c.ToString() == cls) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
}
// Parking a tray or minimized GOE window off screen while it is read (kept in this one compiled block:
// a second Add-Type cost about a second on every run, 2026-11-17).
public static class Style {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] struct WP { public int length, flags, showCmd, minX, minY, maxX, maxY, l, t, r, b; }
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref WP p);
  // all screens together: left, top, right, bottom
  public static int[] Virtual() { int x = GetSystemMetrics(76), y = GetSystemMetrics(77); return new[] { x, y, x + GetSystemMetrics(78), y + GetSystemMetrics(79) }; }
  // restored (normal) rectangle of a window, also while it is minimized
  public static int[] GetNormal(IntPtr h) { var p = new WP(); p.length = Marshal.SizeOf(p); GetWindowPlacement(h, ref p); return new[] { p.l, p.t, p.r, p.b }; }
  public static bool SetNormal(IntPtr h, int l, int t, int r, int b, int show) {
    var p = new WP(); p.length = Marshal.SizeOf(p); GetWindowPlacement(h, ref p);
    p.l = l; p.t = t; p.r = r; p.b = b; p.showCmd = show; p.flags = 0; return SetWindowPlacement(h, ref p);
  }
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  // DWMWA_TRANSITIONS_FORCEDISABLED: no restore/minimize animation while a minimized GOE is read off screen
  public static void NoAnimation(IntPtr h, bool off) { int v = off ? 1 : 0; DwmSetWindowAttribute(h, 3, ref v, 4); }
}
// While a parked GOE is read, every GOE window that shows up on a screen is moved off screen within about 5 ms
// (2026-11-17: the note window, the settings window GOE opens to tell its download folder, the download menu
// and GOE's download progress window all appeared, and GOE itself moved a restored main window back to 0,0).
// Each window's own place is kept so a window the collector closes can be put back first (GOE remembers it).
public static class Keeper {
  delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out W.R r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  static System.Threading.Thread thread;
  static volatile bool running;
  static int pid, left, top, right, bottom;
  static readonly object gate = new object();
  static readonly System.Collections.Generic.Dictionary<long, int[]> home = new System.Collections.Generic.Dictionary<long, int[]>();
  public static int Moves;
  public static void Start(int processId, int l, int t, int r, int b) {
    Stop(); pid = processId; left = l; top = t; right = r; bottom = b; Moves = 0;
    lock (gate) home.Clear();
    running = true;
    thread = new System.Threading.Thread(Loop) { IsBackground = true };
    thread.Start();
  }
  public static void Stop() { running = false; if (thread != null) { thread.Join(1000); thread = null; } }
  static void Loop() {
    SetThreadDpiAwarenessContext((IntPtr)(-4));   // the same physical pixels as the collector
    while (running) {
      EnumWindows((h, l) => {
        uint p; GetWindowThreadProcessId(h, out p);
        if (p != pid || !IsWindowVisible(h) || IsIconic(h)) return true;
        W.R x; GetWindowRect(h, out x);
        if (x.L >= right || x.Rt <= left || x.T >= bottom || x.B <= top) return true;
        lock (gate) { if (!home.ContainsKey((long)h)) home[(long)h] = new[] { x.L, x.T }; }
        SetWindowPos(h, IntPtr.Zero, right + 200, top, 0, 0, 0x15);
        Moves++;
        return true;
      }, IntPtr.Zero);
      System.Threading.Thread.Sleep(5);
    }
  }
  public static int[] Home(IntPtr h) { lock (gate) { int[] v; return home.TryGetValue((long)h, out v) ? v : null; } }
  // hide a window the collector is about to close and put it back where GOE had it
  public static void PutBack(IntPtr h) {
    var v = Home(h); if (v == null) return;
    lock (gate) home.Remove((long)h);
    ShowWindow(h, 0);
    SetWindowPos(h, IntPtr.Zero, v[0], v[1], 0, 0, 0x15);
  }
}
}
'@
function Get-VirtualScreen { $v = [GoeWin.Style]::Virtual(); [pscustomobject]@{ Left = $v[0]; Top = $v[1]; Right = $v[2]; Bottom = $v[3] } }

# Work in physical pixels. GOE is DPI aware but draws at fixed pixel sizes; a DPI-virtualized caller
# (PowerShell is system aware) gets rects divided by the scale and PrintWindow then crops the window.
[void][GoeWin.W]::SetThreadDpiAwarenessContext([IntPtr](-4))   # PER_MONITOR_AWARE_V2

# ---------- OCR (Windows.Media.Ocr, Korean) ----------
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }

function Get-Rect($h) { $r = New-Object GoeWin.W+R; [void][GoeWin.W]::GetWindowRect([IntPtr]$h, [ref]$r); $r }

# Capture a window (works behind other windows, not when minimized), returns @{ bmp; lines }
# lines: x,y in 1x window pixels, t = text. Scale 3 makes small Korean text readable.
function Read-Window($h, [int]$k = 3) {
    $r = Get-Rect $h; $w = $r.Rt - $r.L; $hh = $r.B - $r.T
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    try {
        $g = [Drawing.Graphics]::FromImage($bmp)
        try {
            $dc = $g.GetHdc()
            try { [void][GoeWin.W]::PrintWindow([IntPtr]$h, $dc, 2) } finally { $g.ReleaseHdc($dc) }
        } finally { $g.Dispose() }
        $view = Read-OcrRegion $bmp ([Drawing.Rectangle]::new(0, 0, $w, $hh)) $k
        $lines = @($view.result.Lines | ForEach-Object {
            $b = @($_.Words)[0].BoundingRect
            [pscustomobject]@{ x = [int]($b.X / $view.scaleX); y = [int]($b.Y / $view.scaleY); t = $_.Text } } | Sort-Object y, x)
        @{ bmp = $bmp; lines = $lines }
    } catch { $bmp.Dispose(); throw }
}
# A cheap fingerprint of what the list shows (a small grey thumbnail of the list window), to see whether a
# scroll still moves it. $null when it cannot be taken.
function Get-ListLook([IntPtr]$List) {
    try {
        $r = Get-Rect $List; $w = $r.Rt - $r.L; $hh = $r.B - $r.T
        if ($w -lt 10 -or $hh -lt 10) { return $null }
        $bmp = New-Object System.Drawing.Bitmap $w, $hh
        try {
            $g = [Drawing.Graphics]::FromImage($bmp)
            try { $dc = $g.GetHdc(); try { [void][GoeWin.W]::PrintWindow($List, $dc, 2) } finally { $g.ReleaseHdc($dc) } } finally { $g.Dispose() }
            $small = New-Object System.Drawing.Bitmap $bmp, 24, 48
            try {
                $sb = [Text.StringBuilder]::new()
                for ($y = 0; $y -lt 48; $y++) { for ($x = 0; $x -lt 24; $x++) { $c = $small.GetPixel($x, $y); [void]$sb.Append([char](65 + [int](($c.R + $c.G + $c.B) / 48))) } }
                $sb.ToString()
            } finally { $small.Dispose() }
        } finally { $bmp.Dispose() }
    } catch { $null }
}
# Scroll the note list by wheel ticks (positive = down, negative = up), without moving the mouse.
function Scroll-List([int]$Ticks) {
    $lp = [IntPtr](($lr.T + 100) * 65536 + ($lr.L + 150))
    $delta = if ($Ticks -gt 0) { -120 } else { 120 }
    for ($i = 0; $i -lt [Math]::Abs($Ticks); $i++) {
        [void][GoeWin.W]::PostMessage($H.list, 0x020A, [IntPtr](($delta -band 0xFFFF) -shl 16), $lp); Start-Sleep -Milliseconds 15
    }
}
function Reset-ListScroll {
    # the list keeps its scroll position between visits, and Home/PageUp/wheel do not scroll it up.
    # Clicking the scrollbar track just under the top arrow pages up: do it until the top is reached.
    # Stop as soon as the list no longer moves (40 fixed clicks took 1.6 s of every run, 2026-11-19).
    $lp = [IntPtr](22 * 65536 + 9)
    $lastLook = $null
    for ($batch = 0; $batch -lt 8; $batch++) {
        for ($i = 0; $i -lt 5; $i++) { [void][GoeWin.W]::PostMessage($H.scroll, 0x0201, [IntPtr]1, $lp); [void][GoeWin.W]::PostMessage($H.scroll, 0x0202, [IntPtr]0, $lp); Start-Sleep -Milliseconds 12 }
        Start-Sleep -Milliseconds 40
        $look = Get-ListLook $folderProof.Pane.List
        if ($null -ne $look -and $look -eq $lastLook) { break }
        $lastLook = $look
    }
}
# Only the list's time column (a narrow strip, about a fifth of a full-window OCR). Used to scroll quickly toward
# an old note for reply / download again (2026-11-19: 14 full pages, 29 of 36 s, for a 9-day-old note).
# Returns the times top to bottom, or $null when the column is not known or nothing was read.
function Read-ListTimes([switch]$Rows) {
    if (-not $script:timeColX) { return $null }
    $r = Get-Rect $main; $w = $r.Rt - $r.L; $hh = $r.B - $r.T
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    try {
        $g = [Drawing.Graphics]::FromImage($bmp)
        try { $dc = $g.GetHdc(); try { [void][GoeWin.W]::PrintWindow($main, $dc, 2) } finally { $g.ReleaseHdc($dc) } } finally { $g.Dispose() }
        $x0 = [Math]::Max(0, $script:timeColX - 12); $x1 = [Math]::Min($w, $listRight - 2)
        $y0 = [Math]::Max(0, $listTop + 5); $y1 = [Math]::Min($hh, $listBottom - 50)
        if ($x1 - $x0 -lt 30 -or $y1 - $y0 -lt 30) { return $null }
        $view = Read-OcrRegion $bmp ([Drawing.Rectangle]::new($x0, $y0, $x1 - $x0, $y1 - $y0)) 3
        $found = @($view.result.Lines | ForEach-Object {
            $dt = Parse-ListTime $_.Text
            if ($dt) { [pscustomobject]@{ datetime = $dt; y = $y0 + [int](@($_.Words)[0].BoundingRect.Y / $view.scaleY) } }
        })
        if (!$found.Count) { return }
        if (-not $Rows) { return @($found | ForEach-Object datetime) }
        # On the candidate row read the sender and title too. Keep the other rows for navigation only.
        $k = if ($script:rowScale) { $script:rowScale } else { 1.0 }
        $candidates = @($found | Where-Object { Test-SameNoteRow $_ $retryNote })
        # Resolve ties, a missing target time, and attachment retries with the full row reader.
        # It recovers missed time cells, distinguishes senders and reads the attachment clip.
        if ($candidates.Count -gt 1 -or !$Reply -or
            (!$candidates.Count -and ($found.datetime | Sort-Object)[0] -le $retryNote.datetime)) { return }
        $sender = ''
        $title = ''
        if ($candidates.Count) {
            $t = $candidates[0]
            $y = [Math]::Max(0,$t.y - [int](12 * $k))
            $right = [Math]::Min($x0, $bmp.Width)
            $height = [Math]::Min([int](62 * $k), $bmp.Height - $y)
            if ($right -le $listLeft -or $height -lt 8) { return }
            $area = [Drawing.Rectangle]::new($listLeft, $y, $right - $listLeft, $height)
            $senderView = Read-OcrRegion $bmp $area 3
            foreach ($line in $senderView.result.Lines) {
                $offset = $y + @($line.Words)[0].BoundingRect.Y / $senderView.scaleY - $t.y
                if (!$title -and [Math]::Abs($offset) -lt 6 * $k) { $title = $line.Text }
                if (!$sender -and $offset -gt 10 * $k -and $offset -lt 35 * $k) { $sender = Clean-Sender $line.Text }
            }
            if (!$sender -or !$retryNote.sender -or !(Test-SameNoteRow @{datetime=$t.datetime; sender=$sender} $retryNote)) {
                Mark 'candidate sender needs full list OCR'
                return
            }
        }
        foreach ($t in $found) {
            $top = $t.y - [int][Math]::Round(16 * $k)
            [pscustomobject]@{
                datetime = $t.datetime; titleOcr = $title; sender = $(
                    if ($candidates.Count -and $t.y -eq $candidates[0].y) { $sender })
                unread = ((Count-Yellow $bmp ($listRight - [int](56 * $k)) ($listRight - [int](29 * $k)) ($top + [int](40 * $k)) ($top + [int](64 * $k))) -gt (40 * $k * $k))
                attach = $false
                clickY = $top + [int][Math]::Round(35 * $k) - $listTop
            }
        }
    } finally { $bmp.Dispose() }
}
# The time column's place and the row scale from the last full read, so a reply can start from the time column.
function Save-ListLayout {
    try {
        $mrNow = Get-Rect $main
        [IO.Directory]::CreateDirectory($Inbox) | Out-Null
        [IO.File]::WriteAllText((Join-Path $Inbox 'goe-layout.json'), (@{ colX = $script:timeColX; rowScale = $script:rowScale; width = $mrNow.Rt - $mrNow.L; listTop = $listTop } | ConvertTo-Json -Compress))
    } catch {}
}
function Use-ListLayout {
    try {
        $saved = Get-Content -LiteralPath (Join-Path $Inbox 'goe-layout.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        $mrNow = Get-Rect $main
        if ($saved.width -ne $mrNow.Rt - $mrNow.L -or $saved.listTop -ne $listTop -or -not $saved.colX) { return $false }
        $script:timeColX = [int]$saved.colX; $script:rowScale = [double]$saved.rowScale
        $true
    } catch { $false }
}
function Read-OcrRegion($bmp, [Drawing.Rectangle]$area, [int]$requestedScale, [switch]$Mono) {
    # A full-width 4K window at 3x exceeds the Windows OCR limit. Keep integer zoom when it fits.
    $limit = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [double][Math]::Max($area.Width, $area.Height)
    $scale = if ($limit -lt 1) { $limit } else { [Math]::Min($requestedScale, [Math]::Floor($limit)) }
    $width = [Math]::Max(1, [int]($area.Width * $scale))
    $height = [Math]::Max(1, [int]($area.Height * $scale))
    $png = Join-Path ([IO.Path]::GetTempPath()) ('goe-collector-' + [guid]::NewGuid().ToString() + '.png')
    $s = $null; $sb = $null
    try {
        $big = [Drawing.Bitmap]::new($width, $height)
        try {
            $g = [Drawing.Graphics]::FromImage($big)
            try {
                $g.InterpolationMode = 'HighQualityBicubic'
                $g.DrawImage($bmp, [Drawing.Rectangle]::new(0, 0, $width, $height), $area, [Drawing.GraphicsUnit]::Pixel)
            } finally { $g.Dispose() }
            if ($Mono) {
                # dark text black, everything lighter white: GOE draws a new attachment as dark text on an orange
                # chip, which OCR misread badly in color (2026-11-18, one letter off in black and white instead)
                $data = $big.LockBits([Drawing.Rectangle]::new(0, 0, $width, $height), 'ReadWrite', [Drawing.Imaging.PixelFormat]::Format32bppArgb)
                try {
                    $bytes = [byte[]]::new($data.Stride * $height)
                    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
                    for ($i = 0; $i -lt $bytes.Length; $i += 4) {
                        $v = if (0.114 * $bytes[$i] + 0.587 * $bytes[$i + 1] + 0.299 * $bytes[$i + 2] -lt 140) { 0 } else { 255 }
                        $bytes[$i] = $v; $bytes[$i + 1] = $v; $bytes[$i + 2] = $v
                    }
                    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
                } finally { $big.UnlockBits($data) }
            }
            $big.Save($png)
        } finally { $big.Dispose() }
        $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
        $s = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $sb = Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $res = Await ($ocr.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
        @{ result = $res; scaleX = $width / $area.Width; scaleY = $height / $area.Height }
    } finally {
        if ($sb) { $sb.Dispose() }
        if ($s) { $s.Dispose() }
        Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
    }
}
# Read one list row's time cell again on its own (about 20 ms): only for a row whose time was not read or does
# not fit the list order, so a normal run costs nothing extra (2026-11-17 "too slow is not ok").
function Read-TimeCell($bmp, [int]$x0, [int]$x1, [int]$y, [int]$h) {
    $x0 = [Math]::Max(0, $x0); $x1 = [Math]::Min($bmp.Width, $x1); $y0 = [Math]::Max(0, $y - [int]($h / 4))
    $w = $x1 - $x0; $hh = [Math]::Min($h, $bmp.Height - $y0)
    if ($w -lt 20 -or $hh -lt 8) { return $null }
    $region = Read-OcrRegion $bmp ([Drawing.Rectangle]::new($x0, $y0, $w, $hh)) 4
    $text = (@($region.result.Lines | ForEach-Object { $_.Text }) -join ' ')
    if (Parse-ListTime $text) { $text }
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
    if ($n) { $s / $n }
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
# Find GOE by its main window class, not by the first process with the GOE name (2026-11-17: on another PC GOE
# was running and logged in but was not found; GOE can run more than one process under the same name, and the
# exe name can differ between GOE builds).
$proc = $null; $mainEl = $null
$classCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, $L.mainClass)
foreach ($el in $AE::RootElement.FindAll($TS::Children, $classCond)) {
    $p = Get-Process -Id $el.Current.ProcessId -ErrorAction SilentlyContinue
    if (-not $p -or $p.SessionId -ne $session) { continue }
    $proc = $p; $mainEl = $el
    if ([GoeWin.W]::IsWindowVisible([IntPtr]$el.Current.NativeWindowHandle)) { break }
}
# A main window hidden in the tray is not a UI Automation child of the desktop (2026-11-17: GOE closed to the
# tray read as "not found"). EnumWindows still lists it; FindWindowEx did not find GOE's window on this PC.
if (-not $mainEl) {
    foreach ($hw in [GoeWin.Top]::ByClass($L.mainClass)) {
        $wp = [uint32]0; [void][GoeWin.W]::GetWindowThreadProcessId($hw, [ref]$wp)
        $p = Get-Process -Id $wp -ErrorAction SilentlyContinue
        if (-not $p -or $p.SessionId -ne $session) { continue }
        try { $el = $AE::FromHandle($hw) } catch { continue }
        if ($el) { $proc = $p; $mainEl = $el; break }
    }
}
if (-not $mainEl) {
    $result.status = 'offline'
    $result.reason = if (Get-Process -Name $L.processName -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session) { 'main-window-not-found' } else { 'goe-not-running' }
    Publish-Result $result.reason; return
}
$pidCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $proc.Id)
$main = [IntPtr]$mainEl.Current.NativeWindowHandle
Mark 'found GOE window'

# A hidden (tray) window exposes no controls to UI Automation. The connection check stops here; a real run
# shows it without activating it before looking for the buttons, and Hide-Main / Restore-Main put it back.
# A run cut off while GOE was parked (see below) left it shown right of all screens: put it back where it was,
# hidden again unless the teacher has it in front, before anything else looks at it.
$parkFile = Join-Path $Inbox 'goe-parked.json'
if (Test-Path -LiteralPath $parkFile) {
    try {
        $saved = Get-Content -LiteralPath $parkFile -Raw | ConvertFrom-Json
        $vs = Get-VirtualScreen; $r = Get-Rect $main
        $fgPid = [uint32]0
        [void][GoeWin.W]::GetWindowThreadProcessId([GoeWin.W]::GetForegroundWindow(), [ref]$fgPid)
        $off = $r.L -ge $vs.Right -or $r.Rt -le $vs.Left -or $r.T -ge $vs.Bottom -or $r.B -le $vs.Top
        if ($saved.Min) {
            # parked from minimized: restore its place and minimize it again (left shown if the teacher has it in front)
            [GoeWin.Style]::NoAnimation($main, $false)
            $n = [GoeWin.Style]::GetNormal($main)
            if ($n[0] -ge $vs.Right -or $n[2] -le $vs.Left -or $n[1] -ge $vs.Bottom -or $n[3] -le $vs.Top) {
                [void][GoeWin.Style]::SetNormal($main, [int]$saved.L, [int]$saved.T, [int]$saved.R, [int]$saved.B, $(if ($fgPid -eq $proc.Id) { 1 } else { 7 }))
            }
            $off = $false
        }
        elseif ($off -and $fgPid -ne $proc.Id) { [void][GoeWin.W]::ShowWindow($main, 0) }
        if ($null -ne $saved.Ex) { [void][GoeWin.Style]::SetWindowLong($main, -20, [int]$saved.Ex) }
        if ($off) { [void][GoeWin.W]::SetWindowPos($main, [IntPtr]::Zero, [int]$saved.L, [int]$saved.T, 0, 0, 0x15) }
        # GOE windows the cut-off run opened and the keeper moved off screen (a note, the settings window):
        # close them where the teacher can find GOE again. An open note window would otherwise block every
        # later run as "a note window is open" while nobody can see it.
        $closed = 0
        foreach ($w in [GoeWin.Top]::ByClass($L.childClass)) {
            $wp = [uint32]0; [void][GoeWin.W]::GetWindowThreadProcessId($w, [ref]$wp)
            $wr = Get-Rect $w
            if ($wp -ne $proc.Id -or -not [GoeWin.W]::IsWindowVisible($w) -or $wr.L -lt $vs.Right) { continue }
            [void][GoeWin.W]::ShowWindow($w, 0)
            [void][GoeWin.W]::SetWindowPos($w, [IntPtr]::Zero, $vs.Left + 100, $vs.Top + 100, 0, 0, 0x15)
            [void][GoeWin.W]::PostMessage($w, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
            $closed++
        }
        if ($closed) { Start-Sleep -Milliseconds 500 }
    } catch { }
    Remove-Item -LiteralPath $parkFile -Force -ErrorAction SilentlyContinue
}
if (-not $Inspect) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    [void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
    [void][Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ko'))
    if (-not $ocr) { $result.status = 'list-unreadable'; $result.reason = 'no-korean-ocr'; Publish-Result $result.reason; return }
}
Mark 'ocr ready'
$wasMin = [GoeWin.W]::IsIconic($main); $wasHidden = -not [GoeWin.W]::IsWindowVisible($main)
# While a tray window is read it is parked right of all screens, so the teacher does not see GOE pop up on
# every automatic run (2026-11-17). PrintWindow and UI Automation still read it there. Its place is written to
# goe-parked.json first: if a run is cut off, the next run (any mode) moves it back before anything else.
$parked = $null
function Unpark {
    if (-not $script:parked) { return }
    [GoeWin.Keeper]::Stop()
    $fgPid = [uint32]0
    [void][GoeWin.W]::GetWindowThreadProcessId([GoeWin.W]::GetForegroundWindow(), [ref]$fgPid)
    if ($script:parked.Min) {
        $p = $script:parked
        [void][GoeWin.Style]::SetNormal($main, $p.L, $p.T, $p.R, $p.B, $(if ($fgPid -eq $proc.Id) { 1 } else { 7 }))
        [GoeWin.Style]::NoAnimation($main, $false)
        Remove-Item -LiteralPath $parkFile -Force -ErrorAction SilentlyContinue
        $script:parked = $null
        return
    }
    # hide first so it does not flash at its own place; the teacher may have opened it from the tray meanwhile
    if ($fgPid -ne $proc.Id) { [void][GoeWin.W]::ShowWindow($main, 0) }
    [void][GoeWin.Style]::SetWindowLong($main, -20, [int]$script:parked.Ex)
    [void][GoeWin.W]::SetWindowPos($main, [IntPtr]::Zero, $script:parked.L, $script:parked.T, 0, 0, 0x15)
    Remove-Item -LiteralPath $parkFile -Force -ErrorAction SilentlyContinue
    $script:parked = $null
}
if ($wasHidden -and $Inspect) {
    [IO.Directory]::CreateDirectory((Join-Path $Inbox 'notes')) | Out-Null
    Publish-Result 'available'
    return
}
function Hide-Main {
    $fgPid = [uint32]0
    [void][GoeWin.W]::GetWindowThreadProcessId([GoeWin.W]::GetForegroundWindow(), [ref]$fgPid)
    if ($script:parked) { Unpark }
    elseif ($wasHidden -and $fgPid -ne $proc.Id) { [void][GoeWin.W]::ShowWindow($main, 0) }
}
if ($wasHidden) {
    $r = Get-Rect $main

    $ex = [GoeWin.Style]::GetWindowLong($main, -20)
    [IO.Directory]::CreateDirectory($Inbox) | Out-Null
    $parked = [pscustomobject]@{ L = $r.L; T = $r.T; Ex = $ex }
    $parked | ConvertTo-Json -Compress | Set-Content -LiteralPath $parkFile -Encoding ascii
    # WS_EX_TOOLWINDOW on, WS_EX_APPWINDOW off while it is out: a tool window gets no taskbar button, so the
    # taskbar does not flash a GOE icon on every run (2026-11-17, "that would be a problem"). Put back by Unpark.
    [void][GoeWin.Style]::SetWindowLong($main, -20, (($ex -bor 0x80) -band (-bnot 0x40000)))
    $vs = Get-VirtualScreen
    # Reply shows a note and the reply window to the teacher on purpose, so nothing is kept off screen then.
    if (-not $Reply) { [GoeWin.Keeper]::Start($proc.Id, $vs.Left, $vs.Top, $vs.Right, $vs.Bottom) }
    # SWP_SHOWWINDOW|NOACTIVATE|NOZORDER|NOSIZE: ShowWindow(SW_SHOWNOACTIVATE) on the tray window left GOE in
    # front once (2026-11-17), so the run stopped as "user is in GOE" and the window stayed out.
    [void][GoeWin.W]::SetWindowPos($main, [IntPtr]::Zero, $vs.Right + 200, $vs.Top, 0, 0, 0x55)
    $t0 = Get-Date
    while (-not [GoeWin.W]::IsWindowVisible($main) -and ((Get-Date) - $t0).TotalSeconds -lt 3) { Start-Sleep -Milliseconds 100 }
    Start-Sleep -Milliseconds 400
}

function Find-MainControls {
    $found = @{}
    foreach ($e in $mainEl.FindAll($TS::Descendants, $TRUE_COND)) {
        $c = $e.Current
        if ($c.ClassName -eq 'Button' -and $c.Name -in @($L.noteTab, $L.inboxButton, $L.sentButton) -and -not $found[$c.Name]) { $found[$c.Name] = [IntPtr]$c.NativeWindowHandle }
        # some GOE windows label the tabs short (noteTabShort in labels.json instead of noteTab; 2026-11-18 on
        # another PC with a 452 px wide window, found with the diagnosis tool). The note window has the same title,
        # but it is a window, not a Button.
        if ($L.noteTabShort -and $c.ClassName -eq 'Button' -and $c.Name -eq $L.noteTabShort -and -not $found[$L.noteTab]) { $found[$L.noteTab] = [IntPtr]$c.NativeWindowHandle }
        if ($c.ClassName -eq 'UltariListScrollView' -and -not $found.list) { $found.list = [IntPtr]$c.NativeWindowHandle }
        if ($c.ClassName -eq 'UListScrollBar' -and -not $found.scroll) { $found.scroll = [IntPtr]$c.NativeWindowHandle }
    }
    $found
}
$H = Find-MainControls
# GOE left on another tab (chats, contacts) hides the inbox/sent buttons and the note list (2026-11-16: most
# replies failed this way). Switch to the note tab, unless the teacher is working in GOE right now.
if ($H[$L.noteTab] -and -not ($H[$L.inboxButton] -and $H[$L.sentButton] -and $H.list -and $H.scroll)) {
    $fgPid = 0
    [void][GoeWin.W]::GetWindowThreadProcessId([GoeWin.W]::GetForegroundWindow(), [ref]$fgPid)
    if ($Force -or $fgPid -ne $proc.Id) {
        [void][GoeWin.W]::SendMessage([IntPtr]$H[$L.noteTab], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
        $t0 = Get-Date
        do { Start-Sleep -Milliseconds 300; $H = Find-MainControls } while (-not ($H[$L.inboxButton] -and $H.list) -and ((Get-Date) - $t0).TotalSeconds -lt 3)
    }
}
$controlKeys = @($L.noteTab, $L.inboxButton, $L.sentButton, 'list', 'scroll')
# 2026-11-18 another PC showed "found the GOE window but could not read the note buttons" while GOE sat on the
# contacts tab in front of the teacher. Tell those cases apart instead of one error:
function Test-GoeInFront { $p = [uint32]0; [void][GoeWin.W]::GetWindowThreadProcessId([GoeWin.W]::GetForegroundWindow(), [ref]$p); $p -eq $proc.Id }
if (@($controlKeys | Where-Object { -not $H[$_] }).Count) {
    # a small window folds the inbox/sent buttons away: enlarge it only for this check, then put the size back
    # (reading enlarges it again later when needed)
    $mr = Get-Rect $main
    if ($mr.Rt - $mr.L -lt 360 -or $mr.B - $mr.T -lt 585) {
        [void][GoeWin.W]::SetWindowPos($main, [IntPtr]::Zero, $mr.L, $mr.T, [Math]::Max(360, $mr.Rt - $mr.L), [Math]::Max(585, $mr.B - $mr.T), 0x14)
        Start-Sleep -Milliseconds 400
        $H = Find-MainControls
        if ($H[$L.noteTab] -and -not $H[$L.inboxButton] -and ($Force -or -not (Test-GoeInFront))) {
            [void][GoeWin.W]::SendMessage([IntPtr]$H[$L.noteTab], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 600; $H = Find-MainControls
        }
        [void][GoeWin.W]::SetWindowPos($main, [IntPtr]::Zero, $mr.L, $mr.T, $mr.Rt - $mr.L, $mr.B - $mr.T, 0x14)
    }
}
$missing = @($controlKeys | Where-Object { -not $H[$_] })
if ($missing.Count) {
    # the teacher is using GOE on another tab: not an error, the calendar tries again later
    if (-not $Force -and (Test-GoeInFront)) {
        Hide-Main
        $result.status = 'busy'; $result.busyReason = 'in-goe'
        Publish-Result 'user-is-in-goe'; return
    }
    Hide-Main
    $result.status = 'error'; $result.reason = 'control-not-found'
    # which one, as a fixed word the calendar shows (GOE labels stay in labels.json)
    $result.detail = switch ($missing[0]) { $L.noteTab { 'note-tab' } $L.inboxButton { 'inbox-button' } $L.sentButton { 'sent-button' } default { $missing[0] } }
    Publish-Result "control-not-found:$($result.detail)"; return
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
function Format-Body([string]$Text) { ($Text -replace '\s+', ' ').Trim() }
# A list row that may be the saved note: same day, within a minute, and a sender that differs by at most
# a couple of letters (all OCR). The caller confirms with the exact body.
function Test-SameNoteRow($Row, $Note) {
    try {
        $a = [datetime]::ParseExact($Row.datetime, 'yyyy-MM-dd HH:mm', $calendar)
        $b = [datetime]::ParseExact($Note.datetime, 'yyyy-MM-dd HH:mm', $calendar)
    } catch { return $false }
    if ($a.Date -ne $b.Date -or [Math]::Abs(($a - $b).TotalMinutes) -gt 1) { return $false }
    $x = ([string]$Row.sender -replace '\s+', ''); $y = ([string]$Note.sender -replace '\s+', '')
    if (!$x -or !$y) { return $true }
    (Get-EditDistance $x $y) -le 2
}
# Press the reply button in an open note window and bring the new reply window to the front.
function Open-GoeReply($NoteEl, $Elements) {
    $button = $Elements | Where-Object { $_.Current.ClassName -eq 'Button' -and $_.Current.Name -eq $L.replyButton } | Select-Object -First 1
    if (!$button -or !$button.Current.IsEnabled) { return 'reply-unavailable' }
    $before = @{}
    foreach ($w in $AE::RootElement.FindAll($TS::Children, $pidCond)) { $before[[int64]$w.Current.NativeWindowHandle] = $true }
    Click $button.Current.NativeWindowHandle
    $sendName = [System.Windows.Automation.PropertyCondition]::new($AE::NameProperty, $L.sendButton)
    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 100
        $new = @($AE::RootElement.FindAll($TS::Children, $pidCond) | Where-Object {
            !$before.ContainsKey([int64]$_.Current.NativeWindowHandle) -and [GoeWin.W]::IsWindowVisible([IntPtr]$_.Current.NativeWindowHandle)
        })
        foreach ($window in $new) {
            if ($window.Current.ClassName -ne $L.childClass) { continue }
            $send = $window.FindFirst($TS::Descendants, $sendName)
            if (!$send -or $send.Current.ClassName -ne 'Button') { continue }
            $h = [IntPtr]$window.Current.NativeWindowHandle
            [void][GoeWin.W]::SetForegroundWindow($h)
            for ($attempt = 0; $attempt -lt 2 -and [GoeWin.W]::GetForegroundWindow() -ne $h; $attempt++) {
                [GoeWin.W]::BringReplyToFront($h)
                Start-Sleep -Milliseconds 120
            }
            if ([GoeWin.W]::GetForegroundWindow() -eq $h) { return 'opened' }
            return 'opened-background'
        }
    }
    'reply-unconfirmed'
}
function Close-Note($n) {
    if (-not $n) { return }
    $handle = [IntPtr]$n.Current.NativeWindowHandle
    # moved off screen by the keeper while GOE is parked: hide it and put it back before closing
    [GoeWin.Keeper]::PutBack($handle)
    $b = $n.FindAll($TS::Descendants, $TRUE_COND) | Where-Object { $_.Current.ClassName -eq 'Button' -and $_.Current.Name -eq $L.closeButton } | Select-Object -Last 1
    if ($b) { Click $b.Current.NativeWindowHandle }
    $t0 = Get-Date; while ([GoeWin.W]::IsWindow($handle) -and ((Get-Date) - $t0).TotalSeconds -lt 3) { Start-Sleep -Milliseconds 100 }
    # still open: the next note would stop the run as "a note window is open". Ask the window to close once more.
    if ([GoeWin.W]::IsWindow($handle)) {
        [void][GoeWin.W]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        $t0 = Get-Date; while ([GoeWin.W]::IsWindow($handle) -and ((Get-Date) - $t0).TotalSeconds -lt 2) { Start-Sleep -Milliseconds 100 }
    }
}

if ((-not $Force -and (Goe-IsForeground)) -or (Get-NoteWindow)) {
    # tell the calendar why: an open note window blocks even a forced run
    $result.busyReason = if (Get-NoteWindow) { 'note-open' } else { 'in-goe' }
    $result.status = 'busy'
    Hide-Main
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
        # moved off screen by the keeper while GOE is parked: hide it and put it back before Cancel
        [GoeWin.Keeper]::PutBack([IntPtr]$sw.Current.NativeWindowHandle)
        if ($cancel) { Click $cancel.Current.NativeWindowHandle }
        # let the settings window close before the next step (a note or a download button press follows)
        $sh = [IntPtr]$sw.Current.NativeWindowHandle; $t0 = Get-Date
        while ([GoeWin.W]::IsWindow($sh) -and [GoeWin.W]::IsWindowVisible($sh) -and ((Get-Date) - $t0).TotalSeconds -lt 2) { Start-Sleep -Milliseconds 100 }
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

# Files directly in the GOE folder, plus files in the per-note folders GOE makes when a note has several
# attachments ("<sender id>_<yyyyMMddHHmmss>0009", seen 2026-11-16). Keyed by path relative to the folder;
# Name stays the bare file name for matching.
function Download-State([string]$Directory) {
    $state = @{}
    $items = @(Get-ChildItem -LiteralPath $Directory -Force -File | ForEach-Object { @{ key = $_.Name; file = $_ } })
    foreach ($sub in Get-ChildItem -LiteralPath $Directory -Force -Directory | Where-Object {
        $_.Name -match '^[A-Za-z0-9._-]+_\d{18}$' -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }) {
        $items += @(Get-ChildItem -LiteralPath $sub.FullName -Force -File | ForEach-Object { @{ key = $sub.Name + '\' + $_.Name; file = $_ } })
    }
    foreach ($item in $items) {
        $file = $item.file
        $state[$item.key] = [pscustomobject]@{
            Key = $item.key; Name = $file.Name; FullName = $file.FullName; Extension = $file.Extension; Length = $file.Length
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

# Edit distance in C#: the GOE folder is often Downloads with hundreds of files, too slow in a PowerShell loop.
# Clipped labels are compared with the start of each file name, full labels with the whole name.
function Get-OcrDistance([string]$Label, [string]$Stem, [int]$Limit, [bool]$Whole) {
    if (-not ('GoeText' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
public static class GoeText {
  public static int Distance(string p, string s, int limit, bool whole) {
    int n = p.Length;
    if (s.Length < n - limit || (whole && s.Length > n + limit)) return int.MaxValue;
    int m = whole ? s.Length : Math.Min(s.Length, n + limit);
    int[] prev = new int[m + 1], cur = new int[m + 1];
    for (int j = 0; j <= m; j++) prev[j] = j;
    for (int i = 1; i <= n; i++) {
      cur[0] = i;
      for (int j = 1; j <= m; j++) {
        int c = p[i - 1] == s[j - 1] ? 0 : 1;
        cur[j] = Math.Min(Math.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + c);
      }
      int[] t = prev; prev = cur; cur = t;
    }
    if (whole) return prev[m];
    int best = int.MaxValue;
    for (int j = Math.Max(0, n - limit); j <= m; j++) if (prev[j] < best) best = prev[j];
    return best;
  }
}
'@
    }
    [GoeText]::Distance($Label, $Stem, $Limit, $Whole)
}
# Last resort for one label: the file whose name is closest, within 30% of the letters, and clearly closer than
# any other (3 letters or more). A long official name came back with 10 of 58 letters wrong (2026-11-19), past
# the 15% the other checks allow; the files of one document differ in a few letters, hence the margin.
function Find-ClosestAttachment([string]$Label, $Pool) {
    $clipped = ($Label -replace '\s+', '') -match '(?:\.{2,}|\u2026)$'
    $core = ($Label -replace '(?:\.{2,}|\u2026)\s*$', '').Trim()
    $ext = if (!$clipped -and $core -match '(\.[A-Za-z][A-Za-z0-9]{1,6})$') { $Matches[1] } else { '' }
    $stem = if ($ext) { $core.Substring(0, $core.Length - $ext.Length) } else { $core }
    $p = ($stem -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant()
    if ($p.Length -lt 8) { return }
    $limit = [int][Math]::Floor($p.Length * 0.3)
    $scored = @(foreach ($c in $Pool) {
        if ($ext -and $c.Extension -ne $ext) { continue }
        $s = ([IO.Path]::GetFileNameWithoutExtension($c.Name) -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant()
        $d = Get-OcrDistance $p $s $limit (!$clipped)
        if ($d -le $limit) { [pscustomobject]@{ file = $c; d = $d } }
    }) | Sort-Object d
    $scored = @($scored)
    if (!$scored.Count -or ($scored.Count -gt 1 -and $scored[1].d -lt $scored[0].d + 3)) { return }
    $scored[0].file
}

# GOE saves a note's attachments in "<sender id>_<yyyyMMddHHmmss>0009" (seen 2026-11-16..19); the time is the
# note's send time for a note sent directly (a forwarded note keeps the original's time, so this only breaks a
# tie or fills in when names and sizes are of no use). $script:noteTimes holds the list and window times.
$noteTimes = @()
function Test-NoteFolder($File) {
    if (!$script:noteTimes -or $File.Key -notmatch '^[A-Za-z0-9._-]+_(\d{12})\d{6}\\') { return $false }
    try { $t = [datetime]::ParseExact($Matches[1], 'yyyyMMddHHmm', [Globalization.CultureInfo]::InvariantCulture) } catch { return $false }
    [bool]($script:noteTimes | Where-Object { [Math]::Abs(($_ - $t).TotalMinutes) -le 1 })
}
# All files of the one GOE folder that carries this note's time, when there is exactly one such folder and it
# holds exactly the expected number of files.
function Find-NoteFolderFiles($State, [int]$Count) {
    if ($Count -le 0) { return @() }
    $own = @($State.Values | Where-Object { $_.Length -gt 0 -and (Test-NoteFolder $_) })
    $folders = @($own | ForEach-Object { Split-Path -Parent $_.Key } | Sort-Object -Unique)
    if ($folders.Count -ne 1 -or $own.Count -ne $Count) { return @() }
    @($own | Sort-Object Name)
}

# Match the attachment names read from the note window to new or changed files. A name matches one file
# or none: exact name, the same name with "(1)" added by GOE, or the start of a name GOE clipped with "...".
function Select-Attachments($Candidates, [string[]]$Names) {
    $picked = [ordered]@{}
    foreach ($raw in $Names) {
        $label = Repair-OcrName $raw
        if (!$label) { continue }
        $pool = @($Candidates | Where-Object { !$picked.Contains($_.Key) })
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
            # a short name (under 24 letters) with a letter or two misread: same extension, close spelling
            # ("<x>-ra-seu-eun" for "-on", 2026-11-18)
            if (!$found.Count -and $extension) { $found = @($pool | Where-Object { Test-SimilarName $label $_.Name }) }
        }
        if (!$found.Count) { $found = @(Find-ClosestAttachment $label $pool) }
        if ($found.Count -gt 1) { $found = @($found | Where-Object { !(Test-FromInternet $_) }) }
        if ($found.Count -gt 1) { $own = @($found | Where-Object { Test-NoteFolder $_ }); if ($own.Count -eq 1) { $found = $own } }
        if ($found.Count -eq 1) { $picked[$found[0].Key] = $found[0] }
    }
    @($picked.Values)
}

# The GOE folder may be a busy one such as Downloads, so files the note does not name are ignored.
function Get-DownloadBatch($Before, $After, $Previous, [int]$Count, [string[]]$Names) {
    $changed = @($After.Values | Where-Object { !(Test-SameDownloadFile $Before[$_.Key] $_) })
    $partial = @($changed | Where-Object { $_.Extension -in '.tmp', '.part', '.partial', '.crdownload', '.download' })
    $candidates = @($changed | Where-Object {
        $_ -notin $partial -and $_.Length -gt 0 -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    })
    $files = @(Select-Attachments $candidates $Names)
    if ($files.Count -lt $Count -and !$partial.Count) {
        # Names unreadable: accept only when exactly the expected number of files appeared and nothing else changed.
        $plain = @($candidates | Where-Object { !(Test-FromInternet $_) })
        if ($plain.Count -eq $Count -and $changed.Count -eq $Count) { $files = $plain }
        # something else changed in a busy folder at the same time: the files in GOE's folder for this note
        elseif ($script:noteTimes) {
            $own = @($plain | Where-Object { Test-NoteFolder $_ })
            if ($own.Count -eq $Count) { $files = $own }
        }
    }
    if ($Count -gt 0 -and $files.Count -eq $Count -and !($files | Where-Object { !(Test-SameDownloadFile $_ $Previous[$_.Key]) })) {
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

# OCR puts characters a file name cannot hold into names ("x|sx" for xlsx, "Z*Ei"), which made the path
# functions throw and the whole attachment match fail (2026-11-19, a 10-file note). It also reads the file-type
# icon in front of a name as one letter. Clean both before a name is used or saved.
function Repair-OcrName([string]$Name) {
    $n = ($Name -replace '\|', 'l' -replace '[<>:"/\\?*\x00-\x1f]', '').Trim()
    if ($n -match '^\S\s+\S') { $n = $n -replace '^\S\s+', '' }
    $n
}
function Read-AttachmentNames($Lines, $Header, [int]$Count, $NextRow) {
    # "|" for l first, so an extension like "x|sx" is still seen as one
    $clean = @($Lines | ForEach-Object { [pscustomobject]@{ x = $_.x; y = $_.y; t = ([string]$_.t -replace '\|', 'l') } })
    @(Read-AttachmentNamesRaw $clean $Header $Count $NextRow | ForEach-Object { Repair-OcrName $_ } | Where-Object { $_ })
}
function Read-AttachmentNamesRaw($Lines, $Header, [int]$Count, $NextRow) {
    if (-not $Header) { return }
    $sizeSuffix = '\s*[\(\[]?\s*[\d.,]+\s*(?:KB|MB|GB|B)\s*[\)\]]?\s*$'
    # A wide note window lays several files side by side in one row, so read every line between the header and
    # the recipients row, not only the left column (2026-11-16).
    $lastY = if ($NextRow) { $NextRow.y - 5 } else { $Header.y + 50 + 32 * [Math]::Max(0, $Count - 1) }
    foreach ($line in $Lines | Where-Object { $_.y -ge $Header.y + 20 -and $_.y -le $lastY } | Sort-Object y, x) {
        # garbage after the extension (a misread size) is dropped: "name.png 92 <x" -> "name.png"
        if ($line.t -match '^(?<n>.+?\.[A-Za-z][A-Za-z0-9]{1,6})\s+\S{0,3}\s*\S{0,3}$' -and $line.t -notmatch $sizeSuffix) {
            $Matches.n.Trim(); continue
        }
        if ($line.t -match $sizeSuffix) {
            $name = ($line.t -replace $sizeSuffix, '').Trim()
            if ($name) { $name }
        } elseif ($line.t -match '(?:\.{2,}|\u2026)(?:\s+\S{1,4}){0,2}\s*$') {
            # GOE clips long attachment labels with an ellipsis (OCR sometimes reads only two dots). A misread size
            # may follow it ("... 19 <x", 2026-11-18): drop that.
            $name = ($line.t -replace '(?:\.{2,}|\u2026)(?:\s+\S{1,4}){0,2}\s*$', '...').Trim()
            if (($name -replace '\s+', '').Length -ge 15) { $name }
        } elseif ($line.t -match '\.[a-z][a-z0-9]{1,7}\s*$') {
            $line.t.Trim()
        }
    }
}

# The attachment rows read again in black and white (about 0.2 s, only for notes with attachments). Lines come
# back in window pixels like Read-Window's, so Read-AttachmentNames can read them the same way.
function Read-AttachmentBand($Bmp, $Header, $NextRow, [int]$Count) {
    if (-not $Header -or -not $Bmp) { return @() }
    $y0 = [Math]::Min($Bmp.Height - 1, $Header.y + 14)
    $y1 = if ($NextRow) { $NextRow.y - 2 } else { $Header.y + 70 + 32 * [Math]::Max(0, $Count - 1) }
    $y1 = [Math]::Min($Bmp.Height, $y1)
    if ($y1 - $y0 -lt 10) { return @() }
    $view = Read-OcrRegion $Bmp ([Drawing.Rectangle]::new(0, $y0, $Bmp.Width, $y1 - $y0)) 3 -Mono
    @($view.result.Lines | ForEach-Object {
        $b = @($_.Words)[0].BoundingRect
        [pscustomobject]@{ x = [int]($b.X / $view.scaleX); y = $y0 + [int]($b.Y / $view.scaleY); t = $_.Text }
    } | Where-Object { ($_.t -replace '[^\p{L}]', '').Length -ge 3 } | Sort-Object y, x)
}

# Sizes shown next to each attachment ("... .hwp 173 KB"), with how far the rounding may be off.
function Read-AttachmentSizes($Lines, $Header, [int]$Count) {
    if (-not $Header) { return }
    $lastY = $Header.y + 50 + 32 * [Math]::Max(0, $Count - 1)
    $band = @($Lines | Where-Object { $_.y -ge $Header.y + 20 -and $_.y -le $lastY })
    $sizeOnly = '^\s*[\(\[]?\s*\d[\d,]*(?:\.\d+)?\s*(?:KB|MB|GB|B)\s*[\)\]]?\s*$'
    foreach ($line in $band) {
        $text = $line.t
        if ($text -match $sizeOnly) {
            # OCR can read the size as a line of its own beside the name ("96 KB" right of "(picture1).png",
            # 2026-11-18): give it the name on the same row
            $nameLine = $band | Where-Object { $_.t -notmatch $sizeOnly -and $_.x -lt $line.x -and [Math]::Abs($_.y - $line.y) -le 8 } |
                Sort-Object { [Math]::Abs($_.y - $line.y) } | Select-Object -First 1
            if (!$nameLine) { continue }
            $text = $nameLine.t + ' ' + $text
        } elseif ($line.x -ge 110) { continue }
        if ($text -notmatch '^(?<name>.+?)\s*[\(\[]?\s*(?<value>\d[\d,]*(?:\.(?<dec>\d+))?)\s*(?<unit>KB|MB|GB|B)\s*[\)\]]?\s*$') { continue }
        $unit = @{ B = 1; KB = 1024; MB = 1048576; GB = 1073741824 }[$Matches.unit.ToUpperInvariant()]
        $step = [Math]::Pow(10, -$Matches.dec.Length) * $unit
        [pscustomobject]@{
            name = Repair-OcrName $Matches.name
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
    # OCR reads the file-type icon in front of the name as one letter ("<x> (picture1).png", 2026-11-18): also
    # try the label without a one-letter first word
    $labels = @($Label -replace '\|', 'l' -replace '[<>:"/\\?*\x00-\x1f]', '')
    if ($labels[0] -match '^\s*\S\s+\S') { $labels += ($labels[0] -replace '^\s*\S\s+', '') }
    foreach ($one in $labels) {
        $expected = $one -replace '\s+', ''
        if ($expected.EndsWith('...')) { if (Test-AttachmentPrefix $expected $FileName) { return $true }; continue }
        if ([IO.Path]::GetExtension($expected) -ne [IO.Path]::GetExtension($FileName)) { continue }
        # l, I and | are the same stroke to OCR as 1; O as 0
        $a = ([IO.Path]::GetFileNameWithoutExtension($expected) -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant() -replace '[LI]', '1' -replace 'O', '0'
        $b = ([IO.Path]::GetFileNameWithoutExtension($FileName) -replace '\(\d+\)$' -replace '[^\p{L}\p{Nd}]', '').ToUpperInvariant() -replace '[LI]', '1' -replace 'O', '0'
        if (!$a -or !$b) { continue }
        if ((Get-EditDistance $a $b) -le [Math]::Max(1, [Math]::Floor($a.Length * 0.2))) { return $true }
    }
    $false
}

# GOE silently skips an attachment whose file name already exists in its folder (seen 2026-11-16), which is
# common when the folder is Downloads. Use the existing file only when exactly one file there has a similar
# name and the size shown in the note window.
function Find-ExistingAttachments($State, $Sizes, [string[]]$Taken) {
    $picked = [ordered]@{}
    foreach ($entry in $Sizes) {
        $found = @($State.Values | Where-Object {
            $_.Key -notin $Taken -and !$picked.Contains($_.Key) -and $_.Length -gt 0 -and
            !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            [Math]::Abs($_.Length - $entry.size) -le $entry.tolerance -and (Test-SimilarName $entry.name $_.Name)
        })
        if ($found.Count -gt 1) { $found = @($found | Where-Object { !(Test-FromInternet $_) }) }
        if ($found.Count -gt 1) { $own = @($found | Where-Object { Test-NoteFolder $_ }); if ($own.Count -eq 1) { $found = $own } }
        if ($found.Count -ne 1) { return @() }
        $picked[$found[0].Key] = $found[0]
    }
    @($picked.Values)
}

# GOE skipped every file and the window shows no sizes (only 2 of 8 clipped names were visible, 2026-11-17).
# An earlier download wrote the whole set into one folder within a second or two, so take the file a visible
# name points to and every file written into the same folder around the same time. Accept only the exact count.
function Find-ExistingBatch($State, [int]$Count, [string[]]$Names) {
    if ($Count -le 0) { return @() }
    $pool = @($State.Values | Where-Object { $_.Length -gt 0 -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    $anchors = @(Select-Attachments $pool $Names)
    if (!$anchors.Count) { return @() }
    $folder = Split-Path -Parent $anchors[0].Key
    if ($anchors | Where-Object { (Split-Path -Parent $_.Key) -ne $folder }) { return @() }
    $times = @($anchors | ForEach-Object { $_.LastWriteTimeUtc } | Sort-Object)
    if (($times[-1] - $times[0]).TotalSeconds -gt 60) { return @() }
    $from = $times[0].AddSeconds(-60); $to = $times[-1].AddSeconds(60)
    $group = @($pool | Where-Object {
        (Split-Path -Parent $_.Key) -eq $folder -and $_.LastWriteTimeUtc -ge $from -and $_.LastWriteTimeUtc -le $to
    })
    if ($group.Count -gt $Count) { $group = @($group | Where-Object { !(Test-FromInternet $_) }) }
    if ($group.Count -gt $Count) {
        # something else was saved at the same time: keep the files whose names start like the visible one
        $lead = ([IO.Path]::GetFileNameWithoutExtension($anchors[0].Name) -replace '[^\p{L}\p{Nd}]', '')
        $lead = $lead.Substring(0, [Math]::Min(10, $lead.Length))
        $group = @($group | Where-Object { ($_.Name -replace '[^\p{L}\p{Nd}]', '').StartsWith($lead, [StringComparison]::Ordinal) })
    }
    if ($group.Count -ne $Count -or ($anchors | Where-Object { $_ -notin $group })) { return @() }
    $group | Sort-Object Name
}

function Receive-Downloads($Elements, [string]$Directory, [int]$Count, [string[]]$Names, $Sizes) {
    if (!$Directory) { return @{ status = 'folder-not-configured' } }
    $Names = @($Names | Where-Object { $_ })
    if ($Count -le 0) { $Count = $Names.Count }
    if ($Count -le 0 -or (Goe-IsForeground)) { return @{ status = 'review' } }
    $button = $Elements | Where-Object { $_.Current.Name -eq $L.downloadAll } | Select-Object -First 1
    if (!$button) { return @{ status = 'failed'; step = 'no-button' } }
    # a menu left open (by GOE or a cut-off run) made the press fail; close it first
    $stale = Find-GoeMenu
    if ($stale -ne [IntPtr]::Zero) { Key $stale 0x1B; Start-Sleep -Milliseconds 300 }
    if ((Find-GoeMenu) -ne [IntPtr]::Zero) { return @{ status = 'failed'; step = 'menu-busy' } }
    [void][GoeWin.W]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
    $t0 = Get-Date
    do {
        Start-Sleep -Milliseconds 80
        $menu = Find-GoeMenu
    } while ($menu -eq [IntPtr]::Zero -and ((Get-Date) - $t0).TotalSeconds -lt 3)
    if ($menu -eq [IntPtr]::Zero) { return @{ status = 'failed'; step = 'menu-not-shown' } }
    if (Goe-IsForeground) { return @{ status = 'review' } }
    # The menu window can show before its items are filled in (empty text): wait for them instead of failing.
    $t0 = Get-Date
    do {
        $menuHandle = [GoeWin.W]::SendMessage($menu, 0x01E1, [IntPtr]::Zero, [IntPtr]::Zero)
        $first = if ($menuHandle -ne [IntPtr]::Zero) { [GoeWin.W]::MenuItem($menuHandle, 0) } else { '' }
        if ($first) { break }
        Start-Sleep -Milliseconds 100
    } while (((Get-Date) - $t0).TotalSeconds -lt 1.5)
    if ($first -ne $L.menuDefault) { Key $menu 0x1B; return @{ status = 'failed'; step = $(if ($first) { 'menu-item-other' } else { 'menu-item-empty' }) } }

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
    $lastChange = -1
    do {
        Start-Sleep -Milliseconds 300
        if (Goe-IsForeground) { return @{ status = 'review' } }
        if ((Get-PhysicalDirectory $Directory) -ne $Directory) { return @{ status = 'review' } }
        $current = Download-State $Directory
        # any file appearing or growing since the last look: a large attachment on a slow school network is
        # still coming in, so keep waiting past 15 s (up to 2 minutes) while it does (2026-11-19)
        if ($previous.Count -and @($current.Values | Where-Object { !(Test-SameDownloadFile $previous[$_.Key] $_) -and !(Test-SameDownloadFile $before[$_.Key] $_) }).Count) {
            $lastChange = $timer.ElapsedMilliseconds
        }
        $batch = Get-DownloadBatch $before $current $previous $Count $Names
        if ($batch.status -eq 'complete') {
            if ($stableSince -lt 0) { $stableSince = $timer.ElapsedMilliseconds }
            if ($timer.ElapsedMilliseconds - $stableSince -ge 900) {
                return @{ status = 'complete'; files = $batch.files; directory = $Directory }
            }
        } else { $stableSince = -1 }
        $previous = $current
        $growing = $lastChange -ge 0 -and $timer.ElapsedMilliseconds - $lastChange -lt 5000
    } while ($timer.Elapsed.TotalSeconds -lt 15 -or ($growing -and $timer.Elapsed.TotalSeconds -lt 120))
    $Sizes = @($Sizes | Where-Object { $_ })
    if ($Sizes.Count -eq $Count) {
        # some or all attachments were skipped because a file of that name was already there
        $changed = @($current.Values | Where-Object {
            !(Test-SameDownloadFile $before[$_.Key] $_) -and $_.Length -gt 0 -and
            $_.Extension -notin '.tmp', '.part', '.partial', '.crdownload', '.download'
        })
        $new = @(Select-Attachments $changed $Names | Where-Object { Test-SameDownloadFile $_ $previous[$_.Key] })
        $rest = @($Sizes | Where-Object { $entry = $_; !($new | Where-Object { Test-SimilarName $entry.name $_.Name }) })
        $old = @(Find-ExistingAttachments $current $rest @($changed | ForEach-Object Key))
        if ($rest.Count -and $new.Count + $old.Count -eq $Count) {
            return @{ status = 'complete'; files = @($new) + @($old); directory = $Directory }
        }
    }
    $changedAny = @($current.Values | Where-Object { !(Test-SameDownloadFile $before[$_.Key] $_) })
    if (!$changedAny.Count) {
        $old = @(Find-ExistingBatch $current $Count $Names)
        if ($old.Count -eq $Count) { return @{ status = 'complete'; files = $old; directory = $Directory } }
        # names and sizes no help (a common name such as "(picture1).png" in 16 folders): GOE's own folder for
        # this note, named by the send time
        $old = @(Find-NoteFolderFiles $current $Count)
        if ($old.Count -eq $Count) { return @{ status = 'complete'; files = $old; directory = $Directory } }
    }
    if ($batch.activity -or $stableSince -ge 0) { return @{ status = 'review'; step = 'files-unmatched' } }
    @{ status = 'failed'; step = 'nothing-downloaded' }
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
        # 2026-11-18: a 2-file note failed on the first automatic try with nothing written to the GOE folder,
        # and the same note downloaded fine on "download again". When nothing was downloaded, press once more.
        if ($batch.status -eq 'failed' -and $batch.step -ne 'no-button') {
            $first = $batch.step
            Start-Sleep -Milliseconds 800
            $batch = Receive-Downloads $Elements $Directory $Count $Names $Sizes
            if ($batch.status -ne 'complete') { $batch.step = "$first,then-$($batch.step)" }
        }
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
                if ($note.datetime -and $note.ocr.listTitle -and $note.placeholder -ne $true) {
                    $savedRow = [pscustomobject]@{ datetime = $note.datetime; sender = $note.sender; titleOcr = $note.ocr.listTitle }
                    $known[(Row-Key $savedRow)] = $true
                }
            } catch {}
        }
        $rowKeys[$Row.datetime] = $known
    }
    $rowKeys[$Row.datetime].ContainsKey($Key)
}
# A read row is treated as saved when a saved note of that day is within a minute, has a close sender and a
# close list title (all OCR); otherwise the same read note would be opened again on every run.
$dayNotes = @{}
function Known-RowLoose($Row) {
    $day = $Row.datetime.Substring(0, 10) -replace '\D', ''
    if (-not $dayNotes.ContainsKey($day)) {
        $dayNotes[$day] = @(foreach ($file in Get-ChildItem -LiteralPath $notesDir -Filter "goe_${day}*.json" -File -ErrorAction SilentlyContinue) {
            try { Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json } catch {}
        })
    }
    $title = [string]$Row.titleOcr -replace '\s+', ''
    foreach ($note in $dayNotes[$day]) {
        if ($note.placeholder -eq $true -or -not (Test-SameNoteRow $Row $note)) { continue }
        $saved = [string]$note.ocr.listTitle -replace '\s+', ''
        if (!$title -or !$saved -or (Get-EditDistance $title $saved) -le [Math]::Max(2, [int]($saved.Length / 5))) { return $true }
    }
    return $false
}
# A read row whose list OCR came out a little different from the saved note: the exact body tells.
function Test-SavedBody([string]$Datetime, [string]$Body) {
    $stamp = $Datetime -replace '\D', ''
    $wanted = Format-Body $Body
    foreach ($file in Get-ChildItem -LiteralPath $notesDir -Filter "goe_${stamp}_*.json" -File -ErrorAction SilentlyContinue) {
        try { if ((Format-Body (Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json).body) -ceq $wanted) { return $true } } catch {}
    }
    return $false
}
# A note opened but not read (no window, no body control, empty body) still goes to the calendar as a
# placeholder from its list row, so nothing is lost when GOE has already marked it read (2026-11-18, same rule
# as Brity: "the calendar must get it either way"). The real note later takes over the placeholder's id, so the
# calendar's task turns into the real note. After three tries the automatic run stops reopening it.
function Find-Placeholder($Row) {
    $day = $Row.datetime.Substring(0, 10) -replace '\D', ''
    $title = [string]$Row.titleOcr -replace '\s+', ''
    foreach ($file in Get-ChildItem -LiteralPath $notesDir -Filter "goe_${day}*.json" -File -ErrorAction SilentlyContinue) {
        try { $p = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json } catch { continue }
        if ($p.placeholder -ne $true -or $p.id -cne $file.BaseName -or -not (Test-SameNoteRow $Row $p)) { continue }
        $saved = [string]$p.ocr.listTitle -replace '\s+', ''
        if (!$title -or !$saved -or (Get-EditDistance $title $saved) -le [Math]::Max(2, [int]($saved.Length / 5))) { return $p }
    }
}
function Write-Placeholder($Row, $Existing, [string]$Why) {
    if ($Existing) { $pid8 = $Existing.id; $attempts = [int]$Existing.readAttempts + 1 }
    else {
        $hash = [Security.Cryptography.SHA1]::Create()
        try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes('placeholder|' + (Row-Key $Row)))) }
        finally { $hash.Dispose() }
        $pid8 = 'goe_' + ($Row.datetime -replace '\D', '') + '_' + ($digest -replace '-', '').Substring(0, 8).ToLowerInvariant()
        $attempts = 1
    }
    $target = Join-Path $notesDir ($pid8 + '.json')
    if (!$Existing -and [IO.File]::Exists($target)) { return }
    $listed = (@($Row.titleOcr, $Row.sender, $Row.datetime) | Where-Object { $_ }) -join ' / '
    $record = [pscustomobject]@{
        id = $pid8; source = 'goe'; verified = $false; placeholder = $true; readAttempts = $attempts; readFailure = $Why
        datetimeCheck = 'note-time-unread'; datetimeNote = $null; attachCount = 0
        attachStatus = $(if ($Row.attach) { 'review' } else { 'none' })
        wasUnread = $Row.unread; openedByAssistant = $true; collectedAt = (Get-Date).ToString('s')
        title = [string]$Row.titleOcr; sender = [string]$Row.sender; org = ''; datetime = $Row.datetime
        recipients = ''; files = @(); saved = @(); body = $L.placeholderBody + "`n`n" + $L.placeholderList + ': ' + $listed
        ocr = [pscustomobject]@{ sentLine = ''; attachLine = ''; listTitle = $Row.titleOcr }
    }
    if ($RangeImport) { $record | Add-Member -NotePropertyName imported -NotePropertyValue 'range' }
    try { Write-Note $record $target ([bool]$Existing); $script:result.placeholders++ } catch {}
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

# show the main window without activating it (put back at the end; $wasMin/$wasHidden are taken where GOE is found)
$widenedFrom = $null
function Restore-Main {
    if ($widenedFrom) {
        $o = $widenedFrom
        [void][GoeWin.W]::SetWindowPos($main, [IntPtr]::Zero, $o.L, $o.T, $o.Rt - $o.L, $o.B - $o.T, 0x14)
        $script:widenedFrom = $null
    }
    if ($script:parked) { Unpark; return }
    if (Goe-IsForeground) { return }
    if ($wasHidden) { [void][GoeWin.W]::ShowWindow($main, 0) } elseif ($wasMin) { [void][GoeWin.W]::ShowWindow($main, 7) }
}

# read the visible inbox rows: time, title, sender, unread, attachment, click y (list client)
# GOE can be busy for a moment after a folder click or while it redraws (button query times out, pane not
# settled). One 'ambiguous' look stopped the whole run (2026-11-18 review): look again for up to 2 s first.
function Wait-NotAmbiguous([scriptblock]$Look) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        $s = & $Look
        if ($s -ne 'ambiguous') { return $s }
        Start-Sleep -Milliseconds 150
    } while ($sw.ElapsedMilliseconds -lt 2000)
    $s
}
function Get-GoeScanFolder { Wait-NotAmbiguous { Get-GoeScanFolderOnce } }
function Get-GoeScanFolderOnce {
    if (-not (Test-GoeSamePane $folderProof.Pane (Get-GoeVisibleNotePane $main))) { return 'ambiguous' }
    $state = Get-GoeFolderState $inboxButtonEl $sentButtonEl
    if ($state -in 'sent', 'ambiguous') { return $state }
    if ($folderProof.State -eq 'native' -and $state -ne 'inbox') { return 'ambiguous' }
    if ($state -eq 'inbox' -or $folderProof.State -eq 'inbox') { return 'inbox' }
    'visual'
}

function Test-GoeEmptyList {
    try {
        $list = $AE::FromHandle($H.list)
        $grid = $null
        if ($list.TryGetCurrentPattern([System.Windows.Automation.GridPattern]::Pattern, [ref]$grid)) {
            return $grid.Current.RowCount -eq 0
        }
    } catch {}
    return $false
}

function Read-Rows([int]$ocrScale = 3) {
    $folder = Get-GoeScanFolder
    if ($folder -notin 'inbox','visual') { return @{ inbox = $false; rows = @() } }
    try { $cap = Read-Window $main $ocrScale } catch { throw 'list-unreadable' }
    $o = $cap.lines; $bmp = $cap.bmp
    if ($DebugOcr -and -not $script:debugSaved) {
        New-Item -ItemType Directory -Force $Inbox | Out-Null
        $bmp.Save((Join-Path $Inbox 'debug-list.png'))
        @("main=$($mr.L),$($mr.T),$($mr.Rt),$($mr.B) list=$($lr.L),$($lr.T),$($lr.Rt),$($lr.B) listTop=$listTop listRight=$listRight timeMinX=$timeMinX bmp=$($bmp.Width)x$($bmp.Height)") +
            @($o | ForEach-Object { '{0} {1} {2}' -f $_.y, $_.x, $_.t }) | Set-Content (Join-Path $Inbox 'debug-list.txt') -Encoding utf8
        $script:debugSaved = $true
    }
    $visualInbox = $false
    if ($folder -eq 'visual') {
        $header = $L.unreadHeader -replace '\s', ''
        $isInbox = [bool]($o | Where-Object { ($_.t -replace '\s', '').Contains($header) })
        $bIn = Avg-Bright $bmp ($ir.L - $mr.L + 5) ($ir.Rt - $mr.L - 5) ($ir.T - $mr.T + 3) ($ir.B - $mr.T - 3)
        $bSent = Avg-Bright $bmp ($sr.L - $mr.L + 5) ($sr.Rt - $mr.L - 5) ($sr.T - $mr.T + 3) ($sr.B - $mr.T - 3)
        $visualInbox = $isInbox -and $null -ne $bIn -and $null -ne $bSent -and $bIn -lt $bSent - 30
    }
    # A row's time is found by its "yyyy-MM-dd am/pm hh:mm" shape alone, not by where it sits, so the GOE
    # window width does not matter (a fixed column cut missed every row in a narrow window, 2026-11-16).
    # If a title also holds such text, the rightmost one on that line is the row's time.
    $timeLines = @($o | Where-Object { $_.y -ge $listTop + 5 -and $_.y -lt $listBottom - 50 -and (Parse-ListTime $_.t) } |
        Group-Object { [Math]::Round($_.y / 8) } | ForEach-Object { $_.Group | Sort-Object x -Descending | Select-Object -First 1 } |
        Sort-Object y)
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
    # A row whose time OCR failed was dropped from the list altogether (its note never came in). Rows sit one
    # pitch apart: read the time cell alone at each empty slot between, above and below the rows found.
    $rowPitch = 70 * $k
    $colX = 0; $cellH = S 24
    if ($timeLines.Count) {
        $colX = [int](@($timeLines | ForEach-Object { $_.x } | Sort-Object)[[int][Math]::Floor($timeLines.Count / 2)])
        $script:timeColX = $colX
        if (-not $script:layoutSaved -and $timeLines.Count -ge 3) { Save-ListLayout; $script:layoutSaved = $true }
        $filled = [Collections.Generic.List[object]]::new()
        $slots = [Collections.Generic.List[int]]::new()
        if ($timeLines[0].y - $rowPitch -ge $listTop + 5) { $slots.Add([int]($timeLines[0].y - $rowPitch)) }
        for ($i = 1; $i -lt $timeLines.Count; $i++) {
            $n = [int][Math]::Round(($timeLines[$i].y - $timeLines[$i - 1].y) / $rowPitch)
            for ($j = 1; $j -lt $n -and $j -lt 4; $j++) { $slots.Add([int]($timeLines[$i - 1].y + $rowPitch * $j)) }
        }
        $lastY = $timeLines[$timeLines.Count - 1].y + $rowPitch
        if ($lastY -lt $listBottom - 50) { $slots.Add([int]$lastY) }
        foreach ($y in $slots) {
            $text = Read-TimeCell $bmp ($colX - (S 10)) ($listRight - (S 4)) $y $cellH
            if ($text) { $filled.Add([pscustomobject]@{ x = $colX; y = $y; t = $text }) }
        }
        if ($filled.Count) { $timeLines = @(@($timeLines) + @($filled) | Sort-Object y) }
    }
    $rowYs = @($timeLines | ForEach-Object { $_.y })
    $rows = @(foreach ($t in $timeLines) {
        $dt = Parse-ListTime $t.t
        $top = $t.y - (S 16)
        # title and sender sit left of this row's own time text
        $title = ($o | Where-Object { [Math]::Abs($_.y - $t.y) -lt (S 6) -and $_.x -lt $t.x } | Select-Object -First 1).t
        $sender = ($o | Where-Object { $_.y -gt $t.y + (S 10) -and $_.y -lt $t.y + (S 35) -and $_.x -lt $t.x } | Select-Object -First 1).t
        # OCR may read the title and the time as one line: keep the text before the date as the title
        if (!$title) { $title = ($t.t -replace '\s*\d{4}-\d{2}-\d{2}.*$', '').Trim() }
        [pscustomobject]@{
            datetime = $dt; titleOcr = $title; sender = (Clean-Sender $sender)
            unread = ((Count-Yellow $bmp ($listRight - (S 56)) ($listRight - (S 29)) ($top + (S 40)) ($top + (S 64))) -gt (40 * $k * $k))
            attach = ((Count-Yellow $bmp ($listRight - (S 82)) ($listRight - (S 58)) ($top + (S 40)) ($top + (S 64))) -gt (20 * $k * $k))
            clickY = $top + (S 35) - $listTop
        }
    })
    # The inbox lists newest first. A time later than now, or out of order with both neighbours, is read
    # again from its cell alone; the new reading is kept only when it fits between the neighbours.
    if ($rows.Count -ge 2 -and $colX) {
        $soon = (Get-Date).AddMinutes(2).ToString('yyyy-MM-dd HH:mm')
        $down = 0; $up = 0
        for ($i = 1; $i -lt $rows.Count; $i++) { if ($rows[$i].datetime -le $rows[$i - 1].datetime) { $down++ } else { $up++ } }
        if ($down -gt $up) {
            for ($i = 0; $i -lt $rows.Count; $i++) {
                $dt = $rows[$i].datetime
                $above = if ($i -gt 0) { $rows[$i - 1].datetime } else { $soon }
                $below = if ($i -lt $rows.Count - 1) { $rows[$i + 1].datetime } else { '' }
                if ($dt -le $above -and $dt -ge $below -and $dt -le $soon) { continue }
                $text = Read-TimeCell $bmp ($colX - (S 10)) ($listRight - (S 4)) $rowYs[$i] $cellH
                $new = if ($text) { Parse-ListTime $text }
                if ($new -and $new -ne $dt -and $new -le $above -and $new -ge $below -and $new -le $soon) { $rows[$i].datetime = $new }
            }
        }
    }
    $bmp.Dispose()
    $confirmed = $folder -eq (Get-GoeScanFolder) -and ($folder -eq 'inbox' -or $visualInbox)
    $readable = $confirmed -and ($rows.Count -gt 0 -or (Test-GoeEmptyList))
    @{ inbox = $confirmed; readable = $readable; visual = $folder -eq 'visual'; rows = @($rows) }
}

# ---------- go to the inbox ----------
$seen = @{}
$seenRows = [Collections.Generic.List[object]]::new()
$opened = [Collections.Generic.List[object]]::new()
$ownedNote = $null
Mark 'controls found'
try {
    # (a window both hidden and minimized was already parked as a tray window above)
    if ($wasMin -and -not $script:parked) {
        # A minimized GOE showed on screen for the whole read (2026-11-17 case check). Restore it right of all
        # screens instead (SetWindowPlacement, no activation; it keeps its taskbar button as a minimized window
        # does) and minimize it back at its own place in Unpark. goe-parked.json covers a cut-off run.
        # GOE may move a window restored off screen back to 0,0 by itself (2026-11-17, within 50 ms): the keeper
        # moves it out again, and the restore animation is turned off so nothing is drawn on the way.
        $n = [GoeWin.Style]::GetNormal($main)
        [IO.Directory]::CreateDirectory($Inbox) | Out-Null
        $script:parked = [pscustomobject]@{ Min = $true; L = $n[0]; T = $n[1]; R = $n[2]; B = $n[3]; Ex = [GoeWin.Style]::GetWindowLong($main, -20) }
        $script:parked | ConvertTo-Json -Compress | Set-Content -LiteralPath $parkFile -Encoding ascii
        $vs = Get-VirtualScreen
        [GoeWin.Style]::NoAnimation($main, $true)
        if (-not $Reply) { [GoeWin.Keeper]::Start($proc.Id, $vs.Left, $vs.Top, $vs.Right, $vs.Bottom) }
        [void][GoeWin.Style]::SetNormal($main, $vs.Right + 200, $vs.Top, $vs.Right + 200 + ($n[2] - $n[0]), $vs.Top + ($n[3] - $n[1]), 4)
        $t0 = Get-Date
        while ([GoeWin.W]::IsIconic($main) -and ((Get-Date) - $t0).TotalSeconds -lt 3) { Start-Sleep -Milliseconds 100 }
        Start-Sleep -Milliseconds 300
    }
    # A small GOE window squeezes the inbox/sent buttons (300 px wide) or shows too few rows to page through
    # (420 px high) (2026-11-16). Enlarge it to GOE's usual size only while reading, without moving or
    # activating it; Restore-Main puts the size back. PrintWindow reads it even if it runs off screen.
    $mr = Get-Rect $main
    if ($mr.Rt - $mr.L -lt 360 -or $mr.B - $mr.T -lt 585) {
        $script:widenedFrom = $mr
        [void][GoeWin.W]::SetWindowPos($main, [IntPtr]::Zero, $mr.L, $mr.T,
            [Math]::Max(360, $mr.Rt - $mr.L), [Math]::Max(585, $mr.B - $mr.T), 0x14)
        Start-Sleep -Milliseconds 400
    }

    # the folder state is checked (and waited for) right after, so short pauses are enough here
    Click $H[$L.noteTab]; Start-Sleep -Milliseconds 120; Click $H[$L.inboxButton]; Start-Sleep -Milliseconds 120
    $inboxButtonEl = $AE::FromHandle($H[$L.inboxButton])
    $sentButtonEl = $AE::FromHandle($H[$L.sentButton])
    $state = Wait-NotAmbiguous { Get-GoeFolderState $inboxButtonEl $sentButtonEl }
    Mark "folder state: $state"
    if ($state -eq 'sent' -and ($Force -or -not (Goe-IsForeground))) {
        # the inbox click did not take yet: press it once more
        Click $H[$L.inboxButton]; Start-Sleep -Milliseconds 400
        $state = Wait-NotAmbiguous { Get-GoeFolderState $inboxButtonEl $sentButtonEl }
    }
    if ($state -eq 'unsupported') {
        $folderProof = Get-GoeInboxPaneProof $main { Click $H[$L.sentButton] } { Click $H[$L.inboxButton] } {
            ($Force -or -not (Goe-IsForeground)) -and -not (Get-NoteWindow)
        }
        if ($folderProof.State -eq 'busy') { throw 'folder-busy' }
    } elseif ($state -eq 'inbox') {
        $folderProof = @{ State = 'native'; Pane = (Wait-GoeNotePane $main) }
    } else { throw 'inbox-not-confirmed' }
    if (-not $folderProof.Pane) { throw 'inbox-not-confirmed' }
    Mark "folder proof: $($folderProof.State)"
    $H.list = $folderProof.Pane.List
    $H.scroll = $folderProof.Pane.Scroll
    Reset-ListScroll
    $mr = Get-Rect $main; $lr = Get-Rect $H.list; $ir = Get-Rect $H[$L.inboxButton]; $sr = Get-Rect $H[$L.sentButton]
    $listTop = $lr.T - $mr.T; $listBottom = $lr.B - $mr.T; $listLeft = $lr.L - $mr.L; $listRight = $lr.Rt - $mr.L
    $timeMinX = $listLeft + [int](($listRight - $listLeft) * 0.4)  # debug output only

    Mark 'inbox confirmed, list at top'
    $view = $null; $retryUntil = $null; $listOcrScale = 3
    # Reply / download again with a known layout: the first page from the time column alone (about 0.4 s instead of
    # a full-window OCR). Only when the inbox was proven by its own pane; anything unread is still skipped.
    if ($retryNote -and (Use-ListLayout) -and (Get-GoeScanFolder) -eq 'inbox') {
        Start-Sleep -Milliseconds 150
        $quick = @(Read-ListTimes -Rows | Where-Object { $_ })
        if ($quick.Count) { $view = @{ inbox = $true; readable = $true; visual = $false; rows = $quick }; Mark "first page from the time column ($($quick.Count) rows)" }
    }
    if (-not $view) { do {
        # The same small header can be legible at 2x but misread at 3x.
        if ($view -and -not $view.readable) { $listOcrScale = if ($listOcrScale -eq 3) { 2 } else { 3 } }
        Start-Sleep -Milliseconds 300
        $view = Read-Rows $listOcrScale
        if (-not $retryUntil) { $retryUntil = (Get-Date).AddSeconds(4) }
    } while (-not $view.readable -and (Get-Date) -lt $retryUntil) }
    if (-not $view.inbox) { throw 'inbox-not-confirmed' }
    if (-not $view.readable) { throw 'list-unreadable' }
    Mark "first page read ($(@($view.rows).Count) rows)"

    # Reply / download again: the note's time is known, so go there first reading only the time column and moving
    # about a page per step, then read rows normally from there. A step that goes past the note's time goes back up
    # (2026-11-19, "8 s is not good enough, the old one far too slow").
    if ($retryNote -and @($view.rows).Count) {
        $target = $retryNote.datetime
        $times = @($view.rows | ForEach-Object { $_.datetime } | Where-Object { $_ })
        $prevMin = ($times | Sort-Object)[0]; $prevMax = ($times | Sort-Object)[-1]
        $visible = [Math]::Max(4, $times.Count)
        $ticks = 6; $moves = 0
        while ($prevMin -gt $target -and $moves -lt $MaxPages) {
            Scroll-List $ticks; Start-Sleep -Milliseconds 200; $moves++
            $new = @(Read-ListTimes | Where-Object { $_ })
            if (!$new.Count) { break }
            $newMin = ($new | Sort-Object)[0]; $newMax = ($new | Sort-Object)[-1]
            Mark "  step $moves ($ticks ticks): $($new.Count) times $newMax .. $newMin"
            if ($newMin -eq $prevMin -and $newMax -eq $prevMax) { break }   # end of the list
            # Rows skipped between two steps are all newer than what is now shown; that only matters when the note
            # could be among them, i.e. when its time is above the newest row now shown.
            if ($newMax -lt $target) {
                # moved past the note: go back half a step and read from there
                Scroll-List (-[int][Math]::Ceiling($ticks / 2)); Start-Sleep -Milliseconds 200
                break
            }
            $moved = @($new | Where-Object { $_ -lt $prevMin }).Count
            if ($moved -gt 0) {
                $perTick = $moved / $ticks
                $ticks = [Math]::Min(40, [Math]::Max(6, [int][Math]::Floor(($visible - 2) / $perTick)))
            }
            $prevMin = $newMin; $prevMax = $newMax
        }
        Mark "seek: $moves steps, last step $ticks ticks"
        if ($moves) {
            $view = Read-Rows $listOcrScale
            if (-not $view.inbox) { throw 'inbox-lost-while-paging' }
            if (-not $view.readable) { throw 'list-unreadable' }
            # the note must not sit above the rows now shown
            for ($up = 0; $up -lt 3 -and @($view.rows).Count -and (@($view.rows | ForEach-Object { $_.datetime }) | Sort-Object)[-1] -lt $target; $up++) {
                Scroll-List (-[Math]::Max(6, [int]($ticks / 2))); Start-Sleep -Milliseconds 300
                $view = Read-Rows $listOcrScale
                if (-not $view.inbox) { throw 'inbox-lost-while-paging' }
                if (-not $view.readable) { throw 'list-unreadable' }
            }
            Mark "rows read at the note's time ($(@($view.rows).Count) rows)"
        }
    }

    if (-not $ListOnly) { [void][IO.Directory]::CreateDirectory($notesDir) }
    $dlDir = $null
    $checkedDownloadDir = $false

    # If the time-column shortcut misses (OCR or unread-first order), start a full scan once.
    $retryFullScan = $retryNote -and ($quick.Count -gt 0 -or $moves -gt 0)
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
            if ($r.datetime -le $latestPlausible -and (-not $newestRow -or $r.datetime -gt $newestRow)) { $newestRow = $r.datetime }
            $newRead = $readSince -and -not $r.unread -and $r.datetime -ge $readSince
            # GOE can sort unread notes as a group before read notes, so an old row does not end the date range.
            if (($since -and $day -lt $since) -or ($To -and $day -gt $To)) { continue }
            if ($retryNote) {
                # The list is read by OCR, so the same row can come back with a letter or a minute different
                # from the first import ("teacher" read one syllable off, 2026-11-16: reply mostly "not found").
                # Pick rows loosely here; the note body (read exactly) decides below.
                if ($r.unread -or !(Test-SameNoteRow $r $retryNote)) { continue }
            } elseif ((-not $r.unread -and -not $IncludeRead -and -not $newRead) -or ($AttachOnly -and -not $r.attach)) { continue }
            $result.matched++
            if (!$retryNote -and ($IncludeRead -or $newRead) -and (Known-Row $r $key)) { continue }
            if ($newRead -and (Known-RowLoose $r)) { continue }
            $placeholder = if (!$retryNote) { Find-Placeholder $r }
            # tried three times already: leave it in the calendar as "check in GOE" instead of reopening every run
            if ($placeholder -and [int]$placeholder.readAttempts -ge 3 -and -not $range) { continue }
            $result.fresh++
            if ($ListOnly) { continue }
            if ($result.opened -ge $Max) { $result.remaining++; $stop = $true; break }
            if ((-not $Force -and (Goe-IsForeground)) -or (Get-NoteWindow)) {
                $result.busyReason = if (Get-NoteWindow) { 'note-open' } else { 'in-goe' }
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

            if ($view.visual) {
                $current = Read-Rows $listOcrScale
                if (-not $current.inbox -or -not ($current.rows | Where-Object { $_.clickY -eq $r.clickY -and (Row-Key $_) -eq $key })) { throw 'inbox-lost-while-paging' }
            } elseif ((Get-GoeScanFolder) -ne 'inbox') { throw 'inbox-lost-while-paging' }
            Mark "open row $($r.datetime)"
            DoubleClick $H.list 150 $r.clickY
            $n = $null; $t0 = Get-Date
            while (-not $n -and ((Get-Date) - $t0).TotalSeconds -lt 4) { Start-Sleep -Milliseconds 100; $n = Get-NoteWindow }
            $result.opened++
            if (-not $n) {
                $result.unknown++
                if (!$retryNote) { Write-Placeholder $r $placeholder 'window-not-opened' }
                continue
            }
            $ownedNote = $n
            $nh = [IntPtr]$n.Current.NativeWindowHandle
            $els = $n.FindAll($TS::Descendants, $TRUE_COND)
            $re = $els | Where-Object { $_.Current.ClassName -eq 'RICHEDIT50W' } | Select-Object -First 1
            if (-not $re) {
                $result.unknown++
                if (!$retryNote) { Write-Placeholder $r $placeholder 'no-body-control' }
                Close-Note $ownedNote
                $ownedNote = $null
                continue
            }
            $body = ''; $t0 = Get-Date
            do { $body = [GoeWin.W]::Text([IntPtr]$re.Current.NativeWindowHandle); if ($body -and $body -ne $prevBody) { break }; Start-Sleep -Milliseconds 80 } while (((Get-Date) - $t0).TotalSeconds -lt 2)
            $prevBody = $body
            Mark 'note body read'
            if ($Reply -and $retryNote) {
                # a reply needs only the exact body to know it is the right note: no OCR of the note window (1.2 s)
                if ($body -and (Format-Body $body) -ceq (Format-Body $retryNote.body)) {
                    $result.reply = Open-GoeReply $n $els
                    Mark "reply $($result.reply)"
                    # Leave the matched note available when GOE cannot show the compose window.
                    $stop = $true; $ownedNote = $null
                    break
                }
                Close-Note $ownedNote; $ownedNote = $null
                continue
            }
            if (!$body -and !$retryNote) {
                # an empty body is saved as nothing: keep the placeholder and read it again next time
                $result.unknown++
                Write-Placeholder $r $placeholder 'body-empty'
                Close-Note $ownedNote
                $ownedNote = $null
                continue
            }

            $cap = Read-Window $nh; $nl = $cap.lines
            if ($DebugOcr) {
                $cap.bmp.Save((Join-Path $Inbox 'debug-note.png'))
                @($nl | ForEach-Object { '{0} {1} {2}' -f $_.y, $_.x, $_.t }) | Set-Content (Join-Path $Inbox 'debug-note.txt') -Encoding utf8
            }
            $noteBmp = $cap.bmp   # kept for the black-and-white pass over the attachment names below
            $sentRow = $nl | Where-Object { $_.t -match $L.sentTimeWord -and $_.y -lt 150 } | Select-Object -First 1
            $sentLine = $sentRow.t
            # the title line sits between the window caption and the sent-time line
            $title = ''
            if ($sentRow) { $title = ($nl | Where-Object { $_.y -gt 35 -and $_.y -lt $sentRow.y - 15 -and $_.x -lt 300 } | Select-Object -First 1).t }
            if (-not $title) { $title = $r.titleOcr }
            # Both titles are OCR. A missing title made the note "unverified" and kept it from being classified
            # although the body (read exactly) was there (2026-11-18): take the first body line instead.
            if (-not $title) {
                $line = @($body -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ })[0]
                if ($line) { $title = $line.Substring(0, [Math]::Min(60, $line.Length)) }
            }
            $recLine = ($nl | Where-Object { $_.t -match $L.recipientHeader } | Select-Object -First 1).t
            if ($recLine) { $recLine = $recLine.Substring($recLine.IndexOf($L.recipientHeader)) }
            # The attachment header is a short line below the body ("1^1 <attachments> (3<unit>)"); a body sentence
            # that mentions attachments is longer, so take the last short match (2026-11-16, 27 notes misread).
            $attachHeader = $nl | Where-Object { $_.t -match $L.attachHeader -and $_.t.Trim().Length -le 24 } | Select-Object -Last 1
            $attLine = $attachHeader.t
            $attCount = 0
            # the count may carry a unit after the number, e.g. "(3" + unit + ")"
            if ($attLine -match '\(\s*(\d{1,3})\s*\D{0,2}\)') { $attCount = [int]$Matches[1] }
            $recipientRow = $nl | Where-Object { $attachHeader -and $_.y -gt $attachHeader.y -and $_.t -match $L.recipientHeader } | Select-Object -First 1
            $fileNames = @(Read-AttachmentNames $nl $attachHeader $attCount $recipientRow)
            $fileSizes = @(Read-AttachmentSizes $nl $attachHeader $attCount)
            # Names decide which file in the GOE folder is this note's, so read them once more in black and white
            # and keep whichever reading found more names (black and white wins a tie: it misread fewer letters).
            if ($attachHeader -and ($attCount -gt 0 -or $r.attach -or $fileNames.Count)) {
                try {
                    $bwNames = @(Read-AttachmentNames (Read-AttachmentBand $noteBmp $attachHeader $recipientRow $attCount) $attachHeader $attCount $recipientRow)
                    if ($bwNames.Count -ge $fileNames.Count -and $bwNames.Count -gt 0) { $fileNames = $bwNames }
                } catch {}
            }
            $noteBmp.Dispose(); $noteBmp = $null
            # GOE shows the attachment header and its download button on every note, even one without files
            # (2026-11-17), so only a count, a file name or the list row's clip icon means there are attachments.
            $hasAttachments = $attCount -gt 0 -or $fileNames.Count -gt 0 -or $r.attach
            if ($DebugOcr) {
                $dl = $els | Where-Object { $_.Current.Name -eq $L.downloadAll } | Select-Object -First 1
                $kids = if ($attachHeader) { @($els | Where-Object { $_.Current.BoundingRectangle.Y -gt 0 }).Count } else { -1 }
                Add-Content (Join-Path $Inbox 'debug-note.txt') ("listClip={0} headerRead={1} count={2} names={3} sizes={4} downloadButton={5} enabled={6} elements={7}" -f
                    $r.attach, [bool]$attachHeader, $attCount, $fileNames.Count, $fileSizes.Count, [bool]$dl, $(if ($dl) { $dl.Current.IsEnabled } else { '' }), $kids) -Encoding utf8
            }

            $hash = [Security.Cryptography.SHA1]::Create()
            try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($r.sender + '|' + $body))) }
            finally { $hash.Dispose() }
            $id = 'goe_' + ($r.datetime -replace '\D', '') + '_' + ($digest -replace '-', '').Substring(0, 8).ToLowerInvariant()
            $notePath = Join-Path $notesDir ($id + '.json')
            # read at last: the real note replaces the placeholder under the placeholder's id
            $takeOver = $placeholder -and !$retryNote -and ![IO.File]::Exists($notePath)
            if ($takeOver) { $id = $placeholder.id; $notePath = Join-Path $notesDir ($id + '.json') }

            # the time is read twice (list row and note window); both are OCR, so flag when they disagree
            $sentDt = Parse-SentTime $sentLine
            # both readings of the send time (list and note window, both OCR) for GOE's per-note folder
            $script:noteTimes = @(@($r.datetime, $sentDt) | Where-Object { $_ } | Sort-Object -Unique | ForEach-Object {
                [datetime]::ParseExact($_, 'yyyy-MM-dd HH:mm', $calendar) })
            $dtCheck = if (-not $sentDt) { 'note-time-unread' } elseif ($sentDt -eq $r.datetime) { 'match' } else { 'mismatch' }
            if ($sentDt -and [datetime]::ParseExact($sentDt, 'yyyy-MM-dd HH:mm', $calendar) -lt $attachmentCutoff) { $expired = $true }
            # After the storage period the list row keeps its clip icon but the file list is empty and the header
            # has no count (seen on 11/11 notes, 2026-11-16): nothing can be downloaded any more.
            # Expiry is decided by the date alone (GOE keeps attachments 7 days). A clip icon with nothing read in the
            # note window marked fresh notes expired (2026-11-17/18: four notes a day old, none had files when
            # reopened): within 7 days that is "review", which the calendar can retry.
            $attachUnread = $r.attach -and $attCount -eq 0 -and $fileNames.Count -eq 0
            $attachStatus = if (!$hasAttachments) { 'none' } elseif ($expired) { 'expired' } elseif ($attachUnread) { 'review' } else { 'not-requested' }
            $note = [pscustomobject]@{
                id = $id; source = 'goe'; verified = [bool]($body -and $r.datetime)
                datetimeCheck = $dtCheck; datetimeNote = $sentDt; attachCount = $attCount; attachStatus = $attachStatus
                wasUnread = $r.unread; openedByAssistant = $true; collectedAt = (Get-Date).ToString('s')
                title = $title; sender = $r.sender; org = ''; datetime = $r.datetime
                recipients = $recLine; files = $fileNames; saved = @(); body = $body
                ocr = [pscustomobject]@{ sentLine = $sentLine; attachLine = $attLine; listTitle = $r.titleOcr
                    attachSizes = @($fileSizes | ForEach-Object { [pscustomobject]@{ name = $_.name; size = [int64]$_.size } }) }
            }
            # the saved note is found by its exact body (the id also hashes the OCR'd sender, which can differ)
            $sameNote = $retryNote -and $note.verified -and ((Format-Body $body) -ceq (Format-Body $retryNote.body))
            if ($sameNote) { $id = $RetryId; $notePath = Join-Path $notesDir ($id + '.json') }
            if ($sameNote) {
                $result.attached = Get-SavedAttachmentCount $retryNote
                if ($expired) {
                    $result.attachStatus = 'expired'
                    # remember it, so the calendar stops offering "download again" for this note
                    if ($retryNote.attachStatus -ne 'saved' -and $retryNote.attachStatus -ne 'expired') {
                        $updated = [ordered]@{}
                        foreach ($prop in $retryNote.PSObject.Properties) { $updated[$prop.Name] = $prop.Value }
                        $updated.attachStatus = 'expired'
                        try { Write-Note ([pscustomobject]$updated) $notePath $true } catch {}
                    }
                }
                elseif (!$hasAttachments) {
                    # no clip icon, no count, no file name: the note has none. Record it, so an older "review" or
                    # "expired" left by an earlier version stops asking the teacher to check (2026-11-18).
                    $result.attachStatus = 'none'
                    if ($result.attached -eq 0 -and $retryNote.attachStatus -ne 'none') {
                        $updated = [ordered]@{}
                        foreach ($prop in $retryNote.PSObject.Properties) { $updated[$prop.Name] = $prop.Value }
                        $updated.attachStatus = 'none'; $updated.attachCount = 0
                        try { Write-Note ([pscustomobject]$updated) $notePath $true } catch { $result.attachStatus = 'review' }
                    }
                }
                elseif ($attCount -gt 0 -and $result.attached -eq $attCount) { $result.attachStatus = 'already-saved' }
                else {
                    # OCR of the note window can miss the attachment list; fall back to what the first import read
                    $retryNames = if ($fileNames.Count) { $fileNames } else { @($retryNote.files | Where-Object { $_ }) }
                    $retryCount = if ($attCount -gt 0) { $attCount } else { [int]$retryNote.attachCount }
                    $savedBatch = Collect-NoteAttachments $els $dlDir $retryCount $retryNames $fileSizes $retryNote $notePath $true
                    $result.attachStatus = $savedBatch.status
                    if ($savedBatch.step) { $result.attachDetail = $savedBatch.step }
                    if ($savedBatch.status -eq 'saved') { $result.attached = @($savedBatch.note.saved).Count }
                }
                $stop = $true
            } elseif (!$retryNote -and ($takeOver -or ![IO.File]::Exists($notePath)) -and !($newRead -and (Test-SavedBody $r.datetime $body))) {
                if ($RangeImport) { $note | Add-Member -NotePropertyName imported -NotePropertyValue 'range' }
                if ($Download -and $hasAttachments -and !$expired -and !$attachUnread) {
                    if (!$note.verified) { $note.attachStatus = 'review' }
                    else {
                        $savedBatch = Collect-NoteAttachments $els $dlDir $attCount $fileNames $fileSizes $note $notePath ([bool]$takeOver)
                        if ($savedBatch.status -eq 'saved') { $note = $savedBatch.note }
                        else {
                            $note.attachStatus = $savedBatch.status
                            # which step went wrong, so the next failure can be traced (not shown to the teacher)
                            if ($savedBatch.step) { $note | Add-Member -NotePropertyName attachDetail -NotePropertyValue $savedBatch.step -Force }
                        }
                    }
                }
                if ($note.attachStatus -ne 'saved') { Write-Note $note $notePath ([bool]$takeOver) }
                $result.imported++
                $opened.Add($note)
            }
            if ([GoeWin.W]::IsWindow($nh)) { Close-Note $ownedNote }
            $ownedNote = $null
            if ($stop) { break }
        }
        if ($stop) { break }
        if ($retryFullScan) {
            if ((Goe-IsForeground) -or (Get-NoteWindow)) { throw 'folder-busy' }
            $retryFullScan = $false
            Reset-ListScroll
            $view = Read-Rows $listOcrScale
            if (!$view.inbox) { throw 'inbox-lost-while-paging' }
            if (!$view.readable) { throw 'list-unreadable' }
            $seen.Clear()
            Mark 'target not confirmed, resuming normal scan from top'
            continue
        }
        if ($page -ge $MaxPages) { break }
        if (-not $Force -and (Goe-IsForeground)) { $result.status = 'busy'; $result.busyReason = 'in-goe'; break }
        # PageDown leaves a half-cut row at the top that OCR misses: scroll ~4 rows with the wheel so pages overlap
        $before = ($view.rows | ForEach-Object { Row-Key $_ }) -join [Environment]::NewLine
        $wlp = [IntPtr](($lr.T + 100) * 65536 + ($lr.L + 150))
        for ($i = 0; $i -lt 6; $i++) { [void][GoeWin.W]::PostMessage($H.list, 0x020A, [IntPtr]((-120 -band 0xFFFF) -shl 16), $wlp); Start-Sleep -Milliseconds 60 }
        Start-Sleep -Milliseconds 600; $page++
        $view = Read-Rows $listOcrScale
        Mark "page $page read ($(@($view.rows).Count) rows, oldest $(@($view.rows)[-1].datetime))"
        if (-not $view.inbox) { throw 'inbox-lost-while-paging' }
        if (-not $view.readable) { throw 'list-unreadable' }
        if ((($view.rows | ForEach-Object { Row-Key $_ }) -join [Environment]::NewLine) -eq $before) { break }
    }
} catch {
    $result.status = 'error'
    $reason = if ($_.Exception.Message -in 'inbox-not-confirmed', 'inbox-lost-while-paging', 'list-unreadable') {
        $_.Exception.Message
    } elseif ($_.Exception.Message -eq 'folder-busy') {
        $result.status = 'busy'
        $result.busyReason = if (Get-NoteWindow) { 'note-open' } else { 'in-goe' }
        'user-is-in-goe'
    } else {
        'collection-failed:' + $_.InvocationInfo.ScriptLineNumber
    }
    $result.reason = $reason
} finally {
    try {
        try { if ($ownedNote) { Close-Note $ownedNote } }
        finally { Restore-Main }
    } catch {
        $result.status = 'error'
        $reason = 'restore-failed'
        $result.reason = $reason
    }
}

# Remember the newest list time only after a pass that did not stop early (busy, error, -Max reached):
# rows it skipped would sit below that time and never be looked at again.
if ($watchRead -and $newestRow -and $result.status -eq 'ok' -and $result.remaining -eq 0 -and $result.unknown -eq 0 -and
    (-not $readSince -or $newestRow -gt $readSince)) {
    try {
        [void][IO.Directory]::CreateDirectory($Inbox)
        [IO.File]::WriteAllText($tickStatePath, ([pscustomobject]@{ readSince = $newestRow } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    } catch {}
}
if (-not $ResultObject -and (Test-Path -LiteralPath $Inbox)) {
    [pscustomobject]@{ collectedAt = (Get-Date).ToString('s'); list = $seenRows.ToArray(); opened = $opened.ToArray() } |
        ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Inbox 'latest.json') -Encoding utf8
}
Publish-Result $reason
