@echo off
rem Runs the worker in this console window via the supervisor (restart with backoff, daily logs in logs\).
rem The scheduled task does NOT use this file (see install-task.ps1); it is for running by hand.
rem Usage: run-worker.cmd ["C:\path\to\node.exe"]   (default: C:\Program Files\nodejs\node.exe, else node on PATH)
setlocal
title PanelBomWorker
cd /d "%~dp0"
set "NODE_EXE=%~1"
if "%NODE_EXE%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if "%NODE_EXE%"=="" set "NODE_EXE=node"
echo Worker running; output goes to %~dp0logs\worker-YYYY-MM-DD.log. Press Ctrl+C to stop.
"%NODE_EXE%" "%~dp0supervisor.mjs"
