param(
    [switch]$Open,       # open unread notes and read the body (the app marks them as read)
    [switch]$Download,   # with -Open / -Id: also save attachments
    [string[]]$Id,       # open these note ids regardless of read state
    [switch]$ShowNote,   # read JSON {id,title,sender,datetime} from stdin and open that note in Brity
    [switch]$Reply,      # with -ShowNote: also open Brity's reply window
    [int]$Max = 20,
    [string]$From,       # yyyy-MM-dd: open notes in this date range among those visible in the list (read or unread)
    [string]$To,         #   skips notes already saved (state.json). Older notes may not be visible at all.
    [switch]$ListOnly,   # with -From/-To: only count matching notes, open nothing
    [string]$Inbox = (Join-Path $PSScriptRoot 'inbox'),
    [switch]$FunctionsOnly,
    [string]$DiagnosticReadId,
    [scriptblock]$Observe
)
# Reads Brity Messenger notes through Windows UI Automation (the screen-reader channel).
# No screenshots, no mouse, no keyboard. Buttons are run by name with InvokePattern.
# Exception: Brity's classic view opens a note only on a double click, posted to the page as window messages
# (the pointer does not move); see "Classic view" below.
# Keep this file ASCII only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
# All Korean UI labels live in labels.json (edit there when the app renames something).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$L  = Get-Content (Join-Path $PSScriptRoot 'labels.json') -Raw -Encoding utf8 | ConvertFrom-Json
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]

$brityWinSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace BrityWin {
    public static class Finder {
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int command);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
        // Top-level windows (hidden ones too) of the given processes with the given title.
        public static IntPtr[] Find(int[] pids, string title) {
            var found = new List<IntPtr>();
            EnumWindows((h, l) => {
                uint pid; GetWindowThreadProcessId(h, out pid);
                if (Array.IndexOf(pids, (int)pid) >= 0) {
                    var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
                    if (sb.ToString() == title) found.Add(h);
                }
                return true;
            }, IntPtr.Zero);
            return found.ToArray();
        }

        // Classic view support (2026-11-18): the note opens in its own window on a double click only.
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
        [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
        [StructLayout(LayoutKind.Sequential)] struct Placement { public int len, flags, show, minX, minY, maxX, maxY, l, t, r, b; }
        [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref Placement p);
        [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref Placement p);
        public static int[] GetNormal(IntPtr h) {
            var p = new Placement(); p.len = Marshal.SizeOf(p); GetWindowPlacement(h, ref p);
            return new int[] { p.l, p.t, p.r, p.b, p.show };
        }
        public static bool SetNormal(IntPtr h, int l, int t, int r, int b, int show) {
            var p = new Placement(); p.len = Marshal.SizeOf(p); GetWindowPlacement(h, ref p);
            p.l = l; p.t = t; p.r = r; p.b = b; p.show = show; p.flags = 0;
            return SetWindowPlacement(h, ref p);
        }
        public static uint ProcessOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
        // The Chromium page inside an Electron window takes the mouse messages.
        public static IntPtr PageWidget(IntPtr top) {
            IntPtr found = IntPtr.Zero;
            EnumChildWindows(top, (h, l) => {
                var sb = new StringBuilder(64); GetClassName(h, sb, 64);
                if (sb.ToString() == "Chrome_RenderWidgetHostHWND") { found = h; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }
        // Posted messages: the real mouse pointer does not move and nothing is typed.
        public static void DoubleClick(IntPtr h, int x, int y) {
            IntPtr at = (IntPtr)((y << 16) | (x & 0xFFFF));
            PostMessage(h, 0x0200, IntPtr.Zero, at);
            PostMessage(h, 0x0201, (IntPtr)1, at); PostMessage(h, 0x0202, IntPtr.Zero, at);
            PostMessage(h, 0x0203, (IntPtr)1, at); PostMessage(h, 0x0202, IntPtr.Zero, at);
        }
    }

    // Opening a row (Invoke, Select or the double click) makes Brity take the foreground, and in classic view a
    // note window pops up in the middle of the screen (measured 2026-11-18). For a few seconds after each opening
    // this thread moves new Brity windows right of all screens and gives the focus back to the window the teacher
    // was using. Windows that were already on screen and anything after the armed time are left alone, so the
    // teacher can still open Brity on purpose.
    public static class Keeper {
        delegate bool Cb(IntPtr h, IntPtr l);
        [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
        [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
        [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public int x, y; }
        [DllImport("user32.dll")] static extern bool PeekMessage(out Msg m, IntPtr h, uint a, uint b, uint remove);
        [StructLayout(LayoutKind.Sequential)] struct MouseIn { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public MouseIn mi; }
        [DllImport("user32.dll")] static extern uint SendInput(uint n, Input[] i, int size);
        static System.Threading.Thread thread;
        static volatile bool running;
        static int[] pids = new int[0];
        static IntPtr back = IntPtr.Zero;
        static long armedUntil;
        static readonly object gate = new object();
        static readonly HashSet<long> skip = new HashSet<long>();
        public static int Moves, Refocused, RefocusFailed;
        // The main window, its state when the run started (0 hidden, 1 minimized, 2 shown) and, once the keeper has had
        // to move it out (Brity raises it when a note opens), where it was: Stop puts it back, or the teacher would find
        // Brity open but off every screen (seen 2026-11-18).
        static IntPtr main = IntPtr.Zero; static int mainState = 2; static bool mainMoved; static R mainRect;
        public static void Start(int[] processIds, long[] onScreen, IntPtr restoreTo, IntPtr mainWindow, int mainStartState) {
            Stop();
            pids = processIds; back = restoreTo; Moves = 0; Refocused = 0; RefocusFailed = 0; armedUntil = 0;
            main = mainWindow; mainState = mainStartState; mainMoved = false;
            lock (gate) { skip.Clear(); foreach (var h in onScreen) skip.Add(h); }
            running = true;
            thread = new System.Threading.Thread(Loop) { IsBackground = true };
            thread.Start();
        }
        public static void Arm(int milliseconds) { armedUntil = DateTime.UtcNow.AddMilliseconds(milliseconds).Ticks; }
        public static void Stop() {
            running = false; if (thread != null) { thread.Join(1000); thread = null; }
            if (mainMoved && IsWindow(main)) {
                SetWindowPos(main, IntPtr.Zero, mainRect.L, mainRect.T, 0, 0, 0x15);
                if (mainState == 0) ShowWindow(main, 0); else if (mainState == 1) ShowWindow(main, 7);
            }
            mainMoved = false;
        }
        static bool Ours(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return Array.IndexOf(pids, (int)p) >= 0; }
        static void Loop() {
            try { SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch {}
            Msg msg; PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);   // a message queue: AttachThreadInput needs one
            long lastRefocus = 0;
            while (running) {
                if (DateTime.UtcNow.Ticks < armedUntil) {
                    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
                    int right = left + GetSystemMetrics(78), bottom = top + GetSystemMetrics(79);
                    EnumWindows((h, l) => {
                        if (!Ours(h) || !IsWindowVisible(h) || IsIconic(h)) return true;
                        lock (gate) { if (skip.Contains((long)h)) return true; }
                        R x; GetWindowRect(h, out x);
                        if (x.L >= right || x.Rt <= left || x.T >= bottom || x.B <= top) return true;
                        if (h == main && !mainMoved) { mainRect = x; mainMoved = true; }
                        // Brity does not keep this place: its next note window opens in the middle again.
                        SetWindowPos(h, IntPtr.Zero, right + 200, top, 0, 0, 0x15);
                        Moves++;
                        return true;
                    }, IntPtr.Zero);
                    IntPtr fg = GetForegroundWindow();
                    if (back != IntPtr.Zero && fg != back && Ours(fg) &&
                        DateTime.UtcNow.Ticks - lastRefocus > TimeSpan.TicksPerMillisecond * 40) {
                        lastRefocus = DateTime.UtcNow.Ticks;
                        if (GiveBack(back)) Refocused++; else RefocusFailed++;
                    }
                }
                System.Threading.Thread.Sleep(5);
            }
        }
        // Windows lets the foreground thread hand the focus on; joining its input queue for a moment makes that us.
        // If that is refused, a zero mouse move (the pointer stays put) makes us the last input and allows it.
        // No key is sent (an Alt press would reach the teacher's program).
        public static bool GiveBack(IntPtr to) {
            if (to == IntPtr.Zero || !IsWindow(to)) return false;
            IntPtr fg = GetForegroundWindow();
            uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero), me = GetCurrentThreadId();
            bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
            SetForegroundWindow(to);
            if (attached) AttachThreadInput(me, fgThread, false);
            if (GetForegroundWindow() == to) return true;
            var input = new Input[1]; input[0].type = 0; input[0].mi.flags = 0x0001;   // MOUSEEVENTF_MOVE, 0 by 0
            SendInput(1, input, Marshal.SizeOf(typeof(Input)));
            SetForegroundWindow(to);
            return GetForegroundWindow() == to;
        }
    }
}
'@
# Compiling this on every run costs about 0.45 s (measured 2026-11-12), so keep the compiled DLL per source hash.
# Any problem with the cache falls back to compiling in memory.
try {
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($brityWinSource))[0..7] | ForEach-Object { $_.ToString('x2') })
    $cacheDir = Join-Path $env:LOCALAPPDATA 'BrityAssistant'
    $dll = Join-Path $cacheDir "BrityWin-$hash.dll"
    if (-not (Test-Path -LiteralPath $dll)) {
        New-Item -ItemType Directory -Force $cacheDir | Out-Null
        $tmp = "$dll.$PID.tmp"
        Add-Type -TypeDefinition $brityWinSource -OutputAssembly $tmp -OutputType Library
        try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
    }
    Add-Type -Path $dll
} catch {
    Add-Type -TypeDefinition $brityWinSource
}

function New-Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function Norm([string]$s) { if ($null -eq $s) { return '' }; return ($s -replace '\s+', ' ').Trim() }

function Get-AppWindow([switch]$MainOnly) {
    $processes = Get-Process $L.processName -ErrorAction SilentlyContinue
    if ($MainOnly) {
        $processes = $processes | Where-Object SessionId -eq ([Diagnostics.Process]::GetCurrentProcess().SessionId)
    }
    $ids = @($processes.Id | Where-Object { $_ })
    if ($ids.Count -eq 0) { return $null }
    $first = $null
    foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($ids -contains $w.Current.ProcessId) {
            if ($w.Current.Name -eq $L.windowTitle) { return $w }
            if (-not $first) { $first = $w }
        }
    }
    if ($first -and -not $MainOnly) { return $first }
    # Closed to the tray: the window is hidden, so it is not under the desktop root. Reach it by handle.
    foreach ($h in [BrityWin.Finder]::Find([int[]]$ids, $L.windowTitle)) {
        try { return $AE::FromHandle($h) } catch {}
    }
    return $null
}

function Get-ComposeHandles {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $processes = @(Get-Process $L.processName -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)
    if ($processes.Count) {
        [BrityWin.Finder]::Find([int[]]$processes.Id, $L.composeWindow) | Where-Object { [BrityWin.Finder]::IsWindowVisible($_) }
    }
}

function Test-NoteHeader($detail, $note) {
    return $detail -and (Norm $detail.sender) -ceq (Norm $note.sender) -and
        (Norm $detail.datetime) -ceq (Norm $note.datetime) -and (Norm $detail.title) -ceq (Norm $note.title)
}

# Reply buttons named like the label: exact, with spaces around it, or with an ending such as "Reply (R)".
# A name that only contains the label elsewhere (for example "reply all") does not count.
function Find-ReplyButtons($root) {
    $found = @()
    $label = Norm $L.replyButton
    foreach ($b in $root.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Button))) {
        $n = Norm $b.Current.Name
        if ($n -ceq $label -or ($n.StartsWith($label) -and $n.Length -gt $label.Length -and $n[$label.Length] -match '[\s(\[]')) {
            $found += $b
        }
    }
    return $found
}

