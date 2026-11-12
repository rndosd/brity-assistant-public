param([string]$Explicit)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($Explicit) {
    if (-not [IO.Path]::IsPathRooted($Explicit) -or [IO.Path]::GetExtension($Explicit) -notin @('.exe', '.cmd') -or
        -not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { exit 2 }
    (Get-Item -LiteralPath $Explicit).FullName
    exit
}

$command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command) { $command.Source; exit }

if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
    try {
        foreach ($app in (Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Sort-Object Version -Descending)) {
            if (-not $app.InstallLocation) { continue }
            $native = Join-Path $app.InstallLocation 'app\resources\codex.exe'
            if (Test-Path -LiteralPath $native -PathType Leaf) { $native; exit }
        }
    } catch {}
}

$repository = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
$packages = Get-ChildItem -LiteralPath $repository -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match '^OpenAI\.Codex_[0-9]+(?:\.[0-9]+){3}_' } |
    Sort-Object { [version](($_.PSChildName -split '_')[1]) } -Descending
foreach ($package in $packages) {
    $location = $package.GetValue('PackageRootFolder')
    if (-not $location) { continue }
    $native = Join-Path $location 'app\resources\codex.exe'
    if (Test-Path -LiteralPath $native -PathType Leaf) { $native; exit }
}

foreach ($app in (Get-Process -Name 'Codex' -ErrorAction SilentlyContinue)) {
    if (-not $app.Path) { continue }
    $native = Join-Path (Split-Path -Parent $app.Path) 'resources\codex.exe'
    if (Test-Path -LiteralPath $native -PathType Leaf) { $native; exit }
}

$command = Get-Command codex.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command) { $command.Source; exit }
exit 1
