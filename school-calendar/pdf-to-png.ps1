# PDF 첫 쪽(들)을 PNG로 그린다(시간표 PDF를 AI에 그림으로 넘기기, 2026-11-26).
# Windows에 들어 있는 Windows.Data.Pdf를 쓴다(따로 설치 없음). 사용: -Pdf <파일> -OutDir <폴더> [-Pages 2] [-Width 1400]
param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Pages = 2,
  [int]$Width = 1400
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($operation, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}
function AwaitAction($action) { $asTaskAction.Invoke($null, @($action)).Wait(-1) | Out-Null }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $Pdf).Path)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$count = [Math]::Min([int]$doc.PageCount, $Pages)
for ($index = 0; $index -lt $count; $index++) {
  $page = $doc.GetPage([uint32]$index)
  $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $options.DestinationWidth = [uint32]$Width
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($page.RenderToStreamAsync($stream, $options))
  $target = Join-Path $OutDir ("page-{0}.png" -f ($index + 1))
  $source = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
  $output = [System.IO.File]::Create($target)
  try { $source.CopyTo($output) } finally { $output.Dispose(); $source.Dispose(); $stream.Dispose(); $page.Dispose() }
  Write-Output $target
}
