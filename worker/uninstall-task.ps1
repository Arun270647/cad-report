# Stops and removes the "PanelBomWorker" scheduled task (only that task) and ends this folder's worker processes.
# Windows PowerShell 5.1 compatible.
#   powershell -ExecutionPolicy Bypass -File .\uninstall-task.ps1
$ErrorActionPreference = "Stop"
$TaskName = "PanelBomWorker"
$WorkerDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -ne $null) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task $TaskName."
} else {
    Write-Host "Task $TaskName is not installed."
}

$pattern = [regex]::Escape($WorkerDir)
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -match $pattern -and $_.CommandLine -match 'supervisor\.mjs|worker\.mjs|run-worker\.cmd|launch-hidden\.vbs'
} | ForEach-Object {
    Write-Host "Stopping worker process $($_.ProcessId) ($($_.Name))"
    & taskkill.exe /PID $_.ProcessId /T /F | Out-Null
}
