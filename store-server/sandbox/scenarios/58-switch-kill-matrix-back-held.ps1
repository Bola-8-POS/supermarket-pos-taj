# 58 - the switch process is killed at the labels BEFORE the point of no return while the cloud is HELD (classes B1 and BW, 9 labels) (Plan 09 Task 13).
# STAGE 2 (integrated 09+10 build, base pack with the storage tables). Split out of 53 (ids 58 and 59 are the spare ids of conventions 17 F; 59 stays free).
# Timeout 100 minutes is a GUESS: the first measured run sets it.
#   B1 (3)  journal:work:done, journal:verify_clone:intent|done: recovery is quiet (exit 0), the cloud stays held by this operation, status raises
#           SWITCH_CLOUD_NOT_RELEASED, `switch rollback` frees it.
#   BW (6)  journal:swap:intent|done, journal:activate:intent|done, journal:verify_live:intent, before_mark_moved: the move window. Recovery is LOUD
#           (exit 17 CLOUD_MAY_BE_MOVED, progress unknown + op id), the cloud is only frozen, `switch rollback <op>` returns it.
#   Leftover DB after recovery: exactly one pos_failed_* when the swap had run (every BW label except journal:swap:intent), none for journal:swap:intent.
# The dead-man check at the end proves the SQL function (an expired freeze reads active), NOT the keepalive thread or the 30-minute window of a real run.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $all = Assert-LabelTable '58'
  $labels = @($all | Where-Object { (Get-SwitchLabelClass $_) -in @('B1', 'BW') })
  Check '58 the B1 + BW label count (3 + 6)' 9 $labels.Count
  Invoke-SwitchKillMatrix $labels '58'
  Reset-Store
  Set-CloudHold 'frozen' ([Guid]::NewGuid().ToString()) 30
  Check '58 dead-man: a live freeze reads frozen' 'frozen' (Get-CloudEffective)
  [void](Cq "UPDATE public.store_switch_state SET until_at = clock_timestamp() - interval '1 second' WHERE id")
  Check '58 dead-man: an expired freeze reads active with nobody releasing it' 'active' (Get-CloudEffective)
  return @{ Results = (Get-Results); Reboot = $false }
}
