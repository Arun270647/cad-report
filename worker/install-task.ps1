# Registers the Windows Scheduled Task "PanelBomWorker" that keeps the worker running.
# Windows PowerShell 5.1 compatible. Run from the worker folder:
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1            (at logon of the current user, console window)
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Hidden    (elevated PowerShell: runs at startup, no window,
#                                                                           whether or not you are logged on)
# Only the task named below is created/replaced; other scheduled tasks are not touched.
param(
    [string]$NodePath = "",
    [switch]$Hidden,
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"
$TaskName = "PanelBomWorker"
$WorkerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $WorkerDir "run-worker.cmd"
$WorkerJs = Join-Path $WorkerDir "worker.mjs"

if (-not (Test-Path $Runner)) { throw "run-worker.cmd not found in $WorkerDir" }
if (-not (Test-Path $WorkerJs)) { throw "worker.mjs not found in $WorkerDir" }
if (-not (Test-Path (Join-Path $WorkerDir ".env"))) {
    Write-Warning "No .env in $WorkerDir - copy .env.example to .env and set WORKER_TOKEN first."
}

if ($NodePath -eq "") {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -eq $null) { throw "node.exe not found on PATH. Install Node 22 or pass -NodePath C:\path\to\node.exe" }
    $NodePath = $cmd.Source
}
Write-Host "Node:   $NodePath"
Write-Host "Worker: $WorkerDir"

$User = "$env:USERDOMAIN\$env:USERNAME"
# cmd /d /s /c ""runner" "node"" - constant arguments, no user data.
$Arg = '/d /s /c ""' + $Runner + '" "' + $NodePath + '""'
$Action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument $Arg -WorkingDirectory $WorkerDir

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

if ($Hidden) {
    $Trigger = New-ScheduledTaskTrigger -AtStartup
    $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
} else {
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -ne $null) {
    Write-Host "Replacing existing task $TaskName"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
    -Description "Panel BOM Pricer local worker (Claude Code, no tools). Logs: $WorkerDir\logs\worker.log" -Force | Out-Null
Write-Host "Registered scheduled task $TaskName."

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started. Follow the log with:  Get-Content '$WorkerDir\logs\worker.log' -Wait -Tail 20"
}
