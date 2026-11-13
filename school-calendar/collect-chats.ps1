param(
    [Parameter(Mandatory)][string]$Directory,
    [scriptblock]$CanInteract,
    [string[]]$Rooms,
    [switch]$ListRooms,
    # 선생님이 캘린더에서 직접 누른 경우: 브리티 창이 열려 있으면 최소화해 읽고 최소화된 채로 둔다.
    # 창이 보이는 상태에서 단추를 누르면 브리티가 맨 앞으로 튀어나오고, 끝나고 되돌려도 브리티가 맨 앞에 남는다
    # (앞에 있던 창으로 초점을 돌려주는 것은 Windows가 막음, 2026-11-12 실제 시험).
    [switch]$MinimizeFirst
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# reason: 안 된 까닭(앱이 선생님께 할 일을 알려 준다). not-running, tray, menu-open, not-minimized, in-use, screen.
$summary = [pscustomobject]@{ status = 'offline'; reason = ''; rooms = 0; read = 0; baselines = 0; added = 0; needsReview = 0; retry = 0; gaps = 0; scrolled = 0; holds = @(); baselineKeys = @() }
# 방마다 보류·끊김 사유를 남긴다(앱이 방 이름과 함께 보여 준다). missing: 목록에서 못 찾음, unstable: 글을 다 읽지 못함,
# mismatch: 다른 방이 열림, error: 그 밖의 오류, gap: 겹치는 글을 못 찾아 중간 글이 빠졌을 수 있음.
function Add-RoomHold([string]$key, [string]$reason) {
    $summary.holds = @($summary.holds) + @([pscustomobject]@{ key = $key; reason = $reason })
}
if ($ListRooms -and $Rooms.Count) { throw 'List rooms separately from collecting them.' }
# Without -Rooms, $Rooms is $null and "$null | Where-Object" still sends one item: check only when rooms were given.
if ($Rooms -and @($Rooms | Where-Object { $_ -cnotmatch '^[0-9a-f]{64}$' }).Count) { throw 'Invalid room key.' }
if (-not $ListRooms -and -not $Rooms.Count) {
    $summary.status = 'ready'
    return $summary
}
. (Join-Path $PSScriptRoot 'chat-journal.ps1')

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
if (-not ('BrityChat.Window' -as [type])) {
    Add-Type -Namespace BrityChat -Name Window -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
'@
}
if (-not ('BrityChat.Window2' -as [type])) {
    Add-Type -Namespace BrityChat -Name Window2 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, IntPtr extra);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int length);
'@
}
function Get-WindowTitle([IntPtr]$window) {
    $text = [Text.StringBuilder]::new(128)
    [void][BrityChat.Window2]::GetWindowText($window, $text, 128)
    $text.ToString()
}

$automation = [System.Windows.Automation.AutomationElement]
$control = [System.Windows.Automation.ControlType]
$scope = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$any = [System.Windows.Automation.Condition]::TrueCondition
$property = [System.Windows.Automation.PropertyCondition]
$buttons = $property::new($automation::ControlTypeProperty, $control::Button)
$groups = $property::new($automation::ControlTypeProperty, $control::Group)
$tabs = $property::new($automation::ControlTypeProperty, $control::TabItem)
$documents = $property::new($automation::ControlTypeProperty, $control::Document)
$streams = $property::new($automation::AutomationIdProperty, 'chatstream')
$messages = $property::new($automation::ControlTypeProperty, $control::ListItem)
$date = '(?:(?:오전|오후)\s*)?(?:\d{1,2}:\d{2}|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2})(?=\s|$)'
$roomDate = '\s+' + $date

