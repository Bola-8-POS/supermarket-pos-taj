# 77 - a database whose recorded collation version is wrong (Plan 07 Task 11): the source is repaired before the clone (REINDEX + REFRESH), the update succeeds and says so.
# Estimated 10 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $pre = New-PreSnapshot
  $q = "SELECT datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid) FROM pg_database WHERE datname = 'postgres'"
  [void](Psql 'template1' "UPDATE pg_database SET datcollversion = 'bogus' WHERE datname = 'postgres'")
  Check '77 setup: a collation mismatch exists' 't' (Psql 'template1' $q)
  $poll = Join-Path $script:OutDir 'poll77.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '77' $poll
  $r = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u77'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-Exit '77 the update succeeds' $r 'OK'
  Check '77 the repair was reported' $true (@($r.json.data.warnings) -contains 'COLLATION_REPAIRED_ON_SOURCE')
  Check '77 no mismatch remains on the live database' 'f' (Psql 'template1' $q)
  Assert-ConsistentStore '77 after collation repair' $true @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows }
  Assert-UpdateResult '77' 'updated' 'OK' $script:NewV
  Assert-RollbackFenceWindow '77 fence window' $poll
  Assert-NoSecrets '77'
  return @{ Results = (Get-Results); Reboot = $false }
}
