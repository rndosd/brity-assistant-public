<#
.SYNOPSIS
    받은 쪽지 CSV에서 최신 안 읽은 쪽지를 최대 10건 반환합니다.
.DESCRIPTION
    읽음 상태가 포함된 UTF-8 CSV를 사용합니다. 시각에 시간대가 없으면 한국 시간으로 해석합니다.
    쪽지 본문은 -IncludeBody를 지정할 때만 출력합니다.
.EXAMPLE
    .\get-goe-unread.ps1 -Path .\받은쪽지.csv
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Path,

    [switch]$IncludeBody
)

$ErrorActionPreference = 'Stop'
$rows = @(Import-Csv -LiteralPath $Path -Encoding UTF8)
if ($rows.Count -eq 0) { return }

$headers = $rows[0].PSObject.Properties.Name

function Find-Column([string[]]$Names) {
    foreach ($name in $Names) {
        if ($headers -contains $name) { return $name }
    }
}

$timeColumn = Find-Column @('수신일시', '받은 일시', '받은일시', '수신 시간', '수신시간', '일시', 'ReceivedAt')
$senderColumn = Find-Column @('보낸 사람', '보낸사람', '발신자', 'Sender')
$titleColumn = Find-Column @('제목', '쪽지 제목', 'Title', 'Subject')
$bodyColumn = Find-Column @('본문', '내용', '메시지', 'Body')
$readColumn = Find-Column @('읽음 여부', '읽음여부', '읽음 상태', '읽음상태', '읽음', 'IsRead', 'ReadStatus')
$unreadColumn = Find-Column @('안 읽음 여부', '안읽음여부', '안 읽음', '안읽음', 'IsUnread', 'Unread')

if (-not $readColumn -and -not $unreadColumn) {
    throw 'CSV에 읽음 상태 열이 없습니다. 받은 시각만으로 안 읽은 쪽지를 판단할 수 없습니다.'
}
if ($readColumn -and $unreadColumn) {
    throw '읽음 여부 열과 안 읽음 여부 열이 함께 있습니다. 기준으로 쓸 열 하나를 남긴 사본을 사용하세요.'
}
if (-not $timeColumn -or -not $titleColumn) {
    throw 'CSV에 수신일시와 제목 열이 필요합니다.'
}
if ($IncludeBody -and -not $bodyColumn) {
    throw 'CSV에 본문 열이 없습니다.'
}

$statusColumn = if ($readColumn) { $readColumn } else { $unreadColumn }
$affirmative = @('1', 'true', 'y', 'yes', '예')
$negative = @('0', 'false', 'n', 'no', '아니오')
$korean = [Globalization.CultureInfo]::GetCultureInfo('ko-KR')
$koreaOffset = [TimeSpan]::FromHours(9)
$rowNumber = 0

$unread = foreach ($row in $rows) {
    $rowNumber++
    $status = ([string]$row.$statusColumn -replace '\s+', '').ToLowerInvariant()
    $isUnread = switch ($status) {
        { $_ -in @('안읽음', '미읽음', '미열람', 'unread') } { $true; break }
        { $_ -in @('읽음', '열람', 'read') } { $false; break }
        { $_ -in $affirmative } { [bool]$unreadColumn; break }
        { $_ -in $negative } { [bool]$readColumn; break }
        default { throw "CSV 데이터 $rowNumber 번째 항목의 읽음 상태를 해석할 수 없습니다." }
    }
    if (-not $isUnread) { continue }

    $rawTime = ([string]$row.$timeColumn).Trim()
    if ($rawTime -notmatch '^\d{4}[-./]\s*\d{1,2}[-./]\s*\d{1,2}(?:[.\sT]|$)') {
        throw "CSV 데이터 $rowNumber 번째 항목의 수신일시에 연월일이 필요합니다."
    }
    if ($rawTime -notmatch '(?:Z|[+-]\d{2}:?\d{2})$') { $rawTime += ' +09:00' }
    $receivedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($rawTime, $korean, [Globalization.DateTimeStyles]::AllowWhiteSpaces, [ref]$receivedAt)) {
        throw "CSV 데이터 $rowNumber 번째 항목의 수신일시를 해석할 수 없습니다."
    }

    $sender = if ($senderColumn) { $row.$senderColumn }
    $note = [ordered]@{
        ReceivedAt = $receivedAt.ToOffset($koreaOffset)
        Sender = $sender
        Title = $row.$titleColumn
    }
    if ($IncludeBody) { $note['Body'] = $row.$bodyColumn }
    [pscustomobject]$note
}

$unread | Sort-Object -Property ReceivedAt -Descending | Select-Object -First 10
