# 41 - the replacement PC: only the USB drive and the owner's recovery key survive (Plan 08 Task 13, Review Focus "restore on a different PC").
# Proves: BACKUP_KEY_NOT_EXPORTED after 24 h without a key and its removal by key-export; the drive refuses a new machine key and a wrong key (restic exit 12 ->
# posctl PRECONDITION 12, wrong-shape key -> USAGE 2, missing snapshot -> RESTORE_FAILED 31); the recovery key arrives on stdin only (CRLF, BOM, lower case, no dashes)
# and never appears in output, logs, state or evidence; a swap restore from the drive onto a "new PC" (new machine key, new pepper, empty local repository, no
# backup state, no destination) brings the data back and the admin signs in with THIS machine's pepper (the old pepper no longer works); the drive is adopted
# with the recovery key and the new machine backs up to it. R2 refusals that need no network are checked; the R2 success path is recorded as not automatable.
# Estimated 30 minutes.
. C:\scenarios\lib-backup.ps1
function New-WrongKeyShape {   # a well-formed recovery key that opens nothing (Crockford base32, 30 symbols), drawn at run time
  $alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider; $b = New-Object byte[] 30; $rng.GetBytes($b)
  $chars = $b | ForEach-Object { $alphabet[$_ -band 31] }
  return (($chars -join '') -replace '(.{5})(?=.)', '$1-')
}
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore
  Seed-Probe
  New-TestUsb 'E'
  [void](Add-Usb)
  [void](Backup-Now 'manual')

  # ---- no recovery key yet: after a day the owner is told (T10 BACKUP_KEY_NOT_EXPORTED) ------------------------------------------------------------------
  $s0 = Get-BackupStatus
  Check '41 before the first day the missing recovery key is not yet an alert' $false ((Alert-Codes $s0) -contains 'BACKUP_KEY_NOT_EXPORTED')
  try { Set-ClockForward 25; $s1 = Get-BackupStatus; Info-StatusStamp $s1 '41 after +25 h' } finally { Restore-Clock }
  Check '41 25 hours without a recovery key: BACKUP_KEY_NOT_EXPORTED' $true ((Alert-Codes $s1) -contains 'BACKUP_KEY_NOT_EXPORTED')
  Assert-StatusBackupSafe '41 key not exported' $s1
  Test-ConPtyProbe '41 conpty probe'
  Info '41 clock before key-export' (Get-ClockStamp)
  $k = Export-RecoveryKey -Label '41 key-export'
  $key = $k.Key
  Check '41 key-export reports an escrow copy for the drive' $true (@($k.Json.data.escrow | Where-Object { $_.ok }).Count -eq 1)
  Check '41 the alert is gone once the key is issued' $false ((Alert-Codes (Get-BackupStatus)) -contains 'BACKUP_KEY_NOT_EXPORTED')
  Check '41 status says a recovery key was issued' $true ([bool](Get-BackupStatus).backup.recoveryKeyIssued)
  [void](Backup-Now 'manual' 'backup-after-key')
  $good = Get-Fingerprint
  $oldPepper = Get-Pepper
  Assert-KeyNowhere '41 on the old PC' $key

  # ---- the replacement PC: new machine key, new pepper, no local repository, no backup state, the drive not configured -----------------------------------
  $rm = Bk @('backup', 'dest', 'remove', '--name', 'usb-e') 'dest-remove'
  Check '41 dest remove usb-e exits 0 (the new PC does not know the drive yet)' 0 $rm.exit
  Stop-All
  Remove-Item (Join-Path $script:Data 'backups\repo') -Recurse -Force
  foreach ($f2 in 'backups\escrow.age', 'state\backup.json', 'secrets\restic-password.txt') { Remove-Item (Join-Path $script:Data $f2) -Force -ErrorAction SilentlyContinue }
  Check '41 the old machine key, local repository and backup state are gone' $false ((Test-Path (Join-Path $script:Data 'backups\repo')) -or (Test-Path (Join-Path $script:Data 'secrets\restic-password.txt')) -or (Test-Path (Join-Path $script:Data 'state\backup.json')))
  # this PC's own machine key and pepper (run-time values; the file keeps its ACL because it is overwritten, not replaced)
  $newMachineKey = New-RandomToken 32
  [IO.File]::WriteAllText((Join-Path $script:Data 'secrets\restic-password.txt'), $newMachineKey, (New-Object Text.UTF8Encoding($false)))
  # New-RandomBytes returns `,$b` (one byte[] item): never pipe it, ForEach-Object would see the whole array
  $pepperBytes = New-RandomBytes 32
  $newPepper = ([BitConverter]::ToString($pepperBytes)).Replace('-', '').ToLower()
  [IO.File]::WriteAllText((Join-Path $script:Data 'secrets\staff-password-pepper.txt'), $newPepper, (New-Object Text.UTF8Encoding($false)))
  Check '41 the pepper on this PC differs from the old one' $true ($newPepper -ne $oldPepper)
  $script:ExtraPeppers = @($oldPepper, $newPepper)   # the PIN scan also looks for the passwords derived with both
  Start-All
  [void](Psql 'postgres' 'DROP TABLE zz_fixture.zz_probe')
  Check '41 the disaster is real: the data is gone' $true ((Get-Fingerprint) -ne $good)

  # ---- the drive does not open with this PC's key, nor with a wrong one ----------------------------------------------------------------------------------
  $restic = Get-Restic
  $env:RESTIC_PASSWORD = $newMachineKey
  & $restic --no-cache --repo $script:UsbRepo snapshots 2>&1 | Out-Null; $e1 = $LASTEXITCODE
  $env:RESTIC_PASSWORD = (New-RandomToken 24)
  & $restic --no-cache --repo $script:UsbRepo snapshots 2>&1 | Out-Null; $e2 = $LASTEXITCODE
  Remove-Item Env:\RESTIC_PASSWORD -ErrorAction SilentlyContinue
  Check '41 restic refuses this PC''s new machine key on the drive (exit 12)' 12 $e1
  Check '41 restic refuses a random key on the drive (exit 12)' 12 $e2
  $no = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap', '--repo', $script:UsbRepo) 'restore-nokey'
  Check '41 restore with only this PC''s key: PRECONDITION (12)' 12 $no.exit
  Check '41 ... and tells the owner to use the recovery key' $true ([string]$no.json.message -match 'recovery key')
  Check '41 ... and changed nothing: the data is still gone' $true ((Get-Fingerprint) -ne $good)
  $bad1 = Bk @('backup', 'restore', '--snapshot', 'latest', '--repo', $script:UsbRepo, '--key-stdin') 'restore-badshape' $null 'not-a-recovery-key'
  Check '41 a recovery key of the wrong shape is a USAGE error (2)' 2 $bad1.exit
  $wrong = New-WrongKeyShape
  $bad2 = Bk @('backup', 'restore', '--snapshot', 'latest', '--repo', $script:UsbRepo, '--key-stdin') 'restore-wrongkey' $null $wrong
  Check '41 a well-formed recovery key that opens nothing: PRECONDITION (12)' 12 $bad2.exit
  Check '41 the rejected keys are not echoed in the output' 0 ([regex]::Matches($bad1.raw + $bad1.err + $bad2.raw + $bad2.err, [regex]::Escape($wrong))).Count
  $nosnap = Bk @('backup', 'restore', '--snapshot', 'deadbeefdeadbeef', '--repo', $script:UsbRepo, '--key-stdin') 'restore-nosnapshot' $null $key
  Check '41 a snapshot id that does not exist: RESTORE_FAILED (31)' 31 $nosnap.exit

  # ---- the recovery key as people really deliver it: CRLF, BOM, lower case, no dashes (verify-only restore: nothing is replaced) -------------------------------
  $enc = New-Object Text.UTF8Encoding($false)
  $crlf = Invoke-PosctlStdinBytes @('backup', 'restore', '--snapshot', 'latest', '--repo', $script:UsbRepo, '--key-stdin') ($enc.GetBytes($key + "`r`n")) 'restore-crlf'
  Check '41 key on stdin with CRLF: the drive restores and verifies in a scratch database (exit 0)' 0 $crlf.exit
  $bom = [byte[]](0xEF, 0xBB, 0xBF) + $enc.GetBytes($key.Replace('-', '').ToLower() + "`r`n")
  $bomr = Invoke-PosctlStdinBytes @('backup', 'restore', '--snapshot', 'latest', '--repo', $script:UsbRepo, '--key-stdin') $bom 'restore-bom'
  Check '41 key with a BOM, lower case, no dashes, CRLF: accepted (exit 0)' 0 $bomr.exit
  Check '41 the verify-only restore replaced nothing: the data is still gone' $true ((Get-Fingerprint) -ne $good)
  Test-Clean '41 after the verify-only restores'

  # ---- the real thing: swap restore onto the new PC with the recovery key alone ----------------------------------------------------------------------------
  $rs = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap', '--repo', $script:UsbRepo, '--key-stdin') 'restore-newpc' $null $key
  Check '41 swap restore from the drive with the recovery key exits 0' 0 $rs.exit
  $after = Get-Fingerprint
  Check '41 the database is back' (Split-Fingerprint $good).Db (Split-Fingerprint $after).Db
  Check '41 the photos are back with identical bytes' (Split-Fingerprint $good).Photos (Split-Fingerprint $after).Photos
  Info '41 the re-derive report of the restore (staff passwords re-derived with this PC''s pepper)' ($rs.json.data.rederived | ConvertTo-Json -Compress)
  Check '41 the admin signs in with THIS PC''s pepper (HTTP 200 + access_token)' $true ((Invoke-AdminGrant $newPepper).Status -eq 200)
  Check '41 the old PC''s pepper no longer signs the admin in (HTTP 400): nothing of the old machine is needed' 400 (Invoke-AdminGrant $oldPepper).Status
  Check '41 the services are up and the gateway answers' $true ((Test-AllRunning) -and (Get-Health).status -eq 200)
  $canary = Read-JsonFile (Join-Path $script:Data 'state\canary.json')
  Check '41 the canary ran on the restored store: lastOk=true' $true ($canary -ne $null -and $canary.lastOk -eq $true)
  Check '41 the key never appears in the restore output' $false (($rs.raw + $rs.err + $crlf.raw + $crlf.err + $bomr.raw + $bomr.err).Contains($key))
  Assert-KeyNowhere '41 after the new-PC restore' $key
  Test-Clean '41 after the new-PC restore'
  Info '41 not simulated: new keys.json / certificate authority (tills must re-pair after a real new-PC restore)' 'runbook step; the scenario keeps the store''s own keys'

  # ---- adopt the drive for the new machine ----------------------------------------------------------------------------------------------------------------------
  $noKey = Bk @('backup', 'dest', 'add', '--kind', 'device', '--path', 'E:\', '--allow-fixed', '--name', 'usb-e') 'dest-add-nokey'
  Check '41 adopting a drive that holds another key without the recovery key is refused: PRECONDITION (12)' 12 $noKey.exit
  Check '41 ... and the drive is not configured' 0 @(((Bk @('backup', 'dest', 'list') 'dest-list-1').json.data.destinations)).Count
  $ad = Add-Usb 'E' 'usb-e' $key
  Check '41 the drive is adopted with the recovery key' 0 $ad.exit
  $b = Backup-Now 'manual' 'backup-newpc'
  Check '41 the new machine backs up to the same drive' 0 $b.exit
  Check '41 ... and the copy succeeded' $true (@($b.json.data.destinations | Where-Object { $_.name -eq 'usb-e' -and $_.ok }).Count -eq 1)
  Check '41 the drive opens with this PC''s new machine key now (restic exit 0)' 0 (& { $env:RESTIC_PASSWORD = $newMachineKey; & $restic --no-cache --repo $script:UsbRepo snapshots 2>&1 | Out-Null; $c = $LASTEXITCODE; Remove-Item Env:\RESTIC_PASSWORD -ErrorAction SilentlyContinue; $c })
  Assert-KeyNowhere '41 after adoption' $key

  # ---- R2: the refusals that need no network (the success path cannot run offline) ----------------------------------------------------------------------------
  $u = New-RandomToken 8; $p = New-RandomToken 16
  $cred = Bk @('backup', 'dest', 'add', '--kind', 'r2', '--repo', ('s3:https://' + $u + ':' + $p + '@r2.invalid/bucket/folder'), '--name', 'r2') 'r2-credentials'
  Check '41 an s3 address with credentials in it is refused: USAGE (2)' 2 $cred.exit
  Check '41 ... and the credentials are not echoed' $false (($cred.raw + $cred.err).Contains($p))
  $notS3 = Bk @('backup', 'dest', 'add', '--kind', 'r2', '--repo', 'https://r2.invalid/bucket', '--name', 'r2') 'r2-not-s3'
  Check '41 an R2 repository that is not an s3: address is refused: USAGE (2)' 2 $notS3.exit
  $envFile = Join-Path $script:Data 'secrets\r2.env'
  $ak = New-RandomToken 12; $sk = New-RandomToken 30
  Set-Content -LiteralPath $envFile -Value @(('AWS_ACCESS_KEY_ID=' + $ak), ('AWS_SECRET_ACCESS_KEY=' + $sk)) -Encoding ASCII
  Check '41 secrets\r2.env keeps the secrets folder privacy (SYSTEM / Administrators only)' $true (Test-PrivatePath $envFile $false).Ok
  $unreach = Bk @('backup', 'dest', 'add', '--kind', 'r2', '--repo', 's3:http://127.0.0.1:9/pos-bucket/store', '--name', 'r2') 'r2-unreachable' $null $null 600
  Check '41 an unreachable R2 endpoint is refused, not added (non-zero)' $true ($unreach.exit -ne 0)
  Check '41 ... and the R2 credentials never appear in the output' $false (($unreach.raw + $unreach.err).Contains($sk) -or ($unreach.raw + $unreach.err).Contains($ak))
  Check '41 ... and no r2 destination was configured' 0 @(((Bk @('backup', 'dest', 'list') 'dest-list-2').json.data.destinations) | Where-Object { $_.name -eq 'r2' }).Count
  Remove-Item $envFile -Force -ErrorAction SilentlyContinue
  Info '41 not automated: dest add --kind r2 success with r2.env + --key-stdin' 'the offline Sandbox has no S3 endpoint; argument building and state are unit-tested, the live R2 run belongs to Plan 12 / real-hardware validation'
  Assert-StatusBackupSafe '41 end' (Get-BackupStatus)
  Assert-NoSecrets '41'
  return @{ Results = (Get-Results); Reboot = $false }
}
