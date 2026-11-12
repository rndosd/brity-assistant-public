# 지난번 글 지문(Previous)의 끝과 이번 글 지문(Current)의 앞이 맞물리는 가장 긴 길이. 없으면 0.
function Get-BrityChatOverlap {
    param([AllowEmptyCollection()][string[]]$Previous, [AllowEmptyCollection()][string[]]$Current)
    if (-not $Previous) { $Previous = @() }
    if (-not $Current) { $Current = @() }
    for ($length = [Math]::Min($Previous.Count, $Current.Count); $length -gt 0; $length--) {
        $offset = $Previous.Count - $length
        $matched = 0
        while ($matched -lt $length -and $Previous[$offset + $matched] -ceq $Current[$matched]) { $matched++ }
        if ($matched -eq $length) { return $length }
    }
    0
}

# 방 기록에 남은 마지막 글 지문들(스크롤해 올라가며 겹치는 곳을 찾을 때 쓴다). 기록이 없거나 읽지 못하면 빈 목록.
function Get-BrityChatTail {
    param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$RoomKey)
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $roomHash = [BitConverter]::ToString($sha.ComputeHash($encoding.GetBytes($RoomKey))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $path = Join-Path ([IO.Path]::GetFullPath($Directory)) ($roomHash + '.json')
    if (-not [IO.File]::Exists($path)) { return ,@() }
    try { $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path, $encoding)) } catch { return ,@() }
    if ($journal.fingerprints -isnot [array]) { return ,@() }
    ,@($journal.fingerprints | ForEach-Object { [string]$_ })
}

function Get-BrityChatFingerprints {
    param([AllowEmptyCollection()][AllowEmptyString()][string[]]$Messages)
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        ,@(foreach ($message in $Messages) { [BitConverter]::ToString($sha.ComputeHash($encoding.GetBytes($message))).Replace('-', '').ToLowerInvariant() })
    } finally { $sha.Dispose() }
}

function Save-BrityChatSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Directory,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$RoomKey,
        [Parameter(Mandatory)][AllowEmptyString()][string]$RoomTitle,
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Messages,
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$')][string]$ObservedAt
    )

    $ErrorActionPreference = 'Stop'
    if ($Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
        throw 'Chat journal directory must be an absolute path.'
    }
    $Directory = [IO.Path]::GetFullPath($Directory)
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $roomHash = [BitConverter]::ToString($sha.ComputeHash($encoding.GetBytes($RoomKey))).Replace('-', '').ToLowerInvariant()
        $fingerprints = @(
            foreach ($message in $Messages) {
                [BitConverter]::ToString($sha.ComputeHash($encoding.GetBytes($message))).Replace('-', '').ToLowerInvariant()
            }
        )
    } finally {
        $sha.Dispose()
    }

    $path = Join-Path $Directory ($roomHash + '.json')
    $exists = [IO.File]::Exists($path)
    $entries = @()
    $status = 'baseline'
    $added = 0
    if ($exists) {
        try {
            $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path, $encoding))
        } catch {
            throw 'Chat journal could not be read. Its existing data was preserved.'
        }
        if ($journal -isnot [pscustomobject] -or $journal.version -ne 1 -or
            -not [string]::Equals($journal.roomKey, $RoomKey, [StringComparison]::Ordinal) -or
            $journal.roomTitle -isnot [string] -or $journal.fingerprints -isnot [array] -or
            $journal.messages -isnot [array]) {
            throw 'Invalid chat journal format. Its existing data was preserved.'
        }
        foreach ($fingerprint in $journal.fingerprints) {
            if ($fingerprint -isnot [string] -or $fingerprint -cnotmatch '^[0-9a-f]{64}$') {
                throw 'Invalid chat journal fingerprint. Its existing data was preserved.'
            }
        }
        foreach ($entry in $journal.messages) {
            if ($entry -isnot [pscustomobject] -or $entry.text -isnot [string] -or
                ($entry.observedAt -isnot [string] -and $entry.observedAt -isnot [datetime])) {
                throw 'Invalid chat journal message. Its existing data was preserved.'
            }
        }

        $previous = $journal.fingerprints
        # 지난번 끝과 이번 앞이 가장 길게 맞물리는 곳부터 본다. 짧게도 맞물리면(같은 글이 이어진 경우) 긴 쪽이 맞다.
        $overlap = Get-BrityChatOverlap -Previous $previous -Current $fingerprints
        if ($overlap -eq $fingerprints.Count) {
            return [pscustomobject]@{ status = 'unchanged'; added = 0 }
        }
        # 겹치는 곳이 없으면(그사이 글이 화면에 실리는 양보다 많이 옴) 보이는 글을 모두 새 글로 넣고 기준점을 새로 잡는다.
        # 중간 글이 빠졌을 수 있다는 표시(gapBefore)를 첫 새 글에 남긴다.
        $gap = $previous.Count -gt 0 -and -not $overlap
        $added = $Messages.Count - $overlap
        $entries = $journal.messages + @(
            for ($index = $overlap; $index -lt $Messages.Count; $index++) {
                $entry = [pscustomobject]@{ observedAt = $ObservedAt; text = $Messages[$index] }
                if ($gap -and $index -eq $overlap) { $entry | Add-Member -NotePropertyName gapBefore -NotePropertyValue $true }
                $entry
            }
        )
        $status = if ($gap) { 'gap' } else { 'collected' }
    }

    $updated = [pscustomobject]@{
        version = 1
        roomKey = $RoomKey
        roomTitle = $RoomTitle
        fingerprints = $fingerprints
        messages = $entries
    }
    $bytes = $encoding.GetBytes((ConvertTo-Json -InputObject $updated -Depth 5) + "`n")
    [void][IO.Directory]::CreateDirectory($Directory)
    $temporary = "$path.$([Guid]::NewGuid().ToString('N')).tmp"
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        if ($exists) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally {
        [IO.File]::Delete($temporary)
    }
    [pscustomobject]@{ status = $status; added = $added }
}
