@echo off
cd /d "c:\Users\onlin\OneDrive\Рабочий стол\RemoteDeskPBX"
echo [1/3] Compiling main...
call node_modules\.bin\tsc -p tsconfig.main.json
if %errorlevel% neq 0 ( echo ERROR! & pause & exit /b )
echo OK
echo [2/3] Building renderer...
call node_modules\.bin\webpack --mode production
if %errorlevel% neq 0 ( echo ERROR! & pause & exit /b )
echo OK
echo [3/3] Building EXE...
call npx.cmd electron-builder --win portable
echo Done!
pause
