# 배포용 ZIP 만들기: powershell -ExecutionPolicy Bypass -File tools\build-zip.ps1 [-Patch | -Seoryong]
# 결과: 저장소 루트의 BrityMessengerCalendar-Windows-x64-<General 또는 Seoryong>-<날짜>.zip.
# 받은 쪽지(collector/inbox)와 앱 자료는 넣지 않는다.
# -Patch는 공통 패치를 만든다. Electron을 바꿀 때는 -ElectronRuntimeZip에 해당 공식 Windows x64 ZIP을 지정한다.
#       결과는 저장소 루트 release\<판>\ 에 GitHub 릴리스에 그대로 올릴 영문 이름으로 둔다:
#       brity-messenger-calendar-windows-x64-<판>.zip(전체), brity-messenger-calendar-patch-<판>.zip(패치), update.json(판·지문·바뀐 점), notes.md.
#       앱의 업데이트 버튼은 배포받는 PC에서 접근할 수 있는 update.json을 읽는다.
param([switch]$Patch, [switch]$Seoryong, [string]$OutputDirectory, [string]$FactchatGuideUrl = $env:SCHOOL_CALENDAR_FACTCHAT_GUIDE, [string]$ElectronRuntimeZip)
$ErrorActionPreference = 'Stop'
if ($ElectronRuntimeZip -and -not $Patch) { throw '-ElectronRuntimeZip은 -Patch와 함께 사용하세요.' }
if ($Patch -and $Seoryong) {
  throw '공개 릴리스용 전체 ZIP과 공통 패치는 일반판에서 만듭니다. 서룡판 ZIP은 -Seoryong으로 따로 만드세요.'
}
if ($Seoryong) {
  $schoolGuide = $null
  if (-not [Uri]::TryCreate($FactchatGuideUrl, [UriKind]::Absolute, [ref]$schoolGuide) -or
      $schoolGuide.Scheme -ne 'https' -or -not $schoolGuide.Host.EndsWith('.factchat.bot', [StringComparison]::OrdinalIgnoreCase)) {
    throw '서룡판을 만들 때 -FactchatGuideUrl에 학교에서 받은 HTTPS 안내 주소를 넣어 주세요.'
  }
}
$repo = Split-Path -Parent $PSScriptRoot
$outputRoot = if ($OutputDirectory) { (Get-Item -LiteralPath $OutputDirectory).FullName } else { $repo }
$app = Join-Path $repo 'school-calendar'
$collectorSrc = Join-Path $repo 'collector'
$tempRoot = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName
$buildStage = Join-Path $tempRoot ('school-calendar-build-' + [guid]::NewGuid().ToString('N'))
$stageRoot = Join-Path $buildStage 'full'
$package = Get-Content (Join-Path $app 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version
$electronVersion = $package.devDependencies.electron
$installedRuntime = Join-Path $app 'node_modules\electron\dist'
$edition = if ($Seoryong) { 'Seoryong' } else { 'General' }
$out = Join-Path $outputRoot ("BrityMessengerCalendar-Windows-x64-$edition-" + (Get-Date -Format yyyyMMdd) + '.zip')
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

if ($ElectronRuntimeZip) {
  $ElectronRuntimeZip = (Get-Item -LiteralPath $ElectronRuntimeZip).FullName
  $runtimeZip = [IO.Compression.ZipFile]::OpenRead($ElectronRuntimeZip)
  try {
    $versionEntry = $runtimeZip.GetEntry('version')
    $exeEntry = $runtimeZip.GetEntry('electron.exe')
    if (-not $versionEntry -or -not $exeEntry) { throw 'Electron ZIP에 version 또는 electron.exe가 없습니다.' }
    $reader = New-Object IO.StreamReader($versionEntry.Open())
    try { $runtimeZipVersion = $reader.ReadToEnd().Trim() } finally { $reader.Dispose() }
    if ($runtimeZipVersion -ne $electronVersion) { throw 'Electron ZIP과 package.json의 Electron 버전이 다릅니다.' }
  } finally { $runtimeZip.Dispose() }
} elseif (-not (Test-Path -LiteralPath (Join-Path $installedRuntime 'version')) -or
          (Get-Content -LiteralPath (Join-Path $installedRuntime 'version') -Raw).Trim() -ne $electronVersion) {
  throw "Electron $electronVersion 설치가 필요합니다. school-calendar에서 npm ci를 실행하세요."
}

function New-Zip([string]$source, [string]$target) {
  if (Test-Path $target) { Remove-Item $target -Force }
  # Entry names with '/' (CreateFromDirectory on .NET Framework writes '\').
  $base = (Get-Item $source).FullName.TrimEnd('\')
  $fs = [IO.File]::Open($target, 'CreateNew')
  $za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
  Get-ChildItem $base -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length).Replace('\', '/').TrimStart('/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $_.FullName, $rel, 'Optimal')
  }
  $za.Dispose(); $fs.Dispose()
}

