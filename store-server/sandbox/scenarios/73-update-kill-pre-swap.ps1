# 73 - the update process is killed at every journal step BEFORE the swap (Plan 07 Task 11). `dev hook-labels` lists the kill points of the test-hooks build;
# the pre-swap set is every label that is not swap:done / activate / verify_live / reopen / unfence / finalize. Each ends, after `update --recover`, on the OLD level
# (journal:swap:intent is decided by pg_database and is accepted either way). Needs the long timeout (set in scenarios.json). Estimated 40 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $labels = @(Get-KillLabels | Where-Object { $_ -notmatch 'swap:done|activate|verify_live|reopen|unfence|finalize' })
  Check '73 the pre-swap label list is not empty' $true ($labels.Count -ge 10)
  Invoke-KillMatrix $labels '73' { param($l) if ($l -eq 'journal:swap:intent') { 'EITHER' } else { 'OLD' } } -RequireFence   # per label: fence observed, not only never served
  return @{ Results = (Get-Results); Reboot = $false }
}
