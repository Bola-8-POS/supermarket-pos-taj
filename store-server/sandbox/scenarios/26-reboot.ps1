# 26 - reboot, three phases around two real Windows restarts (gated on scenario 29: the sandbox must survive Restart-Computer).
#  Phase 1: provision, write a marker row, reboot.
#  Phase 2: the five services came back by themselves (auto-start), data intact, health and canary OK, tasks survived, sign-in works.
#           Then the BOOT GATE (Task 10 CARRY): a hook variable is removed from gotrue.env and `health --write` gates the sign-in stack
#           (Gateway, Functions, Auth Stopped, start type Manual, still Stopped 30 s later). Reboot again.
#  Phase 3: after the second restart Postgres and Rest are Running by themselves and Gateway, Functions and Auth are STILL Stopped (demand
#           start, nothing started them); posctl start refuses while the file is bad, and with the file restored it starts them and restores Auto.
function Invoke-Retry10([string[]]$A, [string]$Name) {
  for ($i = 1; $i -le 8; $i++) { $r = Invoke-Posctl $A -Name $Name; if ($r.Exit -ne 10) { return $r }; Start-Sleep -Seconds 4 }
  return $r
}
function Invoke-Scenario([int]$Phase) {
  $state = 'C:\out\s26-state.json'
  $sign = 'Gateway', 'Functions', 'Auth'
  if ($Phase -eq 1) {
    [void](Install-Posctl)
    [void](Ensure-VcRuntime)
    $p = Provision-Fresh 'C:\out\r26.json' '26-provision'
    Add-Check '26 provision (before the reboot) exits 0' '0' (Format-Envelope $p.Result) ($p.Result.Exit -eq 0)
    if ($p.Result.Exit -ne 0) { Save-DataEvidence 'setup-failed'; return @{ Results = (Get-Results); Reboot = $false } }
    Check-StoreUp '26 before the reboot:'
    $w = Invoke-Psql "create table public.sandbox_marker(v text); insert into public.sandbox_marker values ('before-reboot'); select count(*) from public.sandbox_marker;"
    Check-Equal '26 marker row written' 1 $w.Out.Trim().Split("`n")[-1].Trim()
    $hookLines = @((Get-Content (Join-Path $script:DataRoot 'secrets\gotrue.env')) | Where-Object { $_ -match '^GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_(ENABLED|URI)=' })
    @{ digits = $p.Digits; adminId = [string]$p.Result.Json.data.firstAdmin.id; packVersion = $p.PackVersion; authPid = (Get-ServiceInfo $script:Svc.Auth).ProcessId; boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o'); hookLines = $hookLines } | ConvertTo-Json | Set-Content $state
    Save-DataEvidence 'before-reboot'
    return @{ Results = (Get-Results); Reboot = $true }
  }
  $s = Get-Content $state -Raw | ConvertFrom-Json
  $script:PackVersion = [string]$s.packVersion
  $envPath = Join-Path $script:DataRoot 'secrets\gotrue.env'

  if ($Phase -eq 2) {
    Add-Check '26 phase 2 ran after the reboot (logon command re-entered the agent)' 'true' 'true' $true
    Check-True '26 the machine really restarted' ((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o') -ne $s.boot) $s.boot
    $up = Wait-Until { Test-AllRunning } 300
    Add-Check '26 all five services Running after the reboot without any posctl command' 'all Running' (Get-AllServiceStates) $up
    Check-True '26 the Auth service is a new process (it really restarted)' ((Get-ServiceInfo $script:Svc.Auth).ProcessId -ne $s.authPid) "pid was $($s.authPid)"
    foreach ($k in $script:Svc.Keys) { Check-Equal "26 $($script:Svc[$k]) start mode" 'Auto' (Get-ServiceInfo $script:Svc[$k]).StartMode }
    Check-StoreUp '26 after the reboot:'
    Check-True '26 health is OK within 300 s of the logon (start type auto, no delay)' (Wait-Until { (Invoke-Posctl @('health') -Name '26-health-poll').Exit -eq 0 } 300 3) (Get-AllServiceStates)
    Check-Equal '26 the marker row survived the restart' 'before-reboot' (Invoke-Psql 'select v from public.sandbox_marker;').Out.Trim()
    $good = Invoke-Grant "$($s.adminId)@barpos.local" (Get-DerivedPassword $s.adminId $s.digits (Get-Pepper))
    Check-True '26 the first admin signs in after the reboot (derived password, HTTP 200)' ($good.Status -eq 200) "status=$($good.Status)"
    $canary = $null; try { $canary = Get-Content (Join-Path $script:DataRoot 'state\canary.json') -Raw | ConvertFrom-Json } catch { }
    Check-True '26 state\canary.json still lastOk=true' ($canary -and $canary.lastOk -eq $true)
    $c = Invoke-Retry10 @('health', '--canary', '--write') '26-health-canary'
    Add-Check '26 the canary passes after the restart (health --canary --write exits 0)' '0' (Format-Envelope $c) ($c.Exit -eq 0)
    Check-True '26 the scheduled tasks survived' (@((Invoke-Posctl @('tasks', 'status') -Name '26-tasks-status').Json.data.tasks | Where-Object { $_.installed -and ($_.name -eq 'Health' -or $_.name -eq 'Canary') }).Count -eq 2)
    $pgLog = @(Get-ChildItem (Join-Path $script:DataRoot 'logs\SupermarketPOS-Postgres') -File -ErrorAction SilentlyContinue)
    $crash = $false; foreach ($f in $pgLog) { if (Select-String -LiteralPath $f.FullName -Pattern 'database system was not properly shut down' -SimpleMatch -Quiet -ErrorAction SilentlyContinue) { $crash = $true } }
    Add-Check '26 RECORDED: Postgres shutdown before the restart (Shawl gives it about 5 s at OS shutdown)' 'recorded' $(if ($crash) { 'crash recovery ran' } else { 'clean shutdown' }) $true
    $r = Invoke-Retry10 @('restart') '26-restart-after-reboot'
    Add-Check '26 posctl restart after the reboot exits 0' '0 / all Running' ((Format-Envelope $r) + ' ' + (Get-AllServiceStates)) ($r.Exit -eq 0 -and (Test-AllRunning))

    # ---- the boot gate: remove a hook variable, let health --write gate the stack, then reboot with it still bad -------------------------
    $orig = [IO.File]::ReadAllText($envPath)
    $bad = ($orig -split "`r?`n" | Where-Object { $_ -notmatch '^GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=' }) -join "`n"
    [IO.File]::WriteAllText($envPath, $bad)
    $gate = Invoke-Retry10 @('health', '--write') '26-health-write-gate'
    Add-Check '26 health --write with the hook variable removed exits 22 (CANARY_FAILED)' '22' (Format-Envelope $gate) ($gate.Exit -eq 22)
    Check-True '26 Gateway, Functions and Auth are Stopped' (Wait-Until { @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0 } 60 1) (Get-AllServiceStates)
    Check-True '26 their start type is Manual (demand)' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Manual' }).Count -eq 0) (($sign | ForEach-Object { "$_=$((Get-ServiceInfo $script:Svc[$_]).StartMode)" }) -join ' ')
    Start-Sleep -Seconds 30
    Check-True '26 still Stopped 30 s later' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0) (Get-AllServiceStates)
    $s | Add-Member -NotePropertyName boot2 -NotePropertyValue (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o') -Force
    $s | ConvertTo-Json | Set-Content $state
    Save-DataEvidence 'phase2-gated'
    return @{ Results = (Get-Results); Reboot = $true }
  }

  # ---- phase 3: after the second restart ------------------------------------------------------------------------------------------------
  Add-Check '26 phase 3 ran after the second reboot' 'true' 'true' $true
  Check-True '26 the machine restarted again' ((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o') -ne $s.boot2) $s.boot2
  Check-True '26 Postgres and Rest came back by themselves (Auto)' (Wait-Until { (Get-ServiceInfo $script:Svc.Postgres).State -eq 'Running' -and (Get-ServiceInfo $script:Svc.Rest).State -eq 'Running' } 300 2) (Get-AllServiceStates)
  Start-Sleep -Seconds 60   # long enough for the SCM to have started any auto service, and for the Health task to have run once
  Check-True '26 Gateway, Functions and Auth are STILL Stopped after the reboot (demand start; the gate held across the restart)' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0) (Get-AllServiceStates)
  $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 7036; StartTime = $bootTime } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'SupermarketPOS-(Auth|Functions|Gateway) service entered the running state' })
  Check-True '26 the System log shows no start of Auth, Functions or Gateway since the boot (the SCM did not start them, and neither did the Health task)' ($ev.Count -eq 0) (($ev | ForEach-Object { $_.Message }) -join ' | ')
  Check-True '26 ... and still Manual' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Manual' }).Count -eq 0) (($sign | ForEach-Object { "$_=$((Get-ServiceInfo $script:Svc[$_]).StartMode)" }) -join ' ')
  $s1 = Invoke-Retry10 @('start') '26-start-refused'
  Add-Check '26 posctl start with the hook variable still missing is refused (UNHEALTHY, exit 20)' '20' (Format-Envelope $s1) ($s1.Exit -eq 20)
  # restore the removed line (it is not a secret) and start
  $cur = [IO.File]::ReadAllText($envPath)
  $enabled = @($s.hookLines | Where-Object { $_ -match 'ENABLED=' })
  [IO.File]::WriteAllText($envPath, ($cur.TrimEnd() + "`n" + ($enabled -join "`n") + "`n"))
  Check-True '26 harness: the hook variables are back, once each' (Test-HookEnv ([IO.File]::ReadAllText($envPath)))
  $s2 = Invoke-Retry10 @('start') '26-start-restored'
  Add-Check '26 with the file restored, posctl start exits 0, everything Running' '0 / all Running' ((Format-Envelope $s2) + ' ' + (Get-AllServiceStates)) ($s2.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120 1))
  Check-True '26 posctl start restored start type Auto on Gateway, Functions and Auth' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Auto' }).Count -eq 0) (($sign | ForEach-Object { "$_=$((Get-ServiceInfo $script:Svc[$_]).StartMode)" }) -join ' ')
  $good = Invoke-Grant "$($s.adminId)@barpos.local" (Get-DerivedPassword $s.adminId $s.digits (Get-Pepper))
  Check-True '26 the first admin signs in again' ($good.Status -eq 200) "status=$($good.Status)"
  Save-DataEvidence 'after-reboot'
  return @{ Results = (Get-Results); Reboot = $false }
}
