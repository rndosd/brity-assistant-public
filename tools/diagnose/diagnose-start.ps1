# 브리티 메신저 캘린더가 켜지자마자 꺼질 때(0x80000003) 원인을 좁히는 진단 도구.
# 두 파일(이 파일과 '캘린더-진단.cmd')을 캘린더 폴더(Brity-Messenger-Calendar)에 넣고 cmd를 두 번 누른다.
# PC 설정은 바꾸지 않고, 샘플(--demo)만 여러 방식으로 켰다가 닫는다. 결과는 바탕 화면 '캘린더-진단.txt'(쪽지·업무 자료 없음).
param([string]$Root, [string]$Report, [switch]$NoPause)
$ErrorActionPreference = 'Continue'
if (-not $Root) {
  # 캘린더 폴더 바로 안에 두었거나, 그 안의 하위 폴더에 두었거나 둘 다 된다.
  $Root = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\electron.exe')) { $PSScriptRoot } else { Split-Path -Parent $PSScriptRoot }
}
$Root = (Resolve-Path -LiteralPath $Root).Path
$electron = Join-Path $Root 'runtime\electron.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$report = if ($Report) { $Report } else { Join-Path $desktop '캘린더-진단.txt' }
$logDir = Join-Path $env:TEMP ('calendar-diag-' + (Get-Date -Format 'HHmmss'))
New-Item -ItemType Directory -Force $logDir | Out-Null
$lines = [System.Collections.Generic.List[string]]::new()
function Note([string]$text) { $lines.Add($text); Write-Host $text }

if (-not (Test-Path -LiteralPath $electron)) {
  Write-Host "runtime\electron.exe 를 찾지 못했습니다. 이 파일을 캘린더 폴더(Brity-Messenger-Calendar) 안에 두고 실행해 주세요."
  Read-Host '엔터를 누르면 닫힙니다'
  exit 1
}

$os = Get-CimInstance Win32_OperatingSystem
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
Note "=== 브리티 메신저 캘린더 시작 진단 $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
Note "Windows: $($os.Caption) $($cv.DisplayVersion) 빌드 $($cv.CurrentBuild).$($cv.UBR)"
Note "CPU: $((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)"
foreach ($gpu in Get-CimInstance Win32_VideoController) { Note "GPU: $($gpu.Name) / 드라이버 $($gpu.DriverVersion) ($($gpu.DriverDate))" }
$electronVersion = (Get-Item -LiteralPath $electron).VersionInfo.FileVersion
$appVersion = try { (Get-Content (Join-Path $Root 'runtime\resources\app\package.json') -Raw | ConvertFrom-Json).version } catch { '?' }
Note "캘린더 $appVersion, Electron $electronVersion, 폴더: $Root"
try {
  $dg = Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop
  Note "메모리 무결성(HVCI) 실행 중: $(@($dg.SecurityServicesRunning) -contains 2)"
} catch { Note 'HVCI 상태: 확인 못 함' }
try { Note "스마트 앱 컨트롤: $((Get-MpComputerStatus -ErrorAction Stop).SmartAppControlState)" } catch {}
Note ''

function Stop-Tree([int]$id) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Tree $_.ProcessId }
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

