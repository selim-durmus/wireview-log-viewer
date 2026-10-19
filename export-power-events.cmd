@echo off
rem Double-click to save this PC's power history to Downloads for WireView Log Viewer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export-power-events.ps1"
echo.
pause
