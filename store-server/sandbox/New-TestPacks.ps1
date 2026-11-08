<#
.SYNOPSIS
  Host side, file work only (no Postgres, no service): builds the signed test packs of the update scenarios into <Out> (default payload\packs).
.DESCRIPTION
  Starts from the unpacked pack of Plan 04 (-BasePackDir, or POS_PACK_DIR, or the one stage-payload.ps1 staged) and writes, for each variant, a
  folder under <Out>\..\packs-work, a manifest with packVersion / appVersion / catalog.digest / gotrueMigrationsMax / dataChanges, and a .pospack
  signed with a THROWAWAY minisign key (tests\fixtures\sign-pack.ps1, the same signer stage-payload.ps1 uses; the private key lives in a temp folder
  and is deleted, only test-pubkey.txt is written next to the packs).

    old / new                  1.0.0-r1 (base minus its newest 3 migrations) / 1.0.1-r1 (the whole base)
    new-fail-migration         new + a migration that always fails                       (rollback before the swap)
    new-grant-drop             new + a migration that revokes a grant                    (the clone's post-migration digest differs from the declared base digest; CATALOG_MISMATCH; scenario 72)
    new-data-change / new-data-loss   new + a migration that deletes public.s7_marker, declared / not declared in dataChanges
    old-auth / new-auth        the pair that raises the GoTrue level: gotrueMigrationsMax 20260824000001 -> 20260831180000 (Set-AuthLevelLow in lib-update.ps1);
                               both ship the same GoTrue 2.197.0 binary and say so in components.gotrue

  catalog.digest: it is a sha256 over the catalog of a MIGRATED DATABASE (src\update\catalog-digest.sql), so it can only be computed where a
  database runs. TWO PASSES, and the pack is never edited after it is signed (start/status/health re-verify the signature on every load,
  so an edited installed pack fails PACK_INVALID):
    pass 1  no -DigestsFile: every pack gets a well-formed placeholder; digestIsPlaceholder = true in packs.json. A Sandbox run
            computes the real values (Get-CatalogDigest) and records them (Save-CatalogDigest -> <run>\out\catalog-digests.json).
    pass 2  -DigestsFile <that file>: the same packs are rebuilt with the real digests and SIGNED AGAIN; digestIsPlaceholder = false.
  ONE key K per staging run: stage-payload.ps1 creates it in -KeyDir (host temp, never in the payload) and this script only REUSES it (it
  refuses to run without it), for the first build and for the -DigestsFile rebuild after scenario 69. K is deleted only with -CleanupKey on the
  last call. test-pubkey.txt is written once, from K. Order: build exes, stage-payload (K), New-TestPacks (K), run 69, New-TestPacks
  -DigestsFile (K, -CleanupKey), run 70+. Test-only key: never a production key, never committed. Windows PowerShell 5.1 compatible.
  FR13 ownership: this script only creates or overwrites <name>.pospack (8 variants), packs.json, catalog-digest.sql, test-pubkey.txt in <Out>, and
  deletes only its own scratch folder <Out>\..\packs-work. It never wipes <Out>; other files there (and the payload root) are not its to touch.
#>
param(
  [string]$BasePackDir = '',
  [string]$Out = 'E:\tmp\two-mode-sandbox\payload\packs',
  [string]$RepoRoot = '',
  [string]$KeyDir = (Join-Path ([IO.Path]::GetTempPath()) 'pos-two-mode-sign-key'),   # the ONE key K that stage-payload.ps1 created for this staging run
  [switch]$CleanupKey,   # delete K after signing (the LAST New-TestPacks call of a staging run)
  [string]$DigestsFile = ''   # catalog-digests.json harvested in the Sandbox (lib-update.ps1 Save-CatalogDigest): {variant: 64-hex digest}
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $BasePackDir) { $BasePackDir = $env:POS_PACK_DIR }
if (-not $BasePackDir) { $BasePackDir = 'E:\tmp\two-mode-sandbox\payload\pack\0.0.0-r1' }
$BasePackDir = (Resolve-Path $BasePackDir).Path.TrimEnd('\')
if (-not (Test-Path (Join-Path $BasePackDir 'manifest.json'))) { throw "No pack at $BasePackDir" }
$sign = Join-Path $here '..\tests\fixtures\sign-pack.ps1'
$catalogSql = Join-Path $here '..\src\update\catalog-digest.sql'
if (-not (Test-Path $sign)) { throw "sign-pack.ps1 not found at $sign" }
if (-not (Test-Path $catalogSql)) { throw "catalog-digest.sql not found at $catalogSql" }
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path.TrimEnd('\')
$work = Join-Path (Split-Path -Parent $Out) 'packs-work'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory $work | Out-Null
if (-not (Test-Path (Join-Path $KeyDir "signer.key"))) { throw "No signing key K in ${KeyDir}: run stage-payload.ps1 first (one key per staging run; this script never creates one)" }
$signPub = Join-Path ([IO.Path]::GetTempPath()) ("s7packs-pub-" + [Guid]::NewGuid().ToString("N") + ".txt")
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sqlBytes = [IO.File]::ReadAllBytes($catalogSql)
$sha = [Security.Cryptography.SHA256]::Create()
# FR15b: same rule as lib-update.ps1 Assert-CatalogSqlHash (kept in step with it): digests harvested from another catalog-digest.sql must never be baked into packs.
function Assert-CatalogSqlHash([string]$Recorded, [string]$Actual, [string]$Context) {
  $r = ([string]$Recorded).Trim().ToLower(); $a = ([string]$Actual).Trim().ToLower()
  if ($r -notmatch '^[0-9a-f]{64}$') { throw "$Context : no sqlSha256 was recorded; the digests were harvested without it (re-run scenario 69 with this library)" }
  if ($r -ne $a) { throw "$Context : catalog-digest.sql is $a but the digests were built from $r; re-stage, re-run 69, rebuild the packs" }
}
function Get-Hex([byte[]]$b) { return (($sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join '') }
# Same text as lib-update.ps1 Assert-DigestsBoundToBase (a host test holds them equal): the digests must come from THIS base pack, not just from this SQL.
function Assert-DigestsBoundToBase($Digests, [string]$BaseManifestSha256, [string]$Context) {
  $rec = ''; if ($Digests -and $Digests.PSObject.Properties['baseManifestSha256']) { $rec = ([string]$Digests.baseManifestSha256).Trim().ToLower() }
  $act = ([string]$BaseManifestSha256).Trim().ToLower()
  if ($rec -notmatch '^[0-9a-f]{64}$') { throw "$Context : the digests file carries no baseManifestSha256 (legacy file, harvested without a base binding); re-harvest it with scenario 69, then rebuild the packs" }
  if ($rec -ne $act) { throw "$Context : the digests were harvested from base manifest $rec but -BasePackDir has $act; re-run scenario 69 against this base, then rebuild the packs" }
}
Copy-Item $catalogSql (Join-Path $Out 'catalog-digest.sql') -Force

$base = [IO.File]::ReadAllText((Join-Path $BasePackDir 'manifest.json'), $utf8).TrimStart([char]0xFEFF) | ConvertFrom-Json
$digests = $null
if ($DigestsFile) { $digests = [IO.File]::ReadAllText((Resolve-Path $DigestsFile).Path, $utf8).TrimStart([char]0xFEFF) | ConvertFrom-Json }
$sqlSha = Get-Hex $sqlBytes
if ($digests) { Assert-CatalogSqlHash ([string]$digests.sqlSha256) $sqlSha "-DigestsFile $DigestsFile" }
if ($digests) { Assert-DigestsBoundToBase $digests (Get-Hex ([IO.File]::ReadAllBytes((Join-Path $BasePackDir 'manifest.json')))) "-DigestsFile $DigestsFile" }
$GotrueOld = '20260824000001'; $GotrueNew = '20260831180000'   # the newest two migrations of the GoTrue 2.197.0 the packs ship

$specs = @(
  @{ name = 'old';                packVersion = '1.0.0-r1'; appVersion = '1.0.0'; drop = 3; add = @();                                                                   gotrue = '2.197.0'; gmax = $GotrueNew; data = @() },
  @{ name = 'new';                packVersion = '1.0.1-r1'; appVersion = '1.0.1'; drop = 0; add = @();                                                                   gotrue = '2.197.0'; gmax = $GotrueNew; data = @() },
  @{ name = 'new-fail-migration'; packVersion = '1.0.1-r1'; appVersion = '1.0.1'; drop = 0; add = @(,@('99990101000000_s7_fail.sql', 'SELECT 1/0;'));                   gotrue = '2.197.0'; gmax = $GotrueNew; data = @() },
  @{ name = 'new-grant-drop';     packVersion = '1.0.1-r1'; appVersion = '1.0.1'; drop = 0; add = @(,@('99990101000001_s7_revoke.sql', 'REVOKE ALL ON TABLE public.products FROM anon;')); gotrue = '2.197.0'; gmax = $GotrueNew; data = @() },
  @{ name = 'new-data-change';    packVersion = '1.0.1-r1'; appVersion = '1.0.1'; drop = 0; add = @(,@('99990101000002_s7_delete_marker.sql', 'DELETE FROM public.s7_marker;')); gotrue = '2.197.0'; gmax = $GotrueNew; data = @(@{ table = 'public.s7_marker'; kind = 'delete' }) },
  @{ name = 'new-data-loss';      packVersion = '1.0.1-r1'; appVersion = '1.0.1'; drop = 0; add = @(,@('99990101000002_s7_delete_marker.sql', 'DELETE FROM public.s7_marker;')); gotrue = '2.197.0'; gmax = $GotrueNew; data = @() },
  @{ name = 'old-auth';           packVersion = '1.0.0-r1'; appVersion = '1.0.0'; drop = 3; add = @();                                                                   gotrue = '2.197.0'; gmax = $GotrueOld; data = @() },   # label = the binary actually shipped (2.197.0); only gotrueMigrationsMax differs
  @{ name = 'new-auth';           packVersion = '1.0.1-r1'; appVersion = '1.0.1'; drop = 0; add = @();                                                                   gotrue = '2.197.0'; gmax = $GotrueNew; data = @() }
)

# functions.exe carries its pack version (/_store/health reports it), so each DISTINCT version is compiled once, serially, into packs-work\fn-<v>.exe.
$cli = (Resolve-Path (Join-Path $here '..\pack\build\cli.mjs')).Path
$fnExes = @{}
foreach ($v in @($specs | ForEach-Object { $_.packVersion } | Sort-Object -Unique)) {
  $fnExes[$v] = Join-Path $work "fn-$v.exe"
  & node $cli functions --pack-version $v --out $fnExes[$v]
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $fnExes[$v])) { throw "node cli.mjs functions --pack-version $v failed ($LASTEXITCODE)" }
}

$index = @()
try {
  foreach ($s in $specs) {
    $dir = Join-Path $work $s.name
    & robocopy $BasePackDir $dir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) for $($s.name)" }
    $mdir = Join-Path $dir 'migrations'
    $files = New-Object System.Collections.ArrayList
    foreach ($f in $base.files) { [void]$files.Add($f) }
    # functions.exe is rebuilt per pack version (before signing, so K's signature covers it); the files list then changes by that entry
    # plus the dropped/added migrations below (every other hash is the base's)
    $fnTarget = Join-Path $dir 'bin\functions.exe'
    Copy-Item $fnExes[$s.packVersion] $fnTarget -Force
    $fe = @($files | Where-Object { $_.path -eq 'bin/functions.exe' })[0]
    if (-not $fe) { throw 'the base manifest has no bin/functions.exe entry' }
    $fnClone = [pscustomobject]@{ path = $fe.path; sha256 = (Get-FileHash $fnTarget -Algorithm SHA256).Hash.ToLower(); size = (Get-Item $fnTarget).Length }
    $files = [System.Collections.ArrayList]@($files | ForEach-Object { if ($_.path -eq 'bin/functions.exe') { $fnClone } else { $_ } })
    $dropped = @()
    if ($s.drop -gt 0) {
      $dropped = @(Get-ChildItem $mdir -Filter *.sql | Sort-Object Name | Select-Object -Last $s.drop)
      foreach ($d in $dropped) {
        $rel = 'migrations/' + $d.Name
        $files = [System.Collections.ArrayList]@($files | Where-Object { $_.path -ne $rel })
        Remove-Item $d.FullName
      }
    }
    foreach ($a in $s.add) {
      $p = Join-Path $mdir $a[0]
      [IO.File]::WriteAllText($p, $a[1] + "`n", $utf8)
      $b = [IO.File]::ReadAllBytes($p)
      [void]$files.Add([pscustomobject]@{ path = 'migrations/' + $a[0]; sha256 = (Get-Hex $b); size = $b.Length })
    }
    $sql = @(Get-ChildItem $mdir -Filter *.sql | Sort-Object Name)
    $m = [IO.File]::ReadAllText((Join-Path $BasePackDir 'manifest.json'), $utf8).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $m.packVersion = $s.packVersion; $m.appVersion = $s.appVersion
    $m.migrations.count = $sql.Count
    $m.migrations.max = ($sql | Select-Object -Last 1).Name.Split('_')[0]
    $m.components.gotrue = $s.gotrue
    $m.files = @($files)
    $isPlaceholder = $true
    $digest = Get-Hex ($sqlBytes + $utf8.GetBytes('|' + $s.name + '|' + $m.migrations.count + '|' + $m.migrations.max))
    if ($digests -and $digests.PSObject.Properties[$s.name]) {
      $digest = ([string]$digests.($s.name)).Trim().ToLower(); $isPlaceholder = $false
      if ($digest -notmatch '^[0-9a-f]{64}$') { throw "digest for $($s.name) in $DigestsFile is not 64 hex characters" }
    }
    $m | Add-Member -NotePropertyName catalog -NotePropertyValue ([pscustomobject]@{ digest = $digest }) -Force
    $m | Add-Member -NotePropertyName gotrueMigrationsMax -NotePropertyValue $s.gmax -Force
    $m | Add-Member -NotePropertyName dataChanges -NotePropertyValue @($s.data | ForEach-Object { [pscustomobject]$_ }) -Force
    [IO.File]::WriteAllText((Join-Path $dir 'manifest.json'), ($m | ConvertTo-Json -Depth 20), $utf8)
    if (Test-Path (Join-Path $dir 'manifest.json.minisig')) { Remove-Item (Join-Path $dir 'manifest.json.minisig') }
    $zip = Join-Path $Out ($s.name + '.pospack')
    $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sign, '-PackDir', $dir, '-OutZip', $zip, '-OutPub', $signPub, '-KeyDir', $KeyDir)
    if ($RepoRoot) { $args2 += @('-RepoRoot', $RepoRoot) }
    & powershell.exe @args2 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sign-pack.ps1 failed for $($s.name)" }
    Remove-Item $dir -Recurse -Force
    $zh = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    $index += [pscustomobject]@{ name = $s.name; file = ($s.name + '.pospack'); bytes = (Get-Item $zip).Length; zipSha256 = $zh; packVersion = $s.packVersion; appVersion = $s.appVersion
      migrations = [pscustomobject]@{ count = $m.migrations.count; max = $m.migrations.max }; gotrueMigrationsMax = $s.gmax; dataChanges = @($s.data); catalogDigest = $digest; catalogSqlSha256 = $sqlSha; digestIsPlaceholder = $isPlaceholder }
  }
  # test-pubkey.txt is written ONCE, from K's public half, and must be the key stage-payload.ps1 staged next to the exes
  Copy-Item (Join-Path $KeyDir 'signer.key.pub') (Join-Path $Out 'test-pubkey.txt') -Force
  $staged = Join-Path (Split-Path -Parent $Out) 'test-pubkey.txt'
  if ((Test-Path $staged) -and ((Get-Content $staged -Raw).Trim() -ne (Get-Content (Join-Path $Out 'test-pubkey.txt') -Raw).Trim())) { throw "the packs are signed with a key that is not the one stage-payload.ps1 staged ($staged): stage again, then rebuild the packs" }
} finally {
  Remove-Item $signPub -Force -ErrorAction SilentlyContinue
  if ($CleanupKey) { Remove-Item $KeyDir -Recurse -Force -ErrorAction SilentlyContinue }   # K only goes when the staging run is over
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
[IO.File]::WriteAllText((Join-Path $Out 'packs.json'), ($index | ConvertTo-Json -Depth 6), $utf8)
$index | ForEach-Object { [pscustomobject]@{ Name = $_.file; Length = $_.bytes; PackVersion = $_.packVersion; GotrueMax = $_.gotrueMigrationsMax; DataChanges = @($_.dataChanges).Count; Digest = $_.catalogDigest.Substring(0, 8) } } | Format-Table -AutoSize
Write-Host "wrote $($index.Count) packs and test-pubkey.txt, catalog-digest.sql, packs.json to $Out"
