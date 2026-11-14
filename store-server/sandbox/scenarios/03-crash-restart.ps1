# 03 - a crashed component is restarted by the SCM within seconds; a manual stop stays stopped.
# Each of Gateway, Functions, Rest and Auth has its child process (the one under its Shawl service) killed three times and must be
# healthy again within 90 s; the postmaster is killed and the database must come back by crash recovery with the data intact and the
# other four recovering alone; a manual `sc stop` of PostgREST (Shawl --pass 0,252) stays stopped, then it starts by hand.
function Stop-ChildOf([string]$ServiceName) {
  $svcPid = (Get-ServiceInfo $ServiceName).ProcessId
  if (-not $svcPid) { return $null }
  $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$svcPid" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $child) { return $null }
  Stop-Process -Id $child.ProcessId -Force
  return "$($child.Name):$($child.ProcessId)"
}
function Test-Healthy { (Invoke-Posctl @('health') -Name 'health-poll').Exit -eq 0 }

function Invoke-Scenario([int]$Phase) {
  [void](Install-Posctl)
  [void](Ensure-VcRuntime)
  $p = Provision-Fresh 'C:\out\r03.json' '03-provision'
  Add-Check '03 provision (setup) exits 0' '0' (Format-Envelope $p.Result) ($p.Result.Exit -eq 0)
  if ($p.Result.Exit -ne 0) { Save-DataEvidence 'setup-failed'; return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; a tick in the next minutes holds update.lock and a lifecycle command answers LOCK_HELD (run 20261025-000013-20)
  $w = Invoke-Psql 'create table public.sandbox_marker(v text); insert into public.sandbox_marker values (''kept''); select count(*) from public.sandbox_marker;'
  Check-Equal '03 marker row written' 1 $w.Out.Trim().Split("`n")[-1].Trim()
  Check-True '03 setup: the stack is healthy before the first kill' (Wait-Until { Test-Healthy } 120 2) ''

  foreach ($k in 'Gateway', 'Functions', 'Rest', 'Auth') {
    $name = $script:Svc[$k]
    for ($i = 1; $i -le 3; $i++) {
      $oldPid = (Get-ServiceInfo $name).ProcessId
      $killed = Stop-ChildOf $name
      Check-True "03 $k child process found and killed (cycle $i)" ($null -ne $killed) 'no child under the Shawl process'
      $t0 = Get-Date
      $back = Wait-Until { (Get-ServiceInfo $name).State -eq 'Running' -and (Test-Healthy) } 90 1
      Check-True "03 $k is healthy again within 90 s (cycle $i)" $back ("waited {0:n0} s after killing $killed" -f ((Get-Date) - $t0).TotalSeconds)
      $newChild = $null
      try { $sp = (Get-ServiceInfo $name).ProcessId; $newChild = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$sp" | Select-Object -First 1).ProcessId } catch { }
      Check-True "03 $k has a new child process (it really restarted, cycle $i)" ($newChild -and "$($killed.Split(':')[1])" -ne "$newChild") "killed=$killed new=$newChild"
    }
  }

  # the database: kill the postmaster; Shawl exits non-zero, the SCM restarts it, crash recovery runs
  $killedPg = Stop-ChildOf $script:Svc.Postgres
  Check-True '03 postmaster killed' ($null -ne $killedPg) 'no child under the Postgres Shawl process'
  $t0 = Get-Date
  $pg = Wait-Until { (Get-ServiceInfo $script:Svc.Postgres).State -eq 'Running' -and (Invoke-Psql 'select 1;').Out.Trim() -eq '1' } 120 1
  Check-True '03 Postgres is back and answers within 120 s' $pg ("waited {0:n0} s" -f ((Get-Date) - $t0).TotalSeconds)
  $all = Wait-Until { Test-Healthy } 120 2
  Check-True '03 the other four recovered by themselves after Postgres returned (health OK)' $all (Get-AllServiceStates)
  Check-True '03 all five services Running' (Test-AllRunning) (Get-AllServiceStates)
  Check-Equal '03 the data is intact after crash recovery' 'kept' (Invoke-Psql 'select v from public.sandbox_marker;').Out.Trim()
  $pgLogs = @(Get-ChildItem (Join-Path $script:DataRoot 'logs\SupermarketPOS-Postgres') -File -ErrorAction SilentlyContinue)
  $recovered = $false
  foreach ($f in $pgLogs) { if (Select-String -LiteralPath $f.FullName -Pattern 'database system was not properly shut down|automatic recovery in progress|redo starts at' -Quiet -ErrorAction SilentlyContinue) { $recovered = $true } }
  Add-Check '03 RECORDED: crash recovery appears in the Postgres log' 'recorded' "recovered=$recovered files=$($pgLogs.Count)" $true
  $g = Invoke-Grant "$($p.Result.Json.data.firstAdmin.id)@barpos.local" (Get-DerivedPassword ([string]$p.Result.Json.data.firstAdmin.id) $p.Digits (Get-Pepper))
  Check-Equal '03 the first admin still signs in after five components were killed' 200 $g.Status

  # PostgREST exits 252 on a stop request: --pass 0,252 makes a manual stop a clean stop, not a crash
  $restPid0 = (Get-ServiceInfo $script:Svc.Rest).ProcessId
  # Rest has dependents (Functions, Gateway), so `sc stop` alone answers 1051; Stop-Service -Force is the services.msc "stop with dependents"
  $scOut = try { Stop-Service -Name $script:Svc.Rest -Force -ErrorAction Stop; 'Stop-Service -Force ok' } catch { "Stop-Service failed: $($_.Exception.Message)" }
  $timeline = New-Object System.Collections.ArrayList
  $seenStopped = $false
  for ($t = 0; $t -lt 60; $t++) {
    $i = Get-ServiceInfo $script:Svc.Rest
    [void]$timeline.Add(("{0,2}s state={1} pid={2}" -f $t, $i.State, $i.ProcessId))
    if ($i.State -eq 'Stopped') { $seenStopped = $true }
    Start-Sleep -Milliseconds 500
  }
  $exitInfo = Get-CimInstance Win32_Service -Filter "Name='$($script:Svc.Rest)'"
  Save-Evidence '03-manual-stop-timeline' ("sc stop output:`n$scOut`nold pid $restPid0`nExitCode=$($exitInfo.ExitCode) ServiceSpecificExitCode=$($exitInfo.ServiceSpecificExitCode)`n" + ($timeline -join "`n") + "`n" + ((& sc.exe qfailure $script:Svc.Rest) -join "`n") + "`n" + ((& sc.exe qfailureflag $script:Svc.Rest) -join "`n"))
  Check-True '03 a manual stop of Rest (with its dependents) reaches Stopped' $seenStopped ($timeline | Select-Object -First 6) -join ' | '
  Check-Equal '03 a manual stop of Rest stays stopped 30 s later (the SCM does not restart a clean stop)' 'Stopped' (Get-ServiceInfo $script:Svc.Rest).State
  Check-True '03 the dependents of Rest are Stopped too (the stop was clean, nothing was crash-restarted)' ((@('Functions', 'Gateway') | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0) (Get-AllServiceStates)
  $st = Invoke-Posctl @('start') -Name '03-start-after-manual-stop'
  Add-Check '03 posctl start brings the stack back after the manual stop (exit 0, all Running, healthy)' '0 / all Running' ((Format-Envelope $st) + ' ' + (Get-AllServiceStates)) ($st.Exit -eq 0 -and (Test-AllRunning) -and (Wait-Until { Test-Healthy } 60 1))
  Save-DataEvidence 'end'
  return @{ Results = (Get-Results); Reboot = $false }
}
