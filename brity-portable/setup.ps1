param([switch]$CheckLayout)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$watchPath = Join-Path $PSScriptRoot 'watch.ps1'
$labelsPath = Join-Path $PSScriptRoot 'labels.json'
$deliveryPath = Join-Path $PSScriptRoot 'inbox\codex-delivery.json'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$state = @{ operation = $null; statusJob = $null; startingWatcher = $null; running = $false; startup = $false; statusKnown = $false }

function Get-ThreadId([string]$Text) {
    $match = [regex]::Match($Text.Trim(), '^(?:codex://threads/)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/?$', 'IgnoreCase')
    if ($match.Success) { return $match.Groups[1].Value.ToLowerInvariant() }
    return ''
}

function Get-SavedThread {
    if (Test-Path -LiteralPath $deliveryPath) {
        $delivery = Get-Content -LiteralPath $deliveryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$delivery.threadId
    }
    return ''
}

function Save-DownloadPath {
    $folder = Get-Item -LiteralPath $downloadBox.Text.Trim() -ErrorAction SilentlyContinue
    if (-not $folder -or -not $folder.PSIsContainer -or $folder.PSProvider.Name -ne 'FileSystem') {
        throw '브리티가 첨부 파일을 내려받는 기존 폴더를 지정하세요.'
    }
    $labels = Get-Content -LiteralPath $labelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($labels.downloadDir -eq $folder.FullName) { return }
    $labels.downloadDir = $folder.FullName
    [IO.File]::WriteAllText($labelsPath, ($labels | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8)
}

function Start-WatchProcess([string]$Arguments, [bool]$WaitForResult) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $windowsPowerShell
    $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" {1}' -f $watchPath, $Arguments
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $WaitForResult
    $info.RedirectStandardError = $WaitForResult
    $process = [System.Diagnostics.Process]::Start($info)
    if ($WaitForResult) {
        return @{
            process = $process
            output = $process.StandardOutput.ReadToEndAsync()
            errorOutput = $process.StandardError.ReadToEndAsync()
        }
    }
    return $process
}

function Show-Problem([string]$Message) {
    [void][System.Windows.Forms.MessageBox]::Show($form, $Message, '브리티 쪽지 모으기', 'OK', 'Warning')
}

function Update-Controls {
    $busy = $null -ne $state.operation -or $null -ne $state.startingWatcher
    $editable = $state.statusKnown -and -not ($busy -or $state.running)
    $downloadBox.Enabled = $editable
    $browseButton.Enabled = $editable
    $threadBox.Enabled = $editable
    $connectButton.Enabled = $editable
    $startButton.Enabled = $editable
    $stopButton.Enabled = $state.statusKnown -and -not $busy -and $state.running
    $autoOnButton.Enabled = $state.statusKnown -and -not ($busy -or $state.startup)
    $autoOffButton.Enabled = $state.statusKnown -and -not $busy -and $state.startup
    $watchStatus.Text = if (-not $state.statusKnown) { '감시 상태 확인 중' } elseif ($state.running) { '현재 상태  •  감시 중' } else { '현재 상태  •  중지됨' }
    $autoStatus.Text = if (-not $state.statusKnown) { '' } elseif ($state.startup) { '자동 시작  •  켜짐' } else { '자동 시작  •  꺼짐' }
}

function Start-Operation([string]$Name, [string]$Arguments, [string]$Progress, [string]$Success) {
    if ($state.operation) { return }
    $state.operation = Start-WatchProcess $Arguments $true
    $state.operation.name = $Name
    $state.operation.success = $Success
    $feedback.Text = $Progress
    Update-Controls
}

function Add-Label([string]$Name, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height = 25) {
    $control = New-Object System.Windows.Forms.Label
    $control.Name = $Name
    $control.Text = $Text
    $control.SetBounds($X, $Y, $Width, $Height)
    $form.Controls.Add($control)
    return $control
}

function Add-TextBox([string]$Name, [int]$Y) {
    $control = New-Object System.Windows.Forms.TextBox
    $control.Name = $Name
    $control.SetBounds(24, $Y, 510, 28)
    $form.Controls.Add($control)
    return $control
}

