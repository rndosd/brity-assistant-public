# 브리티 메신저 캘린더 업데이트 적용(7단계).
# 앱의 업데이트 버튼: 앱이 패치를 임시 폴더에 풀고 이 스크립트를 -WaitPid 와 함께 실행한 뒤 꺼진다.
# 손으로 할 때: 패치 ZIP을 캘린더 폴더(Brity-Messenger-Calendar) 안에 풀고 update.cmd 를 실행한다.
# 바꾸는 것: runtime\resources\app(앱 코드)과 collector 폴더의 스크립트. calendar-data 와 collector\inbox 는 건드리지 않는다.
param(
  [string]$Root = '',
  [string]$Staging = $PSScriptRoot,
  [int]$WaitPid = 0,
  [switch]$NoRestart,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$title = '브리티 메신저 캘린더 업데이트'
$log = Join-Path $Staging 'update-log.txt'
function Write-Log([string]$message) { Add-Content -LiteralPath $log -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $message) -Encoding UTF8 }
function Say([string]$message, [string]$icon = 'Information') {
  if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show($message, $title, 'OK', $icon) }
}
function Test-CalendarRoot([string]$path) {
  return $path -and (Test-Path -LiteralPath (Join-Path $path 'runtime\electron.exe')) -and (Test-Path -LiteralPath (Join-Path $path 'runtime\resources\app\main.js'))
}

# 한 번에 하나만 바꾼다. 실행기도 같은 이름으로 기다렸다가 캘린더를 켠다.
$mutex = New-Object System.Threading.Mutex($false, 'Local\SchoolCalendarUpdate')
try { [void]$mutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] {}

try {
  $files = Join-Path $Staging 'files'
  if (-not (Test-Path -LiteralPath (Join-Path $files 'runtime\resources\app\main.js'))) { throw '패치 파일이 온전하지 않습니다. 패치 ZIP 전체를 다시 풀어 주세요.' }

  # 캘린더 폴더 찾기: 지정한 곳, 없으면 패치를 푼 폴더의 위쪽, 그래도 없으면 고르게 한다.
  if (-not (Test-CalendarRoot $Root)) {
    $Root = ''
    $probe = Split-Path -Parent $Staging
    for ($i = 0; $i -lt 3 -and $probe; $i++) {
      if (Test-CalendarRoot $probe) { $Root = $probe; break }
      $probe = Split-Path -Parent $probe
    }
  }
  if (-not $Root) {
    if ($Quiet) { throw '캘린더 폴더를 찾지 못했습니다.' }
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = '브리티 메신저 캘린더를 푼 폴더(runtime 폴더가 들어 있는 곳)를 골라 주세요.'
    if ($picker.ShowDialog() -ne 'OK' -or -not (Test-CalendarRoot $picker.SelectedPath)) { throw '캘린더 폴더를 찾지 못했습니다. runtime 폴더가 들어 있는 폴더를 골라 주세요.' }
    $Root = $picker.SelectedPath
  }
  $Root = (Resolve-Path -LiteralPath $Root).Path
  Write-Log "root=$Root staging=$Staging"

  # 앱이 꺼질 때까지 기다린다.
  if ($WaitPid -gt 0) { try { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction Stop } catch {} }
  $runtimeDir = Join-Path $Root 'runtime'
  $deadline = (Get-Date).AddSeconds(30)
  while ($true) {
    $running = @(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($runtimeDir, [StringComparison]::OrdinalIgnoreCase) })
    if (-not $running.Count) { break }
    if ($WaitPid -le 0) { throw '브리티 메신저 캘린더가 켜져 있습니다. 캘린더를 닫은 뒤 update.cmd 를 다시 실행해 주세요.' }
    if ((Get-Date) -gt $deadline) { throw '캘린더가 꺼지지 않아 업데이트하지 못했습니다. 캘린더를 닫고 다시 시도해 주세요.' }
    Start-Sleep -Milliseconds 500
  }

  $app = Join-Path $runtimeDir 'resources\app'
  $old = "$app.old"
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
  Move-Item -LiteralPath $app -Destination $old
  try {
    Copy-Item -LiteralPath (Join-Path $files 'runtime\resources\app') -Destination $app -Recurse
    $collectorFiles = Join-Path $files 'collector'
    if (Test-Path -LiteralPath $collectorFiles) {
      $collector = Join-Path $Root 'collector'
      New-Item -ItemType Directory -Force -Path $collector | Out-Null
      Get-ChildItem -LiteralPath $collectorFiles -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $collector $_.Name) -Force }
    }
  } catch {
    if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force }
    Move-Item -LiteralPath $old -Destination $app
    throw "앱 파일을 바꾸지 못해 원래대로 되돌렸습니다. ($($_.Exception.Message))"
  }
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  Write-Log 'applied'
  Remove-Item -LiteralPath (Join-Path $Root 'update-staging\pending.txt') -Force -ErrorAction SilentlyContinue

  if (-not $NoRestart) {
    $launcher = Join-Path $Root 'Brity Messenger Calendar.exe'
    if (Test-Path -LiteralPath $launcher) { Start-Process -FilePath $launcher -WorkingDirectory $Root }
    else {
      $startArgs = if (Test-Path -LiteralPath (Join-Path $Root 'no-sandbox.txt')) { @('--brity', '--no-sandbox') } else { @('--brity') }
      Start-Process -FilePath (Join-Path $runtimeDir 'electron.exe') -ArgumentList $startArgs -WorkingDirectory $Root
    }
  }
  if ($WaitPid -le 0) { Say '업데이트했습니다. 캘린더를 열면 무엇이 바뀌었는지 안내합니다.' }
  exit 0
} catch {
  try { Write-Log "failed: $($_.Exception.Message)" } catch {}
  # 실패해도 같은 패치를 되풀이하지 않는다(앱 폴더는 원래대로 되돌렸다).
  if ($Root) { Remove-Item -LiteralPath (Join-Path $Root 'update-staging\pending.txt') -Force -ErrorAction SilentlyContinue }
  Say "업데이트하지 못했습니다.`n$($_.Exception.Message)" 'Warning'
  if ($WaitPid -gt 0 -and -not $NoRestart -and (Test-CalendarRoot $Root)) {
    # 실행기가 있으면 실행기로 켠다(Windows 26H2 꺼짐 문제 때 샌드박스 없이 다시 켜는 일을 실행기가 맡는다).
    $launcher = Join-Path $Root 'Brity Messenger Calendar.exe'
    if (Test-Path -LiteralPath $launcher) { Start-Process -FilePath $launcher -WorkingDirectory $Root }
    else {
      $startArgs = if (Test-Path -LiteralPath (Join-Path $Root 'no-sandbox.txt')) { @('--brity', '--no-sandbox') } else { @('--brity') }
      Start-Process -FilePath (Join-Path $Root 'runtime\electron.exe') -ArgumentList $startArgs -WorkingDirectory $Root
    }
  }
  exit 1
}
