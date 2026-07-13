@echo off
echo Starting RemoteDeskPBX Signaling Server...
echo.
echo IMPORTANT: Open port 3000 in your firewall!
echo Your friends will connect using your PUBLIC IP address.
echo.
echo Find your IP with: ipconfig (look for IPv4 Address)
echo.
cd /d "%~dp0"
start /wait "" "%cd%\dist\main\index.js" --server
pause