<#
.SYNOPSIS
  Host side: stage the Windows Sandbox payload outside the repo (conventions section 13).
.DESCRIPTION
  Builds posctl.exe (release), posctl-test-hooks.exe (--features test-hooks, separate target dir; Task 4 ruling C1),
  signs the pack with a THROWAWAY key (tests\fixtures\sign-pack.ps1; only the public key is staged) and builds the posctl unit-test executables (cargo test --no-run --release --target-dir target\sandbox-tests),
  copies them and a built backend pack to E:\tmp\two-mode-sandbox\payload and writes payload.json.
  Windows PowerShell 5.1 compatible. Never installs, provisions or touches ProgramData/Program Files.

  RUN ORDER of one staging run (ONE signing key K for all of it; Plan 07 Task 11 addendum):
    1. build the exes            cargo build --release / --features test-hooks (this script does it unless -SkipBuild).
                                 The sha256 of both shipped exes is pinned right after; the unit-test exes build into target\sandbox-tests (FR12), so the
                                 shipped posctl.exe is never rebuilt, and staging refuses if a payload copy differs from the pin.
    2. stage (creates key K)     stage-payload.ps1                       K lives in -KeyDir (a HOST temp folder, never in the payload)
    3. New-TestPacks (K)         New-TestPacks.ps1 -BasePackDir <pack>   signs the 8 variants with K, placeholder catalog digests
    4a. run scenario 68 FIRST    run-scenario.ps1 -Id 68                 the SQL smoke (FR11): every SQL the product sends, run against a real Postgres.
                                                                         It is the first scenario of EVERY run: a real-Postgres SQL error stops the run here,
                                                                         before the scenarios whose assertions need that SQL to work.
    4b. run scenario 69          run-scenario.ps1 -Id 69                 writes <run>\out\catalog-digests.json
    5. New-TestPacks -DigestsFile <that file>  (K again)                  rebuilds and RE-SIGNS the packs with the real digests
    6. re-stage packs only       (step 5 already wrote payload\packs; do NOT run stage-payload again without -ReuseKey)
    7. run scenarios 70+         run-scenario.ps1 -Id 70 ...
  K is deleted only by `New-TestPacks.ps1 -CleanupKey` after the last step, or by hand. A second stage-payload run (without -ReuseKey)
  generates a NEW K, wipes payload\packs, and so invalidates every pack from an earlier run: start again from step 3.
  K is never written into the payload directory (FR10). At the start of every staging run only the generated files of payload\packs are removed
  (*.pospack, packs.json, catalog-digest.sql, test-pubkey.txt); nothing else is deleted (FR13). So stage BEFORE New-TestPacks, never after it.
