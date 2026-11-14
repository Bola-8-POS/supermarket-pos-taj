# Creates a native test instance (posctl dev new, slot 4 by default) from a scratch copy of the unpacked dev pack that also
# carries this branch's migrations, then makes a throwaway "cloud" database `cloud_src` inside it and loads a dump of dev2 (READ-ONLY on dev2).
# The dev2 dump holds plaintext staff PINs: it lives under E:\tmp, never in the repo, and is deleted in `finally`.
# DOT-SOURCE it (`. .\new-switch-instance.ps1 -PackDir ...`): it sets $env:POS_SWITCH_* for the CALLER, and `pwsh -File` would lose them.
# run-fence-db-tests.ps1 does exactly that. pg_dump / pg_restore stderr is never echoed (it can quote row data): only an exit code.
param(
  [int]$Slot = 4,
  [Parameter(Mandatory)][string]$PackDir,                                        # the unpacked dev pack (POS_PACK_DIR)
  [string]$Posctl = (Join-Path $PSScriptRoot '..\..\target\debug\posctl.exe'),   # built with --features test-hooks
  [string]$Dev2Port = '56322',
  [string]$InstanceRoot = 'E:\tmp\two-mode-instances',                            # instances, scratch pack and the transient dump live here
  [string]$PgBin = 'C:\Program Files\PostgreSQL\17\bin'                            # host client tools for the dev2 dump only
)
$ErrorActionPreference = 'Stop'
if ($Slot -ne 4 -and $Slot -ne 5) { throw 'Plan 09 owns native slots 4-5 (ports 47440-47459, conventions v1.5)' }
if ($Dev2Port -ne '56322') { throw 'only dev2 (56322) may be read; never the selfhosted stack' }
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$root = Join-Path $InstanceRoot "slot$Slot"
$scratch = Join-Path $InstanceRoot "pack-switch-$Slot"
$port = 47400 + 10 * $Slot
$pg = $PgBin
$dump = Join-Path $InstanceRoot "cloud-data-slot$Slot.dump"
New-Item -ItemType Directory -Force $InstanceRoot | Out-Null
if (Test-Path $dump) { Remove-Item $dump -Force }                                # a stale dump from an aborted run holds plaintext PINs

# 0. A running instance holds its pack's exes open: destroy it before the scratch pack is rebuilt.
if (Test-Path $root) {
  $out = & $Posctl dev destroy --slot $Slot --json 2>&1
  Write-Host "step 0 destroy slot $Slot exit $LASTEXITCODE : $out"
}

# 1. A pack that has every migration of this branch (the prebuilt pack may be older).
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
Copy-Item $PackDir $scratch -Recurse
$m = Get-Content "$scratch\manifest.json" -Raw | ConvertFrom-Json
if ($m.PSObject.Properties.Name -contains 'catalog') { $m.PSObject.Properties.Remove('catalog') }   # the digest of an older catalog no longer applies
$files = [System.Collections.ArrayList]@($m.files)
foreach ($f in Get-ChildItem (Join-Path $repo 'supabase\migrations') -Filter *.sql) {
  $dest = Join-Path $scratch "migrations\$($f.Name)"
  if (Test-Path $dest) { continue }
  Copy-Item $f.FullName $dest
  # as-built manifest: files[] = {path, sha256, size}; migrations = {count, max}
  [void]$files.Add([pscustomobject]@{ path = "migrations/$($f.Name)"; sha256 = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower(); size = (Get-Item $dest).Length })
  $m.migrations.count = [int]$m.migrations.count + 1
  $ver = $f.Name.Substring(0, 14)
  if ([string]::CompareOrdinal($ver, [string]$m.migrations.max) -gt 0) { $m.migrations.max = $ver }
}
$m.files = $files.ToArray()
[IO.File]::WriteAllText("$scratch\manifest.json", ($m | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))

