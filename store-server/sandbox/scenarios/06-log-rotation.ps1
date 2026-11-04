# 06 (Q9) - the Shawl log rotation flags posctl uses really rotate and cap the log files.
# The probe is a real Windows service run by shawl.exe from the staged pack with the same flag shape the product uses, only with a
# small threshold so the run is fast. No provision is needed.
function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  $meta = Get-PayloadMeta
  $shawl = Join-Path $script:Payload ("pack\$($meta.packVersion)\bin\shawl.exe")
  Check-True '06 shawl.exe is in the staged pack' (Test-Path $shawl) $shawl
  $local = 'C:\shawl\shawl.exe'; New-Item -ItemType Directory -Force C:\shawl | Out-Null; Copy-Item $shawl $local -Force   # a service binary on the mapped share is slower and unusual
  $logDir = 'C:\sandbox-logs'; New-Item -ItemType Directory -Force $logDir | Out-Null
  $name = 'PosctlLogRotationProbe'
  $rotate = 1048576; $retain = 2
  # 60000 lines of ~70 bytes = ~4 MB of output: with a 1 MiB threshold that is at least 3 rotations, so the retain cap must bite
  $cmd = 'for /L %i in (1,1,60000) do @echo line %i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  $bin = "`"$local`" run --name $name --no-restart --log-dir $logDir --log-rotate bytes=$rotate --log-retain $retain -- cmd.exe /d /c `"$cmd`""
  & sc.exe create $name binPath= $bin start= demand | Out-Null
  Check-True '06 probe service registered' ($null -ne (Get-ServiceInfo $name)) ''
  & sc.exe start $name | Out-Null
  $done = Wait-Until { $s = Get-ServiceInfo $name; $s -and $s.State -eq 'Stopped' } 240 1
  Check-True '06 the probe service ran to completion (Stopped)' $done ((Get-ServiceInfo $name).State)
  $files = @(Get-ChildItem $logDir -File)
  Save-Evidence '06-log-files' (($files | ForEach-Object { "$($_.Name)=$($_.Length)" }) -join "`n")
  Check-True '06 output was rotated into more than one file' ($files.Count -gt 1) (($files | ForEach-Object { "$($_.Name)=$($_.Length)" }) -join ', ')
  $largest = ($files | Measure-Object Length -Maximum).Maximum
  Check-True '06 no single log file grows far past the rotate threshold (threshold + 64 KiB)' ($largest -le ($rotate + 65536)) "largest=$largest"
  $total = ($files | Measure-Object Length -Sum).Sum
  # retain 2 keeps at most the live file + 2 rotated ones per output stream
  Check-True "06 old files are capped: retain $retain keeps the folder under (retain+1) x threshold + slack" ($total -le (($retain + 1) * ($rotate + 65536))) "$total bytes in $($files.Count) files"
  $sum = Get-Content (Join-Path $logDir ($files | Sort-Object LastWriteTime | Select-Object -Last 1).Name) -Tail 1 -ErrorAction SilentlyContinue
  Add-Check '06 RECORDED: tail of the newest file (the run reached the last line)' 'recorded' "$sum" $true
  & sc.exe delete $name | Out-Null

  # the product's production values (10 MiB x 5) are asserted on the real service command lines in scenario 20
  return @{ Results = (Get-Results); Reboot = $false }
}
