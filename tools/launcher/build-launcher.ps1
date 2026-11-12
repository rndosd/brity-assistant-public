# 실행기 만들기: powershell -ExecutionPolicy Bypass -File tools\launcher\build-launcher.ps1
# 결과: tools\launcher\out\Brity Messenger Calendar.exe, Brity Messenger Calendar Sample.exe (아이콘은 school-calendar\assets\app.ico).
# Windows에 들어 있는 .NET Framework C# 컴파일러(csc.exe)를 쓴다. 따로 설치할 것은 없다.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$icon = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'school-calendar\assets\app.ico'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'C# 컴파일러(csc.exe)를 찾지 못했습니다.' }
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$source = Join-Path $here 'Launcher.cs'
$targets = @(
  @{ Name = 'Brity Messenger Calendar.exe'; Define = '' },
  @{ Name = 'Brity Messenger Calendar Sample.exe'; Define = '/define:SAMPLE' }
)
foreach ($target in $targets) {
  $args = @('/nologo', '/target:winexe', '/optimize+', '/codepage:65001', "/win32icon:$icon", "/out:$(Join-Path $out $target.Name)", '/reference:System.Windows.Forms.dll')
  if ($target.Define) { $args += $target.Define }
  $args += $source
  & $csc @args
  if ($LASTEXITCODE -ne 0) { throw "실행기를 만들지 못했습니다: $($target.Name)" }
}
Get-ChildItem $out -Filter *.exe | Select-Object Name, Length