# The note is already shown in Brity when this runs. Every failure here still leaves it on screen.
function Open-ReplyComposer($win, $note, $detailGroup) {
    if (@(Get-ComposeHandles).Count) { return 'reply-in-use' }
    # The button can draw a moment after the detail pane, and can sit outside it (a toolbar above).
    $replyButton = $null
    # Short polls everywhere below: each lookup takes about 20 ms (measured 2026-11-12), the wait was the cost.
    for ($i = 0; $i -lt 30 -and -not $replyButton; $i++) {
        if ($i) { Start-Sleep -Milliseconds 100 }
        $detail = Read-Detail $win
        if ($detail) { $detailGroup = $detail.group }
        $buttons = @()
        if ($detailGroup) { $buttons = @(Find-ReplyButtons $detailGroup) }
        if (-not $buttons.Count) { $buttons = @(Find-ReplyButtons $win) }
        if ($buttons.Count -eq 1 -and $buttons[0].Current.IsEnabled) { $replyButton = $buttons[0] }
    }
    if (-not $replyButton) { return 'reply-unavailable' }
    if (-not (Test-NoteHeader (Read-Detail $win) $note)) { return 'unverified' }
    if (-not (Invoke-El $replyButton)) { return 'reply-unavailable' }

    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 100
        $handles = @(Get-ComposeHandles)
        if ($handles.Count -gt 1) { return 'reply-in-use' }
        if ($handles.Count -eq 1) {
            $compose = $AE::FromHandle($handles[0])
            $form = Find-ByName $compose $CT::Group $L.composeWindow
            if ($form -and (Find-ByName $form $CT::Edit $L.composeSubject)) {
                if ([BrityWin.Finder]::GetForegroundWindow() -ne $handles[0]) {
                    [void][BrityWin.Finder]::SetForegroundWindow($handles[0])
                }
                if ([BrityWin.Finder]::GetForegroundWindow() -eq $handles[0]) { return 'opened' }
                return 'opened-background'
            }
        }
    }
    return 'reply-unconfirmed'
}

function Show-OriginalNote($note, [switch]$Reply) {
    if ($note.id -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' -or
        -not (Norm $note.sender) -or -not (Norm $note.datetime) -or -not (Norm $note.title)) { return 'unavailable' }

    $mutex = [Threading.Mutex]::new($false, 'Local\BrityAssistantWatch')
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { return 'busy' }
        # A compose window already open: still show the note; Open-ReplyComposer reports reply-in-use.
        $win = Get-AppWindow -MainOnly
        if (-not $win) { return 'offline' }
        $handle = [IntPtr]$win.Current.NativeWindowHandle
        if ($handle -eq [IntPtr]::Zero) { return 'unavailable' }
        if ([BrityWin.Finder]::IsIconic($handle) -or -not [BrityWin.Finder]::IsWindowVisible($handle)) {
            [void][BrityWin.Finder]::ShowWindowAsync($handle, 9)
        }
        for ($i = 0; $i -lt 20 -and [BrityWin.Finder]::GetForegroundWindow() -ne $handle; $i++) {
            [void][BrityWin.Finder]::SetForegroundWindow($handle)
            Start-Sleep -Milliseconds 50
        }
        $list = Find-ByName $win $CT::List $L.noteListName
        if (-not $list) {
            $menu = Find-ByName $win $CT::Button $L.noteMenu
            if (-not $menu -or -not (Invoke-El $menu)) { return 'unavailable' }
            for ($i = 0; $i -lt 40 -and -not (Find-ByName $win $CT::List $L.noteListName); $i++) { Start-Sleep -Milliseconds 150 }
        }
        # An older note is not on screen: scroll the list to it.
        [void](Find-NoteRow $win $note.id)
        $rowCondition = [System.Windows.Automation.AndCondition]::new(
            (New-Cond $AE::ControlTypeProperty $CT::ListItem),
            (New-Cond $AE::AutomationIdProperty $note.id)
        )
        $invoked = $false
        $before = @((Get-BrityWindows) | ForEach-Object { $_.Current.NativeWindowHandle })
        $doubleClicked = $false
        for ($i = 0; $i -lt 60; $i++) {
            $list = Find-ByName $win $CT::List $L.noteListName
            if ($list) {
                $rows = $list.FindAll($TS::Descendants, $rowCondition)
                if ($rows.Count -gt 1) { return 'not-found' }
                if ($rows.Count -eq 1) {
                    $row = $rows.Item(0)
                    $name = Norm $row.Current.Name
                    if (-not $name.Contains((Norm $note.sender)) -or -not $name.Contains((Norm $note.title))) { return 'not-found' }
                    if (-not $invoked -or $i -in 20, 40) { $invoked = Invoke-El $row }
                    $detail = Read-Detail $win
                    # Classic view: nothing in the main window, so open (and show) the note's own window.
                    if (-not $detail -and $invoked -and $i -ge 8) {
                        foreach ($w in (Get-NewNoteWindows $win $before)) {
                            $wd = Read-Detail $w
                            if (Test-NoteHeader $wd $note) {
                                $wh = [IntPtr]$w.Current.NativeWindowHandle
                                if ($Reply) { return (Open-ReplyComposer $w $note $wd.group) }
                                if ([BrityWin.Finder]::GetForegroundWindow() -ne $wh) { [void][BrityWin.Finder]::SetForegroundWindow($wh) }
                                if ([BrityWin.Finder]::GetForegroundWindow() -eq $wh) { return 'opened' }
                                return 'opened-background'
                            }
                        }
                        if (-not $doubleClicked -or ($i -in 30, 45 -and -not (Get-NewNoteWindows $win $before).Count)) {
                            $doubleClicked = (Open-NoteWindow $win $note.id) -or $doubleClicked
                        }
                    }
                    if ($invoked -and (Test-NoteHeader $detail $note)) {
                        if ($Reply) { return (Open-ReplyComposer $win $note $detail.group) }
                        if ([BrityWin.Finder]::GetForegroundWindow() -eq $handle) { return 'opened' }
                        return 'opened-background'
                    }
                }
            }
            Start-Sleep -Milliseconds 120
        }
        if ($invoked) { return 'unverified' }
        return 'not-found'
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Find-ByName($root, $type, [string]$pattern) {
    foreach ($e in $root.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $type))) {
        if ($e.Current.Name -like $pattern) { return $e }
    }
    return $null
}

