param(
    [Parameter(Mandatory)][ValidateSet('Inspect', 'Tick', 'ChatRooms', 'Chats', 'RangePreview', 'Range')][string]$Mode,
    [Parameter(Mandatory)][string]$ScriptsDir,
    [string]$ChatDirectory,
    [switch]$Force,  # Tick: collect even while the teacher is using Brity (they confirmed in the calendar)
    [ValidatePattern('^(\d{4}-\d{2}-\d{2})?$')][string]$From = '',  # RangePreview/Range: past notes by list date
    [ValidatePattern('^(\d{4}-\d{2}-\d{2})?$')][string]$To = ''
)
# Inspect: check that Brity's note list can be read. Tick: collect new notes. Chats: read chat rooms.
# The 1-minute input-idle wait was removed on 2026-11-12. While Brity is in front, Tick reports 'in-use'
# and the calendar asks the teacher before collecting.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-Result([string]$Status, $InboxDir = $null, [bool]$Managed = $false, [int]$Imported = 0) {
    [pscustomobject]@{ status = $Status; inboxDir = $InboxDir; managed = $Managed; imported = $Imported } | ConvertTo-Json -Compress
}

function Find-WatcherInbox {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $processes = Get-CimInstance Win32_Process -Filter "(Name='powershell.exe' OR Name='pwsh.exe') AND SessionId=$session" -OperationTimeoutSec 5
    $watchers = @($processes | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -match '(?i)(?:^|\s)-File\s+(?:"[^"\r\n]*[\\/]watch\.ps1"|[^\s"\r\n]*[\\/]watch\.ps1)(?=\s|$).*?(?:\s)-Loop(?=\s|$)'
    })
    if ($watchers.Count -ne 1) { return $null }

    $command = $watchers[0].CommandLine
    $fileArgument = [regex]::Match($command, '(?i)(?:^|\s)-File\s+(?:"(?<quoted>[^"\r\n]+)"|(?<bare>[^\s"\r\n]+))')
    $watcher = $fileArgument.Groups['quoted'].Value + $fileArgument.Groups['bare'].Value
    if ($watcher -notmatch '^[a-zA-Z]:[\\/]' -or -not (Test-Path -LiteralPath $watcher -PathType Leaf)) { return $null }
    $directory = Split-Path -Parent $watcher
    $labels = Join-Path $directory 'labels.json'
    if (-not (Test-Path -LiteralPath (Join-Path $directory 'collect-notes.ps1') -PathType Leaf) -or
        -not (Test-Path -LiteralPath $labels -PathType Leaf)) { return $null }
    if ((Get-Content -LiteralPath $labels -Raw -Encoding utf8 | ConvertFrom-Json).processName -ne 'BrityMessenger') { return $null }

    $scriptSource = Get-Content -LiteralPath $watcher -Raw -Encoding utf8
    if ($scriptSource -notmatch 'Local\\BrityAssistantWatch') { return $null }
    $watchArgs = $command.Substring($fileArgument.Index + $fileArgument.Length)
    if ($watchArgs -match '(?i)(?:^|\s)-Inbox(?=\s|$)') {
        $tokens = $null
        $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile($watcher, [ref]$tokens, [ref]$errors)
        if ($errors.Count -or 'Inbox' -notin @($ast.ParamBlock.Parameters.Name.VariablePath.UserPath)) { return $null }
        $inboxArgument = [regex]::Match($watchArgs, '(?i)(?:^|\s)-Inbox\s+(?:"(?<quoted>[^"\r\n]+)"|(?<bare>[^\s"\r\n]+))')
        $inbox = $inboxArgument.Groups['quoted'].Value + $inboxArgument.Groups['bare'].Value
        if ($inbox -notmatch '^[a-zA-Z]:[\\/]') { return $null }
        return [IO.Path]::GetFullPath($inbox)
    }
    if ($scriptSource -match '(?m)^\s*\$inbox\s*=\s*Join-Path\s+\$root\s+[''\"]inbox[''\"]\s*$') {
        return (Join-Path $directory 'inbox')
    }
    return $null
}

