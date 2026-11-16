param(
    [Parameter(Mandatory)][ValidateSet('Inspect', 'Tick', 'ChatRooms', 'Chats', 'RangePreview', 'Range', 'RetryAttachments', 'Reply')][string]$Mode,
    [Parameter(Mandatory)][string]$ScriptsDir,
    [string]$ChatDirectory,
    [switch]$Force,
    [switch]$Manual,
    [ValidatePattern('^(\d{4}-\d{2}-\d{2})?$')][string]$From = '',
    [ValidatePattern('^(\d{4}-\d{2}-\d{2})?$')][string]$To = '',
    [ValidatePattern('^goe_\d{12}_[a-f0-9]{8}$')][string]$NoteId,
    [AllowEmptyString()][string]$AttachmentFolder
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$result = [ordered]@{ status = 'unavailable'; inboxDir = $null; managed = $false; imported = 0 }
$mutex = $null
$locked = $false
try {
    if ($Mode -in 'ChatRooms', 'Chats') { return }
    if ($Mode -in 'RangePreview', 'Range' -and -not ($From -or $To)) { return }
    if ($Mode -in 'RetryAttachments', 'Reply' -and -not $NoteId) { return }

    $collect = Join-Path $ScriptsDir 'collect-goe.ps1'
    if (-not (Test-Path -LiteralPath $collect -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $ScriptsDir 'labels.json') -PathType Leaf)) { return }

    $mutex = [Threading.Mutex]::new($false, 'Local\GoeAssistantCollector')
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        $result.status = 'conflict'
        return
    }

    $inbox = Join-Path $ScriptsDir 'inbox'
    $collectArgs = @{ Inbox = $inbox; ResultObject = $true }
    if ($PSBoundParameters.ContainsKey('AttachmentFolder')) { $collectArgs.AttachmentFolder = $AttachmentFolder }
    switch ($Mode) {
        'Inspect' { $collectArgs.Inspect = $true }
        'Reply' {
            $collectArgs.RetryId = $NoteId
            $collectArgs.Reply = $true
        }
        'RetryAttachments' {
            $collectArgs.RetryId = $NoteId
            $collectArgs.MaxPages = 60
        }
        'Tick' {
            $collectArgs.Download = $true
            $collectArgs.Force = [bool]$Force
            $collectArgs.SinceDays = 0
        }
        default {
            $collectArgs.From = $From
            $collectArgs.To = $To
            $collectArgs.IncludeRead = $true
            $collectArgs.MaxPages = 60
            if ($Mode -eq 'RangePreview') { $collectArgs.ListOnly = $true }
            else {
                $collectArgs.RangeImport = $true
                $collectArgs.Download = $true
            }
        }
    }

    $collected = & $collect @collectArgs 2>$null
    $result.status = switch ($collected.status) {
        'ok' { 'ready' }
        'busy' { 'in-use' }
        'offline' { 'offline' }
        default { 'unverified' }
    }
    $result.imported = [int]$collected.imported
    if ($result.status -in 'ready', 'in-use') {
        $result.inboxDir = $inbox
        $result.managed = $true
    }
    if ($Mode -in 'RangePreview', 'Range' -and $collected) {
        foreach ($key in 'visible', 'matched', 'fresh', 'unknown', 'remaining', 'opened', 'oldest') {
            $result[$key] = $collected.$key
        }
    }
    if ($Mode -eq 'RetryAttachments' -and $collected) {
        $result.attachStatus = $collected.attachStatus
        $result.attached = $collected.attached
    }
    if ($Mode -eq 'Reply' -and $collected) { $result.reply = $collected.reply }
} catch {
    $result.status = 'unavailable'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
    [pscustomobject]$result | ConvertTo-Json -Compress
}