function Invoke-El($el) {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
    return $false
}

# Some list rows expose SelectionItem instead of Invoke. Also try selection
# on a retry if an accepted Invoke did not bring up the requested note.
function Open-NoteRow($row, [switch]$PreferSelect) {
    if ($DiagnosticReadId) {
        $name = Norm $row.Current.Name
        if ($row.Current.AutomationId -cne $DiagnosticReadId -or -not $name -or $name.StartsWith($L.unreadPrefix)) {
            & $Observe 'action' 'guard-skipped'
            return $false
        }
    }
    if (-not $PreferSelect) {
        try { if (Invoke-El $row) { if ($DiagnosticReadId) { & $Observe 'action' 'Invoke' }; return $true } } catch [InvalidOperationException] {}
    }
    try {
        $selection = $null
        if ($row.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
            $selection.Select()
            if ($DiagnosticReadId) { & $Observe 'action' 'Select' }
            return $true
        }
    } catch [InvalidOperationException] {}
    if ($PreferSelect) {
        try { if (Invoke-El $row) { if ($DiagnosticReadId) { & $Observe 'action' 'Invoke' }; return $true } } catch [InvalidOperationException] {}
    }
    if ($DiagnosticReadId) { & $Observe 'action' 'unavailable' }
    return $false
}

function Get-NoteItems($list) {
    $items = New-Object System.Collections.ArrayList
    foreach ($e in $list.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::ListItem))) {
        $n = Norm $e.Current.Name
        $unread = $n.StartsWith($L.unreadPrefix)
        $text = $n
        if ($unread) { $text = $n.Substring($L.unreadPrefix.Length).TrimStart(',', ' ') }
        [void]$items.Add([pscustomobject]@{
            id      = $e.Current.AutomationId
            unread  = $unread
            hasFile = ($n -like ('*, ' + $L.attachWord + ',*'))
            text    = $text
        })
    }
    return $items
}

# The note list is virtual: UI Automation exposes only the 10 or so rows on screen (measured 2026-11-12).
# ScrollItemPattern on the edge row brings the next rows in, about a second later. There is no ScrollPattern.
function Get-NoteRows($win) {
    $list = Find-ByName $win $CT::List $L.noteListName
    if (-not $list) { return @() }
    return @($list.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::ListItem)))
}

# One step down (or up). True when the edge row changed, false at the end of the list.
function Move-NoteList($win, [switch]$Up) {
    try {
        $rows = Get-NoteRows $win
        if (-not $rows.Count) { return $false }
        $edge = if ($Up) { $rows[0] } else { $rows[-1] }
        $edgeId = $edge.Current.AutomationId
        $p = $null
        if (-not $edge.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$p)) { return $false }
        $p.ScrollIntoView()
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Milliseconds 260
            $rows = Get-NoteRows $win
            if ($rows.Count) {
                $now = if ($Up) { $rows[0] } else { $rows[-1] }
                if ($now.Current.AutomationId -ne $edgeId) { return $true }
            }
        }
    } catch {}
    return $false
}

function Reset-NoteList($win) {
    for ($i = 0; $i -lt 400; $i++) { if (-not (Move-NoteList $win -Up)) { return } }
}

# Every note in the list, newest first, read by scrolling down. With -Since (yyyy-MM-dd) stop once the rows on
# screen are all older than that day. Leaves the list scrolled down: call Reset-NoteList when done.
function Get-AllNoteItems($win, [string]$Since) {
    $seen = [ordered]@{}
    for ($i = 0; $i -lt 400; $i++) {
        $list = Find-ByName $win $CT::List $L.noteListName
        if (-not $list) { break }
        $batch = @(Get-NoteItems $list)
        foreach ($it in $batch) { if (-not $seen.Contains($it.id)) { $seen[$it.id] = $it } }
        if ($Since -and $batch.Count) {
            $older = @($batch | Where-Object { $d = Get-ListDate $_.text; $d -and ($d -lt $Since) })
            if ($older.Count -eq $batch.Count) { break }
        }
        if (-not (Move-NoteList $win)) { break }
    }
    return @($seen.Values)
}

# The list from the top down to the first note in $Saved (or rows all older than $Since), then back to the top.
function Get-NoteItemsUntilSaved($win, $Saved, [string]$Since) {
    $seen = [ordered]@{}
    $scrolled = $false
    for ($i = 0; $i -lt 60; $i++) {
        $list = Find-ByName $win $CT::List $L.noteListName
        if (-not $list) { break }
        $batch = @(Get-NoteItems $list)
        foreach ($it in $batch) { if (-not $seen.Contains($it.id)) { $seen[$it.id] = $it } }
        if (@($batch | Where-Object { $Saved -contains $_.id }).Count) { break }
        if ($Since -and $batch.Count) {
            $older = @($batch | Where-Object { $d = Get-ListDate $_.text; $d -and ($d -lt $Since) })
            if ($older.Count -eq $batch.Count) { break }
        }
        if (-not (Move-NoteList $win)) { break }
        $scrolled = $true
    }
    if ($scrolled) { Reset-NoteList $win }
    return @($seen.Values)
}

# The row of one note, scrolling to it when it is not on screen.
function Get-VisibleNoteRow($win, [string]$id) {
    $list = Find-ByName $win $CT::List $L.noteListName
    if (-not $list -or -not $id) { return $null }
    $cond = [System.Windows.Automation.AndCondition]::new(
        (New-Cond $AE::AutomationIdProperty $id), (New-Cond $AE::ControlTypeProperty $CT::ListItem))
    $rows = $list.FindAll($TS::Descendants, $cond)
    if ($rows.Count -eq 1) { return $rows.Item(0) }
    return $null
}

function Find-NoteRow($win, [string]$id) {
    $el = Get-VisibleNoteRow $win $id
    if ($el) { return $el }
    foreach ($pass in 0, 1) {
        if ($pass -eq 1) { Reset-NoteList $win; $el = Get-VisibleNoteRow $win $id; if ($el) { return $el } }
        for ($i = 0; $i -lt 400; $i++) {
            if (-not (Move-NoteList $win)) { break }
            $el = Get-VisibleNoteRow $win $id
            if ($el) { return $el }
        }
    }
    return $null
}

function Read-Detail($win) {
    $g = Find-ByName $win $CT::Group $L.detailName
    if (-not $g) { return $null }
    return (Read-DetailGroup $g)
}