function Assert-BrityMinimized {
    [uint32]$foregroundProcess = 0
    $foreground = [BrityChat.Window]::GetForegroundWindow()
    [void][BrityChat.Window]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
    $minimized = [BrityChat.Window]::IsIconic($handle)
    # 최소화돼 있을 때만 읽는다. 창이 보이는 상태(다른 창 뒤 포함)에서 단추를 누르면 브리티가 맨 앞으로 튀어나와
    # 선생님이 쓰던 창을 가린다(2026-11-12 실제 시험). Windows can still report the main handle as foreground after minimizing it.
    $brityWindowShown = $foregroundProcess -in $processes.Id -and
        [BrityChat.Window]::IsWindowVisible($foreground) -and -not [BrityChat.Window]::IsIconic($foreground)
    # 맨 앞이 브리티의 쪽지 쓰기 창이면 괜찮다: 메인 창이 최소화돼 있으면 단추를 눌러도 앞으로 나오지 않는다.
    if ($brityWindowShown -and $foreground -ne $handle -and (Get-WindowTitle $foreground) -ceq '쪽지 쓰기') { $brityWindowShown = $false }
    if (-not $minimized -or $brityWindowShown) {
        $summary | Add-Member -Force -NotePropertyName windowState -NotePropertyValue ([pscustomobject]@{
            minimized = $minimized
            foregroundIsMain = $foreground -eq $handle
            foregroundIsBrity = $foregroundProcess -in $processes.Id
            foregroundVisible = [BrityChat.Window]::IsWindowVisible($foreground)
            foregroundMinimized = [BrityChat.Window]::IsIconic($foreground)
        })
        throw [OperationCanceledException]::new('Brity is no longer minimized.')
    }
}

function Invoke-BrityButton($element, [string]$expectedLabel) {
    Assert-BrityMinimized
    $action = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$action)) {
        throw 'Brity button does not expose InvokePattern.'
    }
    Assert-BrityInputIdle
    if ($expectedLabel -and $element.Current.Name -cne $expectedLabel) { throw 'The room list changed.' }
    $action.Invoke()
    Assert-BrityMinimized
}

function Assert-BrityInputIdle {
    if ($CanInteract -and -not (& $CanInteract)) {
        throw [OperationCanceledException]::new('The user resumed input.')
    }
}

function Find-BrityButton([string]$name) {
    $matches = @($main.FindAll($scope::Descendants, $buttons) | Where-Object { $_.Current.Name -ceq $name })
    if ($matches.Count -eq 1) { $matches[0] }
}

function Get-BrityRoute {
    $document = $main.FindFirst($scope::Descendants, $documents)
    $value = $null
    if ($document -and $document.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
        [regex]::Match($value.Current.Value, '#/[a-zA-Z]+(?=[?/#]|$)').Value
    }
}

function Find-AllTab {
    if ((Get-BrityRoute) -cne '#/chat') { return }
    $items = @($main.FindAll($scope::Descendants, $tabs))
    if ($items.Count -lt 3) { return }
    $candidates = @($items | Where-Object { $_.Current.Name -ceq '전체' })
    if ($candidates.Count -eq 1) { $candidates[0] }
}

function Get-RoomButtons($panel) {
    foreach ($group in $panel.FindAll($scope::Children, $groups)) {
        if ($group.Current.AutomationId -eq 'chatstream') { continue }
        foreach ($button in $group.FindAll($scope::Children, $buttons)) {
            if ($button.Current.Name -match $roomDate) { $button }
        }
    }
}

function Test-RoomLabel([string]$label, [string]$title) {
    $title.Length -gt 0 -and $label.StartsWith($title, [StringComparison]::Ordinal) -and
        $label.Substring($title.Length) -match ('^\s+(?:\d+\s+)?' + $date)
}

function Get-RoomChoice($button) {
    $label = $button.Current.Name
    $match = [regex]::Match($label, $roomDate)
    if (-not $match.Success) { return }
    # The accessibility label includes mutable time and last-message text. The heading precedes both.
    $name = $label.Substring(0, $match.Index).Trim()
    if (-not $name) { return }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($name))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    [pscustomobject]@{ key = $key; label = $name; fullLabel = $label; button = $button }
}

