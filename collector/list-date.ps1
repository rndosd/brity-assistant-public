# Parse the date at the end of a Brity note list item ("..., 8<month> 27<day>" or "..., <am/pm> 1:54").
# Keep this file ASCII only: Korean letters are written as \u escapes inside the regular expressions.
# The list shows no year for older notes, so the year is the latest one that is not after today.
function Get-ListDate([string]$Text, [datetime]$Today = (Get-Date).Date) {
    $last = (($Text -split ', ') | Select-Object -Last 1)
    if ($null -eq $last) { return $null }
    $last = $last.Trim()
    $y = 0; $m = 0; $d = 0
    if ($last -match '^(\d{4})\s*\uB144\s*(\d{1,2})\s*\uC6D4\s*(\d{1,2})\s*\uC77C$') {
        $y = [int]$Matches[1]; $m = [int]$Matches[2]; $d = [int]$Matches[3]
    } elseif ($last -match '^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})\.?$') {
        $y = [int]$Matches[1]; $m = [int]$Matches[2]; $d = [int]$Matches[3]
    } elseif ($last -match '^(\d{1,2})\s*\uC6D4\s*(\d{1,2})\s*\uC77C$') {
        $m = [int]$Matches[1]; $d = [int]$Matches[2]; $y = $Today.Year
        try { if ((New-Object DateTime $y, $m, $d) -gt $Today) { $y-- } } catch { return $null }
    } elseif ($last -match '^(?:\S+\s+)?\d{1,2}:\d{2}$') {
        return $Today.ToString('yyyy-MM-dd')
    } else {
        return $null
    }
    # New-Object DateTime rejects impossible days (Get-Date -Day 30 in February rolls over to March).
    try { return (New-Object DateTime $y, $m, $d).ToString('yyyy-MM-dd') } catch { return $null }
}