function Read-DetailGroup($g) {
    $textCond = New-Cond $AE::ControlTypeProperty $CT::Text
    $all = @($g.FindAll($TS::Descendants, $textCond) | ForEach-Object { $_.Current.Name })
    $doc = $g.FindFirst($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Document))
    $bodyParts = @()
    $body = ''
    if ($doc) {
        $bodyParts = @($doc.FindAll($TS::Descendants, $textCond) | ForEach-Object { $_.Current.Name })
        $tp = $null
        try {
            if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
                $body = $tp.DocumentRange.GetText(-1)
            }
        } catch {}
        if (-not (Norm $body)) { $body = ($bodyParts | Where-Object { Norm $_ }) -join "`n" }
    }
    $headCount = $all.Count - $bodyParts.Count
    $head = @()
    if ($headCount -gt 0) { $head = @($all[0..($headCount - 1)]) }
    $datetime = ''
    foreach ($h in $head) { if ($h -match '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}') { $datetime = $h; break } }
    $recipients = ''
    for ($i = 0; $i -lt $head.Count - 1; $i++) { if ($head[$i] -eq $L.recipientLabel) { $recipients = $head[$i + 1]; break } }
    $files = @()
    foreach ($b in $g.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Button))) {
        $bn = $b.Current.Name
        if ($bn.StartsWith($L.downloadPrefix + ' ')) { $files += $bn.Substring($L.downloadPrefix.Length + 1) }
    }
    $title = ''; $sender = ''; $org = ''
    if ($head.Count -gt 0) { $title = Norm $head[0] }
    if ($head.Count -gt 1) { $sender = Norm $head[1] }
    if ($head.Count -gt 2) { $org = Norm $head[2] }
    return [pscustomobject]@{
        title = $title; sender = $sender; org = $org; datetime = $datetime
        recipients = $recipients; body = $body.Trim(); files = $files; group = $g
    }
}

function Get-HeadSig($d) { return ('{0}|{1}|{2}' -f $d.title, $d.sender, $d.datetime) }
function Get-RestSig($d) { return ('{0}|{1}' -f (Norm $d.body), ($d.files -join ';')) }

function Get-RangeListHeader([string]$rowText) {
    $dateSeparator = $rowText.LastIndexOf(', ')
    if ($dateSeparator -lt 0) { return '' }
    $header = $rowText.Substring(0, $dateSeparator)
    $attachment = ', ' + $L.attachWord
    if ($header.EndsWith($attachment, [StringComparison]::Ordinal)) {
        $header = $header.Substring(0, $header.Length - $attachment.Length)
    }
    return $header
}

function Test-Match($detail, [string]$listText, [string]$day, $knownHeaders, [switch]$Automatic) {
    # Is the detail pane showing the note we just opened?
    if (-not $detail -or -not $detail.sender) { return $false }
    if ($day -and $detail.datetime -match '^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}' -and $Matches[1] -ne $day) {
        $stamp = [datetime]::MinValue
        if ([datetime]::TryParseExact($Matches[0], 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$stamp)) { return $false }
    }
    $lt = Norm $listText
    if (-not $lt.Contains($detail.sender)) { return $false }
    if ($Automatic) {
        if (-not (Norm $detail.body) -and -not $detail.files.Count -and
            (-not $day -or -not ([string]$detail.datetime).StartsWith($day + ' '))) { return $false }
        $header = Get-RangeListHeader $lt
        $title = [string]$detail.title
        $sender = [string]$detail.sender
        if (-not $title) { return $false }
        $header = $header.Normalize([Text.NormalizationForm]::FormKC) -replace '\s+', ''
        foreach ($expected in @("$title,$sender", "$sender,$title")) {
            if ($header -ceq ($expected.Normalize([Text.NormalizationForm]::FormKC) -replace '\s+', '')) { return $true }
        }
        return $false
    }
    if ($day -and $null -ne $knownHeaders -and $detail.title) {
        $shownHeader = $detail.title + ', ' + $detail.sender
        $targetHeader = Get-RangeListHeader $lt
        # The prefix or body preview can match even while a different listed note is still on screen.
        if ($targetHeader.EndsWith(', ' + $detail.sender, [StringComparison]::Ordinal) -and
            $targetHeader -cne $shownHeader -and $knownHeaders.Contains($shownHeader)) { return $false }
    }
    foreach ($cand in @($detail.title, (Norm $detail.body))) {
        if ($cand) {
            $k = $cand.Substring(0, [Math]::Min(8, $cand.Length))
            if ($lt.Contains($k)) { return $true }
        }
    }
    return $false
}

# A layout can expose a differently named container or open a separate Brity
# window. Start at the recipient header, and never read a whole inbox as a note.
function Find-AlternativeDetail($win, [string]$listText, $existingWindows, [int]$lastDetailWindow, [string]$day, [switch]$AllowReview) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $windows = @($win)
    foreach ($w in (Get-BrityWindows)) {
        $handle = $w.Current.NativeWindowHandle
        if ($handle -ne $win.Current.NativeWindowHandle -and $w.Current.Name -ne $L.composeWindow -and
            ($handle -eq $lastDetailWindow -or $handle -notin $existingWindows)) {
            $windows += $w
        } elseif ($DiagnosticReadId -and $listText -and $handle -ne $win.Current.NativeWindowHandle -and $w.Current.Name -ne $L.composeWindow) {
            & $Observe 'alternative' 'existing-window-excluded'
        }
    }
    $match = $null
    foreach ($w in $windows) {
        try {
            $labels = $w.FindAll($TS::Descendants, (New-Cond $AE::NameProperty $L.recipientLabel))
            if ($DiagnosticReadId -and $listText -and -not $labels.Count) { & $Observe 'alternative' 'no-recipient-label' }
            foreach ($label in $labels) {
                $g = $walker.GetParent($label)
                while ($g) {
                    $atRoot = [System.Windows.Automation.Automation]::Compare($g, $w)
                    if ($atRoot -and $w.Current.NativeWindowHandle -eq $win.Current.NativeWindowHandle) {
                        if ($DiagnosticReadId -and $listText) { & $Observe 'alternative' 'main-root' }; break
                    }
                    if (Find-ByName $g $CT::List $L.noteListName) {
                        if ($DiagnosticReadId -and $listText) { & $Observe 'alternative' 'contains-list' }; break
                    }
                    $docs = $g.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Document))
                    if ($docs.Count -gt 1) { if ($DiagnosticReadId -and $listText) { & $Observe 'alternative' 'multiple-documents' }; break }
                    if ($docs.Count -eq 1) {
                        $d = Read-DetailGroup $g
                        if ($DiagnosticReadId -and $listText) {
                            & $Observe 'criteria' @([bool]$d.datetime, (-not $day -or ($d.datetime -and $d.datetime.StartsWith($day + ' '))),
                                ($d.sender -and $listText.Contains($d.sender)), ($d.title -and $listText.Contains($d.title)), [bool]($d.body -or $d.files.Count))
                        }
                        $reviewCandidate = $AllowReview -and $d.sender -and $d.title -and
                            ($listText.Contains($d.sender) -or $w.Current.NativeWindowHandle -notin $existingWindows)
                        if ($reviewCandidate -or ($d.datetime -and (-not $day -or $d.datetime.StartsWith($day + ' ')) -and
                            $d.sender -and $d.title -and ($d.body -or $d.files.Count) -and
                            (-not $listText -or ($listText.Contains($d.sender) -and $listText.Contains($d.title))))) {
                            if ($match -and -not [System.Windows.Automation.Automation]::Compare($match.group, $g)) {
                                if ($DiagnosticReadId -and $listText) { & $Observe 'alternative' 'multiple-matches' }
                                return $null
                            }
                            $d | Add-Member -NotePropertyName detailWindow -NotePropertyValue $w.Current.NativeWindowHandle
                            $match = $d
                            break
                        }
                    }
                    if ($atRoot) { break }
                    $g = $walker.GetParent($g)
                }
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            # The popup can disappear during polling.
            continue
        }
    }
    return $match
}

function Get-BrityWindows {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $ids = @((Get-Process $L.processName -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session).Id)
    $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object { $ids -contains $_.Current.ProcessId }
}

