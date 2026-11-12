param(
    [switch]$Loop,            # keep running, one check every $IntervalSec
    [ValidateRange(1,86400)][int]$IntervalSec = 30,
    [string]$DemoId = '',     # run the whole pipeline once on this (already read) note id
    [switch]$Stop,            # stop running watchers
    [switch]$Status,
    [switch]$InstallStartup,  # start the watcher at every Windows logon (shortcut in the Startup folder)
    [switch]$UninstallStartup,
    [string]$ConnectCodex,
    [string]$CodexExecutable,
    [switch]$LocalOnly
)

$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$inbox = Join-Path $root 'inbox'
$bridge = Join-Path $root 'codex-bridge.ps1'
$deliveryPath = Join-Path $inbox 'codex-delivery.json'
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant()))).Replace('-', '').Substring(0, 16) }
finally { $hash.Dispose() }
$runningMutexName = 'Local\BrityAssistantWatch-' + $key
$stopPath = Join-Path $inbox 'stop.request'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) ('Brity Assistant Watch ' + $key + '.lnk')

function Test-WatcherRunning {
    try { $probe = [Threading.Mutex]::OpenExisting($runningMutexName) }
    catch [Threading.WaitHandleCannotBeOpenedException] { return $false }
    try {
        try { $available = $probe.WaitOne(0) } catch [Threading.AbandonedMutexException] { $available = $true }
        if ($available) { $probe.ReleaseMutex() }
        return -not $available
    } finally {
        $probe.Dispose()
    }
}

if ($Status) {
    $threadId = $null
    if (Test-Path -LiteralPath $deliveryPath -PathType Leaf) {
        $threadId = (Get-Content -LiteralPath $deliveryPath -Raw -Encoding utf8 | ConvertFrom-Json).threadId
    }
    [pscustomobject]@{
        running = Test-WatcherRunning
        startup = Test-Path -LiteralPath $startupLnk -PathType Leaf
        threadId = $threadId
    } | ConvertTo-Json -Compress
    return
}

New-Item -ItemType Directory -Force $inbox | Out-Null
$L = Get-Content (Join-Path $root 'labels.json') -Raw -Encoding utf8 | ConvertFrom-Json

if ($UninstallStartup) {
    if (Test-Path $startupLnk) { Remove-Item -LiteralPath $startupLnk; Write-Output "removed: $startupLnk" } else { Write-Output 'not installed' }
    exit 0
}
if ($InstallStartup) {
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($startupLnk)
    $s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $s.Arguments = ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Loop' -f (Join-Path $root 'watch.ps1'))
    $s.WorkingDirectory = $root
    $s.WindowStyle = 7
    $s.Save()
    Write-Output "installed: $startupLnk"
    exit 0
}

if ($Stop) {
    if (Test-WatcherRunning) {
        [IO.File]::WriteAllText($stopPath, '')
        Write-Output 'stop requested'
    } else {
        Write-Output 'no watcher running'
    }
    exit 0
}

if ($CodexExecutable -and -not $ConnectCodex) { throw 'Use CodexExecutable with ConnectCodex.' }

function Initialize-ForegroundCheck {
    Add-Type -Namespace BrityWatch -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@
}

function Log([string]$m) {
    Add-Content -Path (Join-Path $inbox 'watch.log') -Value ('{0} {1}' -f (Get-Date).ToString('s'), $m) -Encoding utf8
}
function Norm([string]$s) { if ($null -eq $s) { return '' }; return ($s -replace '\s+', ' ').Trim() }

function Test-UserInMessenger {
    [uint32]$fgPid = 0
    [void][BrityWatch.Fg]::GetWindowThreadProcessId([BrityWatch.Fg]::GetForegroundWindow(), [ref]$fgPid)
    $ids = @((Get-Process $L.processName -ErrorAction SilentlyContinue).Id)
    return ($ids -contains [int]$fgPid)
}

function Show-Toast([string]$title, [string]$text) {
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $t = [System.Security.SecurityElement]::Escape($title)
        $b = [System.Security.SecurityElement]::Escape($text)
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
        return $true
    } catch { Log ('toast failed: ' + $_.Exception.Message); return $false }
}

function Write-Digest($notes) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($n in $notes) {
        [void]$sb.AppendLine(('## {0} | {1} ({2})' -f $n.datetime, $n.sender, $n.org))
        [void]$sb.AppendLine('')
        $body = [string]$n.body
        $t = Norm $n.title
        $head = $t.Substring(0, [Math]::Min(12, $t.Length))
        if ($t -and -not (Norm $body).StartsWith($head)) { [void]$sb.AppendLine("**$t**"); [void]$sb.AppendLine('') }
        if ($n.recipients) { [void]$sb.AppendLine(('{0}: {1}' -f $L.recipientLabel, $n.recipients)); [void]$sb.AppendLine('') }
        foreach ($line in ($body -split "`r?`n")) { [void]$sb.AppendLine(($line.TrimEnd() + '  ')) }
        [void]$sb.AppendLine('')
        foreach ($f in $n.saved) {
            $where = $f.path; if (-not $where) { $where = $L.digestNotSaved }
            [void]$sb.AppendLine(('- {0}: {1} -> {2}' -f $L.attachWord, $f.name, $where))
        }
        [void]$sb.AppendLine(('- id: {0}, {1}: {2}' -f $n.id, $L.digestCollected, $n.collectedAt))
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('---')
        [void]$sb.AppendLine('')
    }
    Add-Content -Path (Join-Path $inbox 'digest.md') -Value $sb.ToString() -Encoding utf8
}

