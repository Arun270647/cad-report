# Stops and removes the "PanelBomWorker" scheduled task (only that task). Windows PowerShell 5.1 compatible.
#   powershell -ExecutionPolicy Bypass -File .\uninstall-task.ps1
$ErrorActionPreference = "Stop"
$TaskName = "PanelBomWorker"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -eq $null) {
    Write-Host "Task $TaskName is not installed."
    exit 0
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task $TaskName."
Write-Host "If a worker console is still open, close it (or end node.exe running worker.mjs in Task Manager)."
