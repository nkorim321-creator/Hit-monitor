# BP Vote Monitor watchdog.
# Windows runs this every 5 minutes (task "BP Vote Monitor Watchdog", made by install-windows.bat).
# If the server does not answer, it restarts it. Problems are written to watchdog.log.

$dir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$log    = Join-Path $dir 'watchdog.log'
$server = Join-Path $dir 'server.js'

function Log($msg) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

# 1) Does the server answer?
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/api/teams' -UseBasicParsing -TimeoutSec 20
  if ($r.StatusCode -eq 200) { exit 0 }     # all good, nothing to do
  Log "Server answered HTTP $($r.StatusCode). Restarting it."
} catch {
  Log "Server not answering ($($_.Exception.Message)). Restarting it."
}

# 2) Stop a stuck server. The restart loop in run-server.bat starts it again after 5 seconds.
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$server*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Log "Stopped node.exe (pid $($_.ProcessId))." }

Start-Sleep -Seconds 10

# 3) If the restart loop itself is not running, start the server task
$loop = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-server.bat*' }
if (-not $loop) {
  Start-ScheduledTask -TaskName 'BP Vote Monitor'
  Log 'Restart loop was not running: started task "BP Vote Monitor".'
}

# 4) Check again and write the result
Start-Sleep -Seconds 10
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/api/teams' -UseBasicParsing -TimeoutSec 20
  Log "Server is back (HTTP $($r.StatusCode))."
} catch {
  Log "Server still not answering after restart ($($_.Exception.Message)). See server.log."
}
