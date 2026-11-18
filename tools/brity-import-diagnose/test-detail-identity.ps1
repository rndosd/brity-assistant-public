# Replays synthetic detail-pane frames through the collector loop. No app, inbox or real notes.
param([string]$Revision)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($Revision) {
    $source = (git -C $root show ("${Revision}:collector/collect-notes.ps1")) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the requested collector revision.' }
} else {
    $source = [IO.File]::ReadAllText((Join-Path $root 'collector/collect-notes.ps1'))
}
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$errors)
if ($errors) { throw $errors[0] }
foreach ($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$entry = $source.IndexOf('# ---- main ----')
if ($entry -lt 0) { throw 'Collector entry point not found.' }
$dateLibrary = Join-Path $root 'collector/list-date.ps1'
$collect = [scriptblock]::Create($source.Substring($entry).Replace('(Join-Path $PSScriptRoot ''list-date.ps1'')', '$dateLibrary'))

function Get-AppWindow { 1 }
function Find-ByName { 1 }
function Reset-NoteList {}
function Get-NoteItems { $row }
function Get-AllNoteItems { $row; if ($peer) { $peer } }
function New-Item {}
function Test-Path { $false }
function Write-CollectorJson {}
function Find-NoteRow { 1 }
function Get-VisibleNoteRow { 1 }
function Open-NoteRow { $true }
function Get-BrityWindows {}
function Find-AlternativeDetail($win, $listText) {
    if ($listText -and $case.alternate) { $case.alternate }
}
function Start-Sleep {}
function Read-Detail {
    $script:reads++
    $frames[[Math]::Min($reads - 1, $frames.Count - 1)]
}
function Set-Content {
    param($Path, $Encoding, [Parameter(ValueFromPipeline=$true)]$Value)
    process {}
}

function New-Detail($title, $body, $datetime) {
    [pscustomobject]@{ title=$title; sender='Example'; datetime=$datetime; body=$body; files=@() }
}

$old = New-Detail 'Meeting: old' 'old body' '2026-11-17 09:00'
$current = New-Detail 'Meeting: new' 'new body' '2026-11-18 09:00'
$sameBody = New-Detail $current.title $old.body $current.datetime
$missingDate = New-Detail $current.title $current.body ''
$invalidDate = New-Detail $current.title $current.body '2026-19-45 09:00'
$day = '2026-11-18'
$otherToday = New-Detail 'Meeting: old' 'earlier body' '2026-11-18 08:00'
$bodyLooksLikeTitle = New-Detail 'Other subject' 'Meeting: new - repeated text' $otherToday.datetime
$titleWithComma = New-Detail 'Meeting: new, agenda' 'body with files' $current.datetime
$titleWithComma.files = @('example.txt')
$L = @{attachWord='attachment'}
$cases = @(
    @{ name='Stale previous-day pane'; frames=@($old,$old); day=$day; expected=$null },
    @{ name='Previous-day pane replaced after two reads'; frames=@($old,$old,$old,$current,$current); day=$day; expected=$current },
    @{ name='Correct separate pane while primary stays on yesterday'; frames=@($old,$old); day=$day; alternate=$current; expected=$current },
    @{ name='Correct day and title'; frames=@($old,$current); day=$day; expected=$current },
    @{ name='Already open'; frames=@($current,$current); day=$day; expected=$current },
    @{ name='Body still indistinguishable from previous'; frames=@($old,$sameBody); day=$day; expected=$null },
    @{ name='New body after delayed header'; frames=@($old,$sameBody,$sameBody,$current,$current); day=$day; expected=$current },
    @{ name='Primary pane without header date'; frames=@($old,$missingDate); day=$day; expected=$missingDate },
    @{ name='Primary pane without usable date'; frames=@($old,$invalidDate); day=$day; expected=$invalidDate },
    @{ name='ID import has no day constraint'; frames=@($old,$old); day=''; expected=$old },
    @{ name='Same day and prefix, exact other row stays visible'; frames=@($otherToday,$otherToday); day=$day; listed=$otherToday; expected=$null },
    @{ name='Same day and prefix, actual target appears later'; frames=@($otherToday,$otherToday,$otherToday,$current,$current); day=$day; listed=$otherToday; expected=$current },
    @{ name='Other listed body starts like target title'; frames=@($bodyLooksLikeTitle,$bodyLooksLikeTitle); day=$day; listed=$bodyLooksLikeTitle; expected=$null },
    @{ name='Correct exact row with comma in title and attachment'; frames=@($otherToday,$titleWithComma); day=$day; listed=$otherToday; rowText='Meeting: new, agenda, Example, attachment, 2026-11-18'; expected=$titleWithComma },
    @{ name='Full title listed on previous day does not block correct short display'; frames=@($old,$current); day=$day; listed=$current; listedDay='2026-11-17'; rowText='Meeting: n..., Example, 2026-11-18'; expected=$current },
    @{ name='Unambiguous short display retains normal primary match'; frames=@($otherToday,$current); day=$day; listed=$otherToday; rowText='Meeting: n..., Example, 2026-11-18'; expected=$current }
)
$failures = 0
foreach ($case in $cases) {
    $frames = $case.frames
    $script:reads = 0
    $opened = @()
    $processed = @()
    $From = if ($case.listedDay) { $case.listedDay } else { $case.day }
    $To = $case.day
    $Id = if (-not $To) { 'test-target' }
    $Max = 1
    $Inbox = Join-Path ([IO.Path]::GetTempPath()) 'brity-synthetic-unused'
    $row = [pscustomobject]@{ id='test-target'; text='Example, Meeting: new, 2026-11-18'; unread=$false }
    $peer = $null
    if ($case.listed) {
        $row.text = if ($case.rowText) { $case.rowText } else { 'Meeting: new, Example, 2026-11-18' }
        $listedDay = if ($case.listedDay) { $case.listedDay } else { $day }
        $peer = [pscustomobject]@{id='test-other'; text=($case.listed.title + ', ' + $case.listed.sender + ', ' + $listedDay); unread=$false}
    }
    if ($Id) { $row.text = 'Example, Meeting: old, 2026-11-17' }
    $null = . $collect
    $verified = @($opened | Where-Object { $_.verified })
    $ok = if ($case.expected) {
        $verified.Count -eq 1 -and $verified[0].title -ceq $case.expected.title -and
            $verified[0].body -ceq $case.expected.body -and $verified[0].datetime -ceq $case.expected.datetime
    } else { $verified.Count -eq 0 }
    if (-not $ok) { $failures++ }
    Write-Output ("{0} {1} (verified={2})" -f @('FAIL','PASS')[[int]$ok], $case.name, $verified.Count)
}
if ($failures) { throw "$failures synthetic detail identity case(s) failed." }
