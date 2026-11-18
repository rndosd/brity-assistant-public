# GOE 메신저 캘린더가 GOE 메신저에 연결하지 못할 때 원인을 좁히는 진단 도구(2026-11-18).
# 'GOE-연결-진단.cmd'를 두 번 누르면 된다. 어디에 두어도 캘린더 폴더를 찾아 그 수집기로 연결 점검을 한 번 돌리고,
# 화면 배율·해상도, GOE 판·창 크기·보이는 단추 이름을 바탕 화면 'GOE-연결-진단.txt'에 적어 메모장으로 연다.
# 쪽지 내용·사람 이름은 적지 않는다(GOE 화면의 단추 이름만). PC·GOE 설정은 바꾸지 않는다.
# 연결 점검은 캘린더가 하는 것과 같아서, GOE가 다른 탭에 있으면 쪽지함 탭으로 바꿀 수 있다.
param([string]$Report, [switch]$NoOpen)
$ErrorActionPreference = 'Continue'
$lines = [Collections.Generic.List[string]]::new()
function Note([string]$t) { $lines.Add($t); Write-Host $t }
Add-Type -AssemblyName UIAutomationClient, System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Dg {
  delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(PT p, uint f);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr m, int t, out uint x, out uint y);
  public struct R { public int L, T, Rt, B; }
  public struct PT { public int X, Y; }
  public static List<IntPtr> ByClass(string cls) { var r = new List<IntPtr>(); EnumWindows((h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256); if (c.ToString() == cls) r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static uint MonitorDpi(int x, int y) { PT p; p.X = x; p.Y = y; uint dx, dy; return GetDpiForMonitor(MonitorFromPoint(p, 2), 0, out dx, out dy) == 0 ? dx : 0; }
}
'@
[void][Dg]::SetThreadDpiAwarenessContext([IntPtr](-4))
Note "GOE 연결 진단 $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Note "Windows: $($os.Caption) $($os.Version)"

Note ''
Note '[화면]'
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds; $dpi = [Dg]::MonitorDpi($b.X + 10, $b.Y + 10)
    Note ("  모니터: {0}x{1} 위치 {2},{3} 배율 {4}%{5}" -f $b.Width, $b.Height, $b.X, $b.Y, [int]($dpi / 96 * 100), $(if ($s.Primary) { ' (주 모니터)' } else { '' }))
}
$applied = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
if ($applied) { Note "  로그인할 때 배율: $([int]($applied / 96 * 100))%" }

Note ''
Note '[GOE 메신저]'
$procs = @(Get-Process -Name AtMessengerMobileEdition -ErrorAction SilentlyContinue)
Note "  실행 중인 GOE 프로세스: $($procs.Count)개"
foreach ($p in $procs) {
    $path = $null; try { $path = $p.MainModule.FileName } catch { }
    if ($path) { Note "  프로그램 판: $((Get-Item -LiteralPath $path).VersionInfo.FileVersion)" }
    else { Note '  프로그램 정보를 읽지 못함(관리자 권한으로 켜졌을 수 있음)' }
}
$mains = @([Dg]::ByClass('@Messenger7_MainWnd'))
Note "  메인 창: $($mains.Count)개"
$AE = [System.Windows.Automation.AutomationElement]
foreach ($h in $mains) {
    $r = New-Object Dg+R; [void][Dg]::GetWindowRect($h, [ref]$r)
    $fgPid = [uint32]0; [void][Dg]::GetWindowThreadProcessId([Dg]::GetForegroundWindow(), [ref]$fgPid)
    $wp = [uint32]0; [void][Dg]::GetWindowThreadProcessId($h, [ref]$wp)
    $state = if (-not [Dg]::IsWindowVisible($h)) { '트레이(숨김)' } elseif ([Dg]::IsIconic($h)) { '최소화' } else { '화면에 보임' }
    Note ("  창 상태: {0}, 크기 {1}x{2}, 창 배율 {3}%, 맨 앞: {4}" -f $state, ($r.Rt - $r.L), ($r.B - $r.T), [int]([Dg]::GetDpiForWindow($h) / 96 * 100), $(if ($fgPid -eq $wp) { '예' } else { '아니요' }))
    if ($state -eq '화면에 보임') {
        try {
            $all = @($AE::FromHandle($h).FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current })
            Note "  보이는 단추: $((@($all | Where-Object { $_.ClassName -eq 'Button' -and $_.Name } | ForEach-Object { $_.Name } | Select-Object -Unique)) -join ', ')"
            Note ("  쪽지 목록 칸: {0}, 목록 스크롤: {1}" -f $(if ($all | Where-Object { $_.ClassName -eq 'UltariListScrollView' }) { '있음' } else { '없음' }), $(if ($all | Where-Object { $_.ClassName -eq 'UListScrollBar' }) { '있음' } else { '없음' }))
        } catch { Note "  단추를 읽지 못함: $($_.Exception.Message)" }
    } else { Note '  (창이 화면에 없어 단추 목록은 아래 연결 점검으로 확인)' }
}

