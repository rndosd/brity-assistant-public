# 브리티 쪽지 열기 진단. 결과 파일에는 정해 둔 이름과 수치만 쓴다.
param([string]$Out, [switch]$OpenReport)
$ErrorActionPreference = 'Stop'
$baseDir = $PSScriptRoot
if (-not $Out) { $Out = Join-Path $baseDir '쪽지-열기-진단-결과.txt' }
$encoding = New-Object Text.UTF8Encoding $true
[IO.File]::WriteAllText($Out, "브리티 쪽지 열기 진단 3 · $(Get-Date -Format 'yyyy-MM-dd HH:mm')`r`n", $encoding)
function Record([string]$line) {
    [IO.File]::AppendAllText($Out, $line + [Environment]::NewLine, $encoding)
    Write-Host $line
}
function YesNo($v) { if ($v) { '예' } else { '아니오' } }

# 창마다 문서 내용을 메모리에서만 대조한다. 이름, 지문, 텍스트는 결과에 쓰지 않는다.
function Document-State($window) {
    $docs = $window.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Document))
    $values = foreach ($doc in $docs) {
        $pattern = $null
        if ($doc.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            $pattern.DocumentRange.GetText(-1)
        } else {
            ($doc.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Text)) | ForEach-Object { $_.Current.Name }) -join ' '
        }
    }
    [pscustomobject]@{ count = $docs.Count; text = (@($values) -join [char]31) }
}

function Inspect-Windows($mainWindow, $caseData, [switch]$Before) {
    $handleMain = $mainWindow.Current.NativeWindowHandle
    $windows = @($mainWindow) + @(Get-BrityWindows | Where-Object { $_.Current.NativeWindowHandle -ne $handleMain })
    $number = 0
    foreach ($window in $windows) {
        try {
            if ($window.Current.Name -eq $L.composeWindow) { continue }
            $number++
            $handle = $window.Current.NativeWindowHandle
            $docState = Document-State $window
            if ($Before) { $caseData.documents[$handle] = $docState; continue }
            $previous = $caseData.documents[$handle]
            $kind = if ($handle -eq $handleMain) { '메인' } elseif ($previous) { '기존 별도 창' } else { '새 별도 창' }
            $changed = if (-not $previous) { '비교 대상 없음' } elseif (-not ($previous.text -or $docState.text)) { '읽을 문서 글자 없음' } else { YesNo ($previous.text -cne $docState.text) }
            $groups = $window.FindAll($TS::Descendants, (New-Cond $AE::NameProperty $L.detailName))
            $recips = $window.FindAll($TS::Descendants, (New-Cond $AE::NameProperty $L.recipientLabel))
            Record "  창 $number ($kind) · 문서 $($docState.count) · 문서 글자 변화 $changed · 상세 보기 이름표 $($groups.Count) · 수신 이름표 $($recips.Count)"
            $tree = [Windows.Automation.TreeWalker]::ControlViewWalker
            $docPaths = foreach ($doc in $window.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Document))) {
                $types = @(); $node = $doc
                while ($node -and $types.Count -lt 6) {
                    $types += $node.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
                    if ([Windows.Automation.Automation]::Compare($node, $window)) { break }
                    $node = $tree.GetParent($node)
                }
                $types -join '<'
            }
            foreach ($path in @($docPaths | Sort-Object -Unique)) { Record "    문서 상위 구조 · $path" }
            $candidates = @()
            foreach ($g in $groups) { if ($g.Current.ControlType -eq $CT::Group) { $candidates += $g } }
            foreach ($recipient in $recips) {
                $g = $recipient
                while ($g) {
                    $atRoot = [Windows.Automation.Automation]::Compare($g, $window)
                    if (($atRoot -and $handle -eq $handleMain) -or (Find-ByName $g $CT::List $L.noteListName)) { break }
                    $docs = $g.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Document))
                    if ($docs.Count -gt 1) { Record '    수신 상위 영역에 문서가 여러 개 있음'; break }
                    if ($docs.Count -eq 1) {
                        if (-not @($candidates | Where-Object { [Windows.Automation.Automation]::Compare($_, $g) }).Count) { $candidates += $g }
                        break
                    }
                    if ($atRoot) { break }
                    $g = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($g)
                }
            }
            foreach ($g in $candidates) {
                $d = Read-DetailGroup $g
                $sameDay = if (-not $caseData.day) { '해당 없음' } else { YesNo ($d.datetime -and $d.datetime.StartsWith($caseData.day + ' ')) }
                Record ("    후보 · 목록과 보낸 사람 일치 {0} · 전체 제목 일치 {1} · 수집기 대조 통과 {2} · 날짜 형식 {3} · 대상 날짜 일치 {4} · 본문 {5}자 · 첨부 {6}개" -f
                    (YesNo ($d.sender -and $caseData.rowText.Contains($d.sender))), (YesNo ($d.title -and $caseData.rowText.Contains($d.title))),
                    (YesNo (Test-Match $d $caseData.rowText)), (YesNo $d.datetime), $sameDay, $d.body.Length, $d.files.Count)
            }
        } catch { Record "  창 구조 관찰 일부 실패 · $($_.Exception.GetType().Name)" }
    }
}