# ---- Classic view (Brity setting "classic view", 2026-11-18) ----
# Invoke/Select on a list row only selects it there; the note opens in its own window on a double click, and that
# window has the usual detail group (found by Find-AlternativeDetail as a new window). A minimized or tray window
# ignores mouse messages, so it is shown right of all screens while notes are opened, without a taskbar button,
# and put back afterwards. Its place is written to a file first: a run that is cut off is undone by the next one.
$script:classicView = $false
$script:parked = $null
$parkFile = Join-Path (Join-Path $env:LOCALAPPDATA 'BrityAssistant') 'brity-parked.json'

function Restore-Parked {
    $p = $script:parked
    if (-not $p) { return }
    $h = [IntPtr][long]$p.Handle
    $fgPid = [BrityWin.Finder]::ProcessOf([BrityWin.Finder]::GetForegroundWindow())
    $brityPids = @((Get-Process $L.processName -ErrorAction SilentlyContinue).Id)
    # The teacher may have opened Brity meanwhile: then leave it on screen at its own place.
    $show = if ($brityPids -contains [int]$fgPid) { 1 } elseif ($p.Hidden) { 0 } else { 7 }
    [void][BrityWin.Finder]::SetNormal($h, $p.L, $p.T, $p.R, $p.B, $show)
    [void][BrityWin.Finder]::SetWindowLong($h, -20, [int]$p.Ex)
    Remove-Item -LiteralPath $parkFile -Force -ErrorAction SilentlyContinue
    $script:parked = $null
}

function Restore-ParkedFromFile($win) {
    if (-not (Test-Path -LiteralPath $parkFile)) { return }
    try {
        $p = Get-Content -LiteralPath $parkFile -Raw | ConvertFrom-Json
        if ([long]$p.Handle -eq [long]$win.Current.NativeWindowHandle) { $script:parked = $p; Restore-Parked }
    } catch {}
    Remove-Item -LiteralPath $parkFile -Force -ErrorAction SilentlyContinue
}

# A run cut off while Brity was parked (PC shut down, Brity restarted with the saved place) can leave the main
# window wholly outside every screen, where the teacher cannot find it even from the tray. Nothing else puts it
# there, so bring it back to the middle of the main screen, keeping its size and its minimized/tray state.
function Repair-OffscreenMain($win) {
    try {
        $h = [IntPtr]$win.Current.NativeWindowHandle
        $n = [BrityWin.Finder]::GetNormal($h)
        if (-not $n) { return }
        $left = [BrityWin.Finder]::GetSystemMetrics(76); $top = [BrityWin.Finder]::GetSystemMetrics(77)
        $right = $left + [BrityWin.Finder]::GetSystemMetrics(78); $bottom = $top + [BrityWin.Finder]::GetSystemMetrics(79)
        if ($n[0] -lt $right -and $n[2] -gt $left -and $n[1] -lt $bottom -and $n[3] -gt $top) { return }
        $w = $n[2] - $n[0]; $hgt = $n[3] - $n[1]
        $x = [Math]::Max(0, [int](([BrityWin.Finder]::GetSystemMetrics(0) - $w) / 2))
        $y = [Math]::Max(0, [int](([BrityWin.Finder]::GetSystemMetrics(1) - $hgt) / 2))
        $show = if (-not [BrityWin.Finder]::IsWindowVisible($h)) { 0 } elseif ([BrityWin.Finder]::IsIconic($h)) { 7 } else { 4 }
        [void][BrityWin.Finder]::SetNormal($h, $x, $y, $x + $w, $y + $hgt, $show)
        # Parking hid the taskbar button (tool window); give it back.
        $ex = [BrityWin.Finder]::GetWindowLong($h, -20)
        if ($ex -band 0x80) { [void][BrityWin.Finder]::SetWindowLong($h, -20, (($ex -band (-bnot 0x80)) -bor 0x40000)) }
    } catch {}
}

# Note windows wholly right of or outside all screens were put there by a run that was cut off (the keeper moves
# them out). The teacher's own windows are never there. Close them before anything else.
function Close-OffscreenNoteWindows($win) {
    try {
        $left = [BrityWin.Finder]::GetSystemMetrics(76); $top = [BrityWin.Finder]::GetSystemMetrics(77)
        $right = $left + [BrityWin.Finder]::GetSystemMetrics(78); $bottom = $top + [BrityWin.Finder]::GetSystemMetrics(79)
        foreach ($w in (Get-NewNoteWindows $win @())) {
            $r = $w.Current.BoundingRectangle
            if ($r.IsEmpty) { continue }
            if ($r.Left -ge $right -or $r.Right -le $left -or $r.Top -ge $bottom -or $r.Bottom -le $top) {
                [void][BrityWin.Finder]::PostMessage([IntPtr]$w.Current.NativeWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
            }
        }
    } catch {}
}

function Show-Parked($win) {
    if ($script:parked) { return }
    $h = [IntPtr]$win.Current.NativeWindowHandle
    $iconic = [BrityWin.Finder]::IsIconic($h)
    $hidden = -not [BrityWin.Finder]::IsWindowVisible($h)
    if (-not $iconic -and -not $hidden) { return }
    $n = [BrityWin.Finder]::GetNormal($h)
    $ex = [BrityWin.Finder]::GetWindowLong($h, -20)
    $script:parked = [pscustomobject]@{ Handle = [long]$h; L = $n[0]; T = $n[1]; R = $n[2]; B = $n[3]; Hidden = $hidden; Ex = $ex }
    New-Item -ItemType Directory -Force (Split-Path $parkFile) | Out-Null
    $script:parked | ConvertTo-Json -Compress | Set-Content -LiteralPath $parkFile -Encoding ascii
    # WS_EX_TOOLWINDOW on, WS_EX_APPWINDOW off: no taskbar button while it is out.
    [void][BrityWin.Finder]::SetWindowLong($h, -20, (($ex -bor 0x80) -band (-bnot 0x40000)))
    $x = [BrityWin.Finder]::GetSystemMetrics(76) + [BrityWin.Finder]::GetSystemMetrics(78) + 200
    $y = [BrityWin.Finder]::GetSystemMetrics(77)
    # SW_SHOWNOACTIVATE at a place right of all screens: shown, but not in front and not seen.
    [void][BrityWin.Finder]::SetNormal($h, $x, $y, $x + ($n[2] - $n[0]), $y + ($n[3] - $n[1]), 4)
    for ($i = 0; $i -lt 30; $i++) {
        if ([BrityWin.Finder]::IsWindowVisible($h) -and -not [BrityWin.Finder]::IsIconic($h)) { break }
        Start-Sleep -Milliseconds 100
    }
    Start-Sleep -Milliseconds 500
}

# Note windows that appeared since $before (handles) and show a note (they have the recipient label).
function Get-NewNoteWindows($win, $before) {
    @(Get-BrityWindows | Where-Object {
        $_.Current.NativeWindowHandle -ne $win.Current.NativeWindowHandle -and $_.Current.NativeWindowHandle -notin $before -and
        $_.Current.Name -ne $L.composeWindow -and
        $_.FindFirst($TS::Descendants, (New-Cond $AE::NameProperty $L.recipientLabel))
    })
}

function Close-NewNoteWindows($win, $before) {
    foreach ($w in (Get-NewNoteWindows $win $before)) {
        [void][BrityWin.Finder]::PostMessage([IntPtr]$w.Current.NativeWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_CLOSE
    }
}

function Get-Foreground { try { [BrityWin.Finder]::GetForegroundWindow() } catch { [IntPtr]::Zero } }

function Open-NoteWindow($win, [string]$id) {
    try { return (Open-NoteWindowCore $win $id) } catch { return $false }
}

function Open-NoteWindowCore($win, [string]$id) {
    Show-Parked $win
    $page = [BrityWin.Finder]::PageWidget([IntPtr]$win.Current.NativeWindowHandle)
    if ($page -eq [IntPtr]::Zero) { return $false }
    # A window that was hidden for a while lays the page out again after it is shown: wait for the row's place.
    $x = 0; $y = 0
    for ($i = 0; $i -lt 15; $i++) {
        $row = Get-VisibleNoteRow $win $id
        $doc = $win.FindFirst($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Document))
        if ($row -and $doc) {
            $r = $row.Current.BoundingRectangle; $d = $doc.Current.BoundingRectangle
            if (-not $r.IsEmpty -and -not $d.IsEmpty) {
                $x = [int]($r.X - $d.X + $r.Width / 2); $y = [int]($r.Y - $d.Y + $r.Height / 2)
                if ($x -gt 0 -and $y -gt 0 -and $x -lt $d.Width -and $y -lt $d.Height) { break }
            }
        }
        $x = 0; Start-Sleep -Milliseconds 200
    }
    if ($x -le 0) { return $false }
    Arm-Keeper
    [BrityWin.Finder]::DoubleClick($page, $x, $y)
    if ($DiagnosticReadId) { & $Observe 'action' 'DoubleClick' }
    return $true
}

function Get-BrityPids { [int[]]@((Get-Process $L.processName -ErrorAction SilentlyContinue).Id | Where-Object { $_ }) }

# The window the teacher was using when the run started, unless that was Brity itself.
function Get-GiveBackWindow($start) {
    if ($start -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
    if ((Get-BrityPids) -contains [int][BrityWin.Finder]::ProcessOf($start)) { return [IntPtr]::Zero }
    return $start
}

function Start-Keeper($start) {
    try {
        $pids = Get-BrityPids
        $onScreen = [long[]]@(Get-BrityWindows | ForEach-Object { [long]$_.Current.NativeWindowHandle } | Where-Object {
            [BrityWin.Finder]::IsWindowVisible([IntPtr]$_) -and -not [BrityWin.Finder]::IsIconic([IntPtr]$_) })
        $mh = [IntPtr]$win.Current.NativeWindowHandle
        $state = if (-not [BrityWin.Finder]::IsWindowVisible($mh)) { 0 } elseif ([BrityWin.Finder]::IsIconic($mh)) { 1 } else { 2 }
        [BrityWin.Keeper]::Start($pids, $onScreen, (Get-GiveBackWindow $start), $mh, $state)
    } catch {}
}
function Arm-Keeper { try { [BrityWin.Keeper]::Arm(3000) } catch {} }
function Stop-Keeper { try { [BrityWin.Keeper]::Stop() } catch {} }

function Restore-Foreground($start) {
    try {
        $to = Get-GiveBackWindow $start
        if ($to -ne [IntPtr]::Zero -and (Get-BrityPids) -contains [int][BrityWin.Finder]::ProcessOf([BrityWin.Finder]::GetForegroundWindow())) {
            [void][BrityWin.Keeper]::GiveBack($to)
        }
    } catch {}
}

function Save-Attachment($g, [string]$file, [string]$destDir) {
    if (-not $g) { return $null }
    $btn = Find-ByName $g $CT::Button ($L.downloadPrefix + ' ' + [System.Management.Automation.WildcardPattern]::Escape($file))
    if (-not $btn) { return $null }
    $t0 = (Get-Date).AddSeconds(-1)
    if (-not (Invoke-El $btn)) { return $null }
    $lastSize = -1
    # Only a file named after this attachment counts (Brity may add " (1)" for a repeat): another download
    # finishing at the same moment must not be saved as this one. No such file means "not confirmed".
    # Compared without spaces and characters Windows does not allow in names, which Brity may replace.
    $nameKey = { param([string]$n)
        $n = $n.Normalize([Text.NormalizationForm]::FormC).ToLowerInvariant()
        -join ($n.ToCharArray() | Where-Object { -not [char]::IsWhiteSpace($_) -and $_ -ne '_' -and [IO.Path]::GetInvalidFileNameChars() -notcontains $_ }) }
    $wantBase = & $nameKey ([IO.Path]::GetFileNameWithoutExtension($file))
    $wantExt = & $nameKey ([IO.Path]::GetExtension($file))
    $sameName = { param($f)
        $b = & $nameKey ([IO.Path]::GetFileNameWithoutExtension($f.Name))
        (& $nameKey $f.Extension) -eq $wantExt -and ($b -eq $wantBase -or ($b -match '^(.*)\(\d+\)$' -and $Matches[1] -eq $wantBase)) }
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        $new = Get-ChildItem -LiteralPath $L.downloadDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $t0 -and (& $sameName $_) } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($new) {
            if ($new.Length -eq $lastSize -and $new.Length -gt 0) {
                New-Item -ItemType Directory -Force $destDir | Out-Null
                $dest = Join-Path $destDir $new.Name
                Copy-Item -LiteralPath $new.FullName -Destination $dest -Force
                return $dest
            }
            $lastSize = $new.Length
        }
    }
    return $null
}

