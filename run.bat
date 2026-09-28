@echo off
title CACAO WhatsApp CRM - Quick Launcher
color 0A
echo ===============================================================================
echo                CACAO WHATSAPP CRM - LOCAL RUNNER
echo ===============================================================================
echo.

cd /d "%~dp0"

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please download and install Node.js (LTS version) from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [1/3] Node.js found:
node -v
echo.

:: 2. Install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo [2/3] Installing dependencies (first run only, please wait)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
) else (
    echo [2/3] Dependencies already installed.
)
echo.

:: 3. Set Port & Environment
set PORT=3000
set HOST=0.0.0.0
set NODE_ENV=production

echo [3/3] Starting CACAO WhatsApp CRM on Port %PORT%...
echo ===============================================================================
echo   Local URL:       http://localhost:%PORT%
echo   ngrok Command:   ngrok http %PORT%
echo   Default Login:   admin / admin123
echo ===============================================================================
echo.

:: Open browser automatically after 2 seconds
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"

:: Start the server
if exist "dist-server\server.cjs" (
    node dist-server\server.cjs
) else (
    npx tsx server.ts
)

echo.
pause
