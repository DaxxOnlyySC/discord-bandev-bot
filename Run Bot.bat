@echo off
title Discord Bandev Bot
cd /d "%~dp0"

rem -- Node versi portable (tanpa admin): tambahkan ke PATH sesi ini --
set "NODEDIR=%LOCALAPPDATA%\Programs\nodejs"
if exist "%NODEDIR%\node.exe" set "PATH=%NODEDIR%;%PATH%"

echo ============================================
echo    Discord Bandev Bot  -  Launcher
echo ============================================
echo.

rem ========== 1) Node.js ==========
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js belum terinstall.
  echo.
  echo   Install dulu dari:  https://nodejs.org  ^(pilih LTS^)
  echo   Centang "Add node.exe to PATH" saat instal.
  echo.
  echo   Membuka halaman download...
  start "" "https://nodejs.org"
  echo.
  pause
  exit /b 1
)
echo   [OK] Node : & node --version
echo   [OK] npm  : & call npm --version
echo.

rem ========== 2) file .env ==========
if not exist ".env" (
  echo   [!] .env belum ada - dibuat dari .env.example
  copy ".env.example" ".env" >nul
  echo.
  echo   ==================================================
  echo    BUKA file .env, isi DISCORD_TOKEN kamu,
  echo    lalu jalankan launcher ini lagi.
  echo   ==================================================
  echo.
  if exist ".env" start "" ".env"
  pause
  exit /b 1
)

findstr /b /c:"DISCORD_TOKEN=" ".env" | findstr /v /c:"your_discord" >nul
if errorlevel 1 (
  echo   [X] DISCORD_TOKEN belum diisi di file .env
  echo.
  if exist ".env" start "" ".env"
  pause
  exit /b 1
)
echo   [OK] .env terisi
echo.

rem ========== 3) dependencies ==========
if not exist "node_modules\discord.js" (
  echo   [!] node_modules belum ada - menjalankan npm install ...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] npm install gagal. Cek koneksi internet.
    pause
    exit /b 1
  )
  echo.
)
echo   [OK] dependencies siap
echo.

rem ========== 4) jalankan ==========
echo ============================================
echo    Menjalankan bot...  Ctrl+C untuk berhenti
echo ============================================
echo.
node index.js
echo.
echo   Bot berhenti.
pause