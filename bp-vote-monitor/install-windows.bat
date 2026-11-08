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

REM run-server.bat restarts the server 5 seconds after it stops for any reason
(
  echo @echo off
  echo cd /d "%~dp0"
  echo set PORTS=3100,80
  echo :loop
  echo echo [%%date%% %%time%%] starting server ^>^> server.log
  echo "%NODE%" "%~dp0server.js" ^>^> server.log 2^>^&1
  echo echo [%%date%% %%time%%] server stopped, restarting in 5 seconds ^>^> server.log
  echo ping -n 6 127.0.0.1 ^>nul
  echo goto loop
) > run-server.bat

netsh advfirewall firewall delete rule name="BP Vote Monitor" >nul 2>&1
netsh advfirewall firewall add rule name="BP Vote Monitor" dir=in action=allow protocol=TCP localport=3100,80 >nul
echo  Firewall: ports 3100 and 80 opened.

schtasks /end /tn "BP Vote Monitor" >nul 2>&1
REM stop an old restart loop first, then the server itself
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-server.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*%~dp0server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
REM Startup task with no time limit (schtasks /create would stop it after 72 hours) and restart on failure
powershell -NoProfile -Command "$a = New-ScheduledTaskAction -Execute '%~dp0run-server.bat'; $t = New-ScheduledTaskTrigger -AtStartup; $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; Register-ScheduledTask -TaskName 'BP Vote Monitor' -Action $a -Trigger $t -Settings $s -User 'SYSTEM' -RunLevel Highest -Force | Out-Null"
if errorlevel 1 (
  echo  [!] Could not create the startup task with PowerShell, using schtasks instead.
  schtasks /create /tn "BP Vote Monitor" /tr "\"%~dp0run-server.bat\"" /sc onstart /ru SYSTEM /rl HIGHEST /f >nul
)
schtasks /run /tn "BP Vote Monitor" >nul
echo  Startup task created (no time limit, auto-restart) and server started.

REM Watchdog: every 5 minutes (also after a reboot) check that the server answers, restart it if not
powershell -NoProfile -Command "$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File ' + [char]34 + '%~dp0watchdog.ps1' + [char]34); $rep = (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition; $t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3); $t1.Repetition = $rep; $t2 = New-ScheduledTaskTrigger -AtStartup; $t2.Delay = 'PT3M'; $t2.Repetition = $rep; $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; Register-ScheduledTask -TaskName 'BP Vote Monitor Watchdog' -Action $a -Trigger @($t1, $t2) -Settings $s -User 'SYSTEM' -RunLevel Highest -Force | Out-Null"
if errorlevel 1 (echo  [!] Could not create the watchdog task.) else (echo  Watchdog task created: checks the server every 5 minutes.)

timeout /t 3 >nul
echo.
echo  ======================================================
echo   Done! Open the dashboard:  http://localhost:3100
echo   From other PCs:            http://50.117.3.240   (or http://50.117.3.240:3100)
echo   Passwords are in passwords.json (change with set-password.js)
echo   Log file: %~dp0server.log
echo   Watchdog log: %~dp0watchdog.log  (only written when it had to restart)
echo   You do NOT need to run this file again. Only after updating the files.
echo  ======================================================
echo.
start "" "http://localhost:3100"
pause
