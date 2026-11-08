@echo off
setlocal
cd /d "%~dp0"
set "KEYFILE=%~dp0.env.local"
if not exist "%KEYFILE%" (
  echo Create .env.local in this folder with this line:
  echo MESH_API_KEY=your_mesh_api_key_here
  echo.
  echo Replace the example value with your real key. Do not share or commit it.
  notepad "%KEYFILE%"
  if not exist "%KEYFILE%" exit /b 1
)
set "MESH_API_KEY="
for /f "usebackq tokens=1,* delims==" %%A in ("%KEYFILE%") do if /i "%%A"=="MESH_API_KEY" set "MESH_API_KEY=%%B"
if not defined MESH_API_KEY echo MESH_API_KEY was not found in .env.local. Add MESH_API_KEY=your_key and try again.& exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preview-server.ps1"
