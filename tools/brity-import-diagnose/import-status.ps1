param([string]$CalendarRoot)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Read-Record([string]$Path) {
    # Preserve JSON arrays, including an empty task list, on Windows PowerShell 5.1.
    $json = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    (ConvertFrom-Json -InputObject ('{"value":' + $json + '}'))
}

if (-not $CalendarRoot) {
    Add-Type -AssemblyName System.Windows.Forms
    $pick = New-Object Windows.Forms.OpenFileDialog
    $pick.Title = '평소 사용하는 브리티 캘린더 실행 파일을 선택해 주세요'
    $pick.Filter = '브리티 캘린더|Brity Messenger Calendar.exe;Start-Calendar.cmd'
    try {
        if ($pick.ShowDialog() -ne 'OK') { return }
        $CalendarRoot = [IO.Path]::GetDirectoryName($pick.FileName)
    } finally { $pick.Dispose() }
}

$package = Join-Path $CalendarRoot 'runtime\resources\app\package.json'
if (-not [IO.File]::Exists($package)) {
    Write-Output '선택한 폴더에서 캘린더를 찾지 못했습니다. 압축을 풀어 평소 사용하는 실행 파일을 골라 주세요.'
    return
}

$inbox = Join-Path $CalendarRoot 'collector\inbox'
Write-Output '브리티 쪽지 가져오기 진단'
try {
    $version = (Read-Record $package).value.version
    if ($version -match '^\d{1,4}\.\d{1,4}\.\d{1,4}$') { Write-Output "앱 버전 $version" }
} catch {}

$settings = Join-Path $CalendarRoot 'calendar-data\settings.json'
try {
    $configured = (Read-Record $settings).value.inboxDir
    $source = if (-not $configured -or [IO.Path]::GetFullPath($configured) -eq $inbox) { '기본 폴더' } else { '다른 폴더' }
    Write-Output "앱이 읽는 쪽지 위치  $source"
} catch { Write-Output '앱이 읽는 쪽지 위치  확인 불가' }

$latest = Join-Path $inbox 'latest.json'
if ([IO.File]::Exists($latest)) {
    try {
        $record = (Read-Record $latest).value
        if ($null -eq $record.list -or $null -eq $record.opened) { throw 'format' }
        $attempts = @($record.opened)
        $rows = @($attempts | Where-Object { $_.error -eq 'list item not found' }).Count
        $panes = @($attempts | Where-Object { $_.error -eq 'detail pane not found' }).Count
        $verified = @($attempts | Where-Object { $_.verified -eq $true }).Count
        $mismatch = @($attempts | Where-Object { $_.verified -eq $false }).Count
        $other = $attempts.Count - $rows - $panes - $verified - $mismatch
        $stamp = [IO.File]::GetLastWriteTime($latest).ToString('MM-dd HH:mm')
        Write-Output "마지막 수집 기록  $stamp"
        Write-Output "목록 $(@($record.list).Count)건 / 열기 시도 $($attempts.Count)건 / 원문 확인 ${verified}건"
        Write-Output "목록 항목 못 찾음 ${rows}건 / 상세창 못 찾음 ${panes}건 / 원문 대조 실패 ${mismatch}건 / 기타 ${other}건"
    } catch { Write-Output '마지막 수집 기록  읽기 실패' }
} else { Write-Output '마지막 수집 기록  없음' }

try {
    $notes = Join-Path $inbox 'notes'
    $files = [IO.Directory]::GetFiles($notes, '*.json').Length
    Write-Output "기본 폴더에 저장된 쪽지  ${files}건"
} catch { Write-Output '기본 쪽지 폴더  없거나 읽기 실패' }

try {
    $saved = (Read-Record (Join-Path $CalendarRoot 'calendar-data\tasks.json')).value
    if ($saved -is [array]) { $tasks = $saved }
    elseif ($saved.version -eq 1 -and $saved.tasks -is [array]) { $tasks = $saved.tasks }
    else { throw 'format' }
    $linked = @($tasks | Where-Object { $_.noteId }).Count
    Write-Output "캘린더에 등록된 쪽지  ${linked}건"
} catch { Write-Output '캘린더 업무 기록  없거나 읽기 실패' }