#>
param(
  [string]$Crate = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..'),
  [string]$PackDir = 'E:\tmp\two-mode-sandbox\base-pack-caddy2117\pack-0.0.0-r1',   # FR14: the 04b test pack with the repo's pinned Caddy (sandbox\Prepare-BasePack.ps1 builds it)
  [string]$PayloadDir = 'E:\tmp\two-mode-sandbox\payload',
  [string]$AllowedRoot = 'E:\tmp\two-mode-sandbox\payload',   # PayloadDir must be this folder or below it
  [string]$KeyDir = (Join-Path ([IO.Path]::GetTempPath()) 'pos-two-mode-sign-key'),   # the one throwaway signing key K (host temp, outside the payload)
  [switch]$ReuseKey,    # keep an existing K (re-staging within one staging run); default: a fresh K per staging run
  [switch]$SkipBuild,
  [switch]$AllowStale,  # with -SkipBuild: stage even when the built exes are older than HEAD's commit
  [switch]$AllowStalePack   # stage a base pack whose migrations.max is older than the repo's newest migration (deliberately old pack)
)
$ErrorActionPreference = 'Stop'
$allowedRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')
$resolvedPayload = [IO.Path]::GetFullPath($PayloadDir).TrimEnd('\')
if ($resolvedPayload -ne $allowedRoot -and -not $resolvedPayload.StartsWith($allowedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "PayloadDir $resolvedPayload is not under $allowedRoot" }
if ([IO.Path]::GetFullPath($KeyDir).TrimEnd('\').StartsWith($resolvedPayload, [StringComparison]::OrdinalIgnoreCase)) { throw 'KeyDir must not be inside the payload (FR10)' }
$Crate = (Resolve-Path $Crate).Path
if (-not (Test-Path (Join-Path $PackDir 'manifest.json'))) { throw "No pack at $PackDir" }
$manifest = Get-Content (Join-Path $PackDir 'manifest.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.packVersion
if (-not $version) { throw 'manifest.json has no packVersion' }

# Stale-base guard: the pack must carry every migration the repo has (14-digit timestamp prefixes compare as strings).
$repoMax = Get-ChildItem (Join-Path $Crate '..\supabase\migrations') -Filter '*.sql' | ForEach-Object { $_.Name.Split('_')[0] } | Sort-Object | Select-Object -Last 1
$packMax = [string]$manifest.migrations.max
if (-not $AllowStalePack -and $repoMax -and [string]::CompareOrdinal($packMax, [string]$repoMax) -lt 0) {
  throw "Base pack at $PackDir is stale: its migrations.max is $packMax but the repo's newest migration is $repoMax. Rebuild it with store-server/sandbox/Prepare-BasePack.ps1 (or pass -AllowStalePack for a deliberately old pack)."
}

if ($SkipBuild) {
  # -SkipBuild stages whatever is already built: refuse when that predates HEAD or is missing (a stale exe in the Sandbox proves nothing)
  $headTime = $null
  try { $ct = (& git -C $Crate log -1 --format=%ct 2>$null); if ($ct) { $headTime = [DateTimeOffset]::FromUnixTimeSeconds([long]$ct).LocalDateTime } } catch { }
  foreach ($rel in 'target\release\posctl.exe', 'target\hooks\release\posctl.exe') {
    $p = Join-Path $Crate $rel
    if (-not (Test-Path $p)) { throw "-SkipBuild: $p does not exist; build first" }
    $t = (Get-Item $p).LastWriteTime
    $old = Join-Path $PayloadDir ($(if ($rel -like '*hooks*') { 'posctl-test-hooks.exe' } else { 'posctl.exe' }))
    if ((Test-Path $old) -and (Get-Item $old).LastWriteTime -gt $t) { Write-Warning "payload exe $old is NEWER than $p; staging the older build over it" }
    if ($headTime -and $t -lt $headTime -and -not $AllowStale) { throw "-SkipBuild: $p ($t) is older than HEAD's commit ($headTime); rebuild, or pass -AllowStale to stage it anyway" }
  }
}
# one staging run = one key K and an empty payload\packs (a stale pack signed by an earlier K would fail its signature check)
if (-not $ReuseKey -and (Test-Path $KeyDir)) { Remove-Item $KeyDir -Recurse -Force }
New-Item -ItemType Directory -Force $KeyDir | Out-Null
$packsDir = [IO.Path]::GetFullPath((Join-Path $PayloadDir 'packs')).TrimEnd('\')
if (-not $packsDir.StartsWith($allowedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing to wipe $packsDir (not under $allowedRoot)" }
# FR13: remove only what New-TestPacks.ps1 generates (stale packs signed by an earlier K), never a blanket wipe. Anything else in packs\ stays.
# The legacy signed packs, payload.json and caddy-test-root.crt live in the payload ROOT, outside packs\, and are overwritten below, never deleted.
if (Test-Path $packsDir) { Get-ChildItem -LiteralPath $packsDir -File -Force | Where-Object { $_.Name -like '*.pospack' -or $_.Name -in @('packs.json', 'catalog-digest.sql', 'test-pubkey.txt') } | Remove-Item -Force }

Push-Location $Crate
$ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 turns cargo's stderr progress into errors under 'Stop'
try {
  if (-not $SkipBuild) {
    & cargo build --release 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'cargo build --release failed' }
    & cargo build --release --features test-hooks --target-dir target\hooks 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'cargo build --release --features test-hooks failed' }
  }
  # FR12: pin the shipped exes' sha256 BEFORE the test build (with -SkipBuild: the current target exes). Staging refuses if a payload copy differs.
  $pinRelease = (Get-FileHash (Join-Path $Crate 'target\release\posctl.exe') -Algorithm SHA256).Hash
  $pinHooks = (Get-FileHash (Join-Path $Crate 'target\hooks\release\posctl.exe') -Algorithm SHA256).Hash
  # FR12: the unit-test exes go to their OWN target dir; building them in target\release would unify dev-dependency features and REBUILD the shipped posctl.exe
  $json = & cargo test --no-run --release --target-dir target\sandbox-tests --message-format=json 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'cargo test --no-run --release (target\sandbox-tests) failed' }
} finally { Pop-Location; $ErrorActionPreference = 'Stop' }
$tests = @()
foreach ($line in $json) {
  if ($line -notmatch '"executable":"') { continue }
  $o = $line | ConvertFrom-Json
  if ($o.executable -and $o.profile.test) { $tests += $o.executable }
}
if ($tests.Count -eq 0) { throw 'no test executable found' }

New-Item -ItemType Directory -Force $PayloadDir | Out-Null
Copy-Item (Join-Path $Crate 'target\release\posctl.exe') (Join-Path $PayloadDir 'posctl.exe') -Force
Copy-Item (Join-Path $Crate 'target\hooks\release\posctl.exe') (Join-Path $PayloadDir 'posctl-test-hooks.exe') -Force
foreach ($pin in @(@('posctl.exe', $pinRelease), @('posctl-test-hooks.exe', $pinHooks))) {
  $got = (Get-FileHash (Join-Path $PayloadDir $pin[0]) -Algorithm SHA256).Hash
  if ($got -ne $pin[1]) { throw "payload $($pin[0]) sha256 $got differs from the built shipped exe $($pin[1]); the Sandbox would test a different binary" }
}
# Plan 08 T13 AS-3: the escrow-recipient override is a test hook. Static string check on the staged exes (nothing is run): the SHIPPED posctl must carry neither the
# override variable name nor the development escrow recipient; the test-hooks posctl must carry the variable name (so the search is shown to work).
$escName = 'POSCTL_TEST_ESCROW_PUBKEY'
$devKey = [regex]::Match([IO.File]::ReadAllText((Join-Path $Crate '..\scripts\write-escrow-pubkey.mjs')), "DEV_ESCROW_PUBKEY = '(age1[a-z0-9]+)'").Groups[1].Value
if (-not $devKey) { throw 'cannot read DEV_ESCROW_PUBKEY from scripts\write-escrow-pubkey.mjs' }
$relText = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes((Join-Path $PayloadDir 'posctl.exe')))
$hkText = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes((Join-Path $PayloadDir 'posctl-test-hooks.exe')))
if ($relText.Contains($escName)) { throw "the SHIPPED posctl.exe contains ${escName}: the escrow override leaked into a release build" }
if ($relText.Contains($devKey)) { throw 'the SHIPPED posctl.exe contains the development escrow recipient (DEV_ESCROW_PUBKEY)' }
if (-not $hkText.Contains($escName)) { throw "the test-hooks posctl does not contain ${escName}: the scenarios could not issue a recovery key" }
Write-Host "escrow override: absent from the shipped posctl.exe, present in posctl-test-hooks.exe"
Write-Host "payload posctl.exe sha256 $pinRelease (matches target\release); posctl-test-hooks.exe sha256 $pinHooks (matches target\hooks\release)"
# Plan 06 Task 9: the fixture root certificate scenario 30 builds its pairing records from
Copy-Item (Join-Path $Crate 'tests\fixtures\caddy-test-root.crt') (Join-Path $PayloadDir 'caddy-test-root.crt') -Force
$testDir = Join-Path $PayloadDir 'tests'
if (Test-Path $testDir) { Remove-Item $testDir -Recurse -Force }
New-Item -ItemType Directory $testDir | Out-Null
$names = @()
foreach ($t in $tests) {
  $leaf = 'test-' + [IO.Path]::GetFileName($t)
  Copy-Item $t (Join-Path $testDir $leaf)
  $names += $leaf
}
$dest = Join-Path $PayloadDir ('pack\' + $version)
& robocopy $PackDir $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

# signed pack: the ONE throwaway key K lives in -KeyDir (host temp, kept for New-TestPacks, never in the payload); only the public key is staged, once
$sign = Join-Path $Crate 'tests\fixtures\sign-pack.ps1'
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sign -PackDir $PackDir -OutZip (Join-Path $PayloadDir 'pack-ok.pospack') -OutPub (Join-Path $PayloadDir 'test-pubkey.txt') -KeyDir $KeyDir | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'sign-pack.ps1 failed' }
  # Task 10: two STRIPPED packs signed with the same key (manifest only, no files): a lower version, and a higher version whose
  # newest migration is older than the live database. install refuses both on the downgrade / schema-floor rule before it looks at the contents.
  # lowschema must be HIGHER than the base pack (patch + 1), else install hits the downgrade refusal before the schema floor (run 20261105-201900-08)
  if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)-r(\d+)$') { throw "base pack version $version is not X.Y.Z-rN" }
  $higher = '{0}.{1}.{2}-r1' -f $Matches[1], $Matches[2], ([int]$Matches[3] + 1)
  $variants = @(
    @{ out = 'pack-old.pospack'; ver = '0.0.0-r0'; max = [string]$manifest.migrations.max },
    @{ out = 'pack-lowschema.pospack'; ver = $higher; max = '20200101000000' })
  foreach ($v in $variants) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('posctl-stage-var-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $tmp | Out-Null
    try {
      $m = Get-Content (Join-Path $PackDir 'manifest.json') -Raw | ConvertFrom-Json
      $m.packVersion = $v.ver; $m.migrations.max = $v.max; $m.files = @()
      $m | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $tmp 'manifest.json') -Encoding UTF8
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sign -PackDir $tmp -OutZip (Join-Path $PayloadDir $v.out) -OutPub ($tmp + '.pub') -KeyDir $KeyDir | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "sign-pack.ps1 failed for $($v.out)" }
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item ($tmp + '.pub') -Force -ErrorAction SilentlyContinue }
  }
} finally { }   # K (-KeyDir) is kept for New-TestPacks; it is never in the payload

$head = try { (& git -C $Crate rev-parse HEAD 2>$null).Trim() } catch { "" }
if (-not $head) { $head = "not-a-git-checkout (local patch)" }
$meta = [ordered]@{ packVersion = $version; testExes = $names; commit = $head; testHooks = $true; signedPack = 'pack-ok.pospack'; oldPack = 'pack-old.pospack'; lowSchemaPack = 'pack-lowschema.pospack'; schemaMax = [string]$manifest.migrations.max; stagedAt = (Get-Date -Format o) }
$meta | ConvertTo-Json | Set-Content (Join-Path $PayloadDir 'payload.json') -Encoding UTF8
Write-Host "Payload staged at $PayloadDir (pack $version, commit $head, tests: $($names -join ', '))"