# 앱 코드(자료·inbox·.qa·.demo·시험·캐시 없음). 전체 ZIP과 패치가 같은 내용을 쓴다.
function Copy-AppCode([string]$appOut) {
  New-Item -ItemType Directory -Force $appOut | Out-Null
  $files = 'ai-provider.js','anthropic-api.js','backup.js','chat-batches.js','chat-decisions.js','claude-cli.js','codex-cli.js','collector-link.js','demo.js','feedback.js','main.js','note-text.js','preload.js','refine.js','store.js','updater.js','work-prompt.js',
           'chat-journal.ps1','collect-chats.ps1','collector-link.ps1','resolve-codex.ps1','update-apply.ps1','refinement-schema.json','rules-seed.md','CHANGES.json','Claude-연결-안내.html','Claude-API-연결-안내.html','Codex-연결-안내.html','API-연결-안내.html','처음-시작-안내.html'
  foreach ($f in $files) { Copy-Item (Join-Path $app $f) $appOut }
  Copy-Item (Join-Path $app 'renderer') $appOut -Recurse
  Copy-Item (Join-Path $app 'assets') $appOut -Recurse -ErrorAction SilentlyContinue
  Set-Content (Join-Path $appOut 'package.json') ('{"name":"school-calendar-portable","version":"' + $version + '","main":"portable-entry.cjs","private":true}') -Encoding ascii
@'
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const editionMarker = path.join(root, 'seoryong.edition');
const seoryong = fs.existsSync(editionMarker);
process.env.SCHOOL_CALENDAR_SEORYONG = seoryong ? '1' : '0';
process.env.SCHOOL_CALENDAR_FACTCHAT_GUIDE = seoryong ? fs.readFileSync(editionMarker, 'utf8').trim() : '';
if (process.argv.includes('--brity') && !process.argv.includes('--demo')) {
  process.env.SCHOOL_CALENDAR_DATA_DIR = path.join(root, 'calendar-data');
  process.env.SCHOOL_CALENDAR_DEFAULT_INBOX_DIR = path.join(root, 'collector', 'inbox');
  process.env.SCHOOL_CALENDAR_AUTOMATIC = '0';
  // 업데이트 버튼은 이 폴더(압축을 푼 곳)를 바꾼다.
  process.env.SCHOOL_CALENDAR_PORTABLE_ROOT = root;
  delete process.env.SCHOOL_CALENDAR_INBOX_DIR;
} else {
  process.argv.push('--demo');
}
require('./main');
'@ | Set-Content (Join-Path $appOut 'portable-entry.cjs') -Encoding ascii
}

function Copy-CollectorScripts([string]$coll) {
  New-Item -ItemType Directory -Force $coll | Out-Null
  Copy-Item (Join-Path $collectorSrc 'collect-notes.ps1'), (Join-Path $collectorSrc 'list-date.ps1'), (Join-Path $collectorSrc 'watch.ps1'), (Join-Path $collectorSrc 'labels.json') $coll
}

# 실행 파일(아이콘 있는 작은 실행기). tools\launcher\build-launcher.ps1 이 만든다. 없으면 .cmd 만 둔다.
$launcherDir = Join-Path $repo 'tools\launcher\out'
try { & (Join-Path $repo 'tools\launcher\build-launcher.ps1') | Out-Null }
catch { Write-Warning "실행기를 만들지 못해 .cmd 로 둡니다: $($_.Exception.Message)" }