function Invoke-Tick {
    if (-not (Get-Process $L.processName -ErrorAction SilentlyContinue)) { return 'messenger-not-running' }
    if (-not $DemoId -and (Test-UserInMessenger)) { return 'skipped-user-in-messenger' }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'collect-notes.ps1'))
    if ($DemoId) { $a += @('-Id', $DemoId, '-Download') } else { $a += @('-Open', '-Download') }
    $out = (& powershell.exe @a | Out-String)
    if ($out -notmatch 'opened=(\d+)') { return ('error: ' + (Norm $out)) }
    if ([int]$Matches[1] -eq 0) { return 'no-new-notes' }
    $j = Get-Content (Join-Path $inbox 'latest.json') -Raw -Encoding utf8 | ConvertFrom-Json
    $good = @($j.opened | Where-Object { $_.verified })
    $bad = @($j.opened).Count - $good.Count
    if ($good.Count -gt 0) {
        Write-Digest $good
        $first = $good[0]
        $t = Norm $first.title
        if ($t.Length -gt 70) { $t = $t.Substring(0, 70) }
        [void](Show-Toast ($L.toastTitle -f $good.Count) ('{0}: {1}' -f $first.sender, $t))
    }
    return ('collected={0} unverified={1}' -f $good.Count, $bad)
}

function Start-DeliveryWorker {
    $script = @'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {{
    & {0} -Inbox {1}
}} catch {{
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}}
'@
    $bridgeLiteral = "'" + $bridge.Replace("'", "''") + "'"
    $inboxLiteral = "'" + $inbox.Replace("'", "''") + "'"
    $script = $script -f $bridgeLiteral, $inboxLiteral
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info = [Diagnostics.ProcessStartInfo]::new(
        $powerShell, ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded)
    )
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = $info.StandardOutputEncoding
    $worker = [Diagnostics.Process]::Start($info)
    return [pscustomobject]@{
        Process = $worker
        Output = $worker.StandardOutput.ReadToEndAsync()
        ErrorOutput = $worker.StandardError.ReadToEndAsync()
    }
}

function Receive-DeliveryWorker($Worker) {
    $Worker.Process.WaitForExit()
    if ($Worker.Process.ExitCode -eq 0) { return $Worker.Output.Result.Trim() }
    return ('codex-error: ' + $Worker.ErrorOutput.Result.Trim())
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\BrityAssistantWatch')
$locked = $false
$deliveryJob = $null
$runningMutex = $null
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'A Brity watcher is already running. Stop it before setting up or starting another watcher.' }
    if ($ConnectCodex) {
        & $bridge -Inbox $inbox -ConnectCodex $ConnectCodex -CodexExecutable $CodexExecutable
        return
    }

    Initialize-ForegroundCheck
    $forward = -not $LocalOnly -and -not $DemoId -and (Test-Path -LiteralPath $deliveryPath -PathType Leaf)
    if (-not $Loop) {
        $result = Invoke-Tick
        Log $result
        Write-Output $result
        if ($forward) {
            $delivery = & $bridge -Inbox $inbox
            Log $delivery
            Write-Output $delivery
        }
        return
    }

    if ([IO.File]::Exists($stopPath)) { [IO.File]::Delete($stopPath) }
    $runningMutex = [Threading.Mutex]::new($false, $runningMutexName)
    try { [void]$runningMutex.WaitOne() } catch [Threading.AbandonedMutexException] {}
    Log ('watcher started, interval=' + $IntervalSec + 's, pid=' + $PID)
    $lastCollection = ''
    $lastDelivery = ''
    while (-not [IO.File]::Exists($stopPath)) {
        $tick = [Diagnostics.Stopwatch]::StartNew()
        try { $result = Invoke-Tick } catch { $result = 'error: ' + $_.Exception.Message }
        if ($result -like 'collected=*' -or $result -ne $lastCollection) { Log $result }
        $lastCollection = $result

        if ($deliveryJob -and $deliveryJob.Process.HasExited) {
            $delivery = Receive-DeliveryWorker $deliveryJob
            $deliveryJob.Process.Dispose()
            $deliveryJob = $null
            if ($delivery -ne $lastDelivery -or $delivery -like 'codex-sent=*' -or $delivery -like 'codex-review-needed=*') { Log $delivery }
            $lastDelivery = $delivery
        }
        if ($forward -and -not $deliveryJob -and -not [IO.File]::Exists($stopPath)) {
            try { $deliveryJob = Start-DeliveryWorker }
            catch { Log ('codex-error: ' + $_.Exception.Message) }
        }

        $remaining = ($IntervalSec * 1000) - $tick.ElapsedMilliseconds
        while ($remaining -gt 0 -and -not [IO.File]::Exists($stopPath)) {
            Start-Sleep -Milliseconds ([Math]::Min(500, $remaining))
            $remaining = ($IntervalSec * 1000) - $tick.ElapsedMilliseconds
        }
    }
    if ($deliveryJob) {
        Log (Receive-DeliveryWorker $deliveryJob)
    }
    Log 'watcher stopped'
} finally {
    if ($deliveryJob) { $deliveryJob.Process.Dispose() }
    if ($runningMutex) {
        $runningMutex.ReleaseMutex()
        $runningMutex.Dispose()
    }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
