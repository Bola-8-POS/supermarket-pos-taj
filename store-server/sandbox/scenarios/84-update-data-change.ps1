# 84 - a DECLARED data change (variant new-data-change; Plan 07 Task 11 follow-up). The pack's migration deletes public.s7_marker and its signed manifest says so
# (dataChanges: public.s7_marker / delete), so the row-count guard lets it through: exit 0, exactly the declared rows are gone, every other table is unchanged.
# Estimated 10 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new-data-change'
  $pre = New-PreSnapshot
  $m = Get-Content (Join-Path $script:Prog "packs\$($script:NewV)\manifest.json") -Raw | ConvertFrom-Json
  Check '84 the signed manifest declares the delete' 'public.s7_marker/delete' ("$(@($m.dataChanges)[0].table)/$(@($m.dataChanges)[0].kind)")
  Check '84 setup: the marker has rows to lose' $true ([int](Psql 'postgres' 'SELECT count(*) FROM public.s7_marker') -gt 0)
  $poll = Join-Path $script:OutDir 'poll84.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '84' $poll
  $r = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u84'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-Exit '84 the declared delete is allowed' $r 'OK'
  Check '84 updated' $true $r.json.data.updated
  Check '84 exactly the declared rows are gone (s7_marker is empty)' '0' (Psql 'postgres' 'SELECT count(*) FROM public.s7_marker')
  $strip = { param($t) (@($t -split "`r?`n" | Where-Object { $_ -and $_ -notlike 's7_marker=*' })) -join ',' }
  Check '84 every other table has the same row count as before' (& $strip $pre.Rows) (& $strip (Get-RowCounts))
  Assert-ConsistentStore '84 after the declared change' $true @{ StartTypes = $pre.StartTypes; MarkerGone = $true }
  Assert-UpdateResult '84' 'updated' 'OK' $script:NewV
  Assert-RollbackFenceWindow '84 fence window' $poll
  Assert-NoSecrets '84'
  return @{ Results = (Get-Results); Reboot = $false }
}
