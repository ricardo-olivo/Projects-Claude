@echo off
cd /d "%~dp0"
start "Dashboard Farmacias - servidor" powershell -NoExit -ExecutionPolicy Bypass -File serve.ps1
timeout /t 2 /nobreak >nul
start "" http://localhost:51873
