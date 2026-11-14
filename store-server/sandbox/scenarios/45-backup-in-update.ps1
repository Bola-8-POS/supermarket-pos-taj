# 45 - an update takes a real pre-update backup, and no backup means no update (Plan 08 Task 13; Plan 07's runner with the REAL backup service, no test hook).
# Part 1  the readiness gate: with the local repository made unusable (a file where the folder must be) and no snapshot on record, a SCHEDULED update gets exactly ONE
#         fenced attempt per maintenance window (it fences, the backup fails, it rolls back: 16 PRE_UPDATE_BACKUP_FAILED); the second scheduled run in the same window is
#         refused before any fence (12 BACKUP_NOT_READY, no fence on the LAN, no new journal); a person at the console still gets their own fenced attempt. The store is
#         untouched and consistent after each.
# Part 2  the repository works again: the update succeeds (exit 0); exactly one pre-update snapshot exists, protected from retention, tagged with the OLD schema level.
# Part 3  restoring that older snapshot onto the new pack migrates it forward (migrate_restored: GoTrue auth.exe migrate + db push on the clone): the store ends on the new
#         pack with the old data, the admin signs in, the canary ran.
# Part 4  a restore against a held update.lock gives LOCK_HELD (10) after the lock wait.
# Estimated 45 minutes.
. C:\scenarios\lib-backup.ps1
function Get-ArchivedJournalCount { return @(Get-ChildItem (Join-Path $script:Data 'logs\posctl\ops') -Filter '*.journal.json' -File -ErrorAction SilentlyContinue).Count }
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore -Variant 'new-auth' -OldPack 'old-auth' -LowerAuth
  Seed-Probe
  $oldMax = [string](Get-Content (Join-Path $script:Prog "packs\$($script:OldV)\manifest.json") -Raw | ConvertFrom-Json).migrations.max
  $newM = (Get-Content (Join-Path $script:Prog "packs\$($script:NewV)\manifest.json") -Raw | ConvertFrom-Json).migrations
  Check '45 setup: no backup exists yet' 0 @(Get-Snapshots).Count
  $pre = New-PreSnapshot
  $live0 = $pre.AuthLevel
  $n = 0; if ($live0 -match '^(\d+)\|') { $n = [int]$Matches[1] }
  $consistentPre = @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows; AuthLevel = $live0; AuthLevelNew = "$($n + 1)|$($script:AuthNewMax)" }

  # ---- Part 1: the gate ----------------------------------------------------------------------------------------------------------------------------------------------
  $blocker = Join-Path $script:Data 'backups\repo'
  New-Item -ItemType File -Path $blocker -Force | Out-Null
  Check '45 setup: the local repository is made unusable (a file where the folder must be)' $true (Test-Path -LiteralPath $blocker -PathType Leaf)
  $j0 = Get-ArchivedJournalCount

  $p1 = Join-Path $script:OutDir 'poll45-1.jsonl'; Remove-Item $p1 -Force -ErrorAction SilentlyContinue
  $job1 = Start-FencePoller $p1; Assert-PollerConnects '45 run 1' $p1
  $r1 = Bk @('update', '--pack', $script:NewV, '--scheduled') 'update-1-scheduled'
  Start-Sleep -Seconds 2; Stop-LanPoller $job1
  Assert-Exit '45 run 1 (scheduled, stale store, backup cannot be made)' $r1 'ROLLED_BACK' 'PRE_UPDATE_BACKUP_FAILED'
  Check '45 run 1 really fenced the tills (data-path 503 STORE_UPDATING rows seen)' $true ((Get-FenceRowCount $p1) -gt 0)
  Assert-RollbackFenceWindow '45 run 1' $p1
  Check '45 run 1 left one archived journal' 1 ((Get-ArchivedJournalCount) - $j0)
  Check '45 run 1: the store stayed on the old pack' $script:OldV ([string](Get-Cfg).pack.current)
  Assert-ConsistentStore '45 after run 1' $null $consistentPre
  $rb = Get-UpdateReadPath 'update-rolled-back.json'
  Info '45 a rolled-back record exists after a backup failure (the version is not parked unless it caused the failure)' (Test-Path $rb)
  if (Test-Path $rb) { Remove-Item $rb -Force; Info '45 test manipulation' 'the rolled-back record was removed so the gate, not the parked-version skip, answers run 2' }

  $p2 = Join-Path $script:OutDir 'poll45-2.jsonl'; Remove-Item $p2 -Force -ErrorAction SilentlyContinue
  $job2 = Start-FencePoller $p2; Assert-PollerConnects '45 run 2' $p2
  $r2 = Bk @('update', '--pack', $script:NewV, '--scheduled') 'update-2-scheduled'
  Start-Sleep -Seconds 2; Stop-LanPoller $job2
  Assert-Exit '45 run 2 (scheduled, same window, the attempt already failed)' $r2 'PRECONDITION' 'BACKUP_NOT_READY'
  Check '45 run 2 did NOT fence: not one data-path 503 STORE_UPDATING row' 0 (Get-FenceRowCount $p2)
  Check '45 run 2 wrote no new journal' 0 ((Get-ArchivedJournalCount) - $j0 - 1)
  Check '45 run 2 left no journal and no fence marker' $false ((Test-Path (Get-UpdateReadPath 'journal.json')) -or (Test-Path (Join-Path $script:Data 'conf\Caddyfile.live')))
  Check '45 run 2: update-result.json records the refusal' 'BACKUP_NOT_READY' ([string](Get-UpdateResult).lastReason)
  Assert-ConsistentStore '45 after run 2' $null $consistentPre

  $r3 = Bk @('update', '--pack', $script:NewV) 'update-3-by-hand'
  Assert-Exit '45 run 3 (a person at the console still gets a fenced attempt of their own)' $r3 'ROLLED_BACK' 'PRE_UPDATE_BACKUP_FAILED'
  Check '45 run 3 fenced and journaled (a second archived journal)' 2 ((Get-ArchivedJournalCount) - $j0)
  Assert-ConsistentStore '45 after run 3' $null $consistentPre
  Check '45 no snapshot was ever made while the repository was unusable' 0 @(Get-Snapshots).Count

  # ---- Part 2: the real thing -----------------------------------------------------------------------------------------------------------------------------------------
  Remove-Item -LiteralPath $blocker -Force
  Check '45 setup: the blocker is gone' $false (Test-Path -LiteralPath $blocker)
  $r = Bk @('update', '--pack', $script:NewV) 'update-real'
  Assert-Exit '45 the update succeeds with the REAL backup service (no test hook)' $r 'OK'
  $preSnaps = @(Get-Snapshots | Where-Object { $_.reason -eq 'pre-update' })
  Check '45 exactly one pre-update snapshot was taken' 1 $preSnaps.Count
  Check '45 it is protected from retention' $true ($preSnaps.Count -eq 1 -and $preSnaps[0].protected -eq $true)
  Check '45 it is a snapshot of the OLD schema level' $oldMax ($(if ($preSnaps.Count -eq 1) { [string]$preSnaps[0].schema } else { '' }))
  Check '45 the store is on the new pack' $script:NewV ([string](Get-Cfg).pack.current)
  Assert-ConsistentStore '45 after the update' $true $consistentPre
  $s = Get-BackupStatus
  # status.backup.lastKind is the newest OFF-DISK copy and is null with no destination: judge the local snapshot list and the local success time instead
  Check '45 the newest snapshot is the pre-update one' 'pre-update' ([string]@(Get-Snapshots)[0].reason)
  Check '45 status.backup carries a local success time' $true ($null -ne $s.backup.localLastSuccessAt)
  Assert-StatusBackupSafe '45 after the update' $s
  Test-Clean '45 after the update'

  # ---- Part 3: restore the older snapshot onto the new pack ----------------------------------------------------------------------------------------------------------
  [void](Psql 'postgres' "INSERT INTO zz_fixture.zz_probe VALUES (999999, 'after-update')")
  $rs = Bk @('backup', 'restore', '--snapshot', [string]$preSnaps[0].id, '--swap') 'restore-older'
  Check '45 restoring the pre-update snapshot onto the new pack exits 0' 0 $rs.exit
  Check '45 the result says it was migrated forward' $true ($rs.json.data.migratedForward -eq $true)
  Check '45 the row added after the snapshot is gone (the older data is back)' '0' (Psql 'postgres' "SELECT count(*) FROM zz_fixture.zz_probe WHERE id = 999999")
  Check '45 the database is on the NEW migration level (db push ran on the clone)' "$($newM.count)|$($newM.max)" (Get-Level)
  Check '45 GoTrue was migrated to the new pack''s level (auth.exe migrate ran on the clone)' "$($n + 1)|$($script:AuthNewMax)" (Get-AuthLevel)
  Check '45 the pack pointer is still the new pack' $script:NewV ([string](Get-Cfg).pack.current)
  Check '45 the public row counts are the older snapshot''s' $pre.Rows (Get-RowCounts)
  Check '45 the s7 marker data survived' 'before-update' (Psql 'postgres' 'SELECT v FROM public.s7_marker LIMIT 1')
  Check '45 the admin signs in (HTTP 200 + access_token)' $true ((Invoke-AdminGrant).Status -eq 200)
  $canary = Read-JsonFile (Join-Path $script:Data 'state\canary.json')
  Check '45 the canary ran after the restore: lastOk=true' $true ($canary -ne $null -and $canary.lastOk -eq $true)
  Assert-GatewayPackVersion '45 after the older restore' $script:NewV
  Test-Clean '45 after the older restore'

  # ---- Part 4: a restore against a held update.lock -------------------------------------------------------------------------------------------------------------------
  $lock = Open-ForeignLock $true
  try {
    $t0 = Get-Date
    $rl = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') 'restore-locked'
    Check '45 a restore against a held update.lock: LOCK_HELD (10)' 10 $rl.exit
    Info '45 seconds the restore waited for the lock before giving up' ([int]((Get-Date) - $t0).TotalSeconds)
  } finally { $lock.Dispose() }
  Info '45 not automated: the 3x-database disk-space refusal of restore' 'filling the Sandbox system drive is not safe; restore::check_disk is pinned by unit tests with a fake free-space reading'
  Assert-NoSecrets '45'
  return @{ Results = (Get-Results); Reboot = $false }
}
