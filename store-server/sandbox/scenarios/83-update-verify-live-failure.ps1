# 83 - verification of the NEW live database fails after the swap (Plan 07 Task 11; split out of the brief's 72, which cannot share a Sandbox with new-grant-drop).
# fail_at verify_live: exit 15, the swap is undone, the failed database is kept for support, the OLD level serves again; a second, clean attempt then succeeds.
# Estimated 12 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $pre = New-PreSnapshot
  $poll = Join-Path $script:OutDir 'poll83.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '83' $poll
  $r = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok'; fail_at = 'verify_live' }) -Tag 'u83a'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-Exit '83 a failed verification' $r 'VERIFY_FAILED_ROLLED_BACK'
  $dbs = Get-DbNames
  Check '83 the failed database is kept' 1 @($dbs | Where-Object { $_ -like 'pos_failed_*' }).Count
  Check '83 the previous database was swapped back (no pos_prev left)' 0 @($dbs | Where-Object { $_ -like 'pos_prev_*' }).Count
  Assert-ConsistentStore '83 after verify failure' $true @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows; AuthLevel = $pre.AuthLevel }
  Check '83 still the OLD level' $script:OldV ([string](Get-Cfg).pack.current)
  Assert-UpdateResult '83' 'rolled_back' 'VERIFY_FAILED_ROLLED_BACK' $script:NewV
  [void](Assert-StatusState '83' 'running')
  Assert-RollbackFenceWindow '83 fence window' $poll
  # the retry: a rolled-back update leaves nothing behind that stops the next one
  $ok = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u83b'
  Assert-Exit '83 the retry' $ok 'OK'
  Assert-ConsistentStore '83 after the retry' 'family' @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows }
  $dbs2 = Get-DbNames
  Check '83 retention: the successful retry leaves exactly one pos_prev_* (the policy is one per family, not one in total)' 1 @($dbs2 | Where-Object { $_ -like 'pos_prev_*' }).Count
  Check '83 the retry is on the NEW level' $script:NewV ([string](Get-Cfg).pack.current)
  Assert-UpdateResult '83 retry' 'updated' 'OK' $script:NewV
  Assert-NoSecrets '83'
  return @{ Results = (Get-Results); Reboot = $false }
}
