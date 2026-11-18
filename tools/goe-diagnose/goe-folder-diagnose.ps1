param([string]$Report)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, Accessibility
. (Join-Path $PSScriptRoot 'collector\goe-folder-state.ps1')
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FolderButtonDiagnostic {
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible acc);

    public static string LegacyState(IntPtr h) {
        if (h == IntPtr.Zero) return "-";
        Accessibility.IAccessible acc = null;
        try {
            Guid iid = typeof(Accessibility.IAccessible).GUID;
            if (AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out acc) == 0 && acc != null) {
                // Only SELECTED, CHECKED and MIXED. Focus and momentary presses are irrelevant.
                object state = acc.get_accState(0);
                if (state is int) return (((int)state) & 0x32).ToString();
            }
        } catch (COMException) {
        } finally { if (acc != null && Marshal.IsComObject(acc)) Marshal.ReleaseComObject(acc); }
        return "-";
    }
}
'@

$element = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$condition = [System.Windows.Automation.PropertyCondition]
$mainClass = $condition::new($element::ClassNameProperty, '@Messenger7_MainWnd')
$buttonClass = $condition::new($element::ClassNameProperty, 'Button')

function Find-FolderButton($Main, [string]$Caption) {
    $name = $condition::new($element::NameProperty, $Caption)
    $match = [System.Windows.Automation.AndCondition]::new($buttonClass, $name)
    $buttons = @($Main.FindAll($scope::Descendants, $match) | Where-Object { -not $_.Current.IsOffscreen })
    if ($buttons.Count -eq 1) { $buttons[0] }
}

function Get-ButtonSignals($Button) {
    $handle = [IntPtr]$Button.Current.NativeWindowHandle
    'MSAA={0}, BM_GETCHECK={1}' -f [FolderButtonDiagnostic]::LegacyState($handle), [GoeFolderButton]::Checked($handle)
}

$messages = @{
    inbox = '수신함'
    sent = '발신함'
    ambiguous = '선택값 불확실'
    unsupported = '선택값 미제공'
    'window-missing' = '화면에 열린 GOE 메인 창을 찾지 못함'
    'multiple-windows' = 'GOE 메인 창이 여러 개 보임'
    'window-changed' = '점검 도중 GOE 창이 바뀜'
    'buttons-missing' = '화면에 표시된 수신함·발신함 단추를 한 쌍으로 찾지 못함'
    'read-error' = 'Windows에서 선택 상태를 읽지 못함'
}

$lines = [Collections.Generic.List[string]]::new()
function Note([string]$Text) { $lines.Add($Text); Write-Host $Text }

Write-Host 'GOE 캘린더를 닫고, GOE 메신저의 쪽지 탭을 화면에 열어 두세요.'
Write-Host '안내에 따라 함만 바꿔 주세요. 쪽지는 열 필요가 없습니다.'
Note 'GOE 수신함 선택 진단'
$observed = @()
$panes = [Collections.Generic.List[object]]::new()
$paneLabels = @{}
$previousWindow = $null
foreach ($expected in 'inbox', 'sent', 'inbox') {
    $caption = $messages[$expected]
    [void](Read-Host "GOE에서 $caption 단추를 누른 뒤 이 창으로 돌아와 Enter를 누르세요")
    $signals = $null
    $pane = $null
    try {
        $mains = @($element::RootElement.FindAll($scope::Children, $mainClass) | Where-Object { -not $_.Current.IsOffscreen })
        $status = if ($mains.Count -eq 0) { 'window-missing' }
        elseif ($mains.Count -gt 1) { 'multiple-windows' }
        else {
            $main = $mains[0]
            $window = $main.Current.NativeWindowHandle
            if ($null -ne $previousWindow -and $window -ne $previousWindow) { 'window-changed' }
            else {
                $previousWindow = $window
                $inbox = Find-FolderButton $main '수신함'
                $sent = Find-FolderButton $main '발신함'
                if ($inbox -and $sent) {
                    $pane = Wait-GoeNotePane ([IntPtr]$window) $null
                    try {
                        $inSignals = Get-ButtonSignals $inbox
                        $outSignals = Get-ButtonSignals $sent
                        $signals = "  수신함 [$inSignals] / 발신함 [$outSignals]"
                    } catch { $signals = '  보조 단추 상태 확인 불가' }
                    Get-GoeFolderState $inbox $sent
                }
                else { 'buttons-missing' }
            }
        }
    } catch { $status = 'read-error' }
    if (-not $status -or -not $messages.ContainsKey($status)) { $status = 'read-error' }
    $observed += $status
    $panes.Add($pane)
    Note ("{0}번째 · 선택한 함 {1} · Windows 판정 {2}" -f $observed.Count, $caption, $messages[$status])
    if ($pane) {
        $pair = '{0}/{1}/{2}' -f $pane.List.ToInt64(), $pane.Scroll.ToInt64(), $pane.Parent.ToInt64()
        if (-not $paneLabels.ContainsKey($pair)) { $paneLabels[$pair] = @('A', 'B', 'C')[$paneLabels.Count] }
        Note ("  화면에 표시된 목록·스크롤 쌍 " + $paneLabels[$pair])
    } else { Note '  화면에 표시된 목록·스크롤 쌍 확인 불가' }
    if ($signals) { Note $signals }
    if ($status -notin 'inbox', 'sent', 'ambiguous', 'unsupported') { break }
}

$buttonMatch = ($observed -join ',') -eq 'inbox,sent,inbox'
if ($buttonMatch) { Note '단추 결과 · 세 번 모두 선택한 함과 일치했습니다.' }
else { Note '단추 결과 · 세 번 모두 일치하는 신호를 확인하지 못했습니다.' }
$paneMatch = $panes.Count -eq 3 -and $panes[0] -and $panes[1] -and $panes[2] -and
    $panes[0].List -ne $panes[1].List -and $panes[0].Scroll -ne $panes[1].Scroll -and $panes[0].Parent -ne $panes[1].Parent -and
    (Test-GoeSamePane $panes[0] $panes[2])
if ($paneMatch) { Note '목록 결과 · 발신함에서 목록과 스크롤이 함께 바뀌고, 수신함으로 돌아오자 처음 쌍이 다시 나타났습니다.' }
else { Note '목록 결과 · 수신함과 발신함을 구별하는 목록 쌍을 확인하지 못했습니다.' }

if (-not $Report) {
    $Report = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ('GOE-수신함-선택-진단-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.txt')
}
[IO.File]::WriteAllLines($Report, $lines, [Text.UTF8Encoding]::new($true))
Write-Host "결과 파일을 저장했습니다. $Report"
