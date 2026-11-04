# store-server/sandbox/lib-update.ps1 - helpers for the update scenarios (Plan 07 Task 11). Dot-sourced by each scenario AFTER lib.ps1.
# Windows PowerShell 5.1 syntax only (nothing PowerShell 7 added: no ternary, null-coalescing or null-conditional operators, no per-request certificate switch, no Process.Kill(bool)).
# Runs inside the Sandbox. Processes are only ever stopped by PID (sc queryex / the PID of a process we started), never by image name.
if (-not (Get-Command Add-Check -ErrorAction SilentlyContinue)) { throw 'lib-update.ps1 needs lib.ps1 loaded first' }
$ErrorActionPreference = 'Stop'
$script:Data = $script:DataRoot
$script:Prog = $script:ProgRoot
$script:OldV = '1.0.0-r1'; $script:NewV = '1.0.1-r1'
$script:PackSrc = Join-Path $script:Payload 'packs'
$script:SvcShort = @('Postgres', 'Auth', 'Rest', 'Functions', 'Gateway')
$script:ServiceDbRoles = @('authenticator', 'supabase_auth_admin')   # fence::SERVICE_DB_ROLES
$script:AsyncPids = New-Object System.Collections.ArrayList
$script:PristineTypes = $null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }   # the store root is not trusted yet in a fresh Sandbox

# ---- checks / hooks / posctl -----------------------------------------------------------------------------------
function Check($id, $expected, $actual) { Add-Check ([string]$id) ([string]"$expected") $actual (("$expected") -eq ("$actual")) }

# POSCTL_TEST_HOOKS = {exit_at, fail_at, pause_at:{label,flag,ms}, backup}. The packs are signed with the packs key (Use-PackKey)
# and the signature is ALWAYS verified: start/status/health re-verify it on every pack load (lifecycle.rs), and the services and minute tasks
# never see a per-process skip variable, so an installed pack must never be edited after signing. There is deliberately no
# -SkipSignature here and no helper that edits an installed pack. The real catalog digests are harvested in the Sandbox
# (Save-CatalogDigest) and fed back to the host, which rebuilds AND re-signs the packs (New-TestPacks.ps1 -DigestsFile).
function Hooks($h = @{}) {
  $e = @{}
  if ($h -and $h.Count -gt 0) { $e['POSCTL_TEST_HOOKS'] = ($h | ConvertTo-Json -Compress -Depth 6) }
  return $e
}

# The test packs are signed with their own throwaway key (New-TestPacks.ps1 writes only the public half next to them). The services and
# the scheduled tasks verify the pack on every load, so the key goes to Machine scope exactly like lib.ps1's Install-Posctl does.
function Use-PackKey {
  $key = (Get-Content (Join-Path $script:PackSrc 'test-pubkey.txt') -Raw).Trim()
  $env:POSCTL_TEST_UPDATER_PUBKEY = $key
  [Environment]::SetEnvironmentVariable('POSCTL_TEST_UPDATER_PUBKEY', $key, 'Machine')
}

