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

function Get-UpdateTarget([string]$base, [string]$relative) {
  $target = $base
  foreach ($part in $relative.Split('/')) {
    if (!$part -or $part -in '.', '..' -or $part -match '[\x00-\x1F\\:*?"<>|]|[ .]$') { throw "잘못된 업데이트 경로: $relative" }
    $target = Join-Path $target $part
    $entry = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "업데이트 경로가 다른 곳을 가리킵니다: $relative" }
  }
  return $target
}

function Remove-UpdateTransaction([string]$directory) {
  $entry = Get-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue
  if (!$entry) { return }
  $parent = Get-UpdateTarget $Root 'update-staging'
  if ($entry.FullName -ne $directory -or $entry.Parent.FullName -ne $parent -or
      $entry.Name -notmatch '^electron-switch-\d+\.\d+\.\d+$' -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw '업데이트 작업 폴더를 확인하지 못했습니다.'
  }
  Remove-Item -LiteralPath $entry.FullName -Recurse -Force
}

function Get-RuntimePayload([string]$zip, [string]$destination) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $required = @(
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll',
    'electron_wer.dll', 'electron.exe', 'ffmpeg.dll', 'icudtl.dat', 'LICENSE', 'LICENSES.chromium.html',
    'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version',
    'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll', 'locales/en-US.pak', 'locales/ko.pak'
  )
  $entries = @{}
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $total = 0L
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName
      if ($name -cin 'resources/default_app.asar', 'locales/', 'resources/') { continue }
      $total += $entry.Length
      if (($name -cnotin $required -and $name -cnotmatch '^locales/[A-Za-z0-9-]+\.pak$') -or
          $entries.ContainsKey($name) -or $entries.Count -ge 256 -or $total -gt 1GB) {
        throw "실행 파일 묶음에 잘못된 항목이 있습니다: $name"
      }
      $entries[$name] = $entry
    }
    foreach ($name in $required) {
      if (!$entries.ContainsKey($name) -or !$entries[$name].Length) { throw "실행 파일 묶음에 $name 파일이 없습니다." }
    }
    foreach ($name in $entries.Keys) {
      $target = Get-UpdateTarget $destination $name
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[$name], $target)
    }
  } finally {
    $archive.Dispose()
  }
  $version = [IO.File]::ReadAllText((Join-Path $destination 'version')).Trim()
  $exeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $destination 'electron.exe')).FileVersion
  if ($version -notmatch '^\d+\.\d+\.\d+$' -or $exeVersion -notin $version, "$version.0") {
    throw '실행 파일의 Electron 버전을 확인할 수 없습니다.'
  }
  return @($entries.Keys | Sort-Object)
}

function Restore-UpdateFiles([object[]]$changes, [string]$backup) {
  foreach ($change in $changes) {
    if ($change.path -notmatch '^(?:runtime/|collector/(?:collect-notes\.ps1|list-date\.ps1|watch\.ps1|labels\.json)$)' -or
        $change.path -match '(?:^|/)(?:data|calendar-data|inbox|\.demo|\.qa)(?:/|$)' -or $change.existed -isnot [bool]) {
      throw '업데이트 복구 기록을 확인하지 못했습니다.'
    }
    $target = Get-UpdateTarget $Root $change.path
    $saved = Get-UpdateTarget $backup $change.path
    if ([IO.File]::Exists($saved)) {
      if ([IO.File]::Exists($target)) { [IO.File]::Replace($saved, $target, [NullString]::Value) }
      else { [IO.File]::Move($saved, $target) }
    } elseif (!$change.existed -and [IO.File]::Exists($target)) {
      [IO.File]::Delete($target)
    }
  }
}

