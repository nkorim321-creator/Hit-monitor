@echo off
REM ============================================================
REM  BP Vote Monitor - Windows installer
REM  Right-click -> "Run as administrator"
REM  - opens ports 3100 and 80 in Windows Firewall
REM  - creates a startup task so the server runs after every reboot
REM  - starts the server now
REM ============================================================
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [!] Right-click install-windows.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE (
  echo.
  echo  [!] Node.js not found. Install the LTS version from https://nodejs.org
  echo      then run this file again.
  echo.
  pause
  exit /b 1
)
echo  Node found: %NODE%

findstr /c:"\"ALL\"" "%~dp0passwords.json" >nul 2>&1
if not errorlevel 1 goto haveadmin
echo.
echo  First setup: choose the ADMIN password (opens ALL ID on the dashboard).
echo  Team passwords are set later from the dashboard: ALL ID -^> Passwords.
:askadmin
set "ADMINPW="
set /p "ADMINPW=Admin password: "
if not defined ADMINPW goto askadmin
"%NODE%" "%~dp0set-password.js" ALL "%ADMINPW%"
set "ADMINPW="
:haveadmin

(
  echo @echo off
  echo cd /d "%~dp0"
  echo set PORTS=3100,80
  echo "%NODE%" "%~dp0server.js" ^>^> server.log 2^>^&1
) > run-server.bat

netsh advfirewall firewall delete rule name="BP Vote Monitor" >nul 2>&1
netsh advfirewall firewall add rule name="BP Vote Monitor" dir=in action=allow protocol=TCP localport=3100,80 >nul
echo  Firewall: ports 3100 and 80 opened.

schtasks /end /tn "BP Vote Monitor" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*%~dp0server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
schtasks /create /tn "BP Vote Monitor" /tr "\"%~dp0run-server.bat\"" /sc onstart /ru SYSTEM /rl HIGHEST /f >nul
schtasks /run /tn "BP Vote Monitor" >nul
echo  Startup task created and server started.

timeout /t 3 >nul
echo.
echo  ======================================================
echo   Done! Open the dashboard:  http://localhost:3100
echo   From other PCs:            http://50.117.3.240   (or http://50.117.3.240:3100)
echo   Passwords are in passwords.json (change with set-password.js)
echo   Log file: %~dp0server.log
echo  ======================================================
echo.
start "" "http://localhost:3100"
pause