function Read-SelectedRoom([string]$label) {
    Assert-BrityMinimized
    $stream = $main.FindFirst($scope::Descendants, $streams)
    if (-not $stream) { return }
    $panel = $walker.GetParent($stream)
    $titles = @(
        foreach ($button in $panel.FindAll($scope::Children, $buttons)) {
            $title = $button.Current.Name.Trim()
            if (Test-RoomLabel $label $title) { $title }
        }
    )
    if ($titles.Count -ne 1) { return }
    $rows = @($stream.FindAll($scope::Descendants, $messages) | ForEach-Object { $_.Current.Name })
    if (-not $rows.Count -or $rows -contains '') { return }
    [pscustomobject]@{ title = $titles[0]; messages = $rows; fingerprint = (ConvertTo-Json -InputObject $rows -Compress) }
}

# 지난번 마지막 글과 겹치는 곳이 화면에 없으면 맨 위 글로 스크롤해 옛 글을 더 불러온다(몇 번까지).
# 옛 글이 실제로 더 불러와지는지는 글이 많은 방에서 아직 확인하지 못했다(2026-11-12, 최소화 상태에서는 스크롤 영역이 잡히지 않았다).
function Read-RoomBack($snapshot, [string]$label, [string[]]$tail) {
    if (-not $tail.Count) { return $snapshot }
    foreach ($round in 1..6) {
        if ((Get-BrityChatOverlap -Previous $tail -Current (Get-BrityChatFingerprints -Messages $snapshot.messages)) -gt 0) { return $snapshot }
        Assert-BrityMinimized
        Assert-BrityInputIdle
        $stream = $main.FindFirst($scope::Descendants, $streams)
        $first = if ($stream) { $stream.FindFirst($scope::Descendants, $messages) }
        $item = $null
        if (-not $first -or -not $first.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$item)) { return $snapshot }
        $item.ScrollIntoView()
        $longer = $null
        foreach ($attempt in 1..12) {
            Start-Sleep -Milliseconds 500
            $current = Read-SelectedRoom $label
            if ($current -and $current.messages.Count -gt $snapshot.messages.Count) { $longer = $current; break }
        }
        if (-not $longer) { return $snapshot }
        $summary.scrolled++
        $snapshot = $longer
    }
    $snapshot
}

function Read-StableRoom($button, [string]$label) {
    $first = Read-SelectedRoom $label
    $previousFingerprint = $null
    if (-not $first) {
        $previousStream = $main.FindFirst($scope::Descendants, $streams)
        if ($previousStream) {
            $previousRows = @($previousStream.FindAll($scope::Descendants, $messages) | ForEach-Object { $_.Current.Name })
            $previousFingerprint = ConvertTo-Json -InputObject $previousRows -Compress
        }
        Invoke-BrityButton $button $label
    }
    foreach ($attempt in 1..16) {
        Start-Sleep -Milliseconds 250
        $current = Read-SelectedRoom $label
        if ($current -and $current.fingerprint -ceq $previousFingerprint) { $current = $null }
        if ($first -and $current -and $current.title -ceq $first.title -and $current.fingerprint -ceq $first.fingerprint) { return $current }
        $first = $current
    }
}

