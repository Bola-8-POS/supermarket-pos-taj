# 53 - the switch process is killed at every label BEFORE the cloud is touched (class B0, 10 labels) (Plan 09 Task 13).
# STAGE 2: each kill needs a run that reaches its label (integrated 09+10 build, base pack with the storage tables). The B1 and BW labels are 58,
#   the cloud-moved and forward labels are 54. Timeout 125 minutes (the plan's figure; the 2 clean-failure runs at the end are included): the first measured run sets it.
# B0 labels (steps strictly before Work): journal:started:done, fence/backup/repair_collation/clone_db intent+done. The cloud is never held, so recovery is
#   quiet (exit 0), the cloud row stays active with no operation, progress `released`, and local is intact.
# B0W label: journal:work:intent, written right before begin_draining (it may or may not have run): recovery is quiet, the cloud row is still active,
#   but progress is `held` + op id and status raises SWITCH_CLOUD_NOT_RELEASED (work.rs proves_never_drained is false at (Work, Intent)).
# CLEAN FAILURES (exit 41, everything undone, the cloud released): after the matrix, two real failed runs. (1) the photo importer exits 61 (the fake
#   storage endpoint of lib-cloud-storage-stub.ps1 answers 500 for one object): exit 41, cloud active, progress released, local intact. (2) the test hook
#   fail_at=verify_live (the only fail hook of the switch): exit 41 after the swap, the swap is undone, the failed database is kept (pos_failed_*).
#   The reasons of both are recorded (Info), not asserted: the code is the plan's, the reason text is the product's.
# Owner ruling (Alt 2): recovery of a B0 label (strictly before Work) records progress `released` (work.rs verify_after_rollback, never_drained), so status raises NO
#   SWITCH_CLOUD_NOT_RELEASED. B1/BW/M (the cloud was or may have been touched) keep `held` + alert / unknown.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
. C:\scenarios\lib-cloud-storage-stub.ps1
function Reset-ForCleanFailure {
  Reset-Store
  [void](Start-FakeTill $script:TillA 'till-a' 'quiet')
  Check '53 setup: the fake till reported to the cloud' $true (Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 90 1)
}
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $all = Assert-LabelTable '53'
  $labels = @($all | Where-Object { (Get-SwitchLabelClass $_) -in @('B0', 'B0W') })
  Check '53 the B0 + B0W label count' 10 $labels.Count
  Invoke-SwitchKillMatrix $labels '53'
  # ---- clean failure 1: the photo importer fails (exit 61) -> the whole switch is undone, exit 41, failed database kept ---------------------------
  Reset-ForCleanFailure
  $pre = Get-SwitchSnapshot
  [void](Start-CloudStorageStub)
  $objs = Add-StubCloudPhotos 2
  Set-StubFailing @($objs[0].Key)
  $r = Invoke-Switch 'run' @('--wait-minutes', '1') -Stdin (Get-CloudStdin -WithStorage) -Tag '53-photos-fail'
  Assert-Exit '53 photos: importer exit 61 makes the switch fail cleanly' $r 'SWITCH_FAILED_ROLLED_BACK'
  Info '53 photos: failure reason' ([string]$r.json.data.reason)
  Check '53 photos: the stub answered 500 for the failing object at least once (the importer retries up to 3 times)' $true (@((Get-StubRequests) | Where-Object { $_ -eq "GET /storage/v1/object/authenticated/$($objs[0].Key) 500" }).Count -ge 1)
  Check '53 photos: the cloud was given back (active, no operation)' 'active' (Get-CloudStateWord)
  Check '53 photos: progress cloud is released' 'released' ([string](Get-SwitchProgress).cloud)
  # the photo import runs inside verify_live, after the swap: the rollback swaps back and keeps the failed database (pos_failed_*)
  Assert-LocalIntact '53 photos' $pre -KeepFailedDb
  Stop-CloudStorageStub
  Stop-FakeTills

  # ---- clean failure 2: verify_live fails after the swap -> swap undone, exit 41, failed database kept ----------------------
  Reset-ForCleanFailure
  $pre = Get-SwitchSnapshot
  $r = Invoke-Switch 'run' @('--wait-minutes', '1') (Sw-Hooks @{ fail_at = 'verify_live' }) -Tag '53-verify-live-fail'
  Assert-Exit '53 verify_live failure: the switch fails cleanly' $r 'SWITCH_FAILED_ROLLED_BACK'
  Info '53 verify_live failure: reason' ([string]$r.json.data.reason)
  Check '53 verify_live failure: the cloud was given back (active, no operation)' 'active' (Get-CloudStateWord)
  Check '53 verify_live failure: progress cloud is released' 'released' ([string](Get-SwitchProgress).cloud)
  Check '53 verify_live failure: the failed database is kept' 1 @((Get-DbNames) | Where-Object { $_ -like 'pos_failed_*' }).Count
  Assert-LocalIntact '53 verify_live failure' $pre -KeepFailedDb
  Stop-FakeTills
  Assert-NoSecrets '53 clean failures'
  Assert-NoCloudSecrets '53 clean failures' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
