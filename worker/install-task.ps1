# Registers the Windows Scheduled Task "PanelBomWorker" that keeps the worker running.
# Windows PowerShell 5.1 compatible. Run from any folder:
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
#       At logon of the current user. No console window (wscript launcher). No admin needed.
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Hidden [-User PC\name]
#       ELEVATED PowerShell: at system startup, whether or not anyone is logged on (S4U, no window, no stored
#       password). -User registers it for the account that holds the Claude Code login (default: you).
# The task runs supervisor.mjs, which restarts the worker with backoff and writes logs\worker-YYYY-MM-DD.log.
# Only the task named below and node processes running THIS folder's worker are touched.
param(
    [string]$NodePath = "",
    [switch]$Hidden,
    [string]$User = "",
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"
$TaskName = "PanelBomWorker"
$WorkerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Supervisor = Join-Path $WorkerDir "supervisor.mjs"
$Launcher = Join-Path $WorkerDir "launch-hidden.vbs"

foreach ($f in @($Supervisor, (Join-Path $WorkerDir "worker.mjs"), $Launcher)) {
    if (-not (Test-Path $f)) { throw "$(Split-Path -Leaf $f) not found in $WorkerDir" }
}
if (-not (Test-Path (Join-Path $WorkerDir ".env"))) {
    Write-Warning "No .env in $WorkerDir - copy .env.example to .env and set WORKER_TOKEN first."
}

# Prefer the machine-wide Node (C:\Program Files\nodejs) over per-user installs such as nvm.
if ($NodePath -eq "") {
    $sys = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $sys) { $NodePath = $sys }
    else {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd -eq $null) { throw "node.exe not found. Install Node (https://nodejs.org) or pass -NodePath C:\path\to\node.exe" }
        $NodePath = $cmd.Source
    }
}
if (-not (Test-Path $NodePath)) { throw "Node not found at $NodePath" }
$ver = (& $NodePath -v).Trim()
if ([int]($ver.TrimStart('v').Split('.')[0]) -lt 20) { throw "Node $ver at $NodePath is too old (need 20+)" }
Write-Host "Node:   $NodePath ($ver)"
Write-Host "Worker: $WorkerDir"

if ($User -eq "") { $User = "$env:USERDOMAIN\$env:USERNAME" }

function Stop-WorkerProcesses([string]$Dir) {
    # node/cmd/wscript processes whose command line points at THIS worker folder (old run-worker.cmd included).
    $pattern = [regex]::Escape($Dir)
    Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $pattern -and $_.CommandLine -match 'supervisor\.mjs|worker\.mjs|run-worker\.cmd|launch-hidden\.vbs'
    } | ForEach-Object {
        Write-Host "Stopping old worker process $($_.ProcessId) ($($_.Name))"
        & taskkill.exe /PID $_.ProcessId /T /F | Out-Null
    }
}

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

if ($Hidden) {
    # Runs in session 0 without a desktop: no window to hide, start node directly.
    $Action = New-ScheduledTaskAction -Execute $NodePath -Argument ('"' + $Supervisor + '"') -WorkingDirectory $WorkerDir
    $Trigger = New-ScheduledTaskTrigger -AtStartup
    $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
} else {
    # wscript runs launch-hidden.vbs, which starts node with window style 0 (no console window) and waits.
    $Arg = '//B //Nologo "' + $Launcher + '" "' + $NodePath + '"'
    $Action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument $Arg -WorkingDirectory $WorkerDir
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -ne $null) {
    Write-Host "Replacing existing task $TaskName"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Stop-WorkerProcesses $WorkerDir

$mode = if ($Hidden) { "at startup, S4U, user $User" } else { "at logon of $User, no window" }
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
    -Description "Panel BOM Pricer local worker (Claude Code, no tools) - $mode. Logs: $WorkerDir\logs\worker-YYYY-MM-DD.log" -Force | Out-Null
Write-Host "Registered scheduled task $TaskName ($mode)."

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    $today = Get-Date -Format "yyyy-MM-dd"
    Write-Host "Started. Follow the log with:  Get-Content '$WorkerDir\logs\worker-$today.log' -Wait -Tail 20"
}
