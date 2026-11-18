# Both controls must expose the same selection contract and give opposite answers.
# InvokePattern only means a button can be clicked. Focus/pressed are transient.
if (-not ('GoeFolderButton' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class GoeFolderButton {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    delegate bool EnumChild(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr main, EnumChild callback, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    public static int Checked(IntPtr h) {
        var cls = new StringBuilder(128);
        if (GetClassName(h, cls, cls.Capacity) == 0) return -2;
        if (!String.Equals(cls.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) return -1;
        int style = GetWindowLong(h, -16) & 15;
        if (style < 2 || (style > 6 && style != 9)) return -1;
        IntPtr value;
        if (SendMessageTimeout(h, 0xF0, IntPtr.Zero, IntPtr.Zero, 2, 750, out value) == IntPtr.Zero) return -2;
        return value == IntPtr.Zero ? 0 : value == (IntPtr)1 ? 1 : -2;
    }
    public static IntPtr[] VisiblePane(IntPtr main) {
        if (main == IntPtr.Zero || (GetWindowLong(main,-16) & 0x10000000) == 0) return null;
        IntPtr list = IntPtr.Zero, scroll = IntPtr.Zero;
        bool duplicate = false;
        EnumChildWindows(main, delegate(IntPtr h, IntPtr data) {
            var cls = new StringBuilder(128);
            GetClassName(h, cls, cls.Capacity);
            string name = cls.ToString();
            if (name != "UltariListScrollView" && name != "UListScrollBar") return true;
            for (IntPtr p = h; p != main; p = GetParent(p)) {
                if (p == IntPtr.Zero || (GetWindowLong(p, -16) & 0x10000000) == 0) return true;
            }
            if (name == "UltariListScrollView") { duplicate |= list != IntPtr.Zero; list = h; }
            else { duplicate |= scroll != IntPtr.Zero; scroll = h; }
            return !duplicate;
        }, IntPtr.Zero);
        IntPtr parent = GetParent(list);
        if (duplicate || list == IntPtr.Zero || scroll == IntPtr.Zero || parent == IntPtr.Zero || parent != GetParent(scroll)) return null;
        return new IntPtr[]{list,scroll,parent};
    }
}
'@
}

function Get-GoeVisibleNotePane([IntPtr]$Main) {
    $pair = [GoeFolderButton]::VisiblePane($Main)
    if ($pair) { @{ List = $pair[0]; Scroll = $pair[1]; Parent = $pair[2] } }
}

function Test-GoeSamePane($A, $B) {
    $null -ne $A -and $null -ne $B -and $A.List -eq $B.List -and $A.Scroll -eq $B.Scroll -and $A.Parent -eq $B.Parent
}

function Wait-GoeNotePane([IntPtr]$Main, $Previous, [switch]$RequireChange) {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    $last = $null
    $changed = $null
    do {
        $pane = Get-GoeVisibleNotePane $Main
        if ($RequireChange -and $pane -and -not (Test-GoeSamePane $pane $Previous)) {
            if ($changed -and -not (Test-GoeSamePane $changed $pane)) { return }
            $changed = $pane
        }
        if ((Test-GoeSamePane $pane $last) -and (-not $RequireChange -or -not (Test-GoeSamePane $pane $Previous))) { return $pane }
        $last = $pane
        Start-Sleep -Milliseconds 75
    # 1.2 s was too short for a slow school PC right after a folder click (2026-11-18)
    } while ($deadline.ElapsedMilliseconds -lt 2500)
    # A build that shares a pane between folders can use the established visual checks.
    if ($RequireChange -and -not $changed -and (Test-GoeSamePane $pane $Previous)) { return $pane }
}

# Only folder buttons are invoked. No list contents are inspected in the sent folder.
# The caller has already selected inbox. Requiring the original pane after returning
# to inbox rejects recycled/recreated handles or a change of tab during calibration.
function Get-GoeInboxPaneProof([IntPtr]$Main, [scriptblock]$SelectSent, [scriptblock]$SelectInbox, [scriptblock]$CanSwitch) {
    $initial = Wait-GoeNotePane $Main
    if (-not $initial) { return @{ State = 'ambiguous' } }
    if (-not (& $CanSwitch)) { return @{ State = 'busy' } }
    try {
        & $SelectSent
        $sent = Wait-GoeNotePane $Main $initial -RequireChange
    } finally {
        $canReturn = & $CanSwitch
        if ($canReturn) { & $SelectInbox }
    }
    if (-not $canReturn) { return @{ State = 'busy' } }
    if (-not $sent) { return @{ State = 'ambiguous' } }
    $same = Test-GoeSamePane $initial $sent
    $returned = Wait-GoeNotePane $Main $sent -RequireChange:(-not $same)
    if (-not (Test-GoeSamePane $initial $returned)) { return @{ State = 'ambiguous' } }
    if ($same) { return @{ State = 'shared'; Pane = $returned } }
    if ($initial.List -eq $sent.List -or $initial.Scroll -eq $sent.Scroll -or $initial.Parent -eq $sent.Parent) { return @{ State = 'ambiguous' } }
    @{ State = 'inbox'; Pane = $returned; Sent = $sent }
}

function Get-GoeFolderState($InboxButton, $SentButton) {
    if ($null -eq $InboxButton -or $null -eq $SentButton) { return 'ambiguous' }
    $folder = 'unsupported'
    try {
        foreach ($pattern in [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern) {
            $left = $null; $right = $null
            $hasLeft = $InboxButton.TryGetCurrentPattern($pattern, [ref]$left)
            $hasRight = $SentButton.TryGetCurrentPattern($pattern, [ref]$right)
            if (-not $hasLeft -and -not $hasRight) { continue }
            if ($hasLeft -ne $hasRight) { return 'ambiguous' }
            if ($pattern -eq [System.Windows.Automation.SelectionItemPattern]::Pattern) {
                $inbox = $left.Current.IsSelected
                $sent = $right.Current.IsSelected
            } else {
                $inbox = $left.Current.ToggleState
                $sent = $right.Current.ToggleState
                if ($inbox -eq 'Indeterminate' -or $sent -eq 'Indeterminate') { return 'ambiguous' }
                $inbox = $inbox -eq 'On'
                $sent = $sent -eq 'On'
            }
            if ($inbox -eq $sent) { return 'ambiguous' }
            $selected = if ($inbox) { 'inbox' } else { 'sent' }
            if ($folder -ne 'unsupported' -and $folder -ne $selected) { return 'ambiguous' }
            $folder = $selected
        }
        $inbox = [GoeFolderButton]::Checked([IntPtr]$InboxButton.Current.NativeWindowHandle)
        $sent = [GoeFolderButton]::Checked([IntPtr]$SentButton.Current.NativeWindowHandle)
        if ($inbox -eq -1 -and $sent -eq -1) { return $folder }
        if ($inbox -lt 0 -or $sent -lt 0 -or $inbox -eq $sent) { return 'ambiguous' }
        $selected = if ($inbox -eq 1) { 'inbox' } else { 'sent' }
        if ($folder -ne 'unsupported' -and $folder -ne $selected) { return 'ambiguous' }
        $folder = $selected
    } catch { return 'ambiguous' }
    $folder
}