function Run-Case($item, [string]$label, [string]$day) {
    Record ""
    Record "[$label]"
    $caseData = @{ rowText = $item.text; day = $day; documents = @{}; observed = @{}; clock = [Diagnostics.Stopwatch]::StartNew(); lastPoll = ''; terminal = $false; guard = $false; matched = $false; candidate = $false; attempts = 0 }
    $observer = {
        param($stage, $value)
        switch ($stage) {
            'range' { Record "날짜 검색 일치 $($value[0])건 · 날짜 해석 불가 $($value[1])건 · 실제 첫 항목이 시험 대상과 같음 $(YesNo $value[2])" }
            'target' { if ($value -ne 1) { $caseData.terminal = $true; Record '판정 · 대상이 검색에서 빠졌거나 읽음 상태가 바뀌어 열기 생략' } }
            'row' { if (-not $value) { $caseData.terminal = $true; Record '판정 · 목록 항목은 검색됐으나 다시 찾아 열 수 없음' } }
            'before' {
                Inspect-Windows $win $caseData -Before
                Record "누르기 전 수집기가 같은 머리글을 확인함 $(YesNo $value)"
                $caseData.clock.Restart()
            }
            'action' {
                $caseData.attempts++
                if ($value -eq 'guard-skipped') { $caseData.guard = $true }
                Record "  $($caseData.clock.ElapsedMilliseconds)ms · $($caseData.attempts)번째 열기 · $value"
            }
            'poll' {
                $caseData.candidate = $caseData.candidate -or $value[0]
                $caseData.matched = $caseData.matched -or $value[1]
                $state = "본문 후보 $(YesNo $value[0]) · 목록 대조 $(YesNo $value[1]) · 대체 탐색 사용 $(YesNo $value[2])"
                if ($state -ne $caseData.lastPoll) { Record "  $($caseData.clock.ElapsedMilliseconds)ms · $state"; $caseData.lastPoll = $state }
            }
            { $_ -in 'alternative', 'criteria', 'stability' } {
                $message = switch ($stage) {
                    'alternative' { switch ($value) {
                        'existing-window-excluded' { '원래 열려 있던 별도 창을 대체 탐색에서 제외' }
                        'no-recipient-label' { '탐색한 창에 수신 이름표 없음' }
                        'main-root' { '본문 문서 확인 전 메인 창 최상위에 도달' }
                        'contains-list' { '쪽지 목록이 함께 들어 있는 영역 제외' }
                        'multiple-documents' { '문서가 두 개 이상인 영역 제외' }
                        'multiple-matches' { '조건을 통과한 본문 후보가 여러 개라 선택 보류' }
                    } }
                    'criteria' { "대체 후보 · 날짜 형식 $(YesNo $value[0]) · 날짜 조건 $(YesNo $value[1]) · 보낸 사람 일치 $(YesNo $value[2]) · 제목 일치 $(YesNo $value[3]) · 본문 또는 첨부 있음 $(YesNo $value[4])" }
                    'stability' { "본문 변화 조건 통과 $(YesNo $value[0]) · 직전 읽기와 동일 $(YesNo $value[1])" }
                }
                if ($message -and -not $caseData.observed.ContainsKey($message)) {
                    $caseData.observed[$message] = $true
                    Record "  $($caseData.clock.ElapsedMilliseconds)ms · $message"
                }
            }
            'result' {
                $caseData.terminal = $true
                $verdict = if ($value[1] -and $value[0]) { '원문 대조와 연속 두 번의 안정성 확인 통과' }
                    elseif ($caseData.guard) { '대상 ID 또는 읽음 상태가 달라 열기 생략' }
                    elseif (-not $value[0]) { '행 실행·선택 요청을 수집기가 완료하지 못함' }
                    elseif ($caseData.matched) { '머리글 대조 후 본문 변화·안정성 확인 미통과' }
                    elseif ($caseData.candidate) { '본문 후보는 읽었으나 목록 대조 미통과' }
                    else { '열기 요청 후 수집기가 해당 본문 후보를 확보하지 못함' }
                Record "판정 · $verdict ($($caseData.clock.ElapsedMilliseconds)ms)"
            }
            'inspect' { Inspect-Windows $win $caseData }
        }
    }
    try {
        $argsForCase = @{ DiagnosticReadId = $item.id; Observe = $observer; Max = 1 }
        if ($day) { $argsForCase.From = $day; $argsForCase.To = $day } else { $argsForCase.Id = @($item.id) }
        $null = & $collectorFile @argsForCase
        if (-not $caseData.terminal) { Record '판정 보류 · 수집기가 행 시험에 도달하지 못함' }
    } catch { Record "이 시험 오류 · $($_.Exception.GetType().Name) · $($_.InvocationInfo.ScriptLineNumber)행" }
}