function Add-Button([string]$Name, [string]$Text, [int]$X, [int]$Y, [int]$Width) {
    $control = New-Object System.Windows.Forms.Button
    $control.Name = $Name
    $control.Text = $Text
    $control.SetBounds($X, $Y, $Width, 36)
    $form.Controls.Add($control)
    return $control
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '브리티 쪽지 모으기'
$form.ClientSize = New-Object System.Drawing.Size(704, 414)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.AutoScaleMode = 'Dpi'
$form.Font = New-Object System.Drawing.Font('맑은 고딕', 10)
$title = Add-Label 'Title' '브리티 쪽지 모으기' 24 19 656 33
$title.Font = New-Object System.Drawing.Font('맑은 고딕', 16, [System.Drawing.FontStyle]::Bold)
[void](Add-Label 'Intro' '새 쪽지를 30초 간격으로 확인하고, 지정한 Codex 채팅에 모읍니다.' 24 55 656)
[void](Add-Label 'DownloadLabel' '브리티 첨부 다운로드 폴더' 24 98 656)
$downloadBox = Add-TextBox 'DownloadPath' 124
$browseButton = Add-Button 'Browse' '폴더 선택' 546 119 134
[void](Add-Label 'ThreadLabel' '받을 Codex 채팅 링크 또는 ID' 24 174 656)
$threadBox = Add-TextBox 'Thread' 200
$connectButton = Add-Button 'Connect' '연결 시험 및 저장' 546 195 134
[void](Add-Label 'ReadNotice' '시작하면 기존 안 읽은 쪽지도 열며, 연 쪽지는 읽음으로 표시됩니다.' 24 249 656)
$startButton = Add-Button 'Start' '감시 시작' 24 282 124
$stopButton = Add-Button 'Stop' '감시 중지' 157 282 124
$watchStatus = Add-Label 'WatchStatus' '' 307 290 373
$autoOnButton = Add-Button 'EnableStartup' '로그인 시 자동 시작' 24 332 164
$autoOffButton = Add-Button 'DisableStartup' '자동 시작 해제' 198 332 150
$autoStatus = Add-Label 'StartupStatus' '' 373 340 307
$feedback = Add-Label 'Feedback' '' 24 380 656 32

if ($CheckLayout) {
    $required = 'DownloadPath', 'Thread', 'Connect', 'Start', 'Stop', 'EnableStartup', 'DisableStartup'
    foreach ($name in $required) {
        if (-not $form.Controls[$name]) { throw "Missing launcher control: $name" }
    }
    foreach ($control in $form.Controls) {
        if (-not $form.ClientRectangle.Contains($control.Bounds)) { throw "Out-of-bounds control: $($control.Name)" }
    }
    $form.Dispose()
    Write-Output 'launcher-layout-ok'
    return
}

try {
    $labels = Get-Content -LiteralPath $labelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $downloadBox.Text = [string]$labels.downloadDir
    $savedThread = Get-SavedThread
    if ($savedThread) { $threadBox.Text = 'codex://threads/' + $savedThread }
} catch {
    Show-Problem "설정을 읽을 수 없습니다. ZIP을 모두 풀었는지 확인하세요.`n$($_.Exception.Message)"
    $form.Dispose()
    return
}

$browseButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '브리티 첨부 다운로드 폴더를 선택하세요.'
    if (Test-Path -LiteralPath $downloadBox.Text -PathType Container) { $dialog.SelectedPath = $downloadBox.Text }
    try {
        if ($dialog.ShowDialog($form) -eq 'OK') { $downloadBox.Text = $dialog.SelectedPath }
    } finally { $dialog.Dispose() }
})

$connectButton.Add_Click({
    try {
        if ($state.running) { throw '채팅을 바꾸려면 감시를 먼저 중지하세요.' }
        $threadId = Get-ThreadId $threadBox.Text
        if (-not $threadId) { throw '이 PC에서 열 수 있는 기존 Codex 채팅의 링크 또는 ID를 입력하세요.' }
        Save-DownloadPath
        Start-Operation 'connect' "-ConnectCodex $threadId" '선택한 채팅에 테스트 메시지를 보내는 중입니다.' '채팅 연결을 저장했습니다. Codex에서 테스트 메시지를 확인하세요.'
    } catch { Show-Problem $_.Exception.Message }
})

$startButton.Add_Click({
    try {
        if ($state.running) { return }
        $threadId = Get-ThreadId $threadBox.Text
        if (-not $threadId -or $threadId -ne (Get-SavedThread)) { throw '먼저 받을 채팅을 입력하고 연결 시험 및 저장을 누르세요.' }
        Save-DownloadPath
        $state.startingWatcher = Start-WatchProcess '-Loop' $false
        $feedback.Text = '감시 프로그램이 시작되기를 기다리는 중입니다.'
        Update-Controls
    } catch { Show-Problem $_.Exception.Message }
})