Note ''
Note '[캘린더 앱]'
$app = $null
$candidates = @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot))
foreach ($base in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('MyDocuments'), $env:USERPROFILE)) {
    if ($base -and (Test-Path -LiteralPath $base)) {
        $candidates += @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName; Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName })
    }
}
foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath (Join-Path $c 'goe.edition')) -and (Test-Path -LiteralPath (Join-Path $c 'collector\collect-goe.ps1'))) { $app = $c; break } }
if (-not $app) { Note '  GOE 메신저 캘린더 폴더를 찾지 못함(이 진단 폴더를 캘린더 폴더 안에 넣고 다시 실행해 주세요)' }
else {
    $pkg = Join-Path $app 'runtime\resources\app\package.json'
    $ver = if (Test-Path -LiteralPath $pkg) { (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { '?' }
    Note "  캘린더 판: $ver"
    Note "  수집기 수정 시각: $((Get-Item -LiteralPath (Join-Path $app 'collector\collect-goe.ps1')).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
}

function Run-Check([string]$name, [string]$collector) {
    $tmp = Join-Path $env:TEMP ('goe-diag-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $out = Join-Path $tmp 'out.txt'
    $p = Start-Process powershell -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$collector`"", '-Inspect', '-Inbox', "`"$tmp`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput $out
    if (-not $p.WaitForExit(90000)) { try { $p.Kill() } catch { }; Note "  ${name}: 90초 안에 끝나지 않음"; return }
    # the collector writes through the console code page (949 on Korean Windows), not UTF-8
    $text = $null
    try { $text = [IO.File]::ReadAllText($out, [Text.Encoding]::GetEncoding((Get-Culture).TextInfo.OEMCodePage)) } catch { }
    Note "  ${name}: $(if ($text) { $text.Trim() } else { '(출력 없음)' })"
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Note ''
Note '[연결 점검] (캘린더가 하는 것과 같은 점검, 쪽지는 열지 않음)'
if ($app) { Run-Check '설치된 수집기' (Join-Path $app 'collector\collect-goe.ps1') }
$bundled = Join-Path $PSScriptRoot 'collector\collect-goe.ps1'
if (Test-Path -LiteralPath $bundled) { Run-Check '새 수집기(진단 도구에 든 것)' $bundled }
Note ''
Note '읽는 법: status=ok 이면 연결됨. control-not-found:<이름> 이면 그 단추·칸을 찾지 못한 것(list=쪽지 목록 칸, scroll=목록 스크롤).'
Note 'main-window-not-found 는 창을 못 찾음, goe-not-running 은 GOE 꺼짐, no-korean-ocr 는 한국어 글자 인식 없음, user-is-in-goe 는 GOE를 쓰는 중.'

$report = if ($Report) { $Report } else { Join-Path ([Environment]::GetFolderPath('Desktop')) 'GOE-연결-진단.txt' }
[IO.File]::WriteAllLines($report, $lines, [Text.UTF8Encoding]::new($true))
if (-not $NoOpen) { Start-Process notepad.exe -ArgumentList "`"$report`"" }