$mutex = $null
$locked = $false
try {
    Add-Type -AssemblyName System.Windows.Forms
    $collectorFile = Join-Path $baseDir 'collector\collect-notes.ps1'
    . $collectorFile -FunctionsOnly
    . (Join-Path $baseDir 'collector\list-date.ps1')
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ProbeDisplay { [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h); [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; } [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r); }'
    $mutex = [Threading.Mutex]::new($false, 'Local\BrityAssistantWatch')
    try { $locked = $mutex.WaitOne(90000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { Record '시험 생략 · 캘린더 수집이 90초 안에 끝나지 않음'; return }
    $mainWindow = Get-AppWindow -MainOnly
    if (-not $mainWindow) { Record '시험 생략 · 현재 Windows 세션에 브리티 메인 창이 없음'; return }
    $processInfo = Get-Process -Id $mainWindow.Current.ProcessId
    $hwnd = [IntPtr]$mainWindow.Current.NativeWindowHandle
    $bounds = New-Object 'ProbeDisplay+Rect'
    [void][ProbeDisplay]::GetWindowRect($hwnd,[ref]$bounds)
    $displayState = if ([BrityWin.Finder]::IsIconic($hwnd)) { '최소화' } elseif ([BrityWin.Finder]::IsWindowVisible($hwnd)) { '보임' } else { '숨김' }
    Record "브리티 $($processInfo.MainModule.FileVersionInfo.ProductVersion) · Windows $([Environment]::OSVersion.Version) · 화면 $([Windows.Forms.Screen]::AllScreens.Count)개 · 창 $displayState $($bounds.R - $bounds.L)×$($bounds.B - $bounds.T) · DPI $([ProbeDisplay]::GetDpiForWindow($hwnd))"
    $initialList = Find-ByName $mainWindow $CT::List $L.noteListName
    if (-not $initialList) {
        $menu = Find-ByName $mainWindow $CT::Button $L.noteMenu
        if ($menu -and (Invoke-El $menu)) {
            for ($i = 0; $i -lt 15 -and -not $initialList; $i++) { Start-Sleep -Milliseconds 400; $initialList = Find-ByName $mainWindow $CT::List $L.noteListName }
        }
        if (-not $initialList) { Record '시험 생략 · 쪽지 메뉴 또는 목록을 찾지 못함'; return }
    }
    Reset-NoteList $mainWindow
    $initialList = Find-ByName $mainWindow $CT::List $L.noteListName
    $first = @(Get-NoteItems $initialList)
    $read = @($first | Where-Object { $_.id -and $_.text -and -not $_.unread })
    Record "첫 화면 목록 $($first.Count)건 · 읽은 시험 후보 $($read.Count)건"
    $already = Read-Detail $mainWindow
    $near = $read | Where-Object { -not (Test-Match $already $_.text) } | Select-Object -First 1
    if (-not $near) { $near = $read | Select-Object -First 1 }
    if ($near) { Run-Case $near '첫 화면 쪽지 · ID로 열기' '' }
    else { Record '첫 화면 시험 생략 · 읽은 대상 없음' }

    $firstIds = @($first | ForEach-Object { $_.id })
    $far = $null
    $fallback = $null
    $seenDays = @{}
    foreach ($item in $first) { $day = Get-ListDate $item.text; if ($day) { $seenDays[$day] = $true } }
    for ($steps = 0; $steps -lt 12 -and -not $far; $steps++) {
        if (-not (Move-NoteList $mainWindow)) { break }
        $currentList = Find-ByName $mainWindow $CT::List $L.noteListName
        if (-not $currentList) { break }
        foreach ($item in (Get-NoteItems $currentList)) {
            $day = Get-ListDate $item.text
            if (-not $day) { continue }
            if ($item.id -and -not $item.unread -and $firstIds -notcontains $item.id) {
                if (-not $fallback) { $fallback = $item }
                if (-not $seenDays.ContainsKey($day)) { $far = $item; break }
            }
            $seenDays[$day] = $true
        }
    }
    if (-not $far) { $far = $fallback }
    if ($far) { Run-Case $far '목록 아래 쪽지 · 날짜로 검색 후 다시 찾아 열기' (Get-ListDate $far.text) }
    else {
        Record '목록 아래쪽에 날짜를 읽을 수 있는 읽은 대상 없음'
        $other = $read | Where-Object { $_.id -ne $near.id -and (Get-ListDate $_.text) } | Select-Object -First 1
        if (-not $other -and $near -and (Get-ListDate $near.text)) { $other = $near; Record '같은 쪽지로 날짜 경로만 시험함' }
        if ($other) { Run-Case $other '첫 화면 쪽지 · 날짜로 검색 (대체 시험)' (Get-ListDate $other.text) }
        else { Record '날짜 시험 생략 · 날짜를 읽을 수 있는 읽은 대상 없음' }
    }
} catch { Record "진단 중단 · $($_.Exception.GetType().Name) · $($_.InvocationInfo.ScriptLineNumber)행" }
finally {
    if ($locked) {
        try { if ($initialList) { Reset-NoteList $mainWindow } } catch { Record '초기 목록 위치로 돌아가지 못함' }
        $mutex.ReleaseMutex()
    }
    if ($mutex) { $mutex.Dispose() }
    Record '종료 · 이 결과 TXT 한 개만 전달해 주세요.'
    if ($OpenReport) { & notepad.exe $Out }
}
