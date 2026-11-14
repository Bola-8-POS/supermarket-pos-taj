# 94a - Plan 11H Task 16, the legacy snapshot: a backup made before 11H (plaintext PINs, no pepper record) restored onto a freshly provisioned PC with ANOTHER pepper.
# Proves: the legacy re-derive runs BEFORE the forward migration hashes the PINs (the 11H migration is in the pack the restore migrates to); the staff member and the admin
# sign in with their same PINs and THIS PC's pepper (the old pepper no longer works); no 6-digit value is left in profiles.pin and the bcrypt CHECK exists; verify_staff_pin
# answers right and wrong; no PIN or pepper reaches a log, state or evidence file. The legacy snapshot is made with the test hook legacy_snapshot (this posctl always writes the pepper).
# RED ONCE (control): with the hook skip_legacy_rederive the same restore is refused (the admin's stored credential does not verify against this PC's pepper), the fresh store is
# untouched; the real restore then passes. Needs the test-hooks payload built from this branch (it carries both hooks). Estimated 40 minutes.
. C:\scenarios\lib-pin.ps1
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore    # the old pack provisions (plaintext PINs); the new pack, which carries the 11H migration, is installed but not applied
  $oldPepper = Get-Pepper
  $staff = Add-PinStaff '94a Staff' $oldPepper
  $script:ExtraPeppers = @($oldPepper)
  Check '94a setup: the live database holds plaintext PINs (admin + staff, a non-zero count)' $true ((Get-PlainPinCount) -ge 2)
  Check '94a setup: the staff member signs in with the PIN (200)' 200 (Get-StaffGrant $staff.Id $staff.Pin $oldPepper).Status
  $key = Initialize-PinDrive '94a'
  $b = Bk @('backup', 'run', '--reason', 'manual') 'backup-legacy' (Hooks @{ legacy_snapshot = $true })
  Check '94a S1: the legacy backup exits 0' 0 $b.exit
  Assert-NoPin '94a after the legacy backup'
  Check '94a S1: the snapshot holds no pepper record (a legacy snapshot)' $false (Test-SnapshotHasPepperRecord)

  # ---- the replacement PC: unprovision --delete-data, fresh provision (new pepper) ------------------------------------------------------------------------------
  Reset-ToFreshStore '94a'
  Check '94a the fresh pepper differs from the snapshot machine''s' $true ($script:FreshPepper -ne $oldPepper)
  $script:ExtraPeppers = @($oldPepper, $script:FreshPepper)

  # ---- RED ONCE: no re-derive, the stored Auth passwords (old pepper) cannot verify against this PC's pepper ---------------------------------------------------------
  $red = Invoke-DriveRestore $key (Hooks @{ skip_legacy_rederive = $true }) 'restore-control'
  Check '94a control (skip_legacy_rederive): the restore is refused (non-zero exit)' $true ($red.exit -ne 0)
  Info '94a control: the refusal' ("exit=" + $red.exit + " code=" + [string]$red.json.code + " reason=" + [string]$red.json.data.reason)
  Assert-FreshStoreIntact '94a control:' $staff.Id

  # ---- the real restore ------------------------------------------------------------------------------------------------------------------------------------------
  $rs = Invoke-DriveRestore $key $null 'restore-legacy'
  Check '94a the legacy snapshot restores (exit 0)' 0 $rs.exit
  Info '94a the re-derive report (counts and ids only)' ($rs.json.data.rederived | ConvertTo-Json -Compress)
  Check '94a the re-derive report is present (the legacy path ran before the migration)' $true ($rs.json.data.rederived -ne $null)
  Check '94a the pepper is still THIS PC''s (a legacy snapshot installs none)' $true ((Get-Pepper) -eq $script:FreshPepper)
  Check '94a the staff member signs in with the SAME PIN and this PC''s pepper (200)' 200 (Get-StaffGrant $staff.Id $staff.Pin $script:FreshPepper).Status
  Check '94a the admin signs in with the SAME PIN and this PC''s pepper (200)' 200 (Invoke-AdminGrant $script:FreshPepper).Status
  Check '94a the snapshot machine''s pepper no longer signs the staff member in (400)' 400 (Get-StaffGrant $staff.Id $staff.Pin $oldPepper).Status
  Check '94a count of profiles with a 6-digit pin is 0' 0 (Get-PlainPinCount)
  Check '94a the stored PINs are bcrypt (admin + staff, a non-zero count)' $true ((Get-HashedPinCount) -ge 2)
  Check '94a the CHECK profiles_pin_is_bcrypt exists' '1' (([string](Psql 'postgres' 'SELECT count(*) FROM pg_constraint WHERE conname = ''profiles_pin_is_bcrypt''')).Trim())
  Assert-VerifyStaffPin '94a' $staff $script:FreshPepper
  Check '94a the services are up and the gateway answers' $true ((Test-AllRunning) -and (Get-Health).status -eq 200)
  Assert-NoPin '94a after the restore'
  Assert-NoStaffPin '94a staff PIN after the restore' $staff
  Test-Clean '94a after the restore'
  Assert-NoSecrets '94a'
  return @{ Results = (Get-Results); Reboot = $false }
}
