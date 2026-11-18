@echo off
setlocal
cd /d %~dp0

where uv >nul 2>nul
if errorlevel 1 echo [setup] E001: uv not found. Install uv from https://docs.astral.sh/uv/ and run this script again.
if errorlevel 1 exit /b 1
where node >nul 2>nul
if errorlevel 1 echo [setup] E002: Node.js not found. Install Node.js from https://nodejs.org/ and run this script again.
if errorlevel 1 exit /b 1
where pnpm >nul 2>nul
if errorlevel 1 echo [setup] E003: pnpm not found. Install pnpm from https://pnpm.io/ and run this script again.
if errorlevel 1 exit /b 1

echo [setup] Installing backend dependencies...
pushd backend
uv sync
if errorlevel 1 popd
if errorlevel 1 echo [setup] E004: uv sync failed.
if errorlevel 1 exit /b 1
popd
if not exist backend\.env copy backend\.env.example backend\.env >nul
if not exist backend\.env echo [setup] E005: Failed to create backend\.env.
if not exist backend\.env exit /b 1

echo [setup] Installing frontend dependencies...
pushd frontend
call pnpm install
if errorlevel 1 popd
if errorlevel 1 echo [setup] E006: pnpm install failed.
if errorlevel 1 exit /b 1
popd
if not exist frontend\.env copy frontend\.env.example frontend\.env >nul
if not exist frontend\.env echo [setup] E007: Failed to create frontend\.env.
if not exist frontend\.env exit /b 1

echo [setup] Setup complete.
echo [setup] Start the llama.cpp OpenAI-compatible server separately, then run python dev.py for development or python prod.py --build for production.
endlocal
