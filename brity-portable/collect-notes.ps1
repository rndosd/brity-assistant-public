param(
    [switch]$Open,       # open unread notes and read the body (the app marks them as read)
    [switch]$Download,   # with -Open / -Id: also save attachments
    [string[]]$Id,       # open these note ids regardless of read state
    [switch]$ShowNote,
    [switch]$Reply,
    [int]$Max = 20,
    [string]$Inbox = (Join-Path $PSScriptRoot 'inbox')
)
# Reads Brity Messenger notes through Windows UI Automation (the screen-reader channel).
# No screenshots, no mouse, no keyboard. Buttons are run by name with InvokePattern.
# Keep this file ASCII only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
# All Korean UI labels live in labels.json (edit there when the app renames something).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$L  = Get-Content (Join-Path $PSScriptRoot 'labels.json') -Raw -Encoding utf8 | ConvertFrom-Json
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]

Add-Type -TypeDefinition @'
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
    }
}
'@

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

function Open-ReplyComposer($win, $note, $detailGroup) {
    if (@(Get-ComposeHandles).Count) { return 'reply-in-use' }
    $condition = [System.Windows.Automation.AndCondition]::new(
        (New-Cond $AE::ControlTypeProperty $CT::Button),
        (New-Cond $AE::NameProperty $L.replyButton)
    )
    $buttons = $detailGroup.FindAll($TS::Descendants, $condition)
    if ($buttons.Count -ne 1) { return 'reply-unavailable' }
    $replyButton = $buttons.Item(0)
    if (-not (Test-NoteHeader (Read-Detail $win) $note)) { return 'unverified' }
    if (-not $replyButton.Current.IsEnabled -or -not (Invoke-El $replyButton)) { return 'reply-unavailable' }

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
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
        if ($Reply -and @(Get-ComposeHandles).Count) { return 'reply-in-use' }
        $win = Get-AppWindow -MainOnly
        if (-not $win) { return 'offline' }
        $handle = [IntPtr]$win.Current.NativeWindowHandle
        if ($handle -eq [IntPtr]::Zero) { return 'unavailable' }
        if ([BrityWin.Finder]::IsIconic($handle) -or -not [BrityWin.Finder]::IsWindowVisible($handle)) {
            [void][BrityWin.Finder]::ShowWindowAsync($handle, 9)
        }
        for ($i = 0; $i -lt 8 -and [BrityWin.Finder]::GetForegroundWindow() -ne $handle; $i++) {
            [void][BrityWin.Finder]::SetForegroundWindow($handle)
            Start-Sleep -Milliseconds 125
        }
        $list = Find-ByName $win $CT::List $L.noteListName
        if (-not $list) {
            $menu = Find-ByName $win $CT::Button $L.noteMenu
            if (-not $menu -or -not (Invoke-El $menu)) { return 'unavailable' }
        }
        $rowCondition = [System.Windows.Automation.AndCondition]::new(
            (New-Cond $AE::ControlTypeProperty $CT::ListItem),
            (New-Cond $AE::AutomationIdProperty $note.id)
        )
        $invoked = $false
        for ($i = 0; $i -lt 20; $i++) {
            $list = Find-ByName $win $CT::List $L.noteListName
            if ($list) {
                $rows = $list.FindAll($TS::Descendants, $rowCondition)
                if ($rows.Count -gt 1) { return 'not-found' }
                if ($rows.Count -eq 1) {
                    $row = $rows.Item(0)
                    $name = Norm $row.Current.Name
                    if (-not $name.Contains((Norm $note.sender)) -or -not $name.Contains((Norm $note.title))) { return 'not-found' }
                    if (-not $invoked -or $i -in 7, 13) { $invoked = Invoke-El $row }
                    $detail = Read-Detail $win
                    if ($invoked -and (Test-NoteHeader $detail $note)) {
                        if ($Reply) { return (Open-ReplyComposer $win $note $detail.group) }
                        if ([BrityWin.Finder]::GetForegroundWindow() -eq $handle) { return 'opened' }
                        return 'opened-background'
                    }
                }
            }
            Start-Sleep -Milliseconds 350
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

function Read-Detail($win) {
    $g = Find-ByName $win $CT::Group $L.detailName
    if (-not $g) { return $null }
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

function Test-Match($detail, [string]$listText) {
    # Is the detail pane showing the note we just opened?
    if (-not $detail -or -not $detail.sender) { return $false }
    $lt = Norm $listText
    if (-not $lt.Contains($detail.sender)) { return $false }
    foreach ($cand in @($detail.title, (Norm $detail.body))) {
        if ($cand) {
            $k = $cand.Substring(0, [Math]::Min(8, $cand.Length))
            if ($lt.Contains($k)) { return $true }
        }
    }
    return $false
}

function Save-Attachment($win, [string]$file, [string]$destDir) {
    $g = Find-ByName $win $CT::Group $L.detailName
    if (-not $g) { return $null }
    $btn = Find-ByName $g $CT::Button ($L.downloadPrefix + ' ' + [System.Management.Automation.WildcardPattern]::Escape($file))
    if (-not $btn) { return $null }
    $t0 = (Get-Date).AddSeconds(-1)
    if (-not (Invoke-El $btn)) { return $null }
    $lastSize = -1
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        $new = Get-ChildItem $L.downloadDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $t0 -and $_.Extension -notin '.tmp', '.crdownload', '.part' } |
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

# ---- main ----
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
if (-not $win) { Write-Output 'ERROR: Brity Messenger window not found (is it running and logged in?)'; exit 1 }

$menu = Find-ByName $win $CT::Button $L.noteMenu
if (-not $menu) { Write-Output 'ERROR: note menu button not found (check labels.json)'; exit 2 }
[void](Invoke-El $menu)
$items = $null
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 400
    $list = Find-ByName $win $CT::List $L.noteListName
    if (-not $list) { continue }
    $items = Get-NoteItems $list
    if ($items.Count -gt 0) { break }
}
if (-not $list) { Write-Output 'ERROR: note list not found'; exit 3 }

$notesDir = Join-Path $Inbox 'notes'
New-Item -ItemType Directory -Force $notesDir | Out-Null
$statePath = Join-Path $Inbox 'state.json'
$processed = @()
if (Test-Path $statePath) { $processed = @((Get-Content $statePath -Raw -Encoding utf8 | ConvertFrom-Json).processed) }

$targets = @()
if ($Id) { $Id = @($Id | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }  # -File passes "a,b" as one string
if ($Id) { $targets = @($items | Where-Object { $Id -contains $_.id }) }
elseif ($Open) { $targets = @($items | Where-Object { $_.unread -and ($processed -notcontains $_.id) } | Select-Object -First $Max) }

$opened = @()
foreach ($t in $targets) {
    $el = $win.FindFirst($TS::Descendants, (New-Cond $AE::AutomationIdProperty $t.id))
    if (-not $el) { $opened += [pscustomobject]@{ id = $t.id; error = 'list item not found' }; continue }
    # The pane updates in steps (header first, body and files later), so a matching header is not enough.
    # Accept only when two reads in a row are identical AND the body/files are no longer the previous note's.
    $b = Read-Detail $win
    $beforeHead = ''; $beforeRest = ''
    if ($b) { $beforeHead = (Get-HeadSig $b); $beforeRest = (Get-RestSig $b) }
    [void](Invoke-El $el)
    $d = $null; $ok = $false; $prev = ''
    for ($i = 0; $i -lt 18; $i++) {
        Start-Sleep -Milliseconds 500
        $d = Read-Detail $win
        if (Test-Match $d $t.text) {
            $head = Get-HeadSig $d; $rest = Get-RestSig $d
            $fresh = ($rest -ne $beforeRest) -or ($head -eq $beforeHead)   # same head before the click = this note was already showing
            if ($fresh -and ("$head#$rest" -eq $prev)) { $ok = $true; break }
            $prev = "$head#$rest"
        } else { $prev = '' }
        if ($i -eq 5 -or $i -eq 11) {
            # the app sometimes ignores the first click right after the list renders: click again
            $el = $win.FindFirst($TS::Descendants, (New-Cond $AE::AutomationIdProperty $t.id))
            if ($el) { [void](Invoke-El $el) }
        }
    }
    if (-not $d) { $opened += [pscustomobject]@{ id = $t.id; error = 'detail pane not found' }; continue }
    $saved = @()
    if ($Download -and $ok) {
        foreach ($f in $d.files) {
            $dest = Save-Attachment $win $f (Join-Path (Join-Path $Inbox 'files') $t.id)
            $saved += [pscustomobject]@{ name = $f; path = $dest }
        }
    }
    $note = [pscustomobject]@{
        id = $t.id; verified = $ok; wasUnread = $t.unread; openedByAssistant = $true
        collectedAt = (Get-Date).ToString('s')
        title = $d.title; sender = $d.sender; org = $d.org; datetime = $d.datetime
        recipients = $d.recipients; files = $d.files; saved = $saved; body = $d.body
    }
    $note | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $notesDir ($t.id + '.json')) -Encoding utf8
    if ($ok -and ($processed -notcontains $t.id)) { $processed += $t.id }
    $opened += $note
}

[pscustomobject]@{ processed = $processed } | ConvertTo-Json | Set-Content -Path $statePath -Encoding utf8
[pscustomobject]@{ collectedAt = (Get-Date).ToString('s'); list = $items; opened = $opened } |
    ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Inbox 'latest.json') -Encoding utf8

$unreadCount = @($items | Where-Object { $_.unread }).Count
$okCount = @($opened | Where-Object { $_.verified }).Count
$savedCount = @($opened | ForEach-Object { $_.saved } | Where-Object { $_.path }).Count
Write-Output ("list={0} unread={1} opened={2} verified={3} filesSaved={4}" -f $items.Count, $unreadCount, $opened.Count, $okCount, $savedCount)
Write-Output ("latest: " + (Join-Path $Inbox 'latest.json'))
