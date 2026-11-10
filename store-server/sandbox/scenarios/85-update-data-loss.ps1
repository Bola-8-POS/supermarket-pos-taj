# 85 - an UNDECLARED shrink (variant new-data-loss; Plan 07 Task 11 follow-up). The migration deletes public.s7_marker but the manifest says nothing:
# the clone's row counts are below the live ones, so verification refuses (exit 14 ROWS_LOST) before the swap. The clone is dropped, the live database is
# untouched and the tills are let back in. Estimated 10 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new-data-loss'
  $pre = New-PreSnapshot
  $m = Get-Content (Join-Path $script:Prog "packs\$($script:NewV)\manifest.json") -Raw | ConvertFrom-Json
  Check '85 the manifest declares no data change' 0 @($m.dataChanges).Count
  $poll = Join-Path $script:OutDir 'poll85.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '85' $poll   # FR14 (C)
  $r = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u85'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-Exit '85 an undeclared shrink' $r 'MIGRATION_FAILED' 'ROWS_LOST'
  $dbs = Get-DbNames
  Check '85 the clone was dropped' $false ($dbs -contains 'pos_next')
  Check '85 nothing was swapped (no pos_prev_*, no pos_failed_*)' 0 @($dbs | Where-Object { $_ -like 'pos_prev_*' -or $_ -like 'pos_failed_*' }).Count
  Check '85 live is unchanged: every row count is as before' $pre.Rows (Get-RowCounts)
  Check '85 live is unchanged: the marker row survived' 'before-update' (Psql 'postgres' 'SELECT v FROM public.s7_marker LIMIT 1')
  Assert-ConsistentStore '85 after ROWS_LOST' $false @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows; AuthLevel = $pre.AuthLevel }
  Check '85 still the OLD level' $script:OldV ([string](Get-Cfg).pack.current)
  Assert-UpdateResult '85' 'rolled_back' 'MIGRATION_FAILED' $script:NewV
  Check '85 update-result keeps the reason' 'ROWS_LOST' ([string](Get-UpdateResult).lastReason)
  [void](Assert-StatusState '85' 'running')
  $rows = @(Read-LanPoll $poll | Where-Object { $_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*' })
  Check '85 the tills saw STORE_UPDATING while it ran' $true (@($rows | Where-Object { $_.s -eq 503 -and $_.b -match 'STORE_UPDATING' }).Count -gt 0)
  Check '85 the tills are back (the last data answer is not 503)' $true ($rows.Count -gt 0 -and $rows[$rows.Count - 1].s -ne 503)
  Assert-RollbackFenceWindow '85 fence window' $poll
  Assert-NoSecrets '85'
  return @{ Results = (Get-Results); Reboot = $false }
}
