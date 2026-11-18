@echo off
setlocal
echo Brity note diagnostics. Keep Brity Messenger logged in until the report opens.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0detail-probe.ps1" -OpenReport
if errorlevel 1 pause
