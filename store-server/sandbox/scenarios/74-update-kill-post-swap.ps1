# 74 - killed at every journal step AT OR AFTER the swap (Plan 07 Task 11): swap:done, activate, verify_live, reopen, before/after the unfence, finalize, after the gateway reopen.
# The order after the point of no return is commit, unfence, THEN reopen_gateway: the unfence labels are killed while the LAN is still fenced (fence-window checked).
# The swap is visible, so recovery rolls FORWARD (ResumeAfterSwap re-verifies, RollForwardReopen reopens): every label ends on the NEW level.
# Estimated 30 minutes (long timeout in scenarios.json).
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $labels = @(Get-KillLabels | Where-Object { $_ -match 'swap:done|activate|verify_live|reopen|unfence|finalize' })
  Check '74 the post-swap label list is not empty' $true ($labels.Count -ge 10)
  foreach ($l in 'before:finish_unfence', 'after:finish_unfence', 'after:reopen_gateway') { Check "74 the kill label $l is listed" $true ($labels -contains $l) }
  Invoke-KillMatrix $labels '74' { param($l) 'NEW' }
  return @{ Results = (Get-Results); Reboot = $false }
}
