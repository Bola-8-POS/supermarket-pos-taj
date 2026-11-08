# 94b - Plan 11H Task 16, the hashed snapshot: a backup made on an 11H store (profiles.pin bcrypt, the pepper inside the snapshot) restored onto a freshly provisioned PC.
# Proves: the update to the 11H pack backfills the hashes (no 6-digit value left); the snapshot lists a pepper record (name only, content never printed); after unprovision --delete-data
# and a fresh provision (a new pepper) the restore installs the SNAPSHOT's pepper (fingerprint equal, the fresh one gone); staff and admin sign in with their PINs; verify_staff_pin
# answers right and wrong; nothing printed or stored carries a PIN or a pepper.
# RED ONCE (control): with the hook skip_pepper_install the same restore fails its live verification (the pepper fingerprint does not match the snapshot's), rolls back, and the fresh
# pepper is still in place; the real restore then passes. Needs the test-hooks payload built from this branch. Estimated 45 minutes.
. C:\scenarios\lib-pin.ps1
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore
  $oldPepper = Get-Pepper
  $oldFp = Get-Sha256Hex $oldPepper
  $staff = Add-PinStaff '94b Staff' $oldPepper
  $script:ExtraPeppers = @($oldPepper)
  Check '94b setup: plaintext PINs before the update (admin + staff, a non-zero count)' $true ((Get-PlainPinCount) -ge 2)
  $up = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag '94b-update' -TimeoutSec 1800
  Assert-Exit '94b update to the 11H pack' $up 'OK'
  Check '94b after the update: count of profiles with a 6-digit pin is 0' 0 (Get-PlainPinCount)
  Check '94b after the update: the stored PINs are bcrypt (admin + staff, a non-zero count)' $true ((Get-HashedPinCount) -ge 2)
  Check '94b after the update: the staff member signs in with the same PIN (200)' 200 (Get-StaffGrant $staff.Id $staff.Pin $oldPepper).Status
  $key = Initialize-PinDrive '94b'
  $b = Backup-Now 'manual' 'backup-hashed'
  Check '94b S2: the hashed backup exits 0' 0 $b.exit
  Check '94b S2: the snapshot lists the pepper record (name only)' $true (Test-SnapshotHasPepperRecord)
  Assert-NoPin '94b after the hashed backup'

  Reset-ToFreshStore '94b'
  Check '94b the fresh pepper differs from the snapshot machine''s' $true ($script:FreshPepper -ne $oldPepper)
  $script:ExtraPeppers = @($oldPepper, $script:FreshPepper)

  # ---- RED ONCE: the snapshot's pepper is not installed, the live verification must fail and the restore roll back ------------------------------------------------------
  $red = Invoke-DriveRestore $key (Hooks @{ skip_pepper_install = $true }) 'restore-control'
  Check '94b control (skip_pepper_install): the restore fails its live verification (non-zero exit)' $true ($red.exit -ne 0)
  Info '94b control: the refusal' ("exit=" + $red.exit + " code=" + [string]$red.json.code + " reason=" + [string]$red.json.data.reason)
  Assert-FreshStoreIntact '94b control:' $staff.Id

  # ---- the real restore ------------------------------------------------------------------------------------------------------------------------------------------
  $rs = Invoke-DriveRestore $key $null 'restore-hashed'
  Check '94b the hashed snapshot restores (exit 0)' 0 $rs.exit
  Check '94b the installed pepper fingerprint equals the snapshot''s' $true ((Get-Sha256Hex (Get-Pepper)) -eq $oldFp)
  Check '94b the fresh pepper is gone' $true ((Get-Pepper) -ne $script:FreshPepper)
  Check '94b the staff member signs in with the SAME PIN (200)' 200 (Get-StaffGrant $staff.Id $staff.Pin (Get-Pepper)).Status
  Check '94b the admin signs in with the SAME PIN (200)' 200 (Invoke-AdminGrant (Get-Pepper)).Status
  Check '94b a wrong PIN does not sign the staff member in (400)' 400 (Get-StaffGrant $staff.Id (New-Digits6) (Get-Pepper)).Status
  Check '94b count of profiles with a 6-digit pin is 0' 0 (Get-PlainPinCount)
  Assert-VerifyStaffPin '94b' $staff (Get-Pepper)
  Check '94b the services are up and the gateway answers' $true ((Test-AllRunning) -and (Get-Health).status -eq 200)
  Assert-NoPin '94b after the restore'
  Assert-NoStaffPin '94b staff PIN after the restore' $staff
  Test-Clean '94b after the restore'
  Assert-NoSecrets '94b'
  return @{ Results = (Get-Results); Reboot = $false }
}