# ---- 전체 ZIP ----
New-Item -ItemType Directory -Path $buildStage | Out-Null
try {
$root = Join-Path $stageRoot 'Brity-Messenger-Calendar'
$runtime = Join-Path $root 'runtime'
New-Item -ItemType Directory -Force $root | Out-Null
# Electron runtime (without the default app)
if ($ElectronRuntimeZip) { [IO.Compression.ZipFile]::ExtractToDirectory($ElectronRuntimeZip, $runtime) }
else { Copy-Item -LiteralPath $installedRuntime -Destination $runtime -Recurse }
Remove-Item (Join-Path $runtime 'resources\default_app.asar') -ErrorAction SilentlyContinue
Copy-AppCode (Join-Path $runtime 'resources\app')
Copy-CollectorScripts (Join-Path $root 'collector')

# Launchers and guides
if (Test-Path (Join-Path $launcherDir 'Brity Messenger Calendar.exe')) {
  Copy-Item (Join-Path $launcherDir 'Brity Messenger Calendar.exe'), (Join-Path $launcherDir 'Brity Messenger Calendar Sample.exe') $root
} else {
  "@echo off`r`nsetlocal`r`nif not exist `"%~dp0runtime\electron.exe`" (`r`n  echo Extract the entire ZIP before starting.`r`n  pause`r`n  exit /b 1`r`n)`r`nstart `"`" `"%~dp0runtime\electron.exe`" --brity`r`n" | Set-Content (Join-Path $root 'Start-Calendar.cmd') -Encoding ascii -NoNewline
  "@echo off`r`nsetlocal`r`nif not exist `"%~dp0runtime\electron.exe`" (`r`n  echo Extract the entire ZIP before starting the sample.`r`n  pause`r`n  exit /b 1`r`n)`r`nstart `"`" `"%~dp0runtime\electron.exe`" --demo`r`n" | Set-Content (Join-Path $root 'Start-Sample.cmd') -Encoding ascii -NoNewline
}
Copy-Item (Join-Path $app '처음-시작-안내.html'), (Join-Path $app 'API-연결-안내.html'), (Join-Path $app 'Claude-연결-안내.html'), (Join-Path $app 'Claude-API-연결-안내.html'), (Join-Path $app 'Codex-연결-안내.html') $root
$setup = Get-Content (Join-Path $app 'AI-SETUP.txt') -Raw -Encoding UTF8
if ($Seoryong) {
  Set-Content (Join-Path $root 'seoryong.edition') $schoolGuide.AbsoluteUri -Encoding ascii
  $generalAi = '• 개인 OpenAI API 키 · Luna (권장)'
  $schoolAi = @'
• 서룡 팩트챗 API · Luna (권장)
  학교에서 받은 팩트챗 API 키를 붙여 넣고 ‘연결 시험 및 저장’을 누릅니다.
• 개인 OpenAI API 키 · Luna
'@
  if (!$setup.Contains($generalAi)) { throw 'AI-SETUP.txt에서 일반판 권장 연결 문구를 찾을 수 없습니다.' }
  $setup = $setup.Replace($generalAi, $schoolAi)
  $recommendedAi = '서룡 팩트챗 Luna'
} else {
  $recommendedAi = '개인 OpenAI API Luna'
}
Set-Content (Join-Path $root 'AI-SETUP.txt') $setup -Encoding utf8 -NoNewline
@"
브리티 메신저 캘린더 · Windows x64
이 프로그램은 브리티 메신저의 공식 기능이 아니라 개인이 만든 비공식 도구입니다(삼성SDS·교육청과 관계없음).

1. ZIP 전체를 쓰기 가능한 폴더(예: 문서)에 풉니다.
2. 가상 자료로 둘러보려면 'Brity Messenger Calendar Sample'을 엽니다.
3. 'Brity Messenger Calendar'를 엽니다.
   처음 열 때 Windows가 "PC 보호" 창을 띄우면 '추가 정보' → '실행'을 누릅니다.
   설정 → 백업·정보의 '바탕 화면에 바로 가기 만들기'를 누르면 다음부터 바탕 화면에서 열 수 있습니다.
4. 1단계: 앱 위쪽의 'AI 연결'을 눌러 AI를 먼저 연결합니다($recommendedAi 권장). 쪽지에서 날짜와 할 일을 뽑는 일을 AI가 합니다.
5. 2단계: 브리티 메신저에 로그인한 뒤 앱 위쪽의 '브리티 연결'을 누릅니다.
   자세한 순서는 처음-시작-안내.html과 AI-SETUP.txt에 있습니다.
6. 배포한 곳에서 새 ZIP을 받을 수 있습니다. 설정의 '백업 만들기'로 기존 업무와 쪽지를 옮길 수 있습니다.

실행에 필요한 파일이 모두 들어 있어 Node.js 설치 없이 열립니다.

켜자마자 꺼지면(오류 0x80000003): 폴더 권한에 다른 앱의 항목만 있고 '모든 응용 프로그램 패키지' 읽기 권한이 없을 때 생깁니다.
실행기('Brity Messenger Calendar')로 켜면 runtime 폴더에만 그 권한을 더해 고칩니다. runtime\electron.exe를 직접 켜지 마세요.
그래도 켜지지 않으면 GitHub 첫 화면 '켜지지 않을 때'의 진단 도구 결과를 보내 주세요.
"@ | Set-Content (Join-Path $root 'Read-me.txt') -Encoding utf8
New-Zip $stageRoot $out
Get-Item $out | Select-Object FullName, Length

if (-not $Patch) { return }

# ---- 패치 ZIP과 update.json ----
$releaseDir = Join-Path $outputRoot "release\$version"
New-Item -ItemType Directory -Force $releaseDir | Out-Null
Copy-Item $out (Join-Path $releaseDir "brity-messenger-calendar-windows-x64-$version.zip") -Force

$patchStage = Join-Path $buildStage 'patch'
$patchRoot = Join-Path $patchStage 'School-Calendar-Patch'
Copy-AppCode (Join-Path $patchRoot 'files\runtime\resources\app')
if ($ElectronRuntimeZip) {
  Copy-Item -LiteralPath $ElectronRuntimeZip -Destination (Join-Path $patchRoot 'files\runtime\resources\app\electron-runtime.zip')
}
Copy-CollectorScripts (Join-Path $patchRoot 'files\collector')
Copy-Item (Join-Path $app 'update-apply.ps1') $patchRoot
"@echo off`r`nsetlocal`r`npowershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0update-apply.ps1`" -Staging `"%~dp0.`"`r`n" | Set-Content (Join-Path $patchRoot 'update.cmd') -Encoding ascii -NoNewline
@'
브리티 메신저 캘린더 패치

보통은 캘린더 머리줄의 '업데이트' 버튼으로 바꿉니다. 버튼을 쓸 수 없을 때만 아래처럼 합니다.

1. 캘린더를 닫습니다.
2. 이 ZIP을 캘린더 폴더(runtime 폴더가 있는 곳) 안에 풉니다.
3. School-Calendar-Patch 폴더의 update.cmd 를 엽니다.
   업무와 받은 쪽지(calendar-data, collector\inbox)는 그대로 남습니다.
'@ | Set-Content (Join-Path $patchRoot '읽어 보기.txt') -Encoding utf8
$patchName = "brity-messenger-calendar-patch-$version.zip"
$patchFile = Join-Path $releaseDir $patchName
New-Zip $patchStage $patchFile
if ((Get-Item -LiteralPath $patchFile).Length -gt 200MB) { throw '기존 캘린더에서 받을 수 있는 패치 크기(200MiB)를 넘었습니다.' }
$sha = (Get-FileHash $patchFile -Algorithm SHA256).Hash.ToLower()

$changes = Get-Content (Join-Path $app 'CHANGES.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest = [ordered]@{ version = $version; file = $patchName; sha256 = $sha; changes = @($changes) }
# 기존 앱은 electron이 다르면 패치를 받지 않는다. Electron이 포함된 패치만 이 제한을 건너뛴다.
if (-not $ElectronRuntimeZip) { $manifest.electron = $electronVersion }
[IO.File]::WriteAllText((Join-Path $releaseDir 'update.json'), ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
$current = @($changes | Where-Object { $_.version -eq $version })
# 릴리스 페이지에는 파일이 여럿(전체 ZIP·패치·update.json + GitHub가 붙이는 Source code 둘) 보여 헷갈리므로(2026-11-15 사용자),
# 노트 맨 위에 받을 파일 하나를 바로 받는 링크로 두고, 나머지는 받지 않아도 된다고 맨 아래에 작게 적는다.
$fullName = "brity-messenger-calendar-windows-x64-$version.zip"
$fullUrl = "https://github.com/rndosd/brity-assistant-public/releases/download/v$version/$fullName"
$updateNote = if ($ElectronRuntimeZip) {
  "이미 쓰고 있다면 앱 머리줄의 **업데이트**를 누르세요. 앱이 열리지 않고 기존 자료가 있으면 ``$patchName``을 기존 캘린더 폴더 안에 풀고 ``School-Calendar-Patch/update.cmd``를 실행하세요."
} else {
  "이미 쓰고 있다면 받을 필요 없이 앱 머리줄의 **업데이트**를 누르세요."
}
$items = ($current | ForEach-Object { $_.items | ForEach-Object { "- $_" } }) -join "`n"
$notes = "### ⬇️ 설치하려면 이것만 받으세요`n`n**[$fullName]($fullUrl)**`n받은 ZIP을 **전체 압축 풀기**한 뒤 ``Brity Messenger Calendar``를 실행하세요.`n`n$updateNote`n`n" +
         "## $($version)에서 바뀐 점`n`n$items`n`n---`n`n" +
         "<sub>아래 다른 파일은 받지 않아도 됩니다. ``$patchName``과 ``update.json``은 앱의 업데이트 버튼이 자동으로 쓰고, Source code는 GitHub가 붙이는 프로그램 소스라 실행 파일이 없습니다.</sub>`n"
[IO.File]::WriteAllText((Join-Path $releaseDir 'notes.md'), $notes, (New-Object Text.UTF8Encoding($false)))
Get-ChildItem $releaseDir | Select-Object Name, Length
} finally {
  $createdStage = Get-Item -LiteralPath $buildStage
  if ($createdStage.FullName -eq $buildStage -and $createdStage.Parent.FullName -eq $tempRoot -and
      -not ($createdStage.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Remove-Item -LiteralPath $createdStage.FullName -Recurse -Force
  }
}