function Install-RuntimeUpdate([string]$files, [string]$zip) {
  $appFiles = Join-Path $files 'runtime\resources\app'
  $version = (Get-Content -LiteralPath (Join-Path $appFiles 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '패치의 캘린더 버전이 올바르지 않습니다.' }
  $transaction = Get-UpdateTarget $Root "update-staging/electron-switch-$version"
  $newRuntime = Join-Path $transaction 'runtime'
  $backup = Join-Path $transaction 'backup'
  $journal = Join-Path $transaction 'journal.json'
  $committed = Join-Path $transaction 'committed'

  if ([IO.File]::Exists($journal)) {
    if (![IO.File]::Exists($committed)) {
      $script:recoveryPending = $true
      Restore-UpdateFiles @(Get-Content -LiteralPath $journal -Raw -Encoding UTF8 | ConvertFrom-Json) $backup
      $script:recoveryPending = $false
    }
    [IO.File]::Delete($journal)
  }
  Remove-UpdateTransaction $transaction
  [void][IO.Directory]::CreateDirectory($newRuntime)
  try {
    $payload = [ordered]@{}
    $runtimeFiles = @(Get-RuntimePayload $zip $newRuntime)
    foreach ($name in $runtimeFiles) { $payload["runtime/$name"] = Get-UpdateTarget $newRuntime $name }
    Get-ChildItem -LiteralPath $appFiles -Recurse -File | ForEach-Object {
      $name = $_.FullName.Substring($appFiles.Length + 1).Replace('\', '/')
      if ($_.FullName -ne $zip -and $name -ne 'package.json') { $payload["runtime/resources/app/$name"] = $_.FullName }
    }
    $collectorFiles = Join-Path $files 'collector'
    foreach ($name in 'collect-notes.ps1', 'list-date.ps1', 'watch.ps1', 'labels.json') {
      $source = Join-Path $collectorFiles $name
      if ([IO.File]::Exists($source)) { $payload["collector/$name"] = $source }
    }
    $payload['runtime/resources/app/package.json'] = Join-Path $appFiles 'package.json'

    $changes = @(
      foreach ($name in $payload.Keys) {
        if ($name -match '(?:^|/)(?:data|calendar-data|inbox|\.demo|\.qa)(?:/|$)') { throw "업데이트에 자료 경로가 있습니다: $name" }
        $target = Get-UpdateTarget $Root $name
        if ([IO.Directory]::Exists($target)) { throw "업데이트 파일 위치에 폴더가 있습니다: $name" }
        @{ path = $name; existed = [IO.File]::Exists($target) }
      }
    )
    $temp = Join-Path $transaction 'replace.tmp'
    [IO.File]::WriteAllText($temp, (ConvertTo-Json -InputObject $changes -Depth 3))
    [IO.File]::Move($temp, $journal)
    $script:recoveryPending = $true
    foreach ($change in $changes) {
      $target = Get-UpdateTarget $Root $change.path
      $saved = Get-UpdateTarget $backup $change.path
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.File]::Copy($payload[$change.path], $temp, $true)
      if ($change.existed) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved))
        [IO.File]::Replace($temp, $target, $saved)
      } else {
        [IO.File]::Move($temp, $target)
      }
    }
    [IO.File]::WriteAllText($committed, '')
    $script:recoveryPending = $false
  } catch {
    if ([IO.File]::Exists($journal)) {
      Restore-UpdateFiles $changes $backup
      [IO.File]::Delete($journal)
      $script:recoveryPending = $false
    }
    throw
  } finally {
    if (![IO.File]::Exists($journal) -or [IO.File]::Exists($committed)) {
      if ([IO.File]::Exists($journal)) { [IO.File]::Delete($journal) }
      try { Remove-UpdateTransaction $transaction } catch { Write-Log "cleanup: $($_.Exception.Message)" }
    }
  }
  $sandboxNote = Join-Path $Root 'no-sandbox.txt'
  if ([IO.File]::Exists($sandboxNote)) { Remove-Item -LiteralPath $sandboxNote -Force -ErrorAction SilentlyContinue }
}

# 한 번에 하나만 바꾼다. 실행기도 같은 이름으로 기다렸다가 캘린더를 켠다.
$mutex = New-Object System.Threading.Mutex($false, 'Local\SchoolCalendarUpdate')
$locked = $false
$recoveryPending = $false

try {
  try { $locked = $mutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { throw '다른 업데이트가 진행 중입니다. 잠시 뒤 다시 시도해 주세요.' }
  $Staging = (Resolve-Path -LiteralPath $Staging).Path
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
  $runtimeDir = Get-UpdateTarget $Root 'runtime'
  $deadline = (Get-Date).AddSeconds(30)
  while ($true) {
    $running = @(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $runtimeDir 'electron.exe') })
    if (-not $running.Count) { break }
    if ($WaitPid -le 0) { throw '브리티 메신저 캘린더가 켜져 있습니다. 캘린더를 닫은 뒤 update.cmd 를 다시 실행해 주세요.' }
    if ((Get-Date) -gt $deadline) { throw '캘린더가 꺼지지 않아 업데이트하지 못했습니다. 캘린더를 닫고 다시 시도해 주세요.' }
    Start-Sleep -Milliseconds 500
  }

  $runtimeZip = Join-Path $files 'runtime\resources\app\electron-runtime.zip'
  if ([IO.File]::Exists($runtimeZip)) {
    Install-RuntimeUpdate $files $runtimeZip
  } else {
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
  }
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
  if ($locked -and $Root -and !$recoveryPending) { Remove-Item -LiteralPath (Join-Path $Root 'update-staging\pending.txt') -Force -ErrorAction SilentlyContinue }
  Say "업데이트하지 못했습니다.`n$($_.Exception.Message)" 'Warning'
  if ($locked -and !$recoveryPending -and $WaitPid -gt 0 -and -not $NoRestart -and (Test-CalendarRoot $Root)) {
    # 실행기가 있으면 실행기로 켠다(Windows 26H2 꺼짐 문제 때 샌드박스 없이 다시 켜는 일을 실행기가 맡는다).
    $launcher = Join-Path $Root 'Brity Messenger Calendar.exe'
    if (Test-Path -LiteralPath $launcher) { Start-Process -FilePath $launcher -WorkingDirectory $Root }
    else {
      $startArgs = if (Test-Path -LiteralPath (Join-Path $Root 'no-sandbox.txt')) { @('--brity', '--no-sandbox') } else { @('--brity') }
      Start-Process -FilePath (Join-Path $Root 'runtime\electron.exe') -ArgumentList $startArgs -WorkingDirectory $Root
    }
  }
  exit 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
