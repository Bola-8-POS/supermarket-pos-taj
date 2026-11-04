# 72 - a migration that is clean but drops a grant (variant new-grant-drop; Plan 07 Task 11). The manifest carries the digest of the INTENDED catalog (harvested
# by scenario 69, FR10: the pack is rebuilt and re-signed on the host, never edited here). The clone's catalog differs: exit 14 CATALOG_MISMATCH BEFORE the swap.
# (The verify-live failure needs the intended pack and is scenario 83; a Sandbox can install only one variant of a version.)
# Estimated 10 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new-grant-drop'
  $pre = New-PreSnapshot
  $digest0 = Get-CatalogDigest 'postgres'
  $m = Get-Content (Join-Path $script:Prog "packs\$($script:NewV)\manifest.json") -Raw | ConvertFrom-Json
  Check '72 the manifest carries a real (not placeholder) digest: it equals the harvested base digest' $true ([string]$m.catalog.digest -match '^[0-9a-f]{64}$')
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
