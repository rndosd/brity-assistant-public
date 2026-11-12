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
        $overlap = 0
        for ($length = [Math]::Min($previous.Count, $fingerprints.Count); $length -gt 0; $length--) {
            $offset = $previous.Count - $length
            $matched = 0
            while ($matched -lt $length -and $previous[$offset + $matched] -ceq $fingerprints[$matched]) {
                $matched++
            }
            if ($matched -ne $length) { continue }
            if ($length -eq $previous.Count -and $length -eq $fingerprints.Count) {
                return [pscustomobject]@{ status = 'unchanged'; added = 0 }
            }
            if ($overlap) { return [pscustomobject]@{ status = 'ambiguous'; added = 0 } }
            $overlap = $length
        }
        if ($previous.Count -and -not $overlap) {
            return [pscustomobject]@{ status = 'gap'; added = 0 }
        }
        if ($overlap -eq $fingerprints.Count) {
            return [pscustomobject]@{ status = 'unchanged'; added = 0 }
        }

        $added = $Messages.Count - $overlap
        $entries = $journal.messages + @(
            for ($index = $overlap; $index -lt $Messages.Count; $index++) {
                [pscustomobject]@{ observedAt = $ObservedAt; text = $Messages[$index] }
            }
        )
        $status = 'collected'
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
