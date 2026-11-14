# 57 - execute-level proof of the time budget, and the operator sequence for a HUNG switch run (Plan 09 Task 13; T11-review items, spare id 57).
# STAGE 2 (integrated 09+10 build: the runs go through the data move). Timeout 125 minutes: the four flag waits are capped at 1500 s each (100 min
#   worst case, only if every run stalls; a normal run reaches each label in minutes), so 100 did not fit the worst case. The first measured run sets it.
# A  budget: a real run paused 90 s at journal:clone_db:done. A BEFORE TRUNCATE trigger (Install-SwitchStore -Probe) records the statement_timeout the
#    local machine statement ran with. It must equal the time left to the deadline (not the class cap 2 h, not the unbudgeted 30 min), bounded by
#    real clocks. Until A passes, the FREEZE BOUND in the runbook stays labelled UNVERIFIED.
# B  hung BEFORE the move (paused at journal:verify_clone:intent): status OPERATION_HUNG names the PID; recover and rollback answer LOCK_HELD; the
#    PID is stopped through its Process object (by id, never by image name); recover rolls back; the cloud is still frozen by the op until
#    `switch rollback` (and an expired freeze reads active by itself).
# C  hung AFTER the move (paused at after_mark_moved): alerts name the same PID; stop it; `update --recover` ends exit 17 naming `switch rollback <op>`; the
#    rollback returns the cloud.
# D  hung PAST Reopen (paused at journal:reopen:intent): stop it; recovery rolls FORWARD; the cloud stays moved.
# The dead-man line in B proves the SQL function (an expired freeze reads active), NOT the keepalive thread or a real 30-minute window.
# FIXTURE (said once): the lock info file's started_ms is moved back 23000 s (Set-LockAge) so the holder is older than RUN_CEILING_MS (about 22000 s);
#   waiting 6 hours for real is not possible in a Sandbox. Everything else is the product's own behaviour.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
function Start-HungRun([string]$Label, [string]$Tag) {
  $flag = Join-Path $script:OutDir "$Tag.flag"; Remove-Item $flag -Force -ErrorAction SilentlyContinue
  $h = Start-SwitchAsync @('--wait-minutes', '1') (Sw-Hooks @{ pause_at = @{ label = $Label; flag = $flag; ms = 3600000 } }) $Tag
  Check "$Tag the run reached $Label" $true (Wait-FlagFile $flag 1500)
  Remove-ConsoleAnswers
  return $h
}
function Assert-HungAlert([string]$Tag, $H, [int]$LockPid) {
  Check "$Tag the lock info names the run's process" $H.Pid $LockPid
  Check "$Tag the process is posctl.exe (confirmed before it is stopped)" 'posctl' ((Get-Process -Id $H.Pid -ErrorAction SilentlyContinue).ProcessName)
  $s = Get-StatusDoc
  $hung = @($s.alerts | Where-Object { $_.code -eq 'OPERATION_HUNG' })
  Check "$Tag status raises OPERATION_HUNG" 1 $hung.Count
  if ($hung.Count -eq 1 -and $hung[0].message) { Check "$Tag the alert names the process id" $true (([string]$hung[0].message) -match "process id $($H.Pid)\b") }
}
function Stop-HungRun($H) { if (-not $H.Process.HasExited) { $H.Process.Kill() }; [void]$H.Process.WaitForExit(60000); Check "$($H.Pid) the hung process is gone (stopped by its Process object)" $true $H.Process.HasExited }
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore -Probe
  $pre = Get-SwitchSnapshot
  [void](Start-FakeTill $script:TillA 'till-a' 'quiet')
  Check '57 setup: the fake till reported' $true (Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 60 1)

  # ---- A: execute-level budget -----------------------------------------------------------------------------------------------
  $flag = Join-Path $script:OutDir 'u57a.flag'; Remove-Item $flag -Force -ErrorAction SilentlyContinue
  $h = Start-SwitchAsync @('--wait-minutes', '1') (Sw-Hooks @{ pause_at = @{ label = 'journal:clone_db:done'; flag = $flag; ms = 90000 } }) 'u57a'
  Check '57 A the run reached journal:clone_db:done' $true (Wait-FlagFile $flag 1500)
  Remove-ConsoleAnswers
  $seenMs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  $deadline = [int64](Get-JournalDoc).deadline_ms
  $r = Wait-PosctlAsync $h 3600
  Assert-Exit '57 A the run succeeds' $r 'OK'
  $v = [int64](Psql 'postgres' 'SELECT v FROM zz_probe.t ORDER BY at LIMIT 1')
  Info '57 A statement_timeout of the truncate (ms) / deadline - seen (ms)' "$v / $($deadline - $seenMs)"
  Check '57 A the probe recorded a statement_timeout' $true ($v -gt 0)
  Check '57 A it is not the unbudgeted 30 minutes' $true ($v -ne 1800000)
  Check '57 A it is below the class cap of 2 hours (the time left decided it)' $true ($v -lt 7200000)
  Check '57 A it is at most the time left after the 90 s pause' $true ($v -le ($deadline - $seenMs - 90000 + 5000))
  Check '57 A it is at least that minus ten minutes (the statement started soon after the pause)' $true ($v -ge ($deadline - $seenMs - 90000 - 600000))

  # ---- B: hung before the move -----------------------------------------------------------------------------------------------
  Reset-Store; [void](Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 90 1)
  $h = Start-HungRun 'journal:verify_clone:intent' 'u57b'
  $op = [string](Get-JournalDoc).op_id
  $lp = Set-LockAge
  Assert-HungAlert '57 B' $h $lp
  Assert-Exit '57 B update --recover answers LOCK_HELD while the run hangs' (Invoke-Posctl @('update', '--recover') (Sw-Hooks) -Tag '57b-recover-held') 'LOCK_HELD'
  Assert-Exit '57 B switch rollback answers LOCK_HELD' (Invoke-Switch 'rollback' @($op) -Tag '57b-rb-held') 'LOCK_HELD'
  Stop-HungRun $h
  Assert-Exit '57 B update --recover rolls the local side back' (Invoke-Posctl @('update', '--recover') (Sw-Hooks) -Tag '57b-recover') 'OK'
  Assert-LocalIntact '57 B' $pre
  Check '57 B the cloud is still held by the stopped run' $true ((Get-CloudStateWord) -in @('draining', 'frozen') -and (Get-CloudOp) -eq $op)
  [void](Cq "UPDATE public.store_switch_state SET until_at = clock_timestamp() - interval '1 second' WHERE id")
  Check '57 B an expired freeze reads active by itself (dead-man)' 'active' (Get-CloudEffective)
  Assert-Exit '57 B switch rollback' (Invoke-Switch 'rollback' @() -Tag '57b-rb') 'OK'
  Check '57 B the cloud row reads active' 'active' (Get-CloudStateWord)

  # ---- C: hung after the cloud was marked moved ------------------------------------------------------------------------------
  Reset-Store; [void](Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 90 1)
  $h = Start-HungRun 'after_mark_moved' 'u57c'
  $op = [string](Get-JournalDoc).op_id
  Check '57 C the cloud is moved by the hung run' "moved|$op" ((Get-CloudStateWord) + '|' + (Get-CloudOp))
  $lp = Set-LockAge
  Assert-HungAlert '57 C' $h $lp
  Check '57 C status also raises SWITCH_CLOUD_MAY_BE_MOVED' $true ((Get-AlertCodes) -contains 'SWITCH_CLOUD_MAY_BE_MOVED')
  Stop-HungRun $h
  $rec = Invoke-Posctl @('update', '--recover') (Sw-Hooks) -Tag '57c-recover'
  Assert-Exit '57 C update --recover is loud' $rec 'RECOVERY_NEEDED'
  Check '57 C ... and prints the exact rollback command' $true (($rec.raw + $rec.err) -match [regex]::Escape("posctl switch rollback $op"))
  Assert-Exit '57 C switch rollback <op>' (Invoke-Switch 'rollback' @($op) -Tag '57c-rb') 'OK'
  Check '57 C the cloud row reads active' 'active' (Get-CloudStateWord)
  Assert-LocalIntact '57 C' $pre -KeepFailedDb   # rollback from verify_live (after the swap) keeps exactly one pos_failed_* by design

  # ---- D: hung past the point of no return ------------------------------------------------------------------------------------
  Reset-Store; [void](Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 90 1)
  $h = Start-HungRun 'journal:reopen:intent' 'u57d'
  $op = [string](Get-JournalDoc).op_id
  $lp = Set-LockAge
  Assert-HungAlert '57 D' $h $lp
  Stop-HungRun $h
  Assert-Exit '57 D update --recover rolls forward' (Invoke-Posctl @('update', '--recover') (Sw-Hooks) -Tag '57d-recover') 'OK'
  Assert-SwitchedStore '57 D' $op
  Stop-FakeTills
  Assert-NoSecrets '57'
  Assert-NoCloudSecrets '57' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
