@echo off
title Mavi ERP
cd /d "%~dp0.."
echo ============================================
echo   MAVI ERP  -  starting up
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed.
  echo     Download the LTS version from https://nodejs.org
  echo     Install it, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/3] Installing packages - only the first time, may take a few minutes...
  call npm install
  if errorlevel 1 ( echo [!] npm install failed. Check your internet. & pause & exit /b 1 )
) else (
  echo [1/3] Packages already installed - skipping.
)

if not exist data\mavi.db (
  echo [2/3] Creating the database and demo data...
  call node src\seed.js
) else (
  echo [2/3] Database found - keeping your existing data.
)

echo [3/3] Starting the server...
echo.
echo    Admin panel   ^(owner / staff^):  http://localhost:3000/admin/
echo    Customer page              :  http://localhost:3000/store/
echo.
echo    Logins:  owner@mavi.eg / mavi-owner
echo             staff@mavi.eg / mavi-staff
echo.
echo    Keep this window OPEN while using the program.
echo    Close it (or press Ctrl+C) to stop the server.
echo ============================================
echo.
start "" http://localhost:3000/admin/
node src\server.js
pause