# 방식마다 샘플을 켜고 12초 지켜본다. 살아 있으면 '켜짐'으로 보고 닫는다.
$trials = @(
  @{ Name = '1 기본'; Args = @('--demo') },
  @{ Name = '2 샌드박스 끔'; Args = @('--demo', '--no-sandbox') },
  @{ Name = '3 샌드박스+GPU 끔'; Args = @('--demo', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu') },
  @{ Name = '4 V8 최적화 끔'; Args = @('--demo', '--no-sandbox', '--js-flags=--no-opt --no-maglev --no-concurrent-recompilation') },
  @{ Name = '5 JIT 끔'; Args = @('--demo', '--no-sandbox', '--js-flags=--jitless') },
  @{ Name = '6 코드 무결성 검사 끔'; Args = @('--demo', '--no-sandbox', '--disable-features=RendererCodeIntegrity,WinSboxRestrictCoreSharingOnRenderer') },
  @{ Name = '7 모두 끔'; Args = @('--demo', '--no-sandbox', '--disable-gpu', '--in-process-gpu', '--js-flags=--jitless', '--disable-features=RendererCodeIntegrity') }
)
$started = Get-Date
foreach ($trial in $trials) {
  $log = Join-Path $logDir (($trial.Name -split ' ')[0] + '.log')
  $argList = $trial.Args + @('--enable-logging=file', "--log-file=$log")
  $quoted = $argList | ForEach-Object { if ($_ -match ' ') { '"' + $_ + '"' } else { $_ } }
  Write-Host "시험 $($trial.Name) ..."
  $p = Start-Process -FilePath $electron -ArgumentList $quoted -WorkingDirectory $Root -PassThru
  $alive = -not $p.WaitForExit(12000)
  if ($alive) { $result = '켜짐(12초 넘게 살아 있음)'; Stop-Tree $p.Id; Start-Sleep -Seconds 2 }
  else { $result = ('꺼짐 코드 0x{0:X8}' -f $p.ExitCode) }
  Note "[$($trial.Name)] $result  인자: $($trial.Args -join ' ')"
  if (Test-Path $log) {
    # 꺼진 까닭은 대개 마지막 FATAL/Check failed 줄에 있다. 늘 나오는 캐시 경고와 시험이 닫으며 생긴 줄은 뺀다.
    $all = Get-Content $log -Tail 600 -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch 'persistent_cache|Network service crashed|GPU process exited unexpectedly|has crashed 1 time|Reinitialized the GPU' }
    $keep = @($all | Where-Object { $_ -match 'FATAL|Check failed|NOTREACHED|DCHECK|Unhandled|STATUS_|0x8000' } | Select-Object -Last 6)
    if (-not $alive) { $keep += @($all | Select-Object -Last 4) }
    foreach ($t in ($keep | Select-Object -Unique)) { Note "    로그: $($t.Substring(0, [Math]::Min(400, $t.Length)))" }
  }
}

# 크로미움 없이 Node만 켜 보기(V8 자체가 꺼지는지 가린다).
$env:ELECTRON_RUN_AS_NODE = '1'
$p = Start-Process -FilePath $electron -ArgumentList @('-e', '"setTimeout(()=>process.exit(7),1500)"') -WorkingDirectory $Root -PassThru -WindowStyle Hidden
$done = $p.WaitForExit(15000)
Remove-Item Env:ELECTRON_RUN_AS_NODE
Note ("[8 Node만] " + $(if (-not $done) { '15초 넘게 안 끝남' } else { 'exit 0x{0:X8} (정상은 0x00000007)' -f $p.ExitCode }))
Note ''

Note '=== Windows 오류 기록(응용 프로그램 오류 1000, 방금 시험 이후) ==='
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000; StartTime = $started.AddMinutes(-1) } -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match 'electron' } | Select-Object -First 6)
foreach ($e in $events) {
  $msg = ($e.Message -split "`r?`n" | Where-Object { $_ -match '모듈|module|오프셋|offset|예외|Exception|버전|version' }) -join ' | '
  Note "  $($e.TimeCreated.ToString('HH:mm:ss')) $msg"
}
if (-not $events.Count) { Note '  (없음)' }

$dumps = Get-ChildItem -Path $Root, $env:LOCALAPPDATA\CrashDumps -Recurse -Include *.dmp -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $started } | Select-Object -First 5
if ($dumps) { Note ''; Note '크래시 덤프(필요하면 따로 보내 주세요):'; $dumps | ForEach-Object { Note "  $($_.FullName) $([int]($_.Length/1KB))KB" } }

$lines | Set-Content -LiteralPath $report -Encoding utf8
Write-Host ''
Write-Host "끝났습니다. 바탕 화면의 '캘린더-진단.txt'를 보내 주세요."
if (-not $NoPause) { Read-Host '엔터를 누르면 닫힙니다' }
