# 56 - the gates that are decided before the plan is evaluated, and the status alerts (Plan 09 Task 13; spare id 56 of conventions 17 F).
# STAGE 1 (no importer needed, but a base pack that carries the storage tables IS needed: Install-SwitchStore stops otherwise): ALREADY_SWITCHED, LOCK_HELD (exit 10, distinct), CLOUD_STATE_UNKNOWN + rollback clearing it, CLOUD_STILL_MOVED,
#   moved|other op, held-by-another-op + rollback of the old op, status alerts (seeded records: the real-run paths are 53/54/57), no unexpected table.
# STAGE 1 IF the baseline plan is clean on this base (probed and recorded), else the item marked [needs clean plan] is recorded as Info:
#   STAGING_NOT_PRIVATE and the tampered backups\ refusal happen at `ensure_dump`, which comes after the pre-check.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $pre = Get-SwitchSnapshot
  Assert-NoUnexpectedPublicTables '56 fresh store'
  $base = Invoke-Switch 'plan' -Tag '56-baseline'
  $clean = ($base.exit -eq 0)
  Info '56 baseline plan (exit / block findings): tells the tester whether Stage 1 can go past the pre-check' "$($base.exit) / $((Get-Codes $base) -join ',')"

  # ALREADY_SWITCHED: decided from posctl.json alone, before the cloud is touched
  Set-LocalMode 'offline-only'
  $fp = Get-CloudFingerprint
  $r = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '56-already'
  Assert-Exit '56 run on an Offline-only server' $r 'SWITCH_REFUSED' 'ALREADY_SWITCHED'
  $rb = Invoke-Switch 'rollback' @([Guid]::NewGuid().ToString()) -Tag '56-already-rb'
  Assert-Exit '56 rollback on an Offline-only server' $rb 'SWITCH_REFUSED' 'ALREADY_COMMITTED'
  Check '56 ALREADY_SWITCHED: the cloud was never touched' $fp (Get-CloudFingerprint)

  # LOCK_HELD is exit 10 and never ALREADY_SWITCHED, in either mode (run waits the 120 s lock wait)
  $lock = Open-ForeignLock $true
  Check '56 setup: this scenario holds the operation lock' $true ($lock -ne $null)
  foreach ($mode in @('offline-only', 'cloud')) {
    Set-LocalMode $mode
    $l = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag "56-lock-run-$mode"
    Assert-Exit "56 run, mode $mode, lock held" $l 'LOCK_HELD' 'LOCK_HELD'
    Check "56 run, mode ${mode}: retryable" 'True' ([string]$l.json.retryable)
    Check "56 run, mode ${mode}: the reason is not ALREADY_SWITCHED" $true ([string]$l.json.data.reason -ne 'ALREADY_SWITCHED')
  }
  $lr = Invoke-Switch 'rollback' @([Guid]::NewGuid().ToString()) -Tag '56-lock-rb'
  Assert-Exit '56 rollback, lock held' $lr 'LOCK_HELD' 'LOCK_HELD'
  if ($lock) { $lock.Dispose() }
  Check '56 the cloud was never touched while the lock was held' $fp (Get-CloudFingerprint)
  Reset-Store

  # an unknown cloud (progress record) refuses a new run; rollback clears it only when the cloud reads active
  $opX = [Guid]::NewGuid().ToString(); $opY = [Guid]::NewGuid().ToString()
  Write-SwitchProgress 'rolled back, the cloud may be moved' 'unknown' $opX
  $u = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '56-unknown'
  Assert-Exit '56 run while progress reads unknown' $u 'SWITCH_REFUSED' 'CLOUD_STATE_UNKNOWN'
  Check '56 the message names the command and the operation' $true (([string]$u.json.message) -match [regex]::Escape("switch rollback $opX"))
  Check '56 status alerts SWITCH_CLOUD_MAY_BE_MOVED for an unknown record' $true ((Get-AlertCodes) -contains 'SWITCH_CLOUD_MAY_BE_MOVED')
  Set-CloudHold 'moved' $opY
  $still = Invoke-Switch 'rollback' @($opX) -Tag '56-still-moved'
  Assert-Exit '56 rollback of op X while the cloud is moved by op Y' $still 'SWITCH_REFUSED' 'CLOUD_STILL_MOVED'
  Check '56 the progress record stays unknown' 'unknown' ([string](Get-SwitchProgress).cloud)
  Check '56 the cloud is still moved by Y' "moved|$opY" ((Get-CloudStateWord) + '|' + (Get-CloudOp))
  $mv = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '56-moved-other-unknown'
  Assert-Exit '56 run with progress unknown AND the cloud moved by another op: the unknown record wins' $mv 'SWITCH_REFUSED' 'CLOUD_STATE_UNKNOWN'
  $ry = Invoke-Switch 'rollback' @($opY) -Tag '56-rollback-y'
  Assert-Exit '56 rollback of op Y frees its moved row' $ry 'OK'
  Check '56 the cloud reads active' 'active' (Get-CloudStateWord)
  Check '56 Y''s release does not clear X''s record (another operation)' 'unknown' ([string](Get-SwitchProgress).cloud)
  $rx = Invoke-Switch 'rollback' @($opX) -Tag '56-rollback-x'
  Assert-Exit '56 rollback of op X with the cloud active verifies and clears' $rx 'OK'
  Check '56 the progress record is released' 'released' ([string](Get-SwitchProgress).cloud)
  Check '56 the alert is gone' $false ((Get-AlertCodes) -contains 'SWITCH_CLOUD_MAY_BE_MOVED')
  Reset-Store

  # a cloud moved by another operation and NO progress record: refused as already switched
  Set-CloudHold 'moved' $opY
  $fpMoved = Get-CloudFingerprint
  $mo = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '56-moved-other'
  Assert-Exit '56 run on a cloud moved by another operation (no progress record)' $mo 'SWITCH_REFUSED' 'ALREADY_SWITCHED'
  Check '56 the moved row is untouched' $fpMoved (Get-CloudFingerprint)
  Reset-Store

  # held by another operation: refused at the pre-check naming the old op; rolling the old op back clears it
  Set-CloudHold 'frozen' $opY 30
  $fpHeld = Get-CloudFingerprint
  $h = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '56-held'
  Assert-Exit '56 run while an earlier operation still holds the cloud' $h 'SWITCH_REFUSED' 'CLOUD_HELD_BY_ANOTHER_OPERATION'
  Check '56 the message names the old operation' $true (([string]$h.json.message) -match [regex]::Escape($opY))
  Check '56 the held row is untouched' $fpHeld (Get-CloudFingerprint)
  $hb = Invoke-Switch 'rollback' @($opY) -Tag '56-held-rb'
  Assert-Exit '56 rollback of the old operation' $hb 'OK'
  Check '56 the cloud reads active' 'active' (Get-CloudStateWord)
  Assert-LocalIntact '56 held' $pre
  Reset-Store

  # a held progress record with no journal is the NOT_RELEASED alert
  Write-SwitchProgress 'freezing' 'held' $opY
  Check '56 status alerts SWITCH_CLOUD_NOT_RELEASED for held and no journal' $true ((Get-AlertCodes) -contains 'SWITCH_CLOUD_NOT_RELEASED')
  Reset-Store

  # [needs clean plan] STAGING_NOT_PRIVATE and the tampered backups\ refusal
  if ($clean) {
    $bk = Join-Path $script:Data 'backups'
    icacls.exe $bk /grant '*S-1-5-32-545:(OI)(CI)R' | Out-Null
    Check '56 setup: icacls grant exit code' 0 $LASTEXITCODE
    $fp2 = Get-CloudFingerprint
    $s = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '56-staging'
    Assert-Exit '56 run with backups\ readable by Users' $s 'SWITCH_REFUSED' 'STAGING_NOT_PRIVATE'
    Check '56 the message prints the icacls fix' $true (([string]$s.json.message) -match 'icacls')
    Check '56 nothing was written (no switch-* dump folder)' 0 @(Get-ChildItem $bk -Directory -Filter 'switch-*' -ErrorAction SilentlyContinue).Count
    Check '56 the cloud row is untouched (no hold)' $fp2 (Get-CloudFingerprint)
    icacls.exe $bk /remove '*S-1-5-32-545' | Out-Null
    Check '56 teardown: icacls remove exit code' 0 $LASTEXITCODE
    Reset-Store
  } else { Info '56 [needs clean plan] STAGING_NOT_PRIVATE / tampered backups: NOT RUN, the baseline plan is blocked on this base' ((Get-Codes $base) -join ',') }

  Assert-NoSecrets '56'
  Assert-NoCloudSecrets '56' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
