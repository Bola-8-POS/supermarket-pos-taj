# 72 - a migration that is clean but drops a grant (variant new-grant-drop; Plan 07 Task 11). The manifest carries the digest of the INTENDED catalog (harvested
# by scenario 69, FR10: the pack is rebuilt and re-signed on the host, never edited here). The clone's catalog differs: exit 14 CATALOG_MISMATCH BEFORE the swap. The scenario PROVES the declared digest is the real harvested base one and the failure is the tamper, not a stale or wrong-base digest (Test-MismatchPackIntent).
# (The verify-live failure needs the intended pack and is scenario 83; a Sandbox can install only one variant of a version.)
# Estimated 10 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new-grant-drop'
  $pre = New-PreSnapshot
  $digest0 = Get-CatalogDigest 'postgres'
  $m = Get-Content (Join-Path $script:Prog "packs\$($script:NewV)\manifest.json") -Raw | ConvertFrom-Json
  # PROOF CHAIN for 'the declared digest is the REAL base digest' (installed new-grant-drop and packs.json 'new' share ONE harvested value, so this is not an independent
  # read): 69 harvests the base digest d and proves the revoke changes it; 70 C0 (same packs.json, same staging run) proves the clone of the unmodified 'new' pack computes it;
  # the SQL binding (Assert-PackSqlCurrent) and the base binding (baseManifestSha256, New-TestPacks) tie packs.json to that harvest. 72 adds: not a placeholder, equals
  # the 'new' pack's value, and the only difference to 'new' is the revoke migration.
  $sqlErr = ''; try { Assert-PackSqlCurrent '72' } catch { $sqlErr = $_.Exception.Message }   # FR15b like 70 C0
  Check '72 pre: the packs were built from the catalog-digest.sql this run digests with' '' $sqlErr
  $pjAll = Get-Content (Join-Path $script:PackSrc 'packs.json') -Raw | ConvertFrom-Json; $pj = @($pjAll)   # 5.1: assign first, then wrap
  $eNew = $pj | Where-Object { $_.name -eq 'new' } | Select-Object -First 1
  $eGd = $pj | Where-Object { $_.name -eq 'new-grant-drop' } | Select-Object -First 1
  $real = ''; if ($eNew -and -not [bool]$eNew.digestIsPlaceholder) { $real = [string]$eNew.catalogDigest }   # the base digest scenario 69 harvested; 70 C0 proves the clone computes it
  $isPh = $true; if ($eGd) { $isPh = [bool]$eGd.digestIsPlaceholder }
  $i0 = Test-MismatchPackIntent ([string]$m.catalog.digest) $isPh $real 'CATALOG_MISMATCH'
  Check '72 the installed manifest declares the REAL harvested base digest (not a placeholder, not another base''s)' 'ok' $i0.Why
  # the control: the ONLY difference to the passing pack 'new' is the tampered migration (one more migration, the revoke), same digest
  $ngd = [int]$m.migrations.count; $nn = 0; if ($eNew) { $nn = [int]$eNew.migrations.count }   # the installed manifest, not packs.json
  Check '72 control: the pack has exactly one migration more than the passing pack new (the tamper)' ($nn + 1) $ngd
  Check '72 control: ... and it is the revoke migration' $true (Test-Path (Join-Path $script:Prog "packs\$($script:NewV)\migrations\99990101000001_s7_revoke.sql"))
  # 72 fences like 71 (the catalog check runs on the clone, inside the fence), so it polls the LAN the same way: FR18
  $poll = Join-Path $script:OutDir 'poll72.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '72' $poll
  $r = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u72'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-Exit '72 a dropped grant is caught before the swap' $r 'MIGRATION_FAILED' 'CATALOG_MISMATCH'
  $dbs = Get-DbNames
  Check '72 the clone was dropped' $false ($dbs -contains 'pos_next')
  Check '72 nothing was swapped (no pos_prev_*, no pos_failed_*)' 0 @($dbs | Where-Object { $_ -like 'pos_prev_*' -or $_ -like 'pos_failed_*' }).Count
  Assert-ConsistentStore '72 after catalog mismatch' $false @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows; AuthLevel = $pre.AuthLevel }
  Check '72 the live catalog is byte-for-byte the pre-update digest' $digest0 (Get-CatalogDigest 'postgres')
  Check '72 still the OLD level' $script:OldV ([string](Get-Cfg).pack.current)
  Assert-UpdateResult '72' 'rolled_back' 'MIGRATION_FAILED' $script:NewV
  Check '72 update-result keeps the reason' 'CATALOG_MISMATCH' ([string](Get-UpdateResult).lastReason)
  Assert-RollbackFenceWindow '72 fence window' $poll
  Assert-NoSecrets '72'
  return @{ Results = (Get-Results); Reboot = $false }
}