# Unread notes, plus notes the teacher already read in Brity before the calendar got to them (2026-11-17):
# a read row is new only when it sits above the newest saved note in the list (the list is newest first).
# With nothing saved yet (first connection) read rows are left alone; "load past notes" brings old ones.
function Select-NewNotes($Items, $Processed, [int]$Max, $Pending = @{}) {
    $Processed = @($Processed)
    $newerThanSaved = $Processed.Count -gt 0
    $picked = foreach ($it in $Items) {
        if ($Processed -contains $it.id) { $newerThanSaved = $false; continue }
        if (-not $Pending.ContainsKey($it.id) -and ($it.unread -or $newerThanSaved)) { $it }
    }
    $retry = foreach ($it in $Items) {
        if ($Pending.ContainsKey($it.id) -and $Pending[$it.id].record.readAttempts -lt 3 -and $Pending[$it.id].due -le [datetime]::UtcNow) { $it }
    }
    $ordered = @($picked | Where-Object { $_ }) + @($retry | Where-Object { $_ } | Sort-Object { $Pending[$_.id].due })
    $ordered | Select-Object -First $Max
}

function Write-CollectorJson($value, [string]$path) {
    $temp = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($path)) {
            [IO.File]::Replace($temp, $path, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($temp, $path)
        }
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}

# ---- main ----
if ($FunctionsOnly) { return }
if ($DiagnosticReadId -and (-not $Observe -or $Open -or $Download -or $ShowNote -or $ListOnly)) { throw 'Invalid diagnostic arguments' }
if ($ShowNote) {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    try {
        $note = [Console]::In.ReadToEnd() | ConvertFrom-Json
        Show-OriginalNote $note -Reply:$Reply
    } catch {
        Write-Output 'unavailable'
    }
    return
}

$win = Get-AppWindow
# reason=<code>: why reading failed, shown to the teacher by the calendar (2026-11-18: one message for every cause).
if (-not $win) { Write-Output 'reason=window-not-found'; Write-Output 'ERROR: Brity Messenger window not found (is it running and logged in?)'; exit 1 }
Restore-ParkedFromFile $win
Repair-OffscreenMain $win
Close-OffscreenNoteWindows $win
$startForeground = Get-Foreground

$list = Find-ByName $win $CT::List $L.noteListName
if (-not $list) {
    $menu = Find-ByName $win $CT::Button $L.noteMenu
    if (-not $menu) { Write-Output 'reason=note-menu-not-found'; Write-Output 'ERROR: note menu button not found (check labels.json)'; exit 2 }
    # The note menu can take the foreground. Open it only to recover a missing list.
    if (-not (Invoke-El $menu)) { Write-Output 'reason=note-menu-not-found'; Write-Output 'ERROR: note menu could not be invoked'; exit 2 }
    if (-not $DiagnosticReadId) {
        New-Item -ItemType Directory -Force $Inbox | Out-Null
        Set-Content -Path (Join-Path $Inbox 'menu-pressed.txt') -Value (Get-Date).ToString('s') -Encoding ascii
    }
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 400
        $list = Find-ByName $win $CT::List $L.noteListName
        if ($list) { break }
    }
    if (-not $list) { Write-Output 'reason=note-list-not-found'; Write-Output 'ERROR: note list not found'; exit 3 }
}
# New notes are at the top. A list left scrolled down would hide them, so go back up first.
Reset-NoteList $win
$ranged = [bool]($From -or $To)
. (Join-Path $PSScriptRoot 'list-date.ps1')
if ($ranged) {
    $items = @(Get-AllNoteItems $win $From)
} else {
    $list = Find-ByName $win $CT::List $L.noteListName
    if (-not $list) { Write-Output 'reason=note-list-not-found'; Write-Output 'ERROR: note list not found'; exit 3 }
    $items = @(Get-NoteItems $list)
    # Automatic import (2026-11-18, teacher: missing a note is the worst outcome): new or unread notes pushed
    # below the first screen were never seen. Read on down until a note already saved shows up, at most
    # 30 days back. With nothing saved yet (first connection) stay on the first screen as before.
    $savedPath = Join-Path $Inbox 'state.json'
    if ($Open -and -not $Id -and -not $DiagnosticReadId -and (Test-Path -LiteralPath $savedPath)) {
        $saved = @()
        try { $saved = @((Get-Content -LiteralPath $savedPath -Raw -Encoding utf8 | ConvertFrom-Json).processed) } catch {}
        if ($saved.Count -and -not @($items | Where-Object { $saved -contains $_.id }).Count) {
            $items = @(Get-NoteItemsUntilSaved $win $saved ((Get-Date).AddDays(-30).ToString('yyyy-MM-dd')))
        }
    }
}

