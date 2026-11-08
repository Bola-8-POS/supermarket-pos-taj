# 62 - photos survive a backup and a restore, and `photos verify` tells the truth about both (Plan 10 Task 8).
# Take a `backup run` of a store with photo rows and files, delete one photo file, `photos verify` exits 60 (the row is dangling), restore the snapshot, `photos verify` exits 0
# and every photo is back with identical bytes. Models: scenario 40 (the USB stand-in, Seed-Probe, `backup restore --swap`). Estimated 20 minutes. Runs on the 11H pack (-Hashed): its own snapshot names a pepper, so restore needs bcrypt PINs.
. C:\scenarios\lib-backup.ps1
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore -Hashed
  Seed-Probe
  New-TestUsb 'E'
  [void](Add-Usb)
  $v0 = Bk @('photos', 'verify') '62-verify-clean'
  Check '62 setup: 12 rows, 12 files, photos verify exits 0' '0/12/12/0' ("$($v0.exit)/$($v0.json.data.rows)/$($v0.json.data.files)/$($v0.json.data.dangling)")
  $good = Get-PhotoFingerprint
  $b = Backup-Now 'manual'
  Check '62 setup: the backup exits 0' 0 $b.exit

  $victim = @(Get-ChildItem (Join-Path $script:Data 'photos\product-photos') -File | Sort-Object Name)[0]
  Remove-Item -LiteralPath $victim.FullName -Force
  $v1 = Bk @('photos', 'verify') '62-verify-dangling'
  Check '62.1 with a photo file deleted, photos verify exits 60 (PHOTOS_INCONSISTENT)' '60/PHOTOS_INCONSISTENT' ("$($v1.exit)/$($v1.json.code)")
  Check '62.1 ... and counts exactly one dangling row' 1 ([int]$v1.json.data.dangling)

  $rs = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') '62-restore'
  Check '62.2 restore --swap exits 0' 0 $rs.exit
  Check '62.2 every photo is back with identical bytes (the deleted one too)' $good (Get-PhotoFingerprint)

  $v2 = Bk @('photos', 'verify') '62-verify-restored'
  Check '62.3 after the restore photos verify exits 0' 0 $v2.exit
  Check '62.3 ... with 12 rows, 12 files and none dangling' '12/12/0' ("$($v2.json.data.rows)/$($v2.json.data.files)/$($v2.json.data.dangling)")
  return @{ Results = (Get-Results); Reboot = $false }
}
