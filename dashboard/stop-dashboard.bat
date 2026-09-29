@echo off
cd /d "%~dp0"
node serve.js stop
if errorlevel 1 pause