# 1b. `dev new` loads the pack at the full tier, so the edited manifest needs a signature: a THROWAWAY minisign key (as testsixtures\sign-pack.ps1),
# trusted through POSCTL_TEST_UPDATER_PUBKEY (test-hooks build only). The private key is deleted at once.
$keyDir = Join-Path ([IO.Path]::GetTempPath()) ("posctl-sign-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $keyDir | Out-Null
try {
  $cmd = Join-Path $keyDir 'signer.cmd'
  foreach ($line in @("npx tauri signer generate --ci -w `"$keyDir\signer.key`" -p `"`"", "npx tauri signer sign -f `"$keyDir\signer.key`" -p `"`" `"$scratch\manifest.json`"")) {
    Set-Content -Path $cmd -Value ("@echo off`r`ncd /d `"$repo`"`r`ncall " + $line) -Encoding ASCII
    & $cmd | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tauri signer failed: $line" }
  }
  Move-Item "$scratch\manifest.json.sig" "$scratch\manifest.json.minisig" -Force
  $env:POSCTL_TEST_UPDATER_PUBKEY = (Get-Content "$keyDir\signer.key.pub" -Raw).Trim()
} finally { Remove-Item $keyDir -Recurse -Force -ErrorAction SilentlyContinue }

# 2. The instance.
$out = & $Posctl dev new --slot $Slot --pack-dir $scratch --json
if ($LASTEXITCODE -ne 0) { throw "dev new failed ($LASTEXITCODE): $out" }
$o2 = & $Posctl dev start --slot $Slot --json
if ($LASTEXITCODE -ne 0) { throw "dev start failed ($LASTEXITCODE): $o2" }

# The pgpass file is at <root>\data\secrets (dev.rs instance_roots + Roots::secrets).
$pgpass = "$root\data\secrets\pgpass.conf"
$env:PGPASSFILE = $pgpass
$psql = "$PackDir\pg\bin\psql.exe"
function Mask([string]$t) { ($t -replace '[0-9]', '#') -replace "['""]", '?' }
function Q([string]$Db, [string]$Sql) { $ErrorActionPreference = 'Continue'; $o = & $psql -X -q -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U supabase_admin -d $Db -c $Sql 2>&1; if ($LASTEXITCODE -ne 0) { throw (Mask ($o | Out-String)) }; ($o | Out-String).Trim() }

$eap = $ErrorActionPreference                                                       # restored in `finally` on every path (this script is dot-sourced: the caller keeps what we leave)
try {
  # 3. cloud_src = a clone of the instance's live database (same schema, roles, pack SQL), then dev2's data.
  $ok = $false
  for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
    [void](Q 'template1' "DROP DATABASE IF EXISTS cloud_src WITH (FORCE)")
    [void](Q 'template1' "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid()")
    try { [void](Q 'template1' "CREATE DATABASE cloud_src TEMPLATE postgres STRATEGY = FILE_COPY OWNER postgres"); $ok = $true } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ok) { throw 'could not clone postgres into cloud_src' }

  # 4. dev2 data, read-only: every public base table (except the three the switch never copies) plus auth.users, auth.identities, storage.buckets.
  $env:PGPASSWORD = 'postgres'
  $tables = & "$pg\psql.exe" -X -q -A -t -h 127.0.0.1 -p $Dev2Port -U postgres -d postgres -c "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN ('pin_attempts','store_switch_state','till_sync_report') ORDER BY 1"
  $targs = @(); foreach ($t in $tables) { if ($t) { $targs += '-t'; $targs += "public.$t" } }
  $targs += @('-t', 'auth.users', '-t', 'auth.identities', '-t', 'storage.buckets')
  $ErrorActionPreference = 'Continue'                                                 # Windows PowerShell 5.1 turns redirected native stderr into a terminating error under 'Stop'
  & "$pg\pg_dump.exe" -h 127.0.0.1 -p $Dev2Port -U postgres -d postgres -Fc --data-only --no-owner --no-privileges -f $dump @targs 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "dev2 dump failed (pg_dump exit $LASTEXITCODE; stderr withheld)" }
  $ErrorActionPreference = $eap
  Remove-Item Env:PGPASSWORD
  # Entries look like: 123; 0 456 TABLE DATA public products postgres  ->  fields 5 and 6 are schema and table.
  $list = (& "$pg\pg_restore.exe" --list $dump 2>$null) | Where-Object { $_ -match ' TABLE DATA ' } | ForEach-Object { $f = $_ -split '\s+'; $f[5] + '.' + $f[6] }
  if (@($list).Count -lt 40) { throw "the dev2 dump lists only $(@($list).Count) tables" }
  # Fixture only (not product code): CASCADE is fine here, the product never uses it.
  [void](Q 'cloud_src' ("TRUNCATE TABLE " + ($list -join ', ') + " RESTART IDENTITY CASCADE"))
  $ErrorActionPreference = 'Continue'
  & "$pg\pg_restore.exe" --data-only --disable-triggers --single-transaction --exit-on-error --no-owner -h 127.0.0.1 -p $port -U supabase_admin -d cloud_src $dump 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "loading dev2 data into cloud_src failed (pg_restore exit $LASTEXITCODE; stderr withheld)" }
  $ErrorActionPreference = $eap
} finally {
  $ErrorActionPreference = $eap
  if (Test-Path $dump) { Remove-Item $dump -Force }
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

$env:POS_PACK_DIR = $scratch
$env:POS_SWITCH_PSQL = $psql
$env:POS_SWITCH_PORT = "$port"
$env:POS_SWITCH_PGPASS = $pgpass
Write-Host "POS_PACK_DIR=$scratch"
Write-Host "POS_SWITCH_PSQL=$psql"
Write-Host "POS_SWITCH_PORT=$port"
Write-Host "POS_SWITCH_PGPASS=$pgpass"
Write-Host 'cloud_src is ready (dev2 data, fence tables from this branch).'
