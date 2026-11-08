# 71 - a migration that fails on the clone (variant new-fail-migration; Plan 07 Task 11). Nothing live was touched: exit 14, the clone is dropped,
# no pos_failed_* is kept for a clone failure, the store is back on the OLD level and unfenced, the tills saw 503 only while it ran.
# One variant of 1.0.1-r1 per Sandbox: `pack install` refuses a second variant of the same version ("already installed with different content").
# Estimated 10 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new-fail-migration'
  $pre = New-PreSnapshot
  $poll = Join-Path $script:OutDir 'poll71.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '71' $poll   # FR14 (C): a dead poller must fail here, not pass silently
  $r = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u71'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-Exit '71 a failing migration' $r 'MIGRATION_FAILED'
  Check '71 data.updated is false' $false $r.json.data.updated
  $dbs = Get-DbNames
  Check '71 the clone was dropped' $false ($dbs -contains 'pos_next')
  Check '71 no failed database is kept for a clone failure' 0 @($dbs | Where-Object { $_ -like 'pos_failed_*' }).Count
  Check '71 no previous database was created' 0 @($dbs | Where-Object { $_ -like 'pos_prev_*' }).Count
  Assert-ConsistentStore '71 after the failure' $false @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows; AuthLevel = $pre.AuthLevel }
  Check '71 still the OLD level' $script:OldV ([string](Get-Cfg).pack.current)
  Check '71 live GoTrue level untouched' $pre.AuthLevel (Get-AuthLevel)
  Assert-UpdateResult '71' 'rolled_back' 'MIGRATION_FAILED' $script:NewV
  # FR19 item 4: the rolled-back version is remembered; the scheduled check skips it (no fence, no journal, no attempt) and status says so.
  Check '71 the rolled-back record exists' $true (Test-Path (Get-UpdateReadPath 'update-rolled-back.json'))
  $st71 = Assert-StatusState '71' 'running'
  Check '71 status update.lastCode is 14 (MIGRATION_FAILED)' 14 ([int]$st71.update.lastCode)
  Check '71 status update.lastReason is the result file reason' ([string](Get-UpdateResult).lastReason) ([string]$st71.update.lastReason)
  Check '71 status update.rolledBackVersion' $script:NewV ([string]$st71.update.rolledBackVersion)
  $al71 = @($st71.alerts | Where-Object { $_.code -eq 'UPDATE_ROLLED_BACK' })
  Check '71 status carries the UPDATE_ROLLED_BACK warn alert' 'warn' ([string]($al71 | Select-Object -First 1).level)
  $ops71 = Join-Path $script:Data 'logs\posctl\ops'
  $journals71 = @(Get-ChildItem -Path $ops71 -Filter '*.journal.json' -File -ErrorAction SilentlyContinue).Count
  Copy-Item -LiteralPath (Join-Path $script:PackSrc 'new-fail-migration.pospack') -Destination (Join-Path $script:Prog 'backend.pospack') -Force   # what `--if-available` resolves offline
  $nowClock = Get-Date
  Set-MaintenanceWindow $nowClock.AddHours(-1).ToString('HH:00') $nowClock.AddHours(2).ToString('HH:00')
  $poll71s = Join-Path $script:OutDir 'poll71s.jsonl'; Remove-Item $poll71s -Force -ErrorAction SilentlyContinue
  $job71s = Start-FencePoller $poll71s
  Assert-PollerConnects '71 scheduled' $poll71s
  $sk = Invoke-Posctl @('update', '--if-available', '--window-aware', '--quiet', '--scheduled') (Hooks @{ backup = 'ok' }) -Tag 'u71-scheduled'
  Start-Sleep -Seconds 3; Stop-LanPoller $job71s
  Assert-Exit '71 the scheduled run skips the rolled-back version' $sk 'OK' 'SKIPPED_ROLLED_BACK'
  Check '71 scheduled skip: nothing was updated' $false $sk.json.data.updated
  Check '71 scheduled skip: still the OLD level' $script:OldV ([string](Get-Cfg).pack.current)
  Check '71 scheduled skip: no new journal archived (no fence, no attempt)' $journals71 @(Get-ChildItem -Path $ops71 -Filter '*.journal.json' -File -ErrorAction SilentlyContinue).Count
  Check '71 scheduled skip: no journal is open' $false (Test-Path (Get-UpdateReadPath 'journal.json'))
  Check '71 scheduled skip: the tills never saw STORE_UPDATING' 0 @(Read-LanPoll $poll71s | Where-Object { $_.s -eq 503 -and $_.b -match 'STORE_UPDATING' }).Count
  Assert-UpdateResult '71 after the skip' 'rolled_back' 'MIGRATION_FAILED' $script:NewV   # the skip does not overwrite the real result
  $st71b = Get-StatusDoc
  Check '71 after the skip the alert is still raised' 1 @($st71b.alerts | Where-Object { $_.code -eq 'UPDATE_ROLLED_BACK' }).Count
  $rows = @(Read-LanPoll $poll | Where-Object { $_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*' })
  Check '71 the tills saw STORE_UPDATING while it ran' $true (@($rows | Where-Object { $_.s -eq 503 -and $_.b -match 'STORE_UPDATING' }).Count -gt 0)
  Check '71 the tills were let back in after the rollback (last data answer is not 503)' $true ($rows.Count -gt 0 -and $rows[$rows.Count - 1].s -ne 503)
  Assert-RollbackFenceWindow '71 fence window' $poll
  Assert-NoSecrets '71'
  return @{ Results = (Get-Results); Reboot = $false }
}