function ConvertTo-ArgLine([string[]]$A) {
  return (($A | ForEach-Object { if ($_ -eq '' -or $_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
}

# Supersedes lib.ps1's Invoke-Posctl for the update scenarios. The second positional argument is the environment (a hashtable, as
# `Hooks` returns) or, as in lib.ps1, the stdin text; the third is the other one. Returns exit/json/raw/err (property names are case-insensitive, so lib.ps1's Exit/Json/Raw work; Stderr is kept too).
function Invoke-Posctl([string[]]$PosctlArgs, $Second = $null, $Third = $null, [int]$TimeoutSec = 1800, [Alias('Name')][string]$Tag = '') {   # lib.ps1's own callers use the alias
  $envs = @{}; $stdin = $null
  foreach ($x in @($Second, $Third)) {
    if ($x -is [hashtable]) { $envs = $x } elseif ($x -is [string]) { $stdin = $x }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:Posctl
  $psi.Arguments = ConvertTo-ArgLine $PosctlArgs
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  foreach ($k in $envs.Keys) { $psi.EnvironmentVariables[[string]$k] = [string]$envs[$k] }
  $p = [System.Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  if ($stdin -ne $null) { $p.StandardInput.WriteLine($stdin) }
  $p.StandardInput.Close()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill(); throw ('posctl ' + ($PosctlArgs -join ' ') + " timed out after $TimeoutSec s") }
  $p.WaitForExit()
  $raw = $so.Result.Trim(); $err = $se.Result
  $json = $null; try { $json = $raw | ConvertFrom-Json } catch { }
  if (-not $Tag) { $Tag = (@($PosctlArgs | Select-Object -First 2)) -join '-' }
  Save-Evidence ('posctl-' + $Tag) ("args: $($PosctlArgs -join ' ')`nexit: $($p.ExitCode)`n--- stdout ---`n$raw`n--- stderr ---`n$err")
  return [pscustomobject]@{ exit = $p.ExitCode; json = $json; raw = $raw; err = $err; Stderr = $err }
}

function Get-Cfg { return (Get-Content (Join-Path $script:Data 'conf\posctl.json') -Raw | ConvertFrom-Json) }
function Get-KillLabels {   # the kill points the test-hooks build lists (data.killLabels)
  $r = Invoke-Posctl @('dev', 'hook-labels') -Tag 'hook-labels'
  return @($r.json.data.killLabels)
}

# ---- database ----------------------------------------------------------------------------------------------------
function Get-PsqlExe { $c = Get-Cfg; return (Join-Path $script:Prog ('packs\' + $c.pack.current + '\pg\bin\psql.exe')) }
function Invoke-PsqlAs([string]$User, [string]$Db, [string]$Sql, [switch]$AllowFailure, [switch]$NoStartupRetry) {   # exit code + merged output; PGPASSFILE only, no password anywhere; -w: never prompt
  # FR19 #12: fail-loud by default (ON_ERROR_STOP, then throw on a non-zero exit or an ERROR: line, output in the message). -AllowFailure = the caller expects/inspects a failure.
  $c = Get-Cfg
  $env:PGPASSFILE = Join-Path $script:Data 'secrets\pgpass.conf'
  # Postgres replaying WAL right after a (re)start answers FATAL "the database system is starting up" / "is in recovery mode": that is not a failure of the statement, wait it out (2 s, <= 120 s).
  # ONLY those two messages are retried. "Connection refused" / "could not connect" (a stopped Postgres a scenario may assert on) and every other error are returned or thrown at once.
  $deadline = (Get-Date).AddSeconds(120)
  while ($true) {
    $o = & (Get-PsqlExe) -w -X -q -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $c.ports.base -U $User -d $Db -c $Sql 2>&1
    $code = $LASTEXITCODE
    $text = (($o | ForEach-Object { "$_" }) -join "`n").Trim()
    if (-not $NoStartupRetry -and $code -ne 0 -and $text -match 'the database system is (starting up|in recovery mode)' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2; continue }
    break
  }
  if (-not $AllowFailure -and ($code -ne 0 -or $text -match '(?m)^(psql:[^
]*?)?ERROR:')) { throw "psql failed (user $User, db $Db, exit $code): $Sql`n$text" }
  return [pscustomobject]@{ exit = $code; out = $text }
}
function Psql([string]$Db, [string]$Sql, [switch]$AllowFailure) { return (Invoke-PsqlAs 'supabase_admin' $Db $Sql -AllowFailure:$AllowFailure).out }
function Get-DbNames { return @((Psql 'template1' 'SELECT datname FROM pg_database') -split "`r?`n" | Where-Object { $_ }) }
function Get-Level { return (Psql 'postgres' "SELECT count(*) || '|' || COALESCE(max(version),'') FROM supabase_migrations.schema_migrations") }
# GoTrue's own level (count|max of auth.schema_migrations) of ONE named database. Get-Level reads supabase_migrations only.
function Get-AuthLevel([string]$Db = 'postgres') { return (Psql $Db "SELECT count(*) || '|' || COALESCE(max(version),'') FROM auth.schema_migrations") }
function Get-RowCounts([string]$Db = 'postgres') {   # table=count lines for every public base table
  $sql = "SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
  return (Psql $Db $sql)
}
function Get-RoleCanLogin([string]$Role) { return (Psql 'template1' "SELECT rolcanlogin FROM pg_roles WHERE rolname = '$Role'") }

# ---- GoTrue-level helpers ------------------------------------------------------------------------------------------
# The test pair old-auth / new-auth differs in gotrueMigrationsMax. Both ship the same auth.exe, so the older level is produced here: the
# newest GoTrue migration (add_expires_at_to_one_time_tokens) is `add column if not exists`, so removing the column and its
# schema_migrations row lets `auth migrate` apply it again on the clone and nothing else.
$script:AuthNewestVersion = '20260831180000'
function Set-AuthLevelLow([string]$Db = 'postgres') {
  [void](Psql $Db "ALTER TABLE auth.one_time_tokens DROP COLUMN IF EXISTS expires_at; DELETE FROM auth.schema_migrations WHERE version = '$($script:AuthNewestVersion)'")
  return (Get-AuthLevel $Db)
}
function Test-AuthColumnPresent([string]$Db = 'postgres') { return ((Psql $Db "SELECT count(*) FROM information_schema.columns WHERE table_schema='auth' AND table_name='one_time_tokens' AND column_name='expires_at'") -eq '1') }
function Get-PackAuthMax([string]$PackFile) {   # gotrueMigrationsMax of an installed pack's manifest
  return [string]((Get-Content (Join-Path $script:Prog "packs\$PackFile\manifest.json") -Raw | ConvertFrom-Json).gotrueMigrationsMax)
}

# ---- catalog digest (needs a running database, so it can only be computed here, never on the host) ------------------------------
# FR15b: a digest is only comparable with another digest computed from the SAME catalog-digest.sql. PackSrc is the live-mapped payload folder, so the SQL can change
# under a running scenario. Save-CatalogDigest records sha256 of the SQL it ran (sqlSha256), New-TestPacks refuses digests from another SQL, and the scenarios that
# compare a psql digest with a declared one call this first. Throws when the recorded hash is missing or differs. Pure, so a host test can load it.
function Assert-CatalogSqlHash([string]$Recorded, [string]$Actual, [string]$Context) {
  $r = ([string]$Recorded).Trim().ToLower(); $a = ([string]$Actual).Trim().ToLower()
  if ($r -notmatch '^[0-9a-f]{64}$') { throw "$Context : no sqlSha256 was recorded; the digests were harvested without it (re-run scenario 69 with this library)" }
  if ($r -ne $a) { throw "$Context : catalog-digest.sql is $a but the digests were built from $r; re-stage, re-run 69, rebuild the packs" }
}
function Get-PackSqlSha256 { return (Get-FileHash (Join-Path $script:PackSrc 'catalog-digest.sql') -Algorithm SHA256).Hash.ToLower() }
# The SQL hash the packs were built with (New-TestPacks writes catalogSqlSha256 into every packs.json entry).
function Assert-PackSqlCurrent([string]$Context) {
  $packs = @(Get-Content (Join-Path $script:PackSrc 'packs.json') -Raw | ConvertFrom-Json)
  $rec = ''; if ($packs.Count -gt 0 -and $packs[0].PSObject.Properties['catalogSqlSha256']) { $rec = [string]$packs[0].catalogSqlSha256 }
  Assert-CatalogSqlHash $rec (Get-PackSqlSha256) $Context
}
# Fail fast: an update to a pack whose catalog digest is still the pass-1 placeholder can only end in CATALOG_MISMATCH (scenario 69 has not harvested it).
# Guard only the pack a scenario updates TO; old and old-auth stay placeholder by design (69 harvests no old* digests). Adds a failing row, then throws.
function Assert-TargetPackDigestReal([string]$Variant) {
  $e = @(Get-Content (Join-Path $script:PackSrc 'packs.json') -Raw | ConvertFrom-Json) | Where-Object { $_.name -eq $Variant } | Select-Object -First 1
  $ok = ($null -ne $e -and -not [bool]$e.digestIsPlaceholder)
  $why = if ($null -eq $e) { 'no such pack in packs.json' } else { 'digestIsPlaceholder=true' }
  Check "setup: target pack '$Variant' carries a harvested catalog digest" 'digestIsPlaceholder=false' $(if ($ok) { 'digestIsPlaceholder=false' } else { $why })
  if (-not $ok) { throw "pack '$Variant' ($why): run scenario 69, then New-TestPacks.ps1 -DigestsFile (pass 2), then re-stage; an update to it would only fail CATALOG_MISMATCH" }
}
function Get-CatalogDigest([string]$Db) {
  $c = Get-Cfg
  $env:PGPASSFILE = Join-Path $script:Data 'secrets\pgpass.conf'
  $o = & (Get-PsqlExe) -w -X -q -A -t -h 127.0.0.1 -p $c.ports.base -U supabase_admin -d $Db -v ON_ERROR_STOP=1 -f (Join-Path $script:PackSrc 'catalog-digest.sql') 2>&1
  $code = $LASTEXITCODE; $text = (($o | ForEach-Object { "$_" }) -join "`n").Trim()
  # FR19 #12b: two failed reads would both be '' and compare equal, so a failure or an empty read throws
  if ($code -ne 0 -or -not $text) { throw "catalog digest of $Db failed (psql exit $code, output empty: $(-not $text)): $text" }
  return ($text -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 1)
}
# FR14: every line the digest hashes (the union between `FROM (` and `) q` of catalog-digest.sql), sorted, for a line-by-line diff against the hooks exe's
# catalog-lines-clone.txt / -live.txt when a CATALOG_MISMATCH ever shows up again. Evidence only; the value is written to <OutDir>\<File>.
function Save-CatalogLines([string]$Db, [string]$File) {
  $c = Get-Cfg; $src = [IO.File]::ReadAllText((Join-Path $script:PackSrc 'catalog-digest.sql'))
  $a = $src.IndexOf('FROM (') + 'FROM ('.Length; $b = $src.LastIndexOf(') q')
  $sql = Join-Path $env:TEMP 'catalog-lines.sql'
  [IO.File]::WriteAllText($sql, "SET search_path = pg_catalog;`nSELECT x FROM (" + $src.Substring($a, $b - $a) + ") q ORDER BY x`n", (New-Object System.Text.UTF8Encoding($false)))
  $env:PGPASSFILE = Join-Path $script:Data 'secrets\pgpass.conf'
  $o = & (Get-PsqlExe) -w -X -q -A -t -h 127.0.0.1 -p $c.ports.base -U supabase_admin -d $Db -v ON_ERROR_STOP=1 -f $sql 2>&1
  $code = $LASTEXITCODE; $text = (($o | ForEach-Object { "$_" }) -join "`n").Trim()
  if ($code -ne 0 -or -not $text) { Remove-Item $sql -Force -ErrorAction SilentlyContinue; throw "catalog lines of $Db failed (psql exit $code, output empty: $(-not $text)): $text" }
  [IO.File]::WriteAllText((Join-Path $script:OutDir $File), (($o | ForEach-Object { "$_" }) -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Remove-Item $sql -Force -ErrorAction SilentlyContinue
}
function Write-JsonNoBom([string]$Path, $Obj) {
  [IO.File]::WriteAllText($Path, ($Obj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
}
# Records the real digest of a migrated database for one pack variant in <OutDir>\catalog-digests.json ({variant: digest}). The host copies that
# file next to the packs and runs New-TestPacks.ps1 -DigestsFile, which rebuilds and RE-SIGNS the packs. The Sandbox never edits a pack:
# it has no signer (the signer is node/npx) and an edited installed pack fails PACK_INVALID on the next start/status/health.
function Save-CatalogDigest([string]$Variant, [string]$Digest) {
  $d = ([string]$Digest).Trim().ToLower()
  if ($d -notmatch '^[0-9a-f]{64}$') { throw "catalog digest for $Variant is not 64 hex characters: '$d'" }
  $f = Join-Path $script:OutDir 'catalog-digests.json'
  $h = @{}
  if (Test-Path $f) { $j = Get-Content $f -Raw | ConvertFrom-Json; foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = [string]$p.Value } }
  $h[$Variant] = $d
  $h['sqlSha256'] = Get-PackSqlSha256   # FR15b: the SQL this digest was computed from
  Write-JsonNoBom $f ([pscustomobject]$h)
}

# ---- services / processes (PID only) ---------------------------------------------------------------------------------
function Get-ServicePid([string]$Short) {   # sc queryex: the only way a service process is identified for a kill
  $o = sc.exe queryex ("SupermarketPOS-" + $Short) | Out-String
  if ($o -match 'PID\s*:\s*(\d+)') { return [int]$Matches[1] }
  return 0
}
function Stop-ServiceProcess([string]$Short) {
  $id = Get-ServicePid $Short
  if ($id -gt 0) { try { [System.Diagnostics.Process]::GetProcessById($id).Kill() } catch { } }
  return $id
}
function Stop-StoreProcesses { foreach ($s in $script:SvcShort) { [void](Stop-ServiceProcess $s) }; Start-Sleep -Seconds 3 }   # a hard crash of the whole stack

function Stop-All {
  foreach ($s in 'Gateway', 'Functions', 'Rest', 'Auth', 'Postgres') { sc.exe stop ("SupermarketPOS-" + $s) | Out-Null }
  [void](Wait-Until { @($script:SvcShort | Where-Object { $i = Get-ServiceInfo ("SupermarketPOS-" + $_); $i -and $i.State -ne 'Stopped' }).Count -eq 0 } 60)
  foreach ($s in $script:SvcShort) { $i = Get-ServiceInfo ("SupermarketPOS-" + $s); if ($i -and $i.State -ne 'Stopped') { [void](Stop-ServiceProcess $s) } }
  Start-Sleep -Seconds 2
}
function Start-All {
  foreach ($s in 'Postgres', 'Auth', 'Rest', 'Functions', 'Gateway') { sc.exe start ("SupermarketPOS-" + $s) | Out-Null }
  [void](Wait-Until { Test-AllRunning } 90)
  # Service state is not readiness: Postgres can still be in WAL recovery. Wait until it answers SELECT 1 (same psql + supabase_admin identity as Psql), then throw so the scenario crashes with evidence.
  $pgUp = Wait-Until { (Invoke-PsqlAs 'supabase_admin' 'postgres' 'SELECT 1' -AllowFailure -NoStartupRetry).out -eq '1' } 120 2
  if (-not $pgUp) { throw "Start-All: Postgres did not accept connections within 120 s (SELECT 1 as supabase_admin). Service states: $(Get-AllServiceStates)" }
  Start-Sleep -Seconds 4   # kept: it is the settle time of Auth/Rest/Functions/Gateway behind the database, which the update scenarios 69-85 were tuned with
}

# start type word of each service: auto | demand | delayed (the three the fence and the product use)
function Get-StartTypes {
  $t = @{}
  foreach ($s in $script:SvcShort) {
    $o = sc.exe qc ("SupermarketPOS-" + $s) | Out-String
    $w = 'unknown'
    if ($o -match 'START_TYPE\s*:\s*2\s+AUTO_START\s*\(DELAYED\)') { $w = 'delayed' }
    elseif ($o -match 'START_TYPE\s*:\s*2') { $w = 'auto' }
    elseif ($o -match 'START_TYPE\s*:\s*3') { $w = 'demand' }
    elseif ($o -match 'START_TYPE\s*:\s*4') { $w = 'disabled' }
    $t[$s] = $w
  }
  return $t
}
function Set-StartTypes($Types) {
  foreach ($s in $script:SvcShort) {
    $w = [string]$Types[$s]
    $arg = ''
    if ($w -eq 'auto') { $arg = 'auto' } elseif ($w -eq 'demand') { $arg = 'demand' } elseif ($w -eq 'delayed') { $arg = 'delayed-auto' } elseif ($w -eq 'disabled') { $arg = 'disabled' }
    if ($arg) { sc.exe config ("SupermarketPOS-" + $s) start= $arg | Out-Null }
  }
}
function Format-Types($t) { return (($script:SvcShort | ForEach-Object { "$_=$($t[$_])" }) -join ',') }
function Get-ProductFailureActions([string]$Short, [string]$EvidenceName = '') {   # FR16 (f): the raw `sc qfailure` text is saved as evidence when a name is given
  $t = (sc.exe qfailure ("SupermarketPOS-" + $Short) | Out-String)
  if ($EvidenceName) { Save-Evidence $EvidenceName $t }
  return $t
}
# FR14 (B): `sc qfailure` ALWAYS prints "REBOOT_MESSAGE :" and "COMMAND_LINE :", so matching the words REBOOT / RUN_COMMAND anywhere reports actions on a service that has
# none (run 3: all five services "had actions" while paused at after:fence; the fence had cleared them: failureflag was off on all five). An ACTION line is `RESTART -- Delay = 5000 milliseconds.`
function Test-FailureActions([string]$Text) { return ($Text -match '(?m)\b(RESTART|RUN_COMMAND|REBOOT)\s+--\s') }
function Test-FailureFlag([string]$Short) { return ((sc.exe qfailureflag ("SupermarketPOS-" + $Short) | Out-String) -match 'TRUE') }
# FR15 (b): the ACTION lines of `sc qfailure` as one comparable string, e.g. "RESTART/5000,RESTART/5000,RESTART/5000" ('' = none). Only "<ACTION> -- Delay = n" lines count (see Test-FailureActions).
function Get-FailureActionList([string]$Text) {
  return ((@([regex]::Matches($Text, '(?m)\b(RESTART|RUN_COMMAND|REBOOT)\s+--\s+Delay\s*=\s*(\d+)') | ForEach-Object { "$($_.Groups[1].Value)/$($_.Groups[2].Value)" })) -join ',')
}
# The recovery configuration of every service, taken BEFORE an update: failure actions, failure flag, start type.
function Get-ServiceConfigSnapshot {
  $types = Get-StartTypes; $snap = @{ Types = $types; Actions = @{}; Flag = @{} }
  foreach ($s in $script:SvcShort) { $snap.Actions[$s] = Get-FailureActionList (Get-ProductFailureActions $s "qfailure-pre-$s"); $snap.Flag[$s] = (Test-FailureFlag $s) }
  return $snap
}
# Outcome-aware "after the update" check. Success: the fence is lifted and the recovery policy and recorded start types are back. Rolled back: the original configuration is
# restored. Both are the same fact - the services look exactly as they did before the update - so both compare against the pre-update snapshot, never against a fixed expectation.
function Assert-ServiceConfigRestored([string]$Label, $Snap, [string]$Outcome) {
  Check "$Label ($Outcome) : start types are the pre-update ones" (Format-Types $Snap.Types) (Format-Types (Get-StartTypes))
  foreach ($s in $script:SvcShort) {
    Check "$Label ($Outcome) : $s failure actions are the pre-update ones" ([string]$Snap.Actions[$s]) (Get-FailureActionList (Get-ProductFailureActions $s "qfailure-$Label-$s"))
    Check "$Label ($Outcome) : $s failureflag is the pre-update one" ([bool]$Snap.Flag[$s]) (Test-FailureFlag $s)
  }
}

# ---- the store: install, pristine copy, reset -----------------------------------------------------------------------
# FR14 (A): the marker table is PART of the catalog the update's clone is digested over (catalog-digest.sql covers every public relation and its ACL, and the live
# database carries it from here on, so the clone does too). Scenario 69 therefore adds it BEFORE it harvests the declared digests, with this same function:
# the declared digest is what a CORRECT update produces on the clone (run 3: it was harvested without the table, and 70 failed CATALOG_MISMATCH).
# FR15 (a1): the product's clone invariant (src\update\invariants.sql, RLS_OFF) refuses ANY public/pos_lockout table with relrowsecurity = false - ENABLE is exactly what it checks
# (no FORCE, no policy needed), so the marker is created with RLS enabled. Scenario 69 harvests through this same function, so the digests stay identical.
function Add-S7Marker {
  [void](Psql 'postgres' "CREATE TABLE IF NOT EXISTS public.s7_marker(v text); ALTER TABLE public.s7_marker ENABLE ROW LEVEL SECURITY; INSERT INTO public.s7_marker SELECT 'before-update' WHERE NOT EXISTS (SELECT 1 FROM public.s7_marker)")
}
# -LowerAuth: for the old-auth / new-auth pair - the old store starts one GoTrue migration behind (Set-AuthLevelLow) so the update has one to apply.
# -ParkBackup: provision registers the Backup task (every 5 minutes, StartWhenAvailable), so a tick can fire during the rest of this setup and leave a snapshot behind. It is parked
# (disabled) the moment provision returns, before anything else, and the park is asserted. A tick in the sub-second gap before the park is NOT hidden or repaired: the snapshot-count check fails loudly.
function Install-OldStore([string]$Variant = 'new', [string]$OldPack = 'old', [switch]$LowerAuth, [switch]$ParkBackup, [switch]$KeepTasks) {
  Assert-TargetPackDigestReal $Variant
  Use-PackKey
  [void](Ensure-VcRuntime)
  Install-Posctl
  Use-PackKey   # Install-Posctl set the staged key; the test packs are signed by the packs key
  $r = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:PackSrc "$OldPack.pospack")) -Tag 'old-pack-install' -TimeoutSec 1200
  Check 'setup: old pack installs' 0 $r.exit
  $script:PackVersion = $script:OldV
  $pin = New-Digits6   # built at runtime, never written down
  $p = Invoke-Posctl @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', 'C:\out\update-provision-result.json') $pin -Tag 'old-provision' -TimeoutSec 1800
  Check 'setup: provision exits 0' 0 $p.exit
  if ($ParkBackup) { Invoke-ParkBackupTasks -AssertEmpty }
  elseif (-not $KeepTasks) { Invoke-ParkBackupTasks }
  $i = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:PackSrc "$Variant.pospack")) -Tag 'variant-pack-install' -TimeoutSec 1200   # every variant is packVersion 1.0.1-r1
  Check "setup: install $Variant" 0 $i.exit
  # the hourly UpdateCheck would find the installed newer pack and update the store behind the scenario's back
  Check 'setup: the UpdateCheck task is disabled' 0 (Set-TaskEnabled 'UpdateCheck' $false)
  Add-S7Marker
  if ($LowerAuth) {
    # a failed statement rolls both edits back and would leave nothing to migrate: assert the level is exactly n-1 AND the column is gone
    $before = Get-AuthLevel
    $after = Set-AuthLevelLow
    $n = 0; if ($before -match '^(\d+)\|') { $n = [int]$Matches[1] }
    $want = "$($n - 1)|20260824000001"
    $okLevel = ($n -gt 0 -and $after -eq $want)
    $okColumn = (-not (Test-AuthColumnPresent))
    Check 'setup: GoTrue level is n-1 (20260824000001) after lowering' $want $after
    Check 'setup: auth.one_time_tokens.expires_at is gone' $false (-not $okColumn)
    if (-not ($okLevel -and $okColumn)) { throw "Set-AuthLevelLow did not lower the GoTrue level (before '$before', after '$after', column present: $(-not $okColumn))" }
  }
  Save-Pristine
}
function Save-Pristine {
  $script:PristineTypes = Get-StartTypes
  Write-JsonNoBom (Join-Path $script:OutDir 'pristine-start-types.json') ([pscustomobject]$script:PristineTypes)
  Stop-All
  robocopy $script:Data "$($script:Data)-pristine" /MIR /COPYALL /R:1 /W:1 /NFL /NDL /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy of the data folder to -pristine failed ($LASTEXITCODE)" }   # 0-7 are success codes
  Start-All
}
# Posctl archives each finished journal as <opId>.journal.json under <data>\logs\posctl\ops (Journal::archive; Roots::posctl_logs()/ops). Those hold the fence step/phase
# timestamps, so they are copied into evidence\journal-archive before Reset-Store's robocopy /MIR from -pristine wipes them, and once more when the scenario ends (agent.ps1).
# Tolerant: a missing folder is a note, never a failure.
function Save-JournalArchive {
  $src = Join-Path $script:Data 'logs\posctl\ops'; $dest = Join-Path $script:Evidence 'journal-archive'
  try {
    if (-not (Test-Path $src)) { Save-Evidence 'journal-archive-note' "no ops log folder at $src"; return }
    $j = @(Get-ChildItem -Path $src -Filter '*.journal.json' -File -ErrorAction SilentlyContinue)
    if ($j.Count -eq 0) { Save-Evidence 'journal-archive-note' "no archived journals in $src"; return }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    foreach ($f in $j) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $dest $f.Name) -Force }
  } catch { Save-Evidence 'journal-archive-note' "copy failed: $($_.Exception.Message)" }
}
function Reset-Store {
  Save-JournalArchive
  Stop-All
  robocopy "$($script:Data)-pristine" $script:Data /MIR /COPYALL /R:1 /W:1 /NFL /NDL /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy of -pristine back to the data folder failed ($LASTEXITCODE)" }
  $r =Invoke-Posctl @('pack', 'activate', '--version', $script:OldV, '--set-current') -Tag 'reset-activate'     # services back on the old pack
  foreach ($s in $script:SvcShort) {
    $n = "SupermarketPOS-$s"
    sc.exe failure $n reset= 3600 actions= restart/5000/restart/5000/restart/5000 | Out-Null; sc.exe failureflag $n 1 | Out-Null }
  sc.exe config SupermarketPOS-Gateway depend= SupermarketPOS-Functions/SupermarketPOS-Auth/SupermarketPOS-Rest | Out-Null
  # the fence set Auth/Rest/Functions to demand in the SCM registry (not in the data folder): back to what Save-Pristine recorded
  $t = $script:PristineTypes
  if ($t -eq $null -and (Test-Path (Join-Path $script:OutDir 'pristine-start-types.json'))) {
    $t = @{}; $j = Get-Content (Join-Path $script:OutDir 'pristine-start-types.json') -Raw | ConvertFrom-Json
    foreach ($s in $script:SvcShort) { $t[$s] = [string]$j.$s }
  }
  if ($t -ne $null) { Set-StartTypes $t }
  Start-All
}

# ---- fence assertions (gaps 1, 5) ------------------------------------------------------------------------------------
# State of the tills' side while an operation is undecided (before the internal stack is started, or after a crash at such a point):
# recovery policy off, Auth/Rest/Functions on demand and stopped, maintenance Caddyfile, live copy kept, sidecar written, service roles NOLOGIN.
# -InternalStackUp: the stack was deliberately started behind the fence (activate .. reopen): skips the not-running and NOLOGIN checks.
#   -ScmRestored (scenario 75 point D, journal reopen:done): work.on_commit re-registered the services (conf::activate) AFTER the last scm_fence and before the mark, so the SCM side is
#   already UNFENCED while the Caddy side is still fenced: Auth/Rest/Functions auto + running (the SCM started them at boot), failure actions + failureflag on all five,
#   Gateway dependencies restored, roles LOGIN. The Caddy/sidecar checks below hold unchanged (finish_unfence comes after the mark). Default off: every other caller is unchanged.
# The DEPENDENCIES section of `sc qc` for the gateway (the DEPENDENCIES line and its continuation lines up to SERVICE_START_NAME), not the whole output.
function Get-GatewayDeps {
  $in = $false; $o = @()
  foreach ($l in ((sc.exe qc SupermarketPOS-Gateway | Out-String) -split "`r?`n")) {
    if ($l -match '^\s*DEPENDENCIES\s*:') { $in = $true } elseif ($l -match '^\s*[A-Z_]+\s*:' -and $l -notmatch '^\s+:') { $in = $false }
    if ($in) { $o += $l }
  }
  return ($o -join "`n")
}
function Assert-Fenced([string]$Label, [string]$PreLiveHash = '', [switch]$InternalStackUp, [switch]$RolesMayLogin, [switch]$ScmRestored) {   # -RolesMayLogin: after start_internal_stack NOLOGIN is lifted, only demand + not-running still hold
  $types = Get-StartTypes
  if ($ScmRestored) {
    foreach ($s in 'Auth', 'Rest', 'Functions') { Check "$Label : $s start type is auto (re-registered by on_commit)" 'auto' $types[$s] }
  } else {
    foreach ($s in 'Auth', 'Rest', 'Functions') { Check "$Label : $s start type is demand" 'demand' $types[$s] }
  }
  Check "$Label : Gateway stays automatic" 'auto' $types['Gateway']
  foreach ($s in $script:SvcShort) {
    $f = Get-ProductFailureActions $s "qfailure-$Label-$s"
    $acts = Test-FailureActions $f
    if ($ScmRestored) {
      Add-Check "$Label : $s has failure actions (re-registered by on_commit)" 'present' $(if ($acts) { 'present: ' + ($f -replace '\s+', ' ').Trim() } else { "none: $f" }) ([bool]$acts)
      Check "$Label : $s failureflag is on" $true (Test-FailureFlag $s)
    } else {
      Add-Check "$Label : $s has no failure actions" 'none' $(if ($acts) { ($f -replace '\s+', ' ').Trim() } else { 'none' }) (-not $acts)
      Check "$Label : $s failureflag is off" $false (Test-FailureFlag $s)
    }
  }
  if ($ScmRestored) {
    foreach ($s in 'Auth', 'Rest', 'Functions') { $i = Get-ServiceInfo ("SupermarketPOS-" + $s); Check "$Label : $s is running (SCM auto-started it at boot)" 'Running' $(if ($i) { $i.State } else { 'absent' }) }
    foreach ($r in $script:ServiceDbRoles) { Check "$Label : $r can log in" 't' (Get-RoleCanLogin $r) }
    $qc = Get-GatewayDeps
    foreach ($s in 'Functions', 'Auth', 'Rest') { Check "$Label : Gateway depends on SupermarketPOS-$s (restored)" $true ($qc -match "SupermarketPOS-$s") }
  }
  if (-not $InternalStackUp -and -not $ScmRestored) {
    foreach ($s in 'Auth', 'Rest', 'Functions') { $i = Get-ServiceInfo ("SupermarketPOS-" + $s); Check "$Label : $s is not running" $true ($i -eq $null -or $i.State -ne 'Running') }
    if (-not $RolesMayLogin) { foreach ($r in $script:ServiceDbRoles) { Check "$Label : $r is NOLOGIN" 'f' (Get-RoleCanLogin $r) } }
  }
  if (-not $ScmRestored) { Check "$Label : Gateway has no service dependencies while fenced (depend= empty)" $false ((Get-GatewayDeps) -match 'SupermarketPOS-(Functions|Auth|Rest)') }   # D (-ScmRestored): the dependencies are restored, asserted above
  $conf = Join-Path $script:Data 'conf'
  $cf = Join-Path $conf 'Caddyfile'; $maint = Join-Path $conf 'Caddyfile.maintenance'; $live = Join-Path $conf 'Caddyfile.live'
  Check "$Label : Caddyfile.live (the fence marker) exists" $true (Test-Path $live)
  if ((Test-Path $cf) -and (Test-Path $maint)) { Check "$Label : Caddyfile is byte-identical to the maintenance config" (Get-FileHash $maint -Algorithm SHA256).Hash (Get-FileHash $cf -Algorithm SHA256).Hash }
  else { Check "$Label : Caddyfile and Caddyfile.maintenance exist" $true $false }
  if ($PreLiveHash -and (Test-Path $live)) { Check "$Label : Caddyfile.live is the pre-update render" $PreLiveHash (Get-FileHash $live -Algorithm SHA256).Hash }
  else { Info "$Label : Caddyfile.live pre-update render check not run" $(if ($PreLiveHash) { 'Caddyfile.live is missing' } else { 'the caller gave no pre-update hash' }) }
  $side = Get-UpdateReadPath 'fence-start-types.json'
  Check "$Label : start-type sidecar is present" $true (Test-Path $side)
}

# After any interruption + recovery the store must be on ONE level, fully unfenced.
# -Pre: hashtable of what was true before the update: StartTypes (Get-StartTypes), AuthLevel, Rows (Get-RowCounts). -Swapped: $true = exactly one
# pos_prev_*/pos_failed_* must remain, $false = none, omitted = at most one.
function Assert-ConsistentStore([string]$Label, $Swapped = $null, $Pre = $null) {
  $cfg = Get-Cfg
  $lvl = Get-Level
  $oldM = Get-Content (Join-Path $script:Prog "packs\$($script:OldV)\manifest.json") -Raw | ConvertFrom-Json
  $newM = Get-Content (Join-Path $script:Prog "packs\$($script:NewV)\manifest.json") -Raw | ConvertFrom-Json
  $which = 'unknown'
  if ($lvl -eq "$($newM.migrations.count)|$($newM.migrations.max)") { $which = 'new' } elseif ($lvl -eq "$($oldM.migrations.count)|$($oldM.migrations.max)") { $which = 'old' }
  $want = $script:OldV; if ($which -eq 'new') { $want = $script:NewV }
  Check "$Label : database is on exactly one known level" $true ($which -ne 'unknown')
  Check "$Label : pack pointer matches the database" $want $cfg.pack.current
  Check "$Label : every service runs the matching pack" 0 (@($script:SvcShort | Where-Object { (sc.exe qc ("SupermarketPOS-" + $_) | Out-String) -notmatch [regex]::Escape("packs\$want") }).Count)
  Check "$Label : journal is gone" $false (Test-Path (Get-UpdateReadPath 'journal.json'))
  $dbs = Get-DbNames
  Check "$Label : the live database is present" $true ($dbs -contains 'postgres')
  Check "$Label : no leftover clone" $false ($dbs -contains 'pos_next')
  $kept = @($dbs | Where-Object { $_ -like 'pos_prev_*' -or $_ -like 'pos_failed_*' }).Count
  if ($Swapped -eq $true) { Check "$Label : exactly one of pos_prev_* / pos_failed_* remains" 1 $kept }
  elseif ($Swapped -eq 'family') {   # prune_plan keeps ONE pos_prev_* and ONE pos_failed_* (each <= 7 days), so one of each may remain
    Check "$Label : at most one pos_prev_* and at most one pos_failed_* remain" $true (@($dbs | Where-Object { $_ -like 'pos_prev_*' }).Count -le 1 -and @($dbs | Where-Object { $_ -like 'pos_failed_*' }).Count -le 1)
  }
  elseif ($Swapped -eq $false) { Check "$Label : no pos_prev_* / pos_failed_* remains" 0 $kept }
  else { Check "$Label : at most one of pos_prev_* / pos_failed_* remains" $true ($kept -le 1) }
  Check "$Label : fence marker is gone" $false (Test-Path (Join-Path $script:Data 'conf\Caddyfile.live'))
  Check "$Label : start-type sidecar is gone" $false (Test-Path (Get-UpdateReadPath 'fence-start-types.json'))
  foreach ($s in $script:SvcShort) {
    Check "$Label : $s recovery policy restored" $true ((Get-ProductFailureActions $s "qfailure-$Label-$s") -match '(?m)\bRESTART\s+--\s')
    Check "$Label : $s failureflag is on" $true (Test-FailureFlag $s)
  }
  Check "$Label : gateway dependencies restored" $true ((sc.exe qc SupermarketPOS-Gateway | Out-String) -match 'SupermarketPOS-Functions')
  $recorded = $script:PristineTypes; if ($Pre -ne $null -and $Pre.StartTypes) { $recorded = $Pre.StartTypes }
  if ($recorded -ne $null) { Check "$Label : start types are the pre-update ones" (Format-Types $recorded) (Format-Types (Get-StartTypes)) }
  else { Info "$Label : start-types check not run" 'no pristine or pre-update start types were recorded' }
  foreach ($r in $script:ServiceDbRoles) { Check "$Label : $r can log in again" 't' (Get-RoleCanLogin $r) }
  # AuthLevel = the pre-update level (store still on the old pack); AuthLevelNew = the level the new pack raises it to (used when the store ended on the new pack)
  $wantAuth = $Pre.AuthLevel; if ($Pre -ne $null -and $which -eq 'new' -and $Pre.AuthLevelNew) { $wantAuth = $Pre.AuthLevelNew }
  if ($Pre -ne $null -and $wantAuth) { Check "$Label : GoTrue schema level" $wantAuth (Get-AuthLevel) }
  else { Info "$Label : GoTrue schema level check not run" 'the caller gave no pre-update auth level' }
  if ($Pre -ne $null -and $Pre.Rows) { Check "$Label : row counts survived" $Pre.Rows (Get-RowCounts) }
  else { Info "$Label : row counts check not run" 'the caller gave no pre-update row counts' }
  Assert-GatewayPackVersion $Label $want
  if ($Pre -ne $null -and $Pre.MarkerGone) { Check "$Label : the declared delete removed the marker rows" '0' (Psql 'postgres' 'SELECT count(*) FROM public.s7_marker') }
  else { Check "$Label : data survived" 'before-update' (Psql 'postgres' 'SELECT v FROM public.s7_marker LIMIT 1') }
}

# ---- LAN side (gaps 2, 3, 4) ----------------------------------------------------------------------------------------
# FR14 (C): the LAN listener's certificate and site names are the COMPUTER NAME (+ .local, localhost, 127.0.0.1 as cert names) and Caddy picks the site by SNI.
# A request to https://127.0.0.1:<port> carries no usable SNI, and every probe died at the handshake (run 3: 1,896 of 1,896 probes had status 0, and Get-Health
# returned nothing). Scenario 31 reaches the listener with `curl --resolve <name>:<port>:<ip>`; so does everything below. curl.exe goes through Schannel and the OS trust
# store (the provisioned store root is in LocalMachine\Root); no -k.
# FR15 (c) ROOT CAUSE: Install-OldStore provisions with `--server-host sandbox-pc`, so the certificate and the Caddy site names are sandbox-pc / sandbox-pc.local / localhost /
# 127.0.0.1 (state\gateway.json hosts; run 71's update-provision-result.json). Scenario 31 provisions WITHOUT --server-host, so there the names are COMPUTERNAME and its
# curl --resolve ${COMPUTERNAME}:... matches a site. The poller used COMPUTERNAME unconditionally: the SNI matched no site, Caddy (no catch-all) aborted the handshake with a TLS
# internal_error alert, and Schannel reports that alert as SEC_E_INTERNAL_ERROR ("LSA cannot be contacted") - not an LSA/account/profile problem (the same curl in the main
# process failed identically). So: use the name the store itself was provisioned with. -k is gone too: the store root is in LocalMachine\Root after provision (store_trust), as in 31.
function Get-LanName {
  $gj = Read-JsonFile (Join-Path $script:Data 'state\gateway.json')
  if ($gj -and @($gj.hosts).Count -gt 0 -and [string]@($gj.hosts)[0]) { return ([string]@($gj.hosts)[0]).ToLower() }
  return 'sandbox-pc'   # the --server-host Install-OldStore passes
}
# One LAN request: @{ status; ra (Retry-After); body (first 200 chars); err } - status 0 and err = curl's own words when nothing answered.
function Invoke-LanCurl([string]$Method, [string]$Path, [string]$Ip = '127.0.0.1', [int]$TimeoutSec = 3, [string]$ApiKey = '') {
  $cfg = Get-Cfg; $port = $cfg.ports.base + 4; $name = Get-LanName
  $a = @('-sS', '-i', '--ssl-no-revoke', '--max-time', "$TimeoutSec", '--resolve', "${name}:${port}:${Ip}", '-X', $Method)
  if ($Method -eq 'POST') { $a += @('-H', 'Content-Type: application/json', '-d', '{}') }
  if ($ApiKey) { $a += @('-H', "apikey: $ApiKey") }
  $a += "https://${name}:${port}${Path}"
  $o = & "$env:windir\System32\curl.exe" @a 2>&1
  $txt = (($o | ForEach-Object { "$_" }) -join "`n")
  if ($txt -match '^HTTP/\S+\s+(\d{3})') {
    $st = [int]$Matches[1]; $ra = ''; if ($txt -match '(?mi)^Retry-After:\s*(\S+)') { $ra = $Matches[1] }
    $parts = $txt -split "(?:\r?\n){2}", 2; $b = ''; if ($parts.Count -gt 1) { $b = $parts[1] }
    if ($b.Length -gt 200) { $b = $b.Substring(0, 200) }
    return @{ status = $st; ra = $ra; body = $b; err = '' }
  }
  $e = ($txt -replace '\s+', ' ').Trim(); if ($e.Length -gt 160) { $e = $e.Substring(0, 160) }
  return @{ status = 0; ra = ''; body = ''; err = "curl exit $LASTEXITCODE $e" }
}
function Get-Health {
  $r = Invoke-LanCurl 'GET' '/_store/health'
  return @{ status = $r.status; body = $r.body }
}
# FR16 (h): the gateway's /_store/health (the LAN path the tills use; Caddy rewrites it to the functions router's _health route) must report the pack that is live.
# No retry for the version to appear - only a bounded wait for the first 200 (the gateway may still be coming back after reopen / rollback).
function Get-HealthPackVersion([int]$WaitSec = 30) {
  $dl = [DateTime]::UtcNow.AddSeconds($WaitSec)
  do { $h = Get-Health; if ($h.status -eq 200) { break }; Start-Sleep -Milliseconds 500 } while ([DateTime]::UtcNow -lt $dl)
  $pv = $null; try { $pv = ($h.body | ConvertFrom-Json).packVersion } catch { }
  return @{ status = $h.status; packVersion = $pv; body = $h.body }
}
function Assert-GatewayPackVersion([string]$Label, [string]$Want) {
  $g = Get-HealthPackVersion
  Save-Evidence "health-$Label" "status=$($g.status) body=$($g.body)"
  Check "$Label : gateway /_store/health answers 200 on the LAN path" 200 $g.status
  Check "$Label : gateway /_store/health reports packVersion $Want (tills are let in with the matching version)" $Want ([string]$g.packVersion)
}
# FR16 (g): a JSON timestamp is a [datetime] already on PS 7 (ConvertFrom-Json) and a string on PS 5.1. [DateTime]::Parse($v) of the PS 7 value goes through the CURRENT-culture
# string and drops the Z, so a 15:24:03Z became 21:24:03Z. Take a [datetime] as it is and parse a string as round-trip UTC; either way return UTC.
function ConvertTo-UtcDateTime($Value) {
  if ($Value -is [datetime]) { $d = $Value }
  else { $d = [datetime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
  if ($d.Kind -eq [DateTimeKind]::Unspecified) { return [datetime]::SpecifyKind($d, [DateTimeKind]::Utc) }
  return $d.ToUniversalTime()
}

# One LAN-port probe round = GET and POST over /rest/v1, /auth/v1, /functions/v1 plus GET /_store/status and /_store/health.
# One JSON line per probe: {t (UTC, round-trip ISO), m, p, s (0 = no answer), ra (Retry-After), b (first 200 chars)}.
function Start-LanPoller([string]$OutFile, [string]$HostName = '') {   # HostName = the address curl connects to (--resolve); default = the LAN address, else loopback
  if (-not $HostName) { $HostName = Get-LanIp }
  if (-not $HostName) { $HostName = '127.0.0.1' }
  $cfg = Get-Cfg; $port = $cfg.ports.base + 4; $name = Get-LanName
  return Start-Job -ArgumentList $name, $port, $HostName, $OutFile, "$env:windir\System32\curl.exe" -ScriptBlock {
    param($name, $port, $ip, $out, $curl)
    $targets = @(
      @('GET', '/rest/v1/products?select=id&limit=1'), @('POST', '/rest/v1/rpc/s7_probe'),
      @('GET', '/auth/v1/health'), @('POST', '/auth/v1/token?grant_type=password'),
      @('GET', '/functions/v1/s7-probe'), @('POST', '/functions/v1/s7-probe'),
      @('GET', '/_store/status'), @('GET', '/_store/health'))
    while ($true) {
      foreach ($t in $targets) {
        $s = 0; $b = ''; $ra = ''
        $a = @('-sS', '-i', '--ssl-no-revoke', '--max-time', '3', '--resolve', "${name}:${port}:${ip}", '-X', $t[0])
        if ($t[0] -eq 'POST') { $a += @('-H', 'Content-Type: application/json', '-d', '{}') }
        $a += "https://${name}:${port}$($t[1])"
        $txt = ''
        try { $txt = ((& $curl @a 2>&1) | ForEach-Object { "$_" }) -join "`n" } catch { $txt = "ERR $($_.Exception.Message)" }
        if ($txt -match '^HTTP/\S+\s+(\d{3})') {
          $s = [int]$Matches[1]; if ($txt -match '(?mi)^Retry-After:\s*(\S+)') { $ra = $Matches[1] }
          $parts = $txt -split "(?:\r?\n){2}", 2; if ($parts.Count -gt 1) { $b = $parts[1] }
        } else { $b = 'NOANSWER ' + ($txt -replace '\s+', ' ').Trim() }   # status 0 keeps curl's own words, so a dead poller says why
        if ($b.Length -gt 200) { $b = $b.Substring(0, 200) }
        Add-Content -Path $out -Value (@{ t = [DateTime]::UtcNow.ToString('o'); m = $t[0]; p = $t[1]; s = $s; ra = $ra; b = $b } | ConvertTo-Json -Compress)
      }
      Start-Sleep -Milliseconds 250
    }
  }
}
function Stop-LanPoller($Job) { Stop-Job $Job; Remove-Job $Job -Force }
function Read-LanPoll([string]$OutFile) {
  if (-not (Test-Path $OutFile)) { return @() }
  return @(Get-Content $OutFile | Where-Object { $_ } | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } } | Where-Object { $_ })
}
# Inside [From, To] (UTC) every data-path answer must be 503 STORE_UPDATING with Retry-After 30, and /_store/status must be 200 or 401.
# A 0 (no answer) counts as a violation: the gateway stays up through the fence.
function Assert-LanFenced([string]$Label, [string]$OutFile, [datetime]$From, [datetime]$To) {
  $rows = @(Read-LanPoll $OutFile | Where-Object { $d = ConvertTo-UtcDateTime $_.t; $d -ge $From.ToUniversalTime() -and $d -le $To.ToUniversalTime() })
  $data = @($rows | Where-Object { $_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*' })
  Check "$Label : the poller saw data-path answers while fenced" $true ($data.Count -gt 0)
  Check "$Label : no data-path answer other than 503 while fenced" 0 (@($data | Where-Object { $_.s -ne 503 }).Count)
  Check "$Label : every 503 says STORE_UPDATING" 0 (@($data | Where-Object { $_.s -eq 503 -and $_.b -notmatch 'STORE_UPDATING' }).Count)
  Check "$Label : every 503 carries Retry-After 30" 0 (@($data | Where-Object { $_.s -eq 503 -and $_.ra -ne '30' }).Count)
  Check "$Label : GET and POST were both probed on all three paths" 6 (@($data | ForEach-Object { "$($_.m) $(($_.p -split '/')[1..2] -join '/')" } | Sort-Object -Unique).Count)
  $st = @($rows | Where-Object { $_.p -eq '/_store/status' })
  Check "$Label : /_store/status stays 200 or 401 (anonymous)" 0 (@($st | Where-Object { $_.s -ne 200 -and $_.s -ne 401 }).Count)
}
function Assert-LanNeverServed([string]$Label, [string]$OutFile, [datetime]$FenceAt, [datetime]$ReopenAt) {   # the blunt form: no 2xx on a data path in the window
  $bad = @(Read-LanPoll $OutFile | Where-Object { $d = ConvertTo-UtcDateTime $_.t; $d -ge $FenceAt.ToUniversalTime() -and $d -le $ReopenAt.ToUniversalTime() -and ($_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*') -and $_.s -ge 200 -and $_.s -lt 300 })
  Check "$Label : the LAN was never served a 2xx between fence and reopen" 0 $bad.Count
  Assert-FenceDrops $Label $OutFile $FenceAt $ReopenAt   # every window assert ends here (Fenced/Rollback/Killed/FencedFor all call NeverServed), so the drop accounting lives once
}
# Run 8: the window asserts counted ANSWERS only, so a probe with status 0 (curl 52, no reply) slipped through. A drop is tolerated only where the gateway itself swaps
# state: at the exit boundary (last answered data row 503 STORE_UPDATING, a non-503 answer within 2 s) or the mirror entry boundary (live answer, then a 503 within 2 s).
# Drops are looked for 2 s either side of the window (they sit just OUTSIDE the first/last 503 by definition). FAIL: k > 2, more than 1 drop at one boundary, or any drop
# that is neither (mid-window, or away from a boundary). k = 0 passes. The check lists each drop's timestamp and class.
function Assert-FenceDrops([string]$Label, [string]$OutFile, [datetime]$From, [datetime]$To) {
  $lo = $From.ToUniversalTime().AddSeconds(-2); $hi = $To.ToUniversalTime().AddSeconds(2)
  $rows = @(Read-LanPoll $OutFile | ForEach-Object { [pscustomobject]@{ D = (ConvertTo-UtcDateTime $_.t); S = [int]$_.s; Data = ($_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*'); Fence = ([int]$_.s -eq 503 -and [string]$_.b -match 'STORE_UPDATING') } })
  $parts = @(); $exit = 0; $entry = 0; $other = 0; $k = 0
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $r = $rows[$i]
    if ($r.S -ne 0 -or $r.D -lt $lo -or $r.D -gt $hi) { continue }
    $k++
    $prev = $null; for ($j = $i - 1; $j -ge 0; $j--) { if ($rows[$j].Data -and $rows[$j].S -gt 0) { $prev = $rows[$j]; break } }
    $next = $null; for ($j = $i + 1; $j -lt $rows.Count; $j++) { if ($rows[$j].Data -and $rows[$j].S -gt 0) { $next = $rows[$j]; break } }
    $class = 'mid-window or outside a boundary'
    if ($prev -and $next -and ($next.D - $r.D).TotalSeconds -le 2) {
      if ($prev.Fence -and -not $next.Fence) { $class = 'exit-boundary'; $exit++ }
      elseif (-not $prev.Fence -and $next.Fence) { $class = 'entry-boundary'; $entry++ }
    }
    if ($class -like 'mid*') { $other++ }
    $parts += "$($r.D.ToString('HH:mm:ss.fff'))Z $class"
  }
  $ok = ($k -le 2 -and $exit -le 1 -and $entry -le 1 -and $other -eq 0)
  Add-Check "$Label : dropped connections = $k" 'k<=2, <=1 per boundary, none mid-window' ("k=$k exit=$exit entry=$entry other=$other" + $(if ($parts.Count) { ': ' + ($parts -join '; ') } else { '' })) $ok
}

# Rollback scenarios have no hook that pauses the fence, so the window is taken from what the poller recorded: FENCE = the first data-path 503 STORE_UPDATING,
# REOPEN = the last one (the poller keeps probing, so the first non-503 data answer after it is the reopen). Inside it every data answer must be 503 (Assert-LanFenced)
# and none may be 2xx (Assert-LanNeverServed); a 2xx in the middle of the window breaks both. Before it the poller must also have been connected (Assert-PollerConnects).
function Assert-RollbackFenceWindow([string]$Label, [string]$OutFile) {
  $fenced = @(Read-LanPoll $OutFile | Where-Object { ($_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*') -and [int]$_.s -eq 503 -and $_.b -match 'STORE_UPDATING' } |
    ForEach-Object { ConvertTo-UtcDateTime $_.t } | Sort-Object)
  Check "$Label : the poller saw a fence window (data-path 503 STORE_UPDATING)" $true ($fenced.Count -gt 0)
  if ($fenced.Count -eq 0) { return }
  $from = $fenced[0]; $to = $fenced[$fenced.Count - 1]
  Assert-LanFenced $Label $OutFile $from $to
  Assert-LanNeverServed $Label $OutFile $from $to
}

# A killed update: the fence (if the kill came after it) holds until --recover reopens. One episode, so the same no-2xx rule applies from the first to the last
# fenced answer. A kill BEFORE the fence leaves no 503 at all; that is recorded, not failed (the store was never fenced, so it was legitimately served).
# FR19 #12: how many data-path answers the poller recorded as the fence (503 STORE_UPDATING). "Never served" alone passes vacuously when the poller saw no fence at all.
function Get-FenceRowCount([string]$OutFile) {
  return @(Read-LanPoll $OutFile | Where-Object { ($_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*') -and [int]$_.s -eq 503 -and $_.b -match 'STORE_UPDATING' }).Count
}
function Assert-KilledFenceWindow([string]$Label, [string]$OutFile) {
  $fenced = @(Read-LanPoll $OutFile | Where-Object { ($_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*') -and [int]$_.s -eq 503 -and $_.b -match 'STORE_UPDATING' } |
    ForEach-Object { ConvertTo-UtcDateTime $_.t } | Sort-Object)
  if ($fenced.Count -eq 0) { Info "$Label : FINDING no fence window seen (the update was killed before the fence)" 'none'; return }
  Assert-LanNeverServed $Label $OutFile $fenced[0] $fenced[$fenced.Count - 1]
}

function Get-LanIp {   # the first non-loopback, non-link-local IPv4 address; $null when the Sandbox has no adapter with one
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -ne 'Up' -or $n.NetworkInterfaceType -eq 'Loopback') { continue }
    foreach ($a in $n.GetIPProperties().UnicastAddresses) {
      if ($a.Address.AddressFamily -eq 'InterNetwork' -and -not $a.Address.ToString().StartsWith('169.254.') -and -not $a.Address.ToString().StartsWith('127.')) { return $a.Address.ToString() }
    }
  }
  return $null
}
function Test-TcpOpen([string]$Addr, [int]$Port, [int]$TimeoutMs = 1500) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($Addr, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    try { $c.EndConnect($iar) } catch { return $false }
    return $c.Connected
  } finally { $c.Close() }
}
# The store block is base..base+9. Every service port except the LAN gateway (base+4) is loopback-only and must refuse the LAN address.
function Get-InternalPorts { $b = [int](Get-Cfg).ports.base; return @($b, ($b + 1), ($b + 2), ($b + 3), ($b + 5), ($b + 6), ($b + 8)) }
function Get-NonLoopbackBinds {   # netstat -ano: listeners on the internal ports that are not bound to 127.0.0.1 / ::1
  $ports = Get-InternalPorts; $bad = @()
  foreach ($l in (netstat -ano -p TCP)) {
    if ($l -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)') {
      $addr = $Matches[1]; $port = [int]$Matches[2]
      if (($ports -contains $port) -and $addr -ne '127.0.0.1' -and $addr -ne '[::1]') { $bad += "${addr}:$port" }
    }
  }
  return $bad
}
function Assert-LanPortsClosed([string]$Label) {
  $ip = Get-LanIp
  if ($ip -eq $null) { Add-Check "FINDING $Label : LAN address" 'recorded' 'the Sandbox has no non-loopback IPv4 address; the connect test is not possible here' $true }
  else { foreach ($p in (Get-InternalPorts)) { Check "$Label : ${ip}:$p refuses" $false (Test-TcpOpen $ip $p) } }
  Check "$Label : no internal port is bound beyond loopback (netstat -ano)" '' ((Get-NonLoopbackBinds) -join ',')
}

# A NOLOGIN service role must be refused at connect time. Uses PGPASSFILE only (the password is never on a command line).
function Test-LoginRefused([string]$Role) {
  $r = Invoke-PsqlAs $Role 'postgres' 'SELECT 1' -AllowFailure   # the refusal IS the expected result
  return [pscustomobject]@{ refused = ($r.exit -ne 0 -and $r.out -match 'not permitted to log in'); out = $r.out; exit = $r.exit }
}
function Assert-LoginRefused([string]$Label) {
  foreach ($role in $script:ServiceDbRoles) {
    $t = Test-LoginRefused $role
    Check "$Label : $role is refused ('not permitted to log in')" $true $t.refused
    Check "$Label : $role rolcanlogin is false" 'f' (Get-RoleCanLogin $role)
  }
}

# ---- torn conf files (gap 6) -----------------------------------------------------------------------------------------
# What a power cut mid-write can leave: kind 'empty' (0 bytes), 'zeros' (the old length, all NUL), 'mixed' (the first half of the maintenance
# config followed by the second half of the live config). Written straight, not atomically - that is the point.
function Set-TornConf([string]$File, [string]$Kind) {
  $conf = Join-Path $script:Data 'conf'; $path = Join-Path $conf $File
  $maint = [IO.File]::ReadAllBytes((Join-Path $conf 'Caddyfile.maintenance'))
  $liveP = Join-Path $conf 'Caddyfile.live'
  $len = 0; if (Test-Path $path) { $len = (Get-Item $path).Length }
  if ($Kind -eq 'empty') { [IO.File]::WriteAllBytes($path, [byte[]]@()) }
  elseif ($Kind -eq 'zeros') { [IO.File]::WriteAllBytes($path, (New-Object byte[] ([Math]::Max($len, 16)))) }
  elseif ($Kind -eq 'mixed') {
    $live = $maint; if (Test-Path $liveP) { $live = [IO.File]::ReadAllBytes($liveP) }
    $head = [int]($maint.Length / 2); $tail = $live.Length - [int]($live.Length / 2)
    $buf = New-Object byte[] ($head + $tail)
    [Array]::Copy($maint, 0, $buf, 0, $head); [Array]::Copy($live, [int]($live.Length / 2), $buf, $head, $tail)
    [IO.File]::WriteAllBytes($path, $buf)
  } else { throw "unknown torn kind $Kind" }
  return (Get-Item $path).Length
}

# ---- a second posctl while one holds the lock (gap 7) ---------------------------------------------------------------
# Start-PosctlAsync runs posctl in the background (stdout/stderr to files) and remembers its PID so Stop-AsyncPosctl can clean up.
function Start-PosctlAsync([string[]]$PosctlArgs, [hashtable]$Env = @{}, [string]$Tag = 'async') {
  $out = Join-Path $script:OutDir "$Tag.out.txt"; $err = Join-Path $script:OutDir "$Tag.err.txt"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:Posctl
  $psi.Arguments = ConvertTo-ArgLine $PosctlArgs
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  foreach ($k in $Env.Keys) { $psi.EnvironmentVariables[[string]$k] = [string]$Env[$k] }
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  [void]$script:AsyncPids.Add($p)   # the Process object, not its PID: it holds the handle, so a recycled PID can never be killed by mistake
  return [pscustomobject]@{ Process = $p; Pid = $p.Id; Out = $so; Err = $se; OutFile = $out; ErrFile = $err }
}
function Wait-PosctlAsync($H, [int]$TimeoutSec = 600) {
  if (-not $H.Process.WaitForExit($TimeoutSec * 1000)) { throw "async posctl $($H.Pid) did not finish in $TimeoutSec s" }
  $H.Process.WaitForExit()
  $raw = $H.Out.Result.Trim(); $json = $null; try { $json = $raw | ConvertFrom-Json } catch { }
  Set-Content $H.OutFile $raw; Set-Content $H.ErrFile $H.Err.Result
  return [pscustomobject]@{ exit = $H.Process.ExitCode; json = $json; raw = $raw; err = $H.Err.Result; Stderr = $H.Err.Result }
}
function Stop-AsyncPosctl {   # the Process objects started above, nothing else (no PID lookup, so no PID reuse)
  foreach ($x in @($script:AsyncPids)) { try { if (-not $x.HasExited) { $x.Kill() } } catch { } }
  $script:AsyncPids.Clear()
}
# The holder is a paused update; the contender is any second posctl that takes the lock. LOCK_HELD is exit 10.
function Assert-LockHeld([string]$Label, $Result) {
  Check "$Label : the second posctl exits 10" 10 $Result.exit
  $code = $null; if ($Result.json) { $code = $Result.json.code }
  Check "$Label : the second posctl says LOCK_HELD" 'LOCK_HELD' $code
}
function Wait-FlagFile([string]$Flag, [int]$TimeoutSec = 300) { return (Wait-Until { Test-Path $Flag } $TimeoutSec 0.25) }

# ---- Plan 07 Task 11: scenario helpers (exit codes, status, secrets, pauses, boots, foreign locks) ---------------------------------
# Exit codes of conventions 11.2 (src\envelope.rs Code::exit / src\ops\outcome.rs OpCode::exit).
$script:ExitCodes = [ordered]@{ OK = 0; ERROR = 1; USAGE = 2; NOT_PROVISIONED = 4; LOCK_HELD = 10; PRECONDITION = 12; PACK_INVALID = 13; MIGRATION_FAILED = 14; VERIFY_FAILED_ROLLED_BACK = 15; ROLLED_BACK = 16; RECOVERY_NEEDED = 17 }
$script:AuthOldMax = '20260824000001'; $script:AuthNewMax = '20260831180000'
function Assert-Exit([string]$Label, $R, [string]$Name, [string]$Reason = '') {
  $want = [int]$script:ExitCodes[$Name]
  Check "$Label : exit $want ($Name)" $want $R.exit
  $code = ''; $jx = ''
  if ($R.json) { $code = [string]$R.json.code; $jx = [string]$R.json.exit }
  Check "$Label : envelope code is $Name" $Name $code
  Check "$Label : envelope exit equals the process exit" $R.exit $jx
  if ($Reason) { $got = ''; if ($R.json -and $R.json.data) { $got = [string]$R.json.data.reason }; Check "$Label : reason is $Reason" $Reason $got }
}
function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return (Get-Content $Path -Raw | ConvertFrom-Json) } catch { return $null }
}
function Get-UpdateResult { return (Read-JsonFile (Get-UpdateReadPath 'update-result.json')) }
function Assert-UpdateResult([string]$Label, [string]$Result, [string]$Code, [string]$To = '') {
  $u = Get-UpdateResult
  Check "$Label : update-result.json exists" $true ($u -ne $null)
  if ($u -eq $null) { return }
  Check "$Label : update-result lastResult" $Result ([string]$u.lastResult)
  Check "$Label : update-result lastCode" $Code ([string]$u.lastCode)
  if ($To) { Check "$Label : update-result packTo" $To ([string]$u.packTo) }
}
# status.json states: running | degraded | stopped | updating | recovery-needed (status.rs derive_state). `health --write` refreshes it; exit 17 = recovery-needed.
function Get-StatusDoc {
  [void](Invoke-Posctl @('health', '--write') -Tag 'health-write')
  return (Read-JsonFile (Join-Path $script:Data 'state\status.json'))
}
function Assert-StatusState([string]$Label, [string]$State) {
  $s = Get-StatusDoc; $got = ''; if ($s) { $got = [string]$s.state }
  Check "$Label : status.json state is $State" $State $got
  return $s
}
function Get-JournalDoc { return (Read-JsonFile (Get-UpdateReadPath 'journal.json')) }
function Assert-JournalAt([string]$Label, [string]$KillLabel) {   # KillLabel journal:<step>:<phase>
  $p = $KillLabel -split ':'
  $j = Get-JournalDoc
  Check "$Label : journal.json is on disk" $true ($j -ne $null)
  if ($j -ne $null) { Check "$Label : journal step/phase is the kill point" "$($p[1])/$($p[2])" "$($j.step)/$($j.phase)" }
}
function New-PreSnapshot {
  return @{ StartTypes = (Get-StartTypes); AuthLevel = (Get-AuthLevel); Rows = (Get-RowCounts); LiveHash = (Get-FileHash (Join-Path $script:Data 'conf\Caddyfile') -Algorithm SHA256).Hash; Pack = [string](Get-Cfg).pack.current }
}
# One row per service: start type before the update, after it, match yes/no. Printed (Save-Evidence) and recorded (Add-Check) so a deliberate pre-set (70 run 4: Rest = demand)
# can never again be misread as the update changing a start type. $Notes = @{ Rest = 'why' } adds a note to that row. Passes when every row matches.
function Write-StartTypeTable([string]$Label, $Before, $After, $Notes = @{}) {
  $lines = @('{0,-10} {1,-9} {2,-9} {3,-6} {4}' -f 'service', 'before', 'after', 'match', 'note'); $bad = 0
  foreach ($sv in $script:SvcShort) {
    $b = [string]$Before[$sv]; $a = [string]$After[$sv]; $m = 'yes'; if ($b -ne $a) { $m = 'no'; $bad++ }
    $lines += ('{0,-10} {1,-9} {2,-9} {3,-6} {4}' -f $sv, $b, $a, $m, [string]$Notes[$sv])
  }
  $txt = $lines -join "`n"
  Save-Evidence "starttypes-$Label" $txt
  Add-Check "$Label : start types per service, before the update vs after" 'every service matches' (($lines | Select-Object -Skip 1 | ForEach-Object { ($_ -replace '\s+', ' ').Trim() }) -join ' | ') ($bad -eq 0)
}
function Get-SchemaRowCounts([string]$Schema, [string]$Db = 'postgres') {
  $sql = "SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = '$Schema' AND table_type = 'BASE TABLE' ORDER BY 1"
  return (Psql $Db $sql)
}
# What a boot must not change: GoTrue users and migrations, the lockout tables (the boot Canary writes an Auth user).
function Get-AuthWriteMarks { return ("users=" + (Psql 'postgres' 'SELECT count(*) FROM auth.users') + ';authlevel=' + (Get-AuthLevel) + ';lockout=' + ((Get-SchemaRowCounts 'pos_lockout') -replace "`r?`n", ',')) }

# ---- paused / killed updates --------------------------------------------------------------------------------------------
# A real update held at a hook label (pause_at) while the scenario inspects the fenced store. The posctl process is ours (a Process object), never found by name.
function Start-PausedUpdate([string]$Label, [int]$Ms = 60000, [string[]]$Extra = @(), [string]$Tag = 'paused') {
  $flag = Join-Path $script:OutDir ("$Tag.flag"); Remove-Item $flag -Force -ErrorAction SilentlyContinue
  $a = @('update', '--pack', $script:NewV) + $Extra
  $h = Start-PosctlAsync $a (Hooks @{ backup = 'ok'; pause_at = @{ label = $Label; flag = $flag; ms = $Ms } }) $Tag
  [void](Wait-Until { (Test-Path $flag) -or $h.Process.HasExited } 600 0.25)  # FR15: an update that already ended (rolled back) will never reach the label - do not wait 10 minutes for it
  $ok = (Test-Path $flag)
  Check "$Tag : the update reached $Label" $true $ok
  return $h
}
function Invoke-KilledUpdate([string]$Label, [string[]]$Extra = @(), [string]$Tag = 'killed') {
  return (Invoke-Posctl (@('update', '--pack', $script:NewV) + $Extra) (Hooks @{ backup = 'ok'; exit_at = $Label }) -Tag $Tag)
}
function Set-MaintenanceWindow([string]$Start, [string]$End) {   # posctl.json maintenance.window; only the data-folder copy, Reset-Store restores it
  $p = Join-Path $script:Data 'conf\posctl.json'
  $j = Get-Content $p -Raw | ConvertFrom-Json
  $j.maintenance | Add-Member -NotePropertyName window -NotePropertyValue ([pscustomobject]@{ start = $Start; end = $End }) -Force
  Write-JsonNoBom $p $j
}
function Get-PrevDbName { return (Get-DbNames | Where-Object { $_ -like 'pos_prev_update_*' } | Select-Object -First 1) }

# ---- catalog state (clone replay on the real cluster) -------------------------------------------------------------------
function Get-DbAclRows([string]$Db) {
  return (Psql 'template1' ("SELECT string_agg(coalesce(pg_get_userbyid(NULLIF(x.grantee,0)),'PUBLIC') || ':' || x.privilege_type || ':' || x.is_grantable, ',' ORDER BY coalesce(pg_get_userbyid(NULLIF(x.grantee,0)),'PUBLIC') || ':' || x.privilege_type || ':' || x.is_grantable) FROM pg_database d, aclexplode(d.datacl) x WHERE d.datname = '$Db' AND x.grantee <> d.datdba"))
}
function Get-DbSettingRows([string]$Db) {
  return (Psql 'template1' ("SELECT string_agg(s.setrole::regrole::text || '=' || s.setconfig::text, ';' ORDER BY s.setrole::regrole::text, s.setconfig::text) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = '$Db'"))
}

# ---- secrets (pgpass, keys, pepper, env files are read INSIDE the Sandbox only; values are never printed or stored) ---------
function Get-SecretValues {
  $vals = New-Object System.Collections.ArrayList
  $sd = Join-Path $script:Data 'secrets'
  foreach ($f in (Get-ChildItem $sd -File -ErrorAction SilentlyContinue)) {
    if ($f.Extension -eq '.pem' -or $f.Extension -eq '.key') { continue }
    $t = ''; try { $t = [IO.File]::ReadAllText($f.FullName) } catch { continue }
    if ($f.Name -eq 'pgpass.conf') { foreach ($l in ($t -split "`r?`n")) { $p = $l.Split(':'); if ($p.Count -ge 5) { [void]$vals.Add($p[4]) } } }
    elseif ($f.Extension -eq '.json') { foreach ($m in [regex]::Matches($t, '"[^"]+"\s*:\s*"([^"]{16,})"')) { [void]$vals.Add($m.Groups[1].Value) } }
    else {
      foreach ($l in ($t -split "`r?`n")) {
        if ($l -match '(?i)^\s*[A-Za-z0-9_.-]*(SECRET|KEY|PASSWORD|PEPPER|TOKEN)[A-Za-z0-9_.-]*\s*[=:]\s*"?([^"\r\n]+)"?\s*$') { [void]$vals.Add($Matches[2].Trim()) }
        foreach ($m in [regex]::Matches($l, '://[^:/@\s]+:([^@\s]+)@')) { [void]$vals.Add($m.Groups[1].Value) }
      }
      $one = $t.Trim(); if ($one.Length -ge 16 -and $one.Length -le 200 -and $one -notmatch "[\r\n]") { [void]$vals.Add($one) }
    }
  }
  return @($vals | Where-Object { $_ -and ([string]$_).Length -ge 12 } | Sort-Object -Unique)
}
function Read-SharedText([string]$Path) {
  $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
  try { $sr = New-Object IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $fs.Dispose() }
}
# Secret shapes shared by Assert-NoSecrets (detect) and Protect-SecretText (redact): one list.
$script:JwtRx = '(?i)eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}'
$script:PgUrlRx = '(?i)postgres(ql)?://[^:/@\s]+:[^@\s]+@'
function Protect-SecretText([string]$Text, $Values) {   # replace JWT shapes, postgres://user:pw@ and every Get-SecretValues value with [redacted]
  $r = [regex]::Replace([regex]::Replace($Text, $script:JwtRx, '[redacted]'), $script:PgUrlRx, '[redacted]')
  foreach ($v in @($Values)) { if ($v) { $r = $r.Replace([string]$v, '[redacted]') } }
  return $r
}
# No secret value and no JWT/connection-URL shape in the operation folder (journal, sidecar, results), the service logs, or posctl's own output.
function Assert-NoSecrets([string]$Label, [bool]$ExpectUpdateFiles = $true) {   # FR12: a smoke-only scenario (68) never writes update files: pass $false
  $vals = @(Get-SecretValues)
  Check "$Label : the secret scan has secrets to look for" $true ($vals.Count -ge 3)
  $files = New-Object System.Collections.ArrayList
  # third-party service logs (logs\SupermarketPOS-<Postgres|Auth|Rest|Functions|Gateway>) are not ours to scrub: they are left out.
  # posctl's own logs and the whole ops folder (journal.json, update-result.json, status.json, sidecar) are always scanned.
  foreach ($f in (Get-ChildItem (Join-Path $script:Data 'state') -File -Recurse -ErrorAction SilentlyContinue)) { [void]$files.Add($f) }
  foreach ($f in (Get-ChildItem (Join-Path $script:Data 'logs') -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.DirectoryName -notmatch 'SupermarketPOS-(Postgres|Auth|Rest|Functions|Gateway)' })) { [void]$files.Add($f) }
  if ($ExpectUpdateFiles) { Check "$Label : the ops folder files the scan must cover are present" $true (@($files | Where-Object { $_.Name -eq 'update-result.json' -or $_.Name -eq 'journal.json' -or $_.Name -eq 'status.json' }).Count -ge 1) }
  foreach ($f in (Get-ChildItem (Join-Path $script:OutDir 'evidence') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'posctl-' -and $_.Name -notmatch 'provision|pack-install' })) { [void]$files.Add($f) }
  foreach ($f in (Get-ChildItem $script:OutDir -File -Filter '*.txt' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(out|err)\.txt$' })) { [void]$files.Add($f) }
  $hits = New-Object System.Collections.ArrayList
  $unreadable = New-Object System.Collections.ArrayList
  $vanished = New-Object System.Collections.ArrayList
  $lockHeld = New-Object System.Collections.ArrayList
  foreach ($f in $files) {
    $t = ''; try { $t = Read-SharedText $f.FullName } catch { if (Test-ProductLockFile $f.FullName) { [void]$lockHeld.Add($f.Name) } elseif (Test-Path -LiteralPath $f.FullName) { [void]$unreadable.Add("$($f.Name) ($($_.Exception.GetType().Name))") } else { [void]$vanished.Add($f.Name) }; continue }
    for ($i = 0; $i -lt $vals.Count; $i++) { if ($t.Contains([string]$vals[$i])) { [void]$hits.Add("$($f.Name)#secret$i") } }
    if ($f.FullName -like "$($script:Data)\state\*" -and $t -match $script:JwtRx) { [void]$hits.Add("$($f.Name)#jwt-shape") }
    if ($t -match $script:PgUrlRx) { [void]$hits.Add("$($f.Name)#url-with-password") }
  }
  if ($lockHeld.Count -gt 0) { Info "$Label : lock file held by design by an in-flight posctl operation (no secret content)" (($lockHeld | Sort-Object -Unique) -join ', ') }
  if ($vanished.Count -gt 0) { Info "$Label : files gone between listing and read (atomic-write temps; their content is in the target, which is scanned)" (($vanished | Sort-Object -Unique) -join ', ') }
  Add-Check "$Label : every file of the secret scan could be read" 'none unreadable' $(if ($unreadable.Count -eq 0) { 'none unreadable' } else { 'unreadable: ' + ($unreadable -join ', ') }) ($unreadable.Count -eq 0)
  Check "$Label : no secret-shaped text in $($files.Count) files of the ops folder, logs and posctl output" '' ($hits -join ',')
}

# ---- boots ---------------------------------------------------------------------------------------------------------------
function Get-BootTime { return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime }
function Wait-AfterBoot([double]$Minutes) {   # the boot Canary fires at boot+3 min; judging "nothing wrote" needs boot+5
  $until = (Get-BootTime).AddMinutes($Minutes)
  while ((Get-Date) -lt $until) { Start-Sleep -Seconds 10 }
}
# Service starts since the boot. SCM event 7036 is a KNOWN GAP: this Windows build (26300; the Sandbox runs the host build) logs no 7036 from 'Service Control Manager' at all (run 75
# 20261022-004152-75: positive control 0 at boots A/B/C; 40818 SCM events on the host, none 7036). The authoritative source is Security event 4688 (process creation, Success auditing,
# armed by 75 phase 1 with Set-ProcessCreationAudit), which also sees a start that already stopped again. Everything is anchored on Get-BootTime. The Security log needs admin (elevated guest).
$script:AuditProcCreationGuid = '{0CCE922B-69AE-11D9-BED3-505054503030}'
$script:StartDiag = @{}
function Set-ProcessCreationAudit {   # 75 phase 1, before the kill and the reboot: returns the auditpol exit code (the caller hard-fails on non-zero) and writes the CmdLine key
  $rc = -1
  try { & auditpol.exe /set /subcategory:"$($script:AuditProcCreationGuid)" /success:enable 2>&1 | Out-Null; $rc = $LASTEXITCODE } catch { $rc = -1 }
  $k = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit'
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  New-ItemProperty -Path $k -Name 'ProcessCreationIncludeCmdLine_Enabled' -PropertyType DWord -Value 1 -Force | Out-Null
  return $rc
}
function Set-SecurityLogSize([long]$Bytes) {   # 75 phase 1 (sandbox only): a bigger Security log so 4688 events since the boot cannot roll over; returns the wevtutil exit code
  $rc = -1; try { & wevtutil.exe sl Security "/ms:$Bytes" 2>&1 | Out-Null; $rc = $LASTEXITCODE } catch { $rc = -1 }
  return $rc
}
function Set-SecurityLogOverwrite {   # 75 phase 1 (sandbox only): overwrite as needed instead of retain, so a full log never stops 4688 events; returns the wevtutil exit code
  $rc = -1; try { & wevtutil.exe sl Security /rt:false 2>&1 | Out-Null; $rc = $LASTEXITCODE } catch { $rc = -1 }
  return $rc
}
function Get-SecurityLogCoverage {   # no rollover since the boot <=> the oldest Security event is not newer than the boot. Times and the verdict only.
  $boot = Get-BootTime; $old = $null
  try { $o = @(Get-WinEvent -LogName Security -Oldest -MaxEvents 1 -ErrorAction Stop); if ($o.Count -eq 1) { $old = $o[0].TimeCreated } } catch { $old = $null }
  $ok = ($null -ne $old -and $old -le $boot)
  $txt = if ($null -eq $old) { 'oldest=unreadable' } else { "oldest=$($old.ToString('o'))" }
  return [pscustomobject]@{ Ok = $ok; Text = "$txt boot=$($boot.ToString('o'))" }
}
function Get-ProcessCreationAuditState {   # robust: GUID in, CSV (/r) out, the Inclusion Setting is the 5th column (header and value text are localized, so no English matching on the header)
  $csv = @(); $rc = -1
  try { $csv = @(& auditpol.exe /get /subcategory:"$($script:AuditProcCreationGuid)" /r 2>&1 | ForEach-Object { [string]$_ }); $rc = $LASTEXITCODE } catch { $rc = -1 }
  $inc = ''
  $line = @($csv | Where-Object { $_ -match [regex]::Escape($script:AuditProcCreationGuid) } | Select-Object -First 1)
  if ($line.Count -eq 1) { $f = @([string]$line[0] -split ','); if ($f.Count -ge 5) { $inc = $f[4].Trim() } }
  $key = $null; try { $key = (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit' -Name ProcessCreationIncludeCmdLine_Enabled -ErrorAction Stop).ProcessCreationIncludeCmdLine_Enabled } catch { $key = $null }
  return [pscustomobject]@{ Armed = ($rc -eq 0 -and $inc -match '(?i)success|^[1-3]$'); Setting = $inc; ExitCode = $rc; CmdLineKey = $key }
}
function ConvertTo-CmpText([string]$T) { return ((($T -replace '"', '') -replace '\s+', ' ').Trim().ToLowerInvariant()) }
function Get-ProcessCreations {   # Security 4688 since the boot, fields read by NAME from the event XML. Raw values stay in memory: callers record counts only (command lines can carry secrets)
  $boot = Get-BootTime
  $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688; StartTime = $boot } -ErrorAction SilentlyContinue -ErrorVariable qe)
  $err = ''; if ($qe -and @($qe).Count -gt 0) { $err = [string]@($qe)[0].FullyQualifiedErrorId }
  $o = @()
  foreach ($e in $ev) {
    $d = @{}
    try { $x = [xml]$e.ToXml(); foreach ($n in $x.Event.EventData.Data) { $d[$n.GetAttribute('Name')] = [string]$n.InnerText } } catch { continue }
    $o += [pscustomobject]@{ Time = $e.TimeCreated; Exe = [string]$d['NewProcessName']; Cmd = [string]$d['CommandLine'] }
  }
  $script:StartDiag['Err4688'] = $err
  $script:StartDiag['Raw4688'] = $o.Count
  return $o
}
function Get-ServiceStartsSinceBoot([string[]]$Shorts) {   # one object per start: Short, Time, Source ('4688:cmdline' | '4688:exe' | '4688:postgres.exe'); Postgres children (postgres.exe) are the positive control only
  $pc = @(Get-ProcessCreations)
  $paths = @{}; $exes = @{}
  foreach ($sh in $Shorts) {
    $w = Get-CimInstance Win32_Service -Filter "Name='SupermarketPOS-$sh'" -ErrorAction SilentlyContinue
    if ($null -eq $w -or -not $w.PathName) { continue }
    $pn = [string]$w.PathName
    $paths[$sh] = ConvertTo-CmpText $pn
    $first = if ($pn.StartsWith('"')) { $pn.Substring(1).Split('"')[0] } else { $pn.Split(' ')[0] }
    $exes[$sh] = ConvertTo-CmpText $first
  }
  $shared = (@($exes.Values | Select-Object -Unique).Count -lt @($exes.Values).Count)
  $mode = if ($shared) { 'cmdline' } else { 'exe' }
  $withCmd = @($pc | Where-Object { $_.Cmd }).Count
  if ($shared -and $pc.Count -gt 0 -and $withCmd -eq 0) { $mode = 'cmdline-missing' }   # shared wrapper and no command line captured: attribution impossible -> the caller FAILS loudly
  $script:StartDiag['Mode'] = $mode; $script:StartDiag['PathNames'] = $paths.Count; $script:StartDiag['WithCmd'] = $withCmd
  # backstop only: proven at point D alone (seen >=1 there); the cmdline matcher is the primary detector and is proven at every boot (Postgres shawl wrapper >=1)
  # the exe each shawl wraps (services.rs:92-94 component_command: Auth bin\auth.exe, Rest bin\postgrest.exe, Functions bin\functions.exe): an attribution-free backstop
  $inner = @{ Auth = 'auth.exe'; Rest = 'postgrest.exe'; Functions = 'functions.exe' }
  $script:StartDiag['ShawlEmptyCmd'] = @($pc | Where-Object { (ConvertTo-CmpText $_.Exe) -match '(^|[\\/ ])shawl\.exe$' -and -not $_.Cmd }).Count
  $out = @()
  foreach ($e in $pc) {
    $exeN = ConvertTo-CmpText $e.Exe
    foreach ($k in $inner.Keys) { if ($Shorts -contains $k -and $exeN -match ('(^|[\\/ ])' + [regex]::Escape($inner[$k]) + '$')) { $out += [pscustomobject]@{ Short = $k; Time = $e.Time; Source = '4688:inner' } } }
    if ($exeN -match '(^|[\\/ ])postgres\.exe$') { $out += [pscustomobject]@{ Short = 'Postgres'; Time = $e.Time; Source = '4688:postgres.exe' } }
    foreach ($sh in $paths.Keys) {
      $hit = $false
      if ($mode -eq 'cmdline') { $c = ConvertTo-CmpText $e.Cmd; $hit = ($c -ne '' -and ($c -eq $paths[$sh] -or $c.StartsWith($paths[$sh] + ' '))) }
      elseif ($mode -eq 'exe') { $hit = ($exeN -eq $exes[$sh]) }
      if ($hit) { $out += [pscustomobject]@{ Short = $sh; Time = $e.Time; Source = "4688:$mode" } }
    }
  }
  return $out
}
function Get-ServiceDisplayName([string]$Short) { $w = Get-CimInstance Win32_Service -Filter "Name='SupermarketPOS-$Short'" -ErrorAction SilentlyContinue; if ($w -and $w.DisplayName) { return [string]$w.DisplayName } else { return '' } }
function Get-ServiceStarts7036([string[]]$Shorts) {   # the recorded-gap source: SCM 7036 'running' (Properties[0] = DISPLAY name). Returns Short, Time
  $names = @{}
  foreach ($sh in $Shorts) { $dn = Get-ServiceDisplayName $sh; if ($dn) { $names[$dn] = $sh } }
  $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Id = 7036; StartTime = (Get-BootTime) } -ErrorAction SilentlyContinue -ErrorVariable qe)
  $script:StartDiag['Err7036'] = ''; if ($qe -and @($qe).Count -gt 0) { $script:StartDiag['Err7036'] = [string]@($qe)[0].FullyQualifiedErrorId }
  $out = @()
  foreach ($e in $ev) {
    if ($e.Properties.Count -lt 2) { continue }
    $dn = [string]$e.Properties[0].Value
    if ($names.ContainsKey($dn) -and ([string]$e.Properties[1].Value) -match '(?i)running') { $out += [pscustomobject]@{ Short = $names[$dn]; Time = $e.TimeCreated } }
  }
  return $out
}
function Get-ServicesRunningNow([string[]]$Shorts) {   # NOT a start detector (after a reboot every live process is newer than the boot): which services have a process right now
  return @($Shorts | Where-Object { $w = Get-CimInstance Win32_Service -Filter "Name='SupermarketPOS-$_'" -ErrorAction SilentlyContinue; $null -ne $w -and [int]$w.ProcessId -gt 0 })
}
function Get-StartQueryDiagnostics {   # counts and mode only: 4688 command lines / image names of other processes never reach the results (guest tools can carry secrets in arguments)
  $boot = Get-BootTime; $d = $script:StartDiag
  return "boot=$($boot.ToString('o')) kind=$($boot.Kind) raw4688_since_boot=$($d['Raw4688']) err4688='$($d['Err4688'])' match_mode=$($d['Mode']) pathnames=$($d['PathNames']) events_with_cmdline=$($d['WithCmd']) shawl_events_without_cmdline=$($d['ShawlEmptyCmd']) err7036='$($d['Err7036'])'"
}
function Get-FileHashOrEmpty([string]$Path) { if (Test-Path $Path) { return (Get-FileHash $Path -Algorithm SHA256).Hash } else { return '' } }
function Start-FencePoller([string]$File) {
  if ((Get-LanIp) -eq $null) {
    Add-Check 'FINDING lan: the Sandbox has no non-loopback IPv4 address; the poller connects to 127.0.0.1 with the computer name as SNI (curl --resolve; the gateway binds 0.0.0.0)' 'recorded' 'loopback' $true
    return (Start-LanPoller $File '127.0.0.1')
  }
  return (Start-LanPoller $File)
}
# FR14 (C): a poller that never connects must never pass silently. Call it right after Start-FencePoller, while the store is still LIVE: within $WaitSec the file must hold
# answers with status > 0, and /_store/health must have answered 200 at least once. On failure the actual carries curl's own words (the poller records them in `b`).
function Assert-PollerConnects([string]$Label, [string]$File, [int]$WaitSec = 20) {
  $dl = [DateTime]::UtcNow.AddSeconds($WaitSec); $rows = @()
  do { Start-Sleep -Milliseconds 500; $rows = @(Read-LanPoll $File) } while (@($rows | Where-Object { [int]$_.s -eq 200 -and $_.p -eq '/_store/health' }).Count -eq 0 -and [DateTime]::UtcNow -lt $dl)
  $live = @($rows | Where-Object { [int]$_.s -gt 0 }).Count
  $ok200 = @($rows | Where-Object { [int]$_.s -eq 200 -and $_.p -eq '/_store/health' }).Count
  $why = ''; if ($ok200 -eq 0) { $why = (@($rows | Where-Object { $_.b } | Select-Object -First 2 | ForEach-Object { "$($_.m) $($_.p) -> $($_.b)" }) -join ' | ') }
  Add-Check "$Label : the poller connects before the fence (answered probes, and /_store/health 200)" 'answers>0, health200>=1' "probes=$($rows.Count) answered=$live health200=$ok200 $why" ($live -gt 0 -and $ok200 -gt 0)
}
# Everything a till could see from the LAN side while the store is fenced, observed for ~Seconds s.
function Assert-LanFencedFor([string]$Label, [int]$Seconds = 8) {
  $f = Join-Path $script:OutDir ("poll-" + ($Label -replace '[^A-Za-z0-9]', '_') + ".jsonl"); Remove-Item $f -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $f
  $t0 = [DateTime]::UtcNow; Start-Sleep -Seconds $Seconds; $t1 = [DateTime]::UtcNow
  Stop-LanPoller $job
  Assert-LanFenced $Label $f $t0 $t1
  Assert-LanNeverServed $Label $f $t0 $t1   # LanFenced already implies it (no non-503 data answer); the explicit id keeps the property visible
}
# The gateway torn down and brought back up over whatever file is on disk - what a boot does. Stop/start go through sc (the SCM), not a kill.
function Restart-GatewayOverConf([string]$Label) {
  [void](sc.exe stop SupermarketPOS-Gateway)
  [void](Wait-Until { $i = Get-ServiceInfo 'SupermarketPOS-Gateway'; $i -and $i.State -eq 'Stopped' } 60)
  $s = sc.exe start SupermarketPOS-Gateway | Out-String
  Start-Sleep -Seconds 6
  return $s
}
function Test-ConfTorn([string]$File) {   # empty or all-NUL
  $p = Join-Path (Join-Path $script:Data 'conf') $File
  if (-not (Test-Path $p)) { return $true }
  $b = [IO.File]::ReadAllBytes($p)
  foreach ($x in $b) { if ($x -ne 0) { return $false } }
  return $true
}

# ---- a foreign holder of update.lock (LockFileEx, the same whole-file call shape as Rust's File::try_lock / try_lock_shared) ------
# No posctl command takes a SHARED lock today (a backup/verify would), so shared-vs-exclusive is proven against a holder of our own.
function Initialize-PosLock {
  if ('PosLock' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class PosLock : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct OVERLAPPED { public IntPtr Internal; public IntPtr InternalHigh; public uint Offset; public uint OffsetHigh; public IntPtr hEvent; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool LockFileEx(IntPtr h, uint flags, uint reserved, uint lo, uint hi, ref OVERLAPPED o);
  FileStream fs;
  PosLock(FileStream f) { fs = f; }
  public static PosLock TryOpen(string path, bool exclusive) {
    FileStream f = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
    OVERLAPPED o = new OVERLAPPED();
    uint flags = 1; if (exclusive) flags |= 2;
    if (!LockFileEx(f.SafeFileHandle.DangerousGetHandle(), flags, 0, uint.MaxValue, uint.MaxValue, ref o)) { f.Dispose(); return null; }
    return new PosLock(f);
  }
  public void ReleaseAfter(int ms) { Thread t = new Thread(delegate() { Thread.Sleep(ms); Dispose(); }); t.IsBackground = true; t.Start(); }
  public void Dispose() { FileStream f = Interlocked.Exchange<FileStream>(ref fs, null); if (f != null) f.Dispose(); }
}
'@
}
function Get-UpdateLockPath { return (Get-UpdateFilePath 'update.lock') }
function Open-ForeignLock([bool]$Exclusive) { Initialize-PosLock; return [PosLock]::TryOpen((Get-UpdateLockPath), $Exclusive) }

# ---- kill at every journal step (scenarios 73 / 74) ----------------------------------------------------------------------------------
# For each label: a clean store, an update killed there (process::exit 137, the OS releases the lock), then
#   journal on disk at that step, status.json "recovery-needed" and `health` exit 17, `update --dry-run` refuses (17, recoveryPending) and changes nothing,
#   `update --recover` exits 0, and the store is on ONE level: -Expect OLD | NEW | EITHER.
function Invoke-KillMatrix([string[]]$Labels, [string]$Tag, [scriptblock]$Expect, [switch]$RequireFence) {   # -RequireFence: every label killed at/after journal:fence:done must have been observed fenced
  $pre = New-PreSnapshot
  $consistentPre = @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows }
  $first = $true
  foreach ($label in $Labels) {
    if (-not $first) { Reset-Store }
    $first = $false
    $t = ($label -replace '[^A-Za-z0-9]', '_')
    # The gateway reopens LAST (commit, unfence, then reopen): a kill at any label before after:reopen_gateway happens while the LAN is still fenced
    # (so journal:reopen:*, before/after:finish_unfence are watched); after:reopen_gateway and finalize come after the reopen, and the recovery may fence
    # again: no single episode, so no window check for those
    $watch = $label -notmatch 'after:reopen_gateway|finalize'
    if ($watch) {
      $poll = Join-Path $script:OutDir ("poll-$Tag-$t.jsonl"); Remove-Item $poll -Force -ErrorAction SilentlyContinue
      $job = Start-FencePoller $poll
      Assert-PollerConnects "$label" $poll
    }
    $r = Invoke-KilledUpdate $label @() "$Tag-$t"
    Check "$label : the process was killed (137)" 137 $r.exit
    $j = Get-JournalDoc
    if ($label -like 'journal:*') { Assert-JournalAt $label $label }
    if ($j -ne $null) {
      $h = Invoke-Posctl @('health', '--write') -Tag "$Tag-health-$t"
      Check "$label : health exits 17 (RECOVERY_NEEDED) with the journal left behind" 17 $h.exit
      Check "$label : status.json state is recovery-needed" 'recovery-needed' ([string](Read-JsonFile (Join-Path $script:Data 'state\status.json')).state)
      $d = Invoke-Posctl @('update', '--pack', $script:NewV, '--dry-run') (Hooks @{}) -Tag "$Tag-dry-$t"
      Assert-Exit "$label : a dry run refuses while a journal is on disk" $d 'RECOVERY_NEEDED'
      Check "$label : ... and says recoveryPending" $true $d.json.data.recoveryPending
      Check "$label : ... and leaves the journal alone" $true (Test-Path (Get-UpdateReadPath 'journal.json'))
    } else { Add-Check "$label : a journal is on disk after the kill (the health, status and dry-run checks need it)" 'present' 'missing' $false }
    $rec = Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag "$Tag-recover-$t"
    Assert-Exit "$label : --recover" $rec 'OK'
    if ($watch) {
      Start-Sleep -Seconds 2; Stop-LanPoller $job; Assert-KilledFenceWindow $label $poll
      if ($RequireFence -and $label -notin @('journal:started:done', 'journal:fence:intent')) {
        $nf = Get-FenceRowCount $poll
        Check "$label : fenced - the poller saw data-path 503 STORE_UPDATING rows ($nf)" $true ($nf -gt 0)
      }
    }
    Assert-ConsistentStore $label $null $consistentPre
    $lvl = [string](Get-Cfg).pack.current
    $want = & $Expect $label
    if ($want -eq 'EITHER') { Check "$label : OLD or NEW, never mixed" $true ($lvl -eq $script:OldV -or $lvl -eq $script:NewV) }
    elseif ($want -eq 'OLD') { Check "$label : ends on the OLD level" $script:OldV $lvl }
    else { Check "$label : ends on the NEW level" $script:NewV $lvl }
    [void](Assert-StatusState $label 'running')
  }
  Assert-NoSecrets $Tag
}
function Test-ProcessAlive([int]$ProcessId) { try { $p = [System.Diagnostics.Process]::GetProcessById($ProcessId); return (-not $p.HasExited) } catch { return $false } }

# Plan 07b (K15): one LAN request with arbitrary request headers; returns @{ status; h (response headers, lower-case names); body; err }.
# This is a browser's view of the gateway: Origin / Access-Control-Request-* go in $Headers. -i output: HTTP/2 header names are lower-case, HTTP/1.1 are not, so names are lower-cased.
function Invoke-LanCurlHeaders([string]$Method, [string]$Path, [string[]]$Headers = @(), [int]$TimeoutSec = 5, [string]$Ip = '127.0.0.1') {
  $cfg = Get-Cfg; $port = $cfg.ports.base + 4; $name = Get-LanName
  $a = @('-sS', '-i', '--ssl-no-revoke', '--max-time', "$TimeoutSec", '--resolve', "${name}:${port}:${Ip}", '-X', $Method)
  foreach ($hd in $Headers) { $a += @('-H', $hd) }
  $a += "https://${name}:${port}${Path}"
  $o = & "$env:windir\System32\curl.exe" @a 2>&1
  $txt = (($o | ForEach-Object { "$_" }) -join "`n")
  if ($txt -match '^HTTP/\S+\s+(\d{3})') {
    $st = [int]$Matches[1]
    $parts = $txt -split "(?:\r?\n){2}", 2
    $h = @{}; $n = @{}   # n = how many lines each header name had (a duplicated Access-Control-Allow-Origin makes a browser refuse the answer)
    foreach ($line in ($parts[0] -split "\r?\n" | Select-Object -Skip 1)) { if ($line -match '^([^:]+):\s*(.*)$') { $k = $Matches[1].ToLower(); $h[$k] = $Matches[2].Trim(); $n[$k] = 1 + [int]$n[$k] } }
    $b = ''; if ($parts.Count -gt 1) { $b = $parts[1] }
    return @{ status = $st; h = $h; n = $n; body = $b; err = '' }
  }
  $e = ($txt -replace '\s+', ' ').Trim(); if ($e.Length -gt 160) { $e = $e.Substring(0, 160) }
  return @{ status = 0; h = @{}; n = @{}; body = ''; err = "curl exit $LASTEXITCODE $e" }
}
