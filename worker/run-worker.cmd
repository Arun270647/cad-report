@echo off
rem Keeps the worker running: restarts it 60 s after any exit. Output goes to logs\worker.log.
rem Usage: run-worker.cmd ["C:\path\to\node.exe"]   (default: node on PATH)
setlocal
title PanelBomWorker
cd /d "%~dp0"
set "NODE_EXE=%~1"
if "%NODE_EXE%"=="" set "NODE_EXE=node"
if not exist "%~dp0logs" mkdir "%~dp0logs"
:loop
echo [%date% %time%] starting worker>> "%~dp0logs\worker.log"
"%NODE_EXE%" "%~dp0worker.mjs" >> "%~dp0logs\worker.log" 2>&1
echo [%date% %time%] worker exited with code %errorlevel%; restarting in 60 s>> "%~dp0logs\worker.log"
rem ping instead of timeout: timeout fails without an interactive console.
ping -n 61 127.0.0.1 >nul
goto loop
