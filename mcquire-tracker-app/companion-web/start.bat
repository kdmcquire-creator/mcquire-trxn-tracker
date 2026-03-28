@echo off
REM ── McQuire Companion Web — Start server + tunnel ──────────────────────────
REM
REM Usage: start.bat
REM   Starts the Express server and Cloudflare Tunnel together.
REM   Make sure you've run setup-tunnel first and created your .env file.
REM ───────────────────────────────────────────────────────────────────────────

echo Starting McQuire Companion Web...

REM Start the Express server
start "McQuire Server" cmd /k "cd /d %~dp0 && npx tsx server/index.ts"

REM Give server a moment to start
timeout /t 2 /nobreak >nul

REM Start the Cloudflare Tunnel (adjust config path if needed)
start "Cloudflare Tunnel" cmd /k "cloudflared tunnel --config %USERPROFILE%\.cloudflared\config-mcquire.yml run mcquire-companion"

echo.
echo Server running on http://localhost:3000
echo Tunnel connecting to Cloudflare...
echo.
echo Close both command windows to stop.
