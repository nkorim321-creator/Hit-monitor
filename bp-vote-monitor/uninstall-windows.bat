@echo off
REM Stops the BP Vote Monitor server and removes the startup task + firewall rule.
REM Right-click -> "Run as administrator"
schtasks /end /tn "BP Vote Monitor" >nul 2>&1
schtasks /delete /tn "BP Vote Monitor" /f
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-server.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
netsh advfirewall firewall delete rule name="BP Vote Monitor"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*%~dp0server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
echo Removed.
pause
