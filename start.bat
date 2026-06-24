@echo off
cd /d "%~dp0"
echo kaikei を起動しています...
start "" http://localhost:3941
node server.js
pause