$stopButton.Add_Click({
    try { Start-Operation 'stop' '-Stop' '감시를 중지하는 중입니다.' '중지 요청을 보냈습니다.' }
    catch { Show-Problem $_.Exception.Message }
})

$autoOnButton.Add_Click({
    try {
        $threadId = Get-ThreadId $threadBox.Text
        if (-not $threadId -or $threadId -ne (Get-SavedThread)) { throw '자동 시작을 켜기 전에 Codex 채팅을 연결하세요.' }
        if (-not $state.running) { Save-DownloadPath }
        Start-Operation 'startup' '-InstallStartup' '자동 시작을 설정하는 중입니다.' '다음 Windows 로그인부터 자동으로 감시합니다.'
    } catch { Show-Problem $_.Exception.Message }
})

$autoOffButton.Add_Click({
    try { Start-Operation 'startup' '-UninstallStartup' '자동 시작을 해제하는 중입니다.' 'Windows 로그인 시 자동 시작을 해제했습니다.' }
    catch { Show-Problem $_.Exception.Message }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({
    $operation = $state.operation
    if ($operation -and $operation.process.HasExited -and $operation.output.IsCompleted -and $operation.errorOutput.IsCompleted) {
        $state.operation = $null
        try {
            $output = $operation.output.GetAwaiter().GetResult()
            $errorOutput = $operation.errorOutput.GetAwaiter().GetResult()
            if ($operation.process.ExitCode -ne 0) {
                $feedback.Text = '실행에 실패했습니다. 자세한 내용을 확인하세요.'
                $details = ($errorOutput + "`n" + $output).Trim()
                if ($details) { Show-Problem $details }
            } elseif ($operation.name -eq 'connect' -and $output -notmatch '(?m)^codex-connected [0-9a-f-]+\s*$') {
                $feedback.Text = 'Codex 연결 확인에 실패했습니다.'
            } else {
                $feedback.Text = $operation.success
            }
        } catch { Show-Problem $_.Exception.Message }
        finally { $operation.process.Dispose() }
    }
    $job = $state.statusJob
    if ($job -and $job.process.HasExited -and $job.output.IsCompleted -and $job.errorOutput.IsCompleted) {
        $state.statusJob = $null
        try {
            if ($job.process.ExitCode -ne 0) { throw '감시 상태를 확인하지 못했습니다. ZIP을 모두 풀었는지 확인하세요.' }
            $status = $job.output.GetAwaiter().GetResult() | ConvertFrom-Json
            if ($status.running -isnot [bool] -or $status.startup -isnot [bool]) { throw '감시 상태를 읽을 수 없습니다.' }
            $state.running = $status.running
            $state.startup = $status.startup
            $state.statusKnown = $true
        } catch {
            $state.statusKnown = $false
            if (-not $state.operation) { $feedback.Text = $_.Exception.Message }
        } finally { $job.process.Dispose() }
    }
    if (-not $state.statusJob -and -not $state.operation) {
        try { $state.statusJob = Start-WatchProcess '-Status' $true }
        catch {
            $state.statusKnown = $false
            $feedback.Text = '감시 프로그램을 실행할 수 없습니다.'
        }
    }
    $watcher = $state.startingWatcher
    if ($watcher -and ($watcher.HasExited -or $state.running)) {
        if ($watcher.HasExited) {
            $feedback.Text = '감시가 시작되기 전에 종료됐습니다. 종료 코드 {0}. 다른 브리티 감시가 실행 중인지 확인하세요.' -f $watcher.ExitCode
        } else {
            $feedback.Text = '감시를 시작했습니다. 이 설정 창을 닫아도 계속 확인합니다.'
        }
        $watcher.Dispose()
        $state.startingWatcher = $null
    }
    Update-Controls
})

$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($state.operation) {
        $eventArgs.Cancel = $true
        $feedback.Text = '진행 중인 작업이 끝난 뒤 설정 창을 닫으세요.'
    }
})

try {
    Update-Controls
    $timer.Start()
    [void]$form.ShowDialog()
} finally {
    $timer.Dispose()
    if ($state.statusJob) { $state.statusJob.process.Dispose() }
    if ($state.startingWatcher) { $state.startingWatcher.Dispose() }
    $form.Dispose()
}