$mutex = $null
$locked = $false
try {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $running = Get-Process -Name BrityMessenger -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session
    if (-not $running) { Write-Result 'offline'; return }

    $mutex = [Threading.Mutex]::new($false, 'Local\BrityAssistantWatch')
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        try { $activeInbox = Find-WatcherInbox } catch { $activeInbox = $null }
        if ($Mode -in 'ChatRooms', 'Chats') { Write-Result 'conflict' }
        elseif ($activeInbox) { Write-Result 'ready' $activeInbox }
        else { Write-Result 'conflict' }
        return
    }

    $watch = Join-Path $ScriptsDir 'watch.ps1'
    $collect = Join-Path $ScriptsDir 'collect-notes.ps1'
    $labels = Join-Path $ScriptsDir 'labels.json'
    foreach ($file in @($watch, $collect, $labels)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Write-Result 'unavailable'; return }
    }

    $inbox = Join-Path $ScriptsDir 'inbox'
    if ($Mode -eq 'RangePreview' -or $Mode -eq 'Range') {
        # Load past notes by date. Only the notes Brity's list shows right now can be reached (2026-11-12: first 10).
        $rangeArgs = @{ Inbox = $inbox; Max = 20 }
        if ($From) { $rangeArgs.From = $From }
        if ($To) { $rangeArgs.To = $To }
        if ($Mode -eq 'RangePreview') { $rangeArgs.ListOnly = $true } else { $rangeArgs.Download = $true }
        $output = @(& $collect @rangeArgs 2>$null)
        $result = [ordered]@{ status = 'unverified'; inboxDir = $inbox; managed = $true; imported = 0 }
        foreach ($line in $output) {
            if ($line -match '^range-preview visible=(\d+) matched=(\d+) new=(\d+) unknown=(\d+) oldest=(\S*)$') {
                $result.status = 'ready'; $result.visible = [int]$Matches[1]; $result.matched = [int]$Matches[2]
                $result.fresh = [int]$Matches[3]; $result.unknown = [int]$Matches[4]; $result.oldest = $Matches[5]
            } elseif ($line -match '^list=(\d+) unread=\d+ opened=(\d+) verified=(\d+)') {
                $result.status = 'ready'; $result.visible = [int]$Matches[1]; $result.imported = [int]$Matches[3]; $result.opened = [int]$Matches[2]
            } elseif ($line -match '^range matched=(\d+) remaining=(\d+)$') {
                $result.matched = [int]$Matches[1]; $result.remaining = [int]$Matches[2]
            }
        }
        [pscustomobject]$result | ConvertTo-Json -Compress
        return
    }
    if ($Mode -in 'ChatRooms', 'Chats') {
        $chatArgs = @{ Directory = $ChatDirectory }
        if ($Mode -eq 'ChatRooms') { $chatArgs.ListRooms = $true }
        else { $chatArgs.Rooms = @((ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()))) }
        $result = & (Join-Path $PSScriptRoot 'collect-chats.ps1') @chatArgs
        if ($Mode -eq 'Chats') {
            try {
                [void][IO.Directory]::CreateDirectory($ChatDirectory)
                $result | Add-Member -NotePropertyName checkedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o'))
                $result | Add-Member -NotePropertyName roomKeys -NotePropertyValue @($chatArgs.Rooms)
                [IO.File]::WriteAllText((Join-Path $ChatDirectory 'status.json'), (ConvertTo-Json -InputObject $result -Depth 4), [Text.UTF8Encoding]::new($false))
            } catch {}
        }
        if ($result.status -eq 'waiting') { $result.status = 'in-use' }
        if ($result.status -eq 'busy') { $result.status = 'conflict' }
        $result | Add-Member -NotePropertyName inboxDir -NotePropertyValue $inbox
        $result | ConvertTo-Json -Depth 4 -Compress
        return
    }
    if ($Mode -eq 'Inspect') {
        $collectArgs = @{ Inbox = $inbox }
        # A freshly started Brity exposes its screen to UI Automation only after it is asked once while its
        # window is visible: the first read fails and one a few seconds later works. Ask again before giving up.
        foreach ($attempt in 1..3) {
            $output = @(& $collect @collectArgs 2>$null)
            if ($output -match '^list=\d+ unread=\d+ opened=0 verified=0 filesSaved=0$') { Write-Result 'ready' $inbox $true; return }
            if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
        }
        Write-Result 'unverified'
        return
    }

    $watchArgs = @{}
    if ((Get-Command -Name $watch).Parameters.ContainsKey('LocalOnly')) {
        $watchArgs.LocalOnly = $true
    } elseif ((Test-Path -LiteralPath (Join-Path $ScriptsDir 'codex-bridge.ps1')) -or
        (Get-Content -LiteralPath $watch -Raw -Encoding utf8) -match '(?i)codex-bridge\.ps1|Invoke-Codex') {
        Write-Result 'conflict'
        return
    }
    if ($Force -and (Get-Command -Name $watch).Parameters.ContainsKey('AllowInMessenger')) { $watchArgs.AllowInMessenger = $true }
    $output = @(& $watch @watchArgs 2>$null)
    $count = @($output -match '^collected=\d+ unverified=\d+$') | Select-Object -First 1
    if ($count -match '^collected=(\d+) unverified=(\d+)$') { Write-Result 'ready' $inbox $true ([int]$Matches[1] + [int]$Matches[2]) }
    elseif ($output -contains 'no-new-notes') { Write-Result 'ready' $inbox $true }
    elseif ($output -contains 'skipped-user-in-messenger') { Write-Result 'in-use' $inbox $true }
    elseif ($output -contains 'messenger-not-running') { Write-Result 'offline' }
    else { Write-Result 'unverified' }
} catch {
    Write-Result 'unavailable'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
