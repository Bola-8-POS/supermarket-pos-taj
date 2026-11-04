# 40 - backup to a USB drive, damage the store, restore it on the same PC (Plan 08 Task 13).
# Proves on a real Postgres / GoTrue / restic: the backups\ folder is private to SYSTEM and Administrators (assert_private passing case, PrivateDir through the
# key file of dest add / key-export); key-export on a console prints the key once and nothing keeps it; the copy reaches the drive and the escrow copy sits next to it;
# a caja close is noticed by the 5-minute tick; pg_restore of the real Supabase-shaped database brings rows and photos back byte for byte; a real GoTrue admin
# sign-in works after the restore; the previous database is kept but closed to everyone; the canary ran after the restore; the post-restore backup exists;
# an unreadable photo and a photo row without a file are reported as fixed words only (status.json carries no path, no key, no free text).
# Estimated 25 minutes. Needs diskpart to create a VHD (the USB stand-in); otherwise the scenario stops with the diskpart output.
. C:\scenarios\lib-backup.ps1
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore
  Seed-Probe
  New-TestUsb 'E'
  Info '40 setup: the test USB filesystem (a mounted VHD reports as a fixed disk, hence --allow-fixed)' (Get-UsbFs 'E')
  Assert-BackupsPrivate '40 fresh store'

  $ad = Add-Usb
  Check '40 dest add: the drive got its dedicated folder' $script:UsbRepo ([string]$ad.json.data.path)
  Check '40 dest add: an NTFS drive draws no filesystem warning' 0 @($ad.json.data.warnings).Count
  Assert-BackupsPrivate '40 after dest add' -Expect 'cache','repo'   # dest add creates the local repository and its cache; backups\tmp comes with the first key-export or backup run

  # ---- key-export on a console (T11 carry): printed once, nothing keeps it, escrow copy beside the repository -----------------------------------------------
  Test-ConPtyProbe '40 conpty probe'
  $k = Export-RecoveryKey -Label '40 key-export'
  $esc = @($k.Json.data.escrow)
  Check '40 key-export: every destination has its escrow copy (envelope escrow[].ok)' $true ($esc.Count -eq 1 -and @($esc | Where-Object { $_.ok }).Count -eq 1)
  Check '40 key-export: escrow.age sits next to the USB repository' $true (Test-Path 'E:\escrow.age')
  Check '40 key-export: the escrow copy on this PC exists (backups\escrow.age)' $true (Test-Path (Join-Path $script:Data 'backups\escrow.age'))
  Assert-KeyNowhere '40 key-export' $k.Key
  $kx = Bk @('backup', 'key-export') 'key-export-pipe'
  Check '40 key-export into a pipe is refused: PRECONDITION (12), the key is never put on a pipe' 12 $kx.exit
  Check '40 ... and no key shape reaches that output' 0 ([regex]::Matches($kx.raw + $kx.err, $script:KeyShape)).Count
  $rf = Bk @('backup', 'key-export', '--result-file', 'C:\out\kx-result.json') 'key-export-resultfile'
  Check '40 key-export --result-file is refused: USAGE (2)' 2 $rf.exit
  Check '40 ... and no key shape reaches the result file' 0 ([regex]::Matches((Get-Content 'C:\out\kx-result.json' -Raw -ErrorAction SilentlyContinue) + '', $script:KeyShape)).Count
  Assert-BackupsPrivate '40 after key-export' -Expect 'cache','repo','tmp'

  # ---- backup, tick, caja close -----------------------------------------------------------------------------------------------------------------------------
  $b = Backup-Now 'manual'
  Check '40 manual backup exits 0' 0 $b.exit
  Check '40 the run completed' 'completed' $b.json.data.outcome
  $ud = @($b.json.data.destinations | Where-Object { $_.name -eq 'usb-e' })
  Check '40 the USB copy succeeded' $true ($ud.Count -eq 1 -and $ud[0].ok)
  $snaps = Get-Snapshots
  Check '40 the newest snapshot is held by the local repository and the USB drive' 'local,usb-e' ((@($snaps[0].on) | Sort-Object) -join ',')
  Check '40 its reason is manual' 'manual' $snaps[0].reason
  Test-Clean '40 after the backup' -Expect 'cache','repo','tmp'

  $t0 = Tick
  Check '40 a tick right after a backup exits 0' 0 $t0.exit
  Check '40 ... and finds nothing due' 'skipped' $t0.json.data.outcome
  Close-Caja
  $t = Tick
  Check '40 the tick after a caja close exits 0' 0 $t.exit
  Check '40 ... and took a caja-close backup straight away' 'caja-close' $t.json.data.reason
  $t2 = Tick
  Check '40 the next tick finds nothing due again' 'skipped' $t2.json.data.outcome

  # ---- damage, restore, compare ----------------------------------------------------------------------------------------------------------------------------
  [void](Bk @('backup', 'run', '--reason', 'manual') 'backup-before-damage')
  $good = Get-Fingerprint
  [void](Psql 'postgres' 'DROP TABLE zz_fixture.zz_probe')
  Get-ChildItem (Join-Path $script:Data 'photos\product-photos') -File | Select-Object -First 5 | Remove-Item -Force
  Check '40 the damage is real' $true ((Get-Fingerprint) -ne $good)

  $rs = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') 'restore-swap'
  Check '40 restore --swap exits 0' 0 $rs.exit
  $after = Get-Fingerprint
  Check '40 pg_restore of the real database: rows and tables are back (probe table + every public row count)' (Split-Fingerprint $good).Db (Split-Fingerprint $after).Db
  Check '40 every photo is back with identical bytes' (Split-Fingerprint $good).Photos (Split-Fingerprint $after).Photos
  Check '40 the result names the restored snapshot, the source and says the gateway reopened' $true ($rs.json.data.restored -match '^[0-9a-f]{8,64}$' -and $rs.json.data.reopened -eq $true -and $rs.json.data.source -eq 'local')
  Check '40 a clean restore carries no warning' 0 @($rs.json.data.warnings).Count
  $prev = @((Get-DbNames) | Where-Object { $_ -like 'pos_prev_restore_*' })
  Check '40 the previous database is kept for rollback (one pos_prev_restore_*)' 1 $prev.Count
  if ($prev.Count -eq 1) {
    foreach ($role in 'authenticator', 'supabase_auth_admin') {
      Check "40 the kept copy is closed: $role has no CONNECT privilege on it" 'f' (Psql 'template1' "SELECT has_database_privilege('$role', oid, 'CONNECT') FROM pg_database WHERE datname = '$($prev[0])'")
    }
  }
  Check '40 postgres is the live database name' $true ((Get-DbNames) -contains 'postgres')
  Check '40 the gateway answers on the LAN path again' 200 (Get-Health).status
  Check '40 the services are up and the listeners are loopback-only' $true (Test-AllRunning)
  $g = Invoke-AdminGrant
  Check '40 a real GoTrue sign-in of the admin works after the restore (HTTP 200 + access_token)' $true ($g.Status -eq 200 -and $g.Body -match 'access_token')
  $canary = Read-JsonFile (Join-Path $script:Data 'state\canary.json')
  Check '40 the canary ran after the restore: state\canary.json lastOk=true' $true ($canary -ne $null -and $canary.lastOk -eq $true)
  $post = Get-Snapshots
  Check '40 a PreRestore snapshot of the damaged state exists' $true (@($post | Where-Object { $_.reason -eq 'pre-restore' }).Count -ge 1)
  Check '40 the post-restore backup is the newest snapshot (so latest is the restored data)' $true ($rs.json.data.postRestoreBackup -eq $true -and $post[0].reason -eq 'manual')
  Test-Clean '40 after the restore' -Expect 'cache','repo','tmp'
  $s = Get-BackupStatus
  Check '40 status.backup: no alert' 'none' ([string]$s.backup.alert)
  Check '40 status.backup carries the drive, ok' $true (@($s.backup.destinations | Where-Object { $_.name -eq 'usb-e' -and $_.ok }).Count -eq 1)
  Check '40 status.backup shows the restore' 'restored' ([string]$s.backup.lastRestore.result)
  Assert-StatusBackupSafe '40 after the restore' $s
  Assert-KeyNowhere '40 after the restore' $k.Key

  # ---- an unreadable photo: the backup still completes, the owner gets a fixed-word alert, no file name reaches status.json -----------------------------------
  $one = Get-ChildItem (Join-Path $script:Data 'photos\product-photos') -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $one) { Add-Check '40 setup: a product photo exists to lock' 'a photo file' 'no photo found' $false }
  else {
  # restic skips a file whose size and time are unchanged, so new bytes go in BEFORE the lock or the file would never be read (and never be unreadable)
  $fresh = New-Object byte[] 20000; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($fresh); [IO.File]::WriteAllBytes($one.FullName, $fresh)
  $lock = [IO.File]::Open($one.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try { $bl = Backup-Now 'manual' 'backup-locked-photo' } finally { $lock.Dispose() }
  Check '40 a backup with one unreadable photo still exits 0' 0 $bl.exit
  $s2 = Get-BackupStatus
  $pa = @(@($s2.alerts) | Where-Object { $_.code -eq 'BACKUP_PHOTOS_UNREADABLE' })
  Check '40 BACKUP_PHOTOS_UNREADABLE is raised with a count' $true ($pa.Count -eq 1 -and [int]$pa[0].count -ge 1)
  Check '40 status.json does not carry the unreadable file''s name' $false ((Get-Content (Join-Path $script:Data 'state\status.json') -Raw).Contains($one.Name))
  Assert-StatusBackupSafe '40 photos unreadable' $s2
  [void](Backup-Now 'manual' 'backup-photo-cleared')
  Check '40 the next clean backup clears the photo alert' $false ((Alert-Codes (Get-BackupStatus)) -contains 'BACKUP_PHOTOS_UNREADABLE')
  }

  # ---- a photo row without a file (the delete-during-backup window): restore warns, never fails; the owner is told in fixed words ------------------------------
  $victim = Get-ChildItem (Join-Path $script:Data 'photos\product-photos') -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $victim) { Add-Check '40 setup: a product photo exists to delete' 'a photo file' 'no photo found' $false } else { Remove-Item $victim.FullName -Force }
  [void](Backup-Now 'manual' 'backup-dangling')
  $rw = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') 'restore-dangling'
  Check '40 restoring a backup with one dangling photo row exits 0 (a handful is a warning)' 0 $rw.exit
  Check '40 ... and the result warns PHOTOS_SOME_MISSING' $true (@($rw.json.data.warnings) -contains 'PHOTOS_SOME_MISSING')
  $s3 = Get-BackupStatus
  $rwAlert = @(@($s3.alerts) | Where-Object { $_.code -eq 'BACKUP_RESTORE_WARNING' })
  Check '40 BACKUP_RESTORE_WARNING lists the fixed warning code' $true ($rwAlert.Count -eq 1 -and @($rwAlert[0].warnings) -contains 'PHOTOS_SOME_MISSING')
  Assert-StatusBackupSafe '40 restore warning' $s3
  Check '40 the store is up and the admin still signs in' $true ((Test-AllRunning) -and (Invoke-AdminGrant).Status -eq 200)
  # ---- R1: `latest` never picks a pre-restore snapshot. A restore is killed right after its PreRestore backup (the existing exit_at hook journal:backup:done, the same one scenarios 46/47 use),
  # `update --recover` rolls it back, and the PreRestore snapshot of the damaged state is now the newest. The next `restore --snapshot latest` must still land on the GOOD data. ---------------------
  [void](Psql 'postgres' "DROP TABLE IF EXISTS public.zz_r1; CREATE TABLE public.zz_r1 (v text); INSERT INTO public.zz_r1 VALUES ('pre-damage')")
  [void](Backup-Now 'manual' 'backup-r1-good')
  [void](Psql 'postgres' "INSERT INTO public.zz_r1 VALUES ('damage')")
  $rk = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') 'r1-restore-killed' (Hooks @{ exit_at = 'journal:backup:done' })
  Check '40 R1 the restore was killed after its PreRestore backup (hook journal:backup:done, 137)' 137 $rk.exit
  $rr = Invoke-Posctl @('update', '--recover') -Tag 'r1-recover'
  Assert-Exit '40 R1 update --recover rolls the killed restore back' $rr 'OK'
  Check '40 R1 after the rollback the store still holds the damage marker (the restore did not land)' '2' ([string](Psql 'postgres' 'SELECT count(*) FROM public.zz_r1'))
  $r1Snaps = @(Get-Snapshots)
  Check '40 R1 the newest snapshot is now the PreRestore one (the trap for latest)' 'pre-restore' ([string]$r1Snaps[0].reason)
  $r1 = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') 'r1-restore-latest'
  Check '40 R1 restore --snapshot latest --swap exits 0' 0 $r1.exit
  $chosen = [string]$r1.json.data.restored
  $r1List = @(Get-Snapshots)
  $picked = @($r1List | Where-Object { $chosen -and ([string]$_.id).StartsWith($chosen) -or ([string]$_.id) -eq $chosen })
  Check '40 R1 the chosen snapshot is in backup list and is not reason pre-restore' $true ($picked.Count -ge 1 -and @($picked | Where-Object { $_.reason -eq 'pre-restore' }).Count -eq 0)
  Check '40 R1 the store ends on the GOOD data: the pre-damage marker row is present' '1' ([string](Psql 'postgres' "SELECT count(*) FROM public.zz_r1 WHERE v = 'pre-damage'"))
  Check '40 R1 ... and the damage marker row is absent' '0' ([string](Psql 'postgres' "SELECT count(*) FROM public.zz_r1 WHERE v = 'damage'"))
  Info '40 not automated: CANARY_AFTER_RESTORE / sign-in blocked after a failed canary' 'needs a lockout hook that fails after a restore; covered by the restore_work unit tests'
  Info '40 not automated: BACKUP_STATE_UNKNOWN' 'needs an unreadable posctl.json; covered by the status unit tests'
  Assert-NoSecrets '40'
  return @{ Results = (Get-Results); Reboot = $false }
}