$mutex = [Threading.Mutex]::new($false, 'Local\BrityAssistantWatch')
$locked = $false
$restoreNotes = $false
# 단추를 누르면 최소화된 브리티라도 키보드 초점을 가져간다(실제 시험). 끝나면 시작할 때 앞에 있던 창(대개 캘린더)에 돌려준다.
$startForeground = [BrityChat.Window]::GetForegroundWindow()
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { $summary.status = 'busy'; return $summary }
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $processes = @(Get-Process -Name BrityMessenger -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)
    if (-not $processes.Count) { $summary.reason = 'not-running'; return $summary }
    $windows = @($automation::RootElement.FindAll($scope::Children, $any) | Where-Object {
        $_.Current.ProcessId -in $processes.Id -and $_.Current.Name -ceq 'Brity Messenger'
    })
    # 창을 닫아 트레이에만 있으면 데스크톱 목록에 창이 없다.
    if ($windows.Count -eq 0) { $summary.status = 'unavailable'; $summary.reason = 'tray'; return $summary }
    if ($windows.Count -ne 1) { $summary.status = 'unavailable'; $summary.reason = 'screen'; return $summary }
    $main = $windows[0]
    $handle = [IntPtr]$main.Current.NativeWindowHandle
    # 브리티 메뉴(오른쪽 클릭 메뉴 등)가 열려 있으면 화면이 메뉴만 내준다: 대화·쪽지 메뉴 단추가 안 보이고 메뉴가 있다.
    $menuOpen = { -not (Find-BrityButton '대화 메뉴') -and -not (Find-BrityButton '쪽지 메뉴') -and
        $main.FindFirst($scope::Descendants, $property::new($automation::ControlTypeProperty, $control::Menu)) }
    if (& $menuOpen) { $summary.status = 'unavailable'; $summary.reason = 'menu-open'; return $summary }
    if (-not [BrityChat.Window]::IsIconic($handle) -and $MinimizeFirst) {
        # 6 = 최소화(다음 창이 앞으로). 7(초점을 안 옮기는 최소화)은 수집 뒤 최소화된 브리티가 초점을 쥐고 있었다(실제 시험).
        [void][BrityChat.Window2]::ShowWindow($handle, 6)
        foreach ($attempt in 1..10) { if ([BrityChat.Window]::IsIconic($handle)) { break }; Start-Sleep -Milliseconds 100 }
        if ([BrityChat.Window]::IsIconic($handle)) { $summary | Add-Member -Force -NotePropertyName minimizedBrity -NotePropertyValue $true; Start-Sleep -Milliseconds 400 }
    }
    if (-not [BrityChat.Window]::IsIconic($handle)) { $summary.status = 'waiting'; $summary.reason = 'not-minimized'; return $summary }
    $route = Get-BrityRoute
    if ($route -cne '#/chat') {
        $menu = Find-BrityButton '대화 메뉴'
        if (-not $menu) { $summary.status = 'unavailable'; $summary.reason = 'screen'; return $summary }
        $restoreNotes = $route -ceq '#/directMessage'
        Invoke-BrityButton $menu
    }
    $allTab = $null
    foreach ($attempt in 1..20) {
        Assert-BrityMinimized
        $allTab = Find-AllTab
        if ($allTab) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $allTab) { $summary.status = 'unavailable'; return $summary }
    $selected = $null
    if (-not $allTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selected)) {
        $summary.status = 'unavailable'
        return $summary
    }
    if (-not $selected.Current.IsSelected) {
        Assert-BrityMinimized
        Assert-BrityInputIdle
        $selected.Select()
        Start-Sleep -Milliseconds 350
        Assert-BrityMinimized
        if (-not $selected.Current.IsSelected) { $summary.status = 'unavailable'; return $summary }
    }
    $targets = @()
    foreach ($attempt in 1..20) {
        Assert-BrityMinimized
        $allTab = Find-AllTab
        if ($allTab) {
            $panel = $walker.GetParent($walker.GetParent($allTab))
            $targets = @(Get-RoomButtons $panel | ForEach-Object { Get-RoomChoice $_ })
            if ($targets.Count) { break }
        }
        Start-Sleep -Milliseconds 250
    }
    $summary.rooms = $targets.Count
    $summary.status = 'ready'
    if ($ListRooms) {
        $choices = @($targets | Group-Object -Property key -CaseSensitive |
            Where-Object Count -eq 1 | ForEach-Object { $_.Group[0] | Select-Object key, label })
        $summary.needsReview = $targets.Count - $choices.Count
        $summary | Add-Member -NotePropertyName roomChoices -NotePropertyValue $choices
        return $summary
    }
    foreach ($key in ($Rooms | Sort-Object -Unique -CaseSensitive)) {
        Assert-BrityMinimized
        try {
            $candidates = @(Get-RoomButtons $panel | ForEach-Object { Get-RoomChoice $_ } | Where-Object key -CEQ $key)
            if ($candidates.Count -ne 1) { $summary.retry++; Add-RoomHold $key 'missing'; continue }
            $choice = $candidates[0]
            $snapshot = Read-StableRoom $choice.button $choice.fullLabel
            if (-not $snapshot) { $summary.retry++; Add-RoomHold $key 'unstable'; continue }
            Assert-BrityMinimized
            $matchingTitles = @(Get-RoomButtons $panel | Where-Object { Test-RoomLabel $_.Current.Name $snapshot.title })
            if ($matchingTitles.Count -ne 1 -or
                ($matchingTitles[0].GetRuntimeId() -join ':') -cne ($choice.button.GetRuntimeId() -join ':') -or
                $choice.label -cnotmatch ('^' + [regex]::Escape($snapshot.title) + '(?:\s+\d+)?$')) {
                $summary.needsReview++
                Add-RoomHold $key 'mismatch'
                continue
            }
            $snapshot = Read-RoomBack $snapshot $choice.fullLabel @(Get-BrityChatTail -Directory $Directory -RoomKey $snapshot.title)
            $saved = Save-BrityChatSnapshot -Directory $Directory -RoomKey $snapshot.title -RoomTitle $snapshot.title -Messages $snapshot.messages -ObservedAt ([DateTime]::UtcNow.ToString('o'))
            $summary.read++
            $summary.added += $saved.added
            if ($saved.status -eq 'baseline') { $summary.baselines++; $summary.baselineKeys = @($summary.baselineKeys) + @($key) }
            if ($saved.status -eq 'gap') { $summary.gaps++; Add-RoomHold $key 'gap' }
        } catch [OperationCanceledException] {
            throw
        } catch {
            $summary.retry++
            Add-RoomHold $key 'error'
        }
    }
} catch [OperationCanceledException] {
    $summary.status = 'waiting'
    $summary.reason = 'in-use'
} catch {
    $summary.status = 'unavailable'
    if (-not $summary.reason) { $summary.reason = 'screen' }
} finally {
    if ($restoreNotes) {
        try {
            Assert-BrityMinimized
            $menu = Find-BrityButton '쪽지 메뉴'
            if (-not $menu) { throw 'Note menu is unavailable.' }
            Invoke-BrityButton $menu
            $noteList = [System.Windows.Automation.AndCondition]::new(
                $property::new($automation::NameProperty, '쪽지'),
                $property::new($automation::ControlTypeProperty, $control::List)
            )
            $restored = $false
            foreach ($attempt in 1..20) {
                Assert-BrityMinimized
                if ((Get-BrityRoute) -ceq '#/directMessage' -and $main.FindFirst($scope::Descendants, $noteList)) {
                    $restored = $true
                    break
                }
                Start-Sleep -Milliseconds 250
            }
            if (-not $restored) { $summary.status = 'unavailable' }
        } catch [OperationCanceledException] {
            $summary.status = 'waiting'
        } catch {
            $summary.status = 'unavailable'
        }
    }
    if ($processes -and $startForeground -ne [IntPtr]::Zero) {
        [uint32]$startProcess = 0; [uint32]$nowProcess = 0
        [void][BrityChat.Window]::GetWindowThreadProcessId($startForeground, [ref]$startProcess)
        [void][BrityChat.Window]::GetWindowThreadProcessId([BrityChat.Window]::GetForegroundWindow(), [ref]$nowProcess)
        if ($startProcess -notin $processes.Id -and $nowProcess -in $processes.Id) {
            # Windows는 앞에 없는 프로그램이 초점을 옮기는 것을 막는다. Alt 한 번(누르고 뗌)이면 허용된다.
            [BrityChat.Window2]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
            [BrityChat.Window2]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
            [void][BrityChat.Window2]::SetForegroundWindow($startForeground)
        }
    }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
$summary
