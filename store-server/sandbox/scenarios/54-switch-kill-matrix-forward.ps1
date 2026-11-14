# 54 - the switch process is killed at the labels that are NOT a plain rollback (Plan 09 Task 13).
# STAGE 2 (integrated 09+10 build, base pack with the storage tables). Timeout 125 minutes (the plan's figure) is a GUESS: the first measured run sets it. 8 labels:
#   F (6)  journal:reopen:intent|done, journal:finalize:intent, before:finish_unfence, after:finish_unfence, after:reopen_gateway:
#          `update --recover` rolls FORWARD (exit 0), mode offline-only, cloud stays moved, admin signs in, second run / rollback refused.
#          Before recovery `switch rollback <op>` refuses (PAST_POINT_OF_NO_RETURN, or ALREADY_COMMITTED once the mode flipped).
#   M (2)  after_mark_moved and journal:verify_live:done: the cloud is ALREADY moved but the journal is before Reopen, so the LOCAL side rolls back:
#          recovery is LOUD (exit 17 CLOUD_MAY_BE_MOVED, progress unknown + op id, alert SWITCH_CLOUD_MAY_BE_MOVED, `switch run` refused with
#          CLOUD_STATE_UNKNOWN), `switch rollback <op>` (refused with OPEN_JOURNAL_CLOUD_MOVED while the journal is open) returns the cloud.
#          Leftover DBs: M keeps exactly one pos_failed_* (swap done, rollback keeps it), no pos_next/pos_prev_*; F keeps pos_prev_* (Assert-SwitchedStore).
# Plan text put only after_mark_moved here; journal:verify_live:done behaves the same (mark_moved runs INSIDE verify_live, before its journal Done).
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $all = Assert-LabelTable '54'
  $labels = @($all | Where-Object { (Get-SwitchLabelClass $_) -in @('M', 'F') })
  Check '54 the forward and moved-label count (2 + 6)' 8 $labels.Count
  Invoke-SwitchKillMatrix $labels '54'
  # credentials absent (D2-c): the matrix runs `update --recover` with no stdin at all, so every F row above that ends exit 0 with the mode
  # offline-only IS the "credentials absent" case (asserted per label in Assert-SwitchedStore); no separate row is invented for it.
  return @{ Results = (Get-Results); Reboot = $false }
}