$notesDir = Join-Path $Inbox 'notes'
$statePath = Join-Path $Inbox 'state.json'
$processed = @()
if (-not $DiagnosticReadId) {
    New-Item -ItemType Directory -Force $notesDir | Out-Null
    if (Test-Path $statePath) { $processed = @((Get-Content $statePath -Raw -Encoding utf8 | ConvertFrom-Json).processed) }
}

$targets = @()
$automatic = $false
$headersByDay = @{}
if ($Id) { $Id = @($Id | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }  # -File passes "a,b" as one string
if ($Id) { $targets = @($items | Where-Object { $Id -contains $_.id }) }
elseif ($From -or $To) {
    # Past notes by date (calendar "load past notes"), read or unread. $items holds the whole list down to -From.
    foreach ($it in $items) { $it | Add-Member -NotePropertyName listDate -NotePropertyValue (Get-ListDate $it.text) -Force }
    $lo = if ($From) { $From } else { '0000-00-00' }
    $hi = if ($To) { $To } else { '9999-99-99' }
    $inRange = @($items | Where-Object { $_.listDate -and ($_.listDate -ge $lo) -and ($_.listDate -le $hi) })
    $fresh = @($inRange | Where-Object { $processed -notcontains $_.id })
    $unknown = @($items | Where-Object { -not $_.listDate }).Count
    if ($ListOnly) {
        $dates = @($items | Where-Object { $_.listDate } | ForEach-Object { $_.listDate } | Sort-Object)
        $oldest = ''; if ($dates.Count) { $oldest = $dates[0] }
        Reset-NoteList $win
        Write-Output ("range-preview visible={0} matched={1} new={2} unknown={3} oldest={4}" -f $items.Count, $inRange.Count, $fresh.Count, $unknown, $oldest)
        return
    }
    foreach ($it in $inRange) {
        if (-not $headersByDay.ContainsKey($it.listDate)) {
            $headersByDay[$it.listDate] = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        }
        [void]$headersByDay[$it.listDate].Add((Get-RangeListHeader $it.text))
    }
    if ($DiagnosticReadId) {
        & $Observe 'range' @($inRange.Count, $unknown, ($fresh.Count -gt 0 -and $fresh[0].id -ceq $DiagnosticReadId))
        $fresh = @($fresh | Where-Object { $_.id -ceq $DiagnosticReadId })
    }
    $targets = @($fresh | Select-Object -First $Max)
}
elseif ($Open) {
    $automatic = $true
    $pending = @{}
    foreach ($it in $items) {
        if ($it.id -notmatch '^[a-z0-9][a-z0-9_-]{0,127}$' -or $processed -contains $it.id) { continue }
        $path = Join-Path $notesDir ($it.id + '.json')
        if (Test-Path -LiteralPath $path) {
            try { $copy = Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json } catch { continue }
            if ($copy.id -eq $it.id -and $copy.verified -eq $false) {
                $due = [datetimeoffset]::MinValue
                [void][datetimeoffset]::TryParse([string]$copy.retryAfterUtc, [ref]$due)
                $pending[$it.id] = @{ due = $due.UtcDateTime; record = $copy }
            }
        }
    }
    $targets = @(Select-NewNotes @($items | Where-Object { $_.id -match '^[a-z0-9][a-z0-9_-]{0,127}$' }) $processed $Max $pending)
}

$opened = @()
$lastDetailWindow = 0
# Head of the note accepted last in this run: a pane still showing it is that note, not the next one with the
# same title and sender (a resend), even though the list row matches (2026-11-18).
$lastAcceptedHead = $null
if ($DiagnosticReadId) {
    $targets = @($targets | Where-Object { $_.id -ceq $DiagnosticReadId -and -not $_.unread })
    & $Observe 'target' $targets.Count
}
$noteWindowBase = $null
$classicTried = 0; $classicOk = 0; $viewClassic = 0; $viewOne = 0
if ($targets.Count) { Start-Keeper $startForeground }
try {
foreach ($t in $targets) {
    # Classic view: close the note window the previous note opened before looking at this one.
    if ($null -ne $noteWindowBase) { Close-NewNoteWindows $win $noteWindowBase; $noteWindowBase = $null; Start-Sleep -Milliseconds 300 }
    $knownHeaders = if ($t.listDate) { ,$headersByDay[$t.listDate] }
    $el = Find-NoteRow $win $t.id
    if ($DiagnosticReadId) { & $Observe 'row' ([bool]$el) }
    if (-not $el) { $opened += [pscustomobject]@{ id = $t.id; error = 'list item not found' }; continue }
    if ($automatic) {
        $record = $null
        $t | Add-Member -NotePropertyName listDate -NotePropertyValue (Get-ListDate $t.text) -Force
        $notePath = Join-Path $notesDir ($t.id + '.json')
        if ($pending.ContainsKey($t.id) -or -not (Test-Path -LiteralPath $notePath)) {
            $attempts = 1
            if ($pending.ContainsKey($t.id)) { $attempts += [int]$pending[$t.id].record.readAttempts }
            $header = Get-RangeListHeader $t.text
            if (-not $header) { $header = $t.text }
            $record = if ($pending.ContainsKey($t.id)) { $pending[$t.id].record } else {
                [pscustomobject]@{
                    id = $t.id; verified = $false; wasUnread = $t.unread; openedByAssistant = $true; placeholder = $true
                    collectedAt = (Get-Date).ToString('s'); title = $header; sender = ''; org = ''; datetime = $t.listDate
                    recipients = ''; files = @(); saved = @(); body = ($L.unreadBodyMissing + "`n`n" + $t.text)
                }
            }
            $delay = if ($attempts -eq 2) { 5 } else { 0 }
            $record | Add-Member -Force -NotePropertyName readAttempts -NotePropertyValue $attempts
            $record | Add-Member -Force -NotePropertyName placeholder -NotePropertyValue $true
            $record | Add-Member -Force -NotePropertyName retryAfterUtc -NotePropertyValue ([datetime]::UtcNow.AddMinutes($delay).ToString('o'))
            Write-CollectorJson $record $notePath
        }
    }
    # The pane updates in steps (header first, body and files later), so a matching header is not enough.
    # Accept only when two reads in a row are identical AND the body/files are no longer the previous note's.
    $existingWindows = @((Get-BrityWindows) | ForEach-Object { $_.Current.NativeWindowHandle })
    $b = Read-Detail $win
    if (-not $b) { $b = Find-AlternativeDetail $win '' $existingWindows $lastDetailWindow }
    $beforeHead = ''; $beforeRest = ''
    if ($b) { $beforeHead = (Get-HeadSig $b); $beforeRest = (Get-RestSig $b) }
    if ($DiagnosticReadId) { & $Observe 'before' (Test-Match $b $t.text $t.listDate $knownHeaders) }
    $usedWindow = $false
    if ($script:classicView) {
        # Selecting the row first is not needed there and only takes the focus once more.
        $noteWindowBase = $existingWindows
        $usedWindow = Open-NoteWindow $win $t.id
        $openedRow = $usedWindow
    } else {
        Arm-Keeper
        $openedRow = Open-NoteRow $el
    }
    $d = $null; $ok = $false; $prev = ''; $observed = $null
    for ($i = 0; $i -lt 18; $i++) {
        Start-Sleep -Milliseconds 500
        $d = Read-Detail $win
        if (-not $d -and -not $usedWindow -and $i -eq 1) {
            # Nothing shows the note in the main window a second after opening: classic view, try its window.
            $alt = Find-AlternativeDetail $win $t.text $existingWindows $lastDetailWindow $t.listDate -AllowReview:$automatic
            if ($alt) { $d = $alt }
            if (-not $alt) {
                $noteWindowBase = $existingWindows
                $usedWindow = Open-NoteWindow $win $t.id
                $openedRow = $openedRow -or $usedWindow
                continue
            }
        }
        if ($openedRow -and $i -ge 1 -and -not (Test-Match $d $t.text $t.listDate $knownHeaders -Automatic:$automatic)) {
            # Classic view: a note already open in its own window is brought forward, not opened again, so the
            # windows that were there before count too. Find-AlternativeDetail still needs the full title,
            # the sender and the day, so another note left open does not pass.
            $searchSkip = if ($usedWindow) { @() } else { $existingWindows }
            $alt = Find-AlternativeDetail $win $t.text $searchSkip $lastDetailWindow $t.listDate
            if (-not $alt -and $automatic) {
                $alt = Find-AlternativeDetail $win $t.text $existingWindows $lastDetailWindow $t.listDate -AllowReview
            }
            if ($alt) { $d = $alt }
        }
        if ($automatic -and $d -and (Norm $d.body)) {
            # Keep it only once the screen has left what it showed before opening, or when it already looks like
            # this note (sender and start of the title): a pane still on the previous note would otherwise save
            # that note's body under this one.
            $left = (Get-HeadSig $d) -cne $beforeHead -and (Get-RestSig $d) -cne $beforeRest
            if ($left -or ((Get-HeadSig $d) -cne $lastAcceptedHead -and (Test-Match $d $t.text $t.listDate $null))) { $observed = $d }
        }
        $matchesRow = Test-Match $d $t.text $t.listDate $knownHeaders -Automatic:$automatic
        if ($DiagnosticReadId) { & $Observe 'poll' @([bool]$d, [bool]$matchesRow, [bool]$d.detailWindow) }
        if ($matchesRow) {
            $head = Get-HeadSig $d; $rest = Get-RestSig $d
            # same head before the click = this note was already showing, unless it is the note just read
            $fresh = ($rest -ne $beforeRest) -or ($head -eq $beforeHead -and $head -cne $lastAcceptedHead)
            if ($DiagnosticReadId) { & $Observe 'stability' @($fresh, ("$head#$rest" -eq $prev)) }
            # Give a header-only pane the full loading window before accepting a title-only note.
            $titleOnly = $automatic -and -not (Norm $d.body) -and -not $d.files.Count
            if ($titleOnly) { $fresh = $i -eq 17 -and -not $t.hasFile }
            if ($fresh -and ("$head#$rest" -eq $prev)) { $ok = $true; break }
            $prev = "$head#$rest"
        } else { $prev = '' }
        if (($i -eq 5 -or $i -eq 11) -and -not ($automatic -and $openedRow -and $d)) {
            # the app sometimes ignores the first click right after the list renders: click again
            if ($null -ne $noteWindowBase) {
                # Classic view was tried for this note (even if the row had no place yet): double click again.
                if (-not (Get-NewNoteWindows $win $existingWindows).Count) { $usedWindow = (Open-NoteWindow $win $t.id) -or $usedWindow }
                $openedRow = $openedRow -or $usedWindow
            } else {
                $el = Get-VisibleNoteRow $win $t.id
                if ($el) { Arm-Keeper; $openedRow = (Open-NoteRow $el -PreferSelect:($i -eq 5)) -or $openedRow }
            }
        }
    }
    if ($usedWindow -and $ok) { $script:classicView = $true }
    if ($noteWindowBase -ne $null -or $usedWindow) { $classicTried++; if ($ok) { $classicOk++ } }
    # Which view this PC uses, for the calendar's "switch to One view" notice: a note read from its own window
    # is classic view, one read in the main window is One view.
    if ($ok -and $d.detailWindow -and $usedWindow) { $viewClassic++ } elseif ($ok -and -not $d.detailWindow) { $viewOne++ }
    if ($DiagnosticReadId) {
        & $Observe 'result' @($openedRow, $ok, $i, [bool]$d, $matchesRow)
        & $Observe 'inspect' $existingWindows
        continue
    }
    if ($automatic -and $record -and $observed -and -not $ok) {
        $record.body = $observed.body
        $record | Add-Member -Force -NotePropertyName observedHeader -NotePropertyValue ((@($observed.title, $observed.sender, $observed.datetime) | Where-Object { $_ }) -join ' / ')
        Write-CollectorJson $record $notePath
    }
    if (-not $openedRow -or -not $d -or ($d.detailWindow -and -not $ok)) {
        $opened += [pscustomobject]@{ id = $t.id; error = 'detail pane not found' }
        continue
    }
    if (($ranged -or $automatic) -and -not $ok) {
        $opened += [pscustomobject]@{ id = $t.id; verified = $false; error = 'detail not verified' }
        continue
    }
    if ($ok) { $lastAcceptedHead = Get-HeadSig $d }
    if ($ok -and $d.detailWindow) { $lastDetailWindow = $d.detailWindow }
    $saved = @()
    if ($Download -and $ok) {
        foreach ($f in $d.files) {
            # One attachment failing must not cost this note's body or the notes after it.
            $dest = $null
            try { $dest = Save-Attachment $d.group $f (Join-Path (Join-Path $Inbox 'files') $t.id) } catch { $dest = $null }
            $saved += [pscustomobject]@{ name = $f; path = $dest }
        }
    }
    $note = [pscustomobject]@{
        id = $t.id; verified = $ok; wasUnread = $t.unread; openedByAssistant = $true
        collectedAt = (Get-Date).ToString('s')
        title = $d.title; sender = $d.sender; org = $d.org; datetime = $d.datetime
        recipients = $d.recipients; files = $d.files; saved = $saved; body = $d.body
    }
    # Notes loaded by date range: the calendar does not copy their attachments and asks before classifying.
    if ($From -or $To) { $note | Add-Member -NotePropertyName imported -NotePropertyValue 'range' }
    Write-CollectorJson $note (Join-Path $notesDir ($t.id + '.json'))
    if ($ok -and ($processed -notcontains $t.id)) { $processed += $t.id }
    $opened += $note
}
} finally {
    if ($null -ne $noteWindowBase) { Close-NewNoteWindows $win $noteWindowBase; Start-Sleep -Milliseconds 300 }
    Stop-Keeper
    # Focus first: the closed note window leaves Brity in front, which Restore-Parked would take for the teacher.
    Restore-Foreground $startForeground
    Restore-Parked
}
if ($ranged -or $Id) { Reset-NoteList $win }
if ($DiagnosticReadId) { return }

Write-CollectorJson ([pscustomobject]@{ processed = $processed }) $statePath
[pscustomobject]@{ collectedAt = (Get-Date).ToString('s'); list = $items; opened = $opened } |
    ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Inbox 'latest.json') -Encoding utf8

$unreadCount = @($items | Where-Object { $_.unread }).Count
$okCount = @($opened | Where-Object { $_.verified }).Count
$savedCount = @($opened | ForEach-Object { $_.saved } | Where-Object { $_.path }).Count
# Classic view opened nothing this run (seen at 150% scale, 2026-11-18): the teacher can switch Brity to One view.
if ($classicTried -ge 2 -and $classicOk -eq 0) { Write-Output 'reason=classic-unreadable' }
# Classic view works less reliably (it failed on another PC with 0.5.12): the calendar asks to switch to One view
# as soon as classic view is seen, even when the notes were read (2026-11-19).
if ($viewClassic -or ($classicTried -ge 2 -and $classicOk -eq 0)) { Write-Output 'view=classic' }
elseif ($viewOne) { Write-Output 'view=one' }
Write-Output ("list={0} unread={1} opened={2} verified={3} filesSaved={4}" -f $items.Count, $unreadCount, $opened.Count, $okCount, $savedCount)
if ($From -or $To) {
    $left = @($inRange | Where-Object { $processed -notcontains $_.id }).Count
    Write-Output ("range matched={0} remaining={1}" -f $inRange.Count, $left)
}
Write-Output ("latest: " + (Join-Path $Inbox 'latest.json'))
