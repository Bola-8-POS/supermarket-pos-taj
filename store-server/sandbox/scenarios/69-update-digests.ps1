# 69 - Step 0 of the update scenarios (Plan 07 Task 11): harvest what only a running database can tell.
#  Fresh provision with the BASE pack, then
#   - GoTrue max(version) of auth.schema_migrations -> out\gotrue-max.txt, and it must equal the packs' gotrueMigrationsMax for the base level (FR10: 20260831180000);
#   - the catalog digest of the migrated base database -> out\catalog-digests.json {variant: digest}, the file New-TestPacks.ps1 -DigestsFile consumes.
# Variants whose INTENDED catalog is the base catalog (new, new-auth, new-grant-drop, new-data-*, new-fail-migration) share the base digest ON PURPOSE (the product
# compares the clone, migrated with the pack's own steps, against that declared digest); old / old-auth are never a target of an update, so they keep their
# placeholder. FR13: the checks below prove each variant's own migration has the effect that makes that sharing right. The packs are never edited here; the
# host rebuilds and re-signs them (one key K).
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  $p = Provision-Fresh 'C:\out\r69.json' '69-provision'
  Check '69 provision with the base pack exits 0' 0 $p.Result.Exit
  if ($p.Result.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }

  $max = (Psql 'postgres' 'SELECT max(version) FROM auth.schema_migrations').Trim()
  [IO.File]::WriteAllText((Join-Path $script:OutDir 'gotrue-max.txt'), $max + "`n")
  $packs = Get-Content (Join-Path $script:PackSrc 'packs.json') -Raw | ConvertFrom-Json
  $newEntry = @($packs) | Where-Object { $_.name -eq 'new' } | Select-Object -First 1
  Check '69 packs.json lists the base-level pack (new)' $true ($newEntry -ne $null)
  $want = ''; if ($newEntry) { $want = [string]$newEntry.gotrueMigrationsMax }
  Check '69 GoTrue max(version) equals the packs gotrueMigrationsMax for the base level' $want $max
  Check '69 ... and is the FR10 value' $script:AuthNewMax $max
  $oldAuth = @($packs) | Where-Object { $_.name -eq 'old-auth' } | Select-Object -First 1
  Check '69 the old-auth pack is one GoTrue migration behind' $script:AuthOldMax ([string]$oldAuth.gotrueMigrationsMax)

  # FR14 (A): every update scenario installs its old store with Install-OldStore, which adds public.s7_marker to the LIVE database; the update's clone carries it, and
  # catalog-digest.sql covers every public relation. Run 3 harvested the digest WITHOUT it, so the correct update to new-auth ended in CATALOG_MISMATCH (exit 14).
  # The declared digest is what a correct update produces on the clone: harvest it with the marker present, created by the very function Install-OldStore calls.
  Add-S7Marker
  Check '69 the marker table exists before the digests are harvested' '1' (Psql 'postgres' "SELECT count(*) FROM pg_class WHERE relname = 's7_marker' AND relnamespace = 'public'::regnamespace")
  $d = Get-CatalogDigest 'postgres'
  $d2 = Get-CatalogDigest 'postgres'
  Check '69 the catalog digest is 64 hex characters' $true ($d -match '^[0-9a-f]{64}$')
  Check '69 the second read is 64 hex characters too' $true ($d2 -match '^[0-9a-f]{64}$')
  # FR11: two identical ERROR lines used to satisfy the determinism check; it only means something once both reads are digests
  if (($d -notmatch '^[0-9a-f]{64}$') -or ($d2 -notmatch '^[0-9a-f]{64}$')) {
    Add-Check '69 the digest is deterministic (two reads agree)' 'two 64-hex digests that agree' "not evaluated: a read was not a digest: [$d] [$d2]" $false
    return @{ Results = (Get-Results); Reboot = $false }
  }
  Check '69 the digest is deterministic (two reads agree)' $d $d2
  foreach ($v in 'new', 'new-auth', 'new-grant-drop', 'new-data-change', 'new-data-loss', 'new-fail-migration') { Save-CatalogDigest $v $d }
  Save-CatalogLines 'postgres' 'catalog-lines-base.txt'   # evidence for a line diff against the hooks exe's clone dump if a mismatch ever comes back
  $f = Join-Path $script:OutDir 'catalog-digests.json'
  $j = Get-Content $f -Raw | ConvertFrom-Json
  Check '69 catalog-digests.json records the sha256 of the catalog-digest.sql it was computed from' (Get-PackSqlSha256) ([string]$j.sqlSha256)
  Check '69 catalog-digests.json carries 6 variants' 6 @($j.PSObject.Properties | Where-Object { $_.Name -ne 'sqlSha256' }).Count
  Check '69 gotrue-max.txt written' $max ((Get-Content (Join-Path $script:OutDir 'gotrue-max.txt') -Raw).Trim())

  # FR13: identical digests are right ONLY because every target variant's INTENDED catalog is the base catalog (work.rs verify_clone digests the clone after
  # the pack's own steps and compares it with the manifest). Prove each variant's own migration does what the table in task-11-results.md says, so a
  # grant-drop that stopped changing the catalog (scenario 72 would then pass the wrong way) or a data migration that started to change it fails HERE.
  #   new-grant-drop      declared = base digest, the clone's digest after its revoke must DIFFER  (72: CATALOG_MISMATCH)
  #   new-data-change/loss the delete is data only: catalog before == after                        (84/85 must not trip CATALOG_MISMATCH)
  #   new-fail-migration  SELECT 1/0 aborts before the digest is ever read: nothing to compare
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $catSql = (Join-Path $script:PackSrc 'catalog-digest.sql') -replace '\\', '/'
  foreach ($e in @(@{ v = 'new-grant-drop'; relation = 'differs' }, @{ v = 'new-data-change'; relation = 'same' }, @{ v = 'new-data-loss'; relation = 'same' })) {
    $z = [IO.Compression.ZipFile]::OpenRead((Join-Path $script:PackSrc ($e.v + '.pospack')))
    $mig = @(); try { $mig = @($z.Entries | Where-Object { $_.FullName -match '^migrations/9999\d+_.*\.sql$' } | ForEach-Object { $t = Join-Path $env:TEMP ('s7-' + $_.Name); [IO.Compression.ZipFileExtensions]::ExtractToFile($_, $t, $true); $t -replace '\\', '/' }) } finally { $z.Dispose() }
    Check "69 $($e.v) : the pack ships its own migration(s)" $true ($mig.Count -ge 1)
    if ($mig.Count -lt 1) { continue }
    $sc = @('BEGIN;')   # the marker table the data variants delete from already exists (Add-S7Marker above), exactly as in a real run
    $sc += "\i $catSql"; foreach ($m in $mig) { $sc += "\i $m" }; $sc += "\i $catSql"; $sc += 'ROLLBACK;'
    $sf = Join-Path $env:TEMP ('s7-effect-' + $e.v + '.sql'); [IO.File]::WriteAllText($sf, ($sc -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $env:PGPASSFILE = Join-Path $script:Data 'secrets\pgpass.conf'
    $o = & (Get-PsqlExe) -w -X -q -A -t -h 127.0.0.1 -p (Get-Cfg).ports.base -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f $sf 2>&1
    $pc = $LASTEXITCODE; $ptxt = (($o | ForEach-Object { "$_" }) -join "`n").Trim()
    if ($pc -ne 0 -or -not $ptxt) { throw "69 $($e.v) : the before/after digest script failed (psql exit $pc, output empty: $(-not $ptxt)): $ptxt" }
    $hex = @($o | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^[0-9a-f]{64}$' })
    Check "69 $($e.v) : read the catalog digest before and after its migration" 2 $hex.Count
    if ($hex.Count -ne 2) { continue }
    if ($e.relation -eq 'differs') {
      Check "69 $($e.v) : its migration CHANGES the catalog (digest differs from the declared base digest)" $true ($hex[1] -ne $d)
      Check "69 $($e.v) : ... and the pre-migration digest is the base digest the manifest will declare" $d $hex[0]
    } else {
      Check "69 $($e.v) : its migration leaves the catalog unchanged (data only)" $hex[0] $hex[1]
    }
    Remove-Item $sf -Force -ErrorAction SilentlyContinue
    foreach ($m in $mig) { Remove-Item ($m -replace '/', '\') -Force -ErrorAction SilentlyContinue }
  }
  Assert-NoSecrets '69' $false
  return @{ Results = (Get-Results); Reboot = $false }
}
