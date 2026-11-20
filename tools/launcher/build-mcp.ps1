param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $csc)) { throw 'C# compiler (csc.exe) was not found.' }

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$output = Join-Path $OutputDirectory 'CalendarMcp.exe'
$options = @('/nologo', '/target:exe', '/optimize+', '/codepage:65001', '/reference:System.Web.Extensions.dll', "/out:$output")
& $csc @options (Join-Path $PSScriptRoot 'CalendarMcp.cs')
if ($LASTEXITCODE -ne 0) { throw 'Could not build CalendarMcp.exe.' }
