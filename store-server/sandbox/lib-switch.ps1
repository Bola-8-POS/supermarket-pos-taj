# store-server/sandbox/lib-switch.ps1 - helpers for scenarios 50-57 (Plan 09 Task 13). Dot-sourced AFTER lib.ps1 and lib-update.ps1.
# Windows PowerShell 5.1 syntax only. Runs inside the Sandbox. Processes are stopped only by PID / Process object, never by image name.
# The "cloud" is a database (cloud_src) on the SAME local Postgres, cloned from the live database BEFORE Save-Pristine, so every Reset-Store
# also resets the cloud. posctl reaches it only because the test-hooks build honours POSCTL_TEST_HOOKS {"allow_local_source":true}.
# STAGES (see each scenario header): Stage 1 = runs on a build WITHOUT Plan 10's importer (refusals, gates, plans);
#                                   Stage 2 = needs the integrated 09+10 build (a pack with the storage module, `photos import-from-cloud`).
if (-not (Get-Command Install-OldStore -ErrorAction SilentlyContinue)) { throw 'lib-switch.ps1 needs lib-update.ps1 loaded first' }
$ErrorActionPreference = 'Stop'
$script:ExitCodes['SWITCH_REFUSED'] = 40
$script:ExitCodes['SWITCH_FAILED_ROLLED_BACK'] = 41
$script:CloudDb = 'cloud_src'
$script:CloudAdminId = $null; $script:CloudAdminPin = $null; $script:CloudAdminEmail = $null   # set with the id in Install-SwitchStore: the product signs staff in as <id>@barpos.local (firstadmin.rs staff_email)
$script:FakeTills = New-Object System.Collections.ArrayList
$script:TillA = 'aaaaaaaa-0001-4000-8000-00000000a001'
$script:TillB = 'bbbbbbbb-0002-4000-8000-00000000b002'
$script:SkipCopy = @('till_sync_report', 'store_switch_state', 'pin_attempts')
# 11H: the cloud's staff-password pepper (64 lower-case hex, in memory only) and the console answers file. A switch run asks for the pepper and ONE admin PIN
# on the console; the test-hooks build reads them from this file (hook switch_console_file: a pepper line, then a PIN line per try). The file lives in %TEMP%
# (never evidence, never the data folder that Reset-Store mirrors), is written right before a run and removed as soon as the run is over (Remove-ConsoleAnswers).
$script:CloudPepper = $null
$script:ConsoleFile = Join-Path ([IO.Path]::GetTempPath()) 'sw-console-answers.txt'

# ---- hooks / stdin / invocation ---------------------------------------------------------------------------------------
function New-CloudPepper { return ([BitConverter]::ToString([byte[]](New-RandomBytes 32)).Replace('-', '').ToLower()) }   # = secrets::is_hex64 + enough distinct characters; New-RandomBytes returns ,$b (ONE byte[] item) so never pipe it (ForEach-Object would get the whole array: 5.1 'ToString' overload error)
function Get-DefaultAnswers { return @($script:CloudPepper, $script:CloudAdminPin) }   # the right pepper, then the right admin PIN
function Write-ConsoleAnswers([string[]]$Answers) { $t = ''; if (@($Answers).Count -gt 0) { $t = (@($Answers) -join "`n") + "`n" }; [IO.File]::WriteAllText($script:ConsoleFile, $t) }   # no answers = an EMPTY file (a blank line would be an answer)
function Remove-ConsoleAnswers { Remove-Item -LiteralPath $script:ConsoleFile -Force -ErrorAction SilentlyContinue }
function Sw-Hooks([hashtable]$Extra = @{}) { $h = @{ allow_local_source = $true; backup = 'ok'; switch_console_file = $script:ConsoleFile }; foreach ($k in $Extra.Keys) { $h[$k] = $Extra[$k] }; return (Hooks $h) }
function Get-CloudPassword {
  # pgpass escaping: a colon or backslash inside a field is written \: or \\ ; split on unescaped colons only, then unescape
  foreach ($l in (Get-Content (Join-Path $script:Data 'secrets\pgpass.conf'))) {
    $p = @([regex]::Split($l, '(?<!\\):') | ForEach-Object { ($_ -replace '\\(.)', '$1') })
    if ($p.Count -ge 5 -and $p[3] -eq 'supabase_admin') { return $p[4] }
  }
  throw 'no supabase_admin entry in pgpass.conf'
}
function Get-CloudStdin([switch]$WithStorage, [string]$Db = '') {
  if (-not $Db) { $Db = $script:CloudDb }
  $url = 'postgres://supabase_admin:' + [uri]::EscapeDataString((Get-CloudPassword)) + '@127.0.0.1:' + (Get-Cfg).ports.base + '/' + $Db + '?sslmode=disable'   # the Sandbox's loopback Postgres has no TLS; the product default for a missing sslmode is require
  $o =[ordered]@{ v = 1; db = @{ url = $url } }
  # while lib-cloud-storage-stub.ps1's stub runs ($script:StubUrl set) its url and key are used, so a real photo copy can happen
  if ($WithStorage) { $url2 = 'http://127.0.0.1:9'; if ($script:StubUrl) { $url2 = $script:StubUrl } else { $script:StorageKey = (New-RandomToken 30) }; $o['storage'] = @{ projectUrl = $url2; serviceRoleKey = $script:StorageKey } }
  return ($o | ConvertTo-Json -Compress -Depth 4)
}
# posctl switch <verb> --source-db-stdin <more>; stdin = the cloud credentials (never in the evidence: Invoke-Posctl saves args, stdout and stderr only)
# -Answers: the console lines of a `run` (default: the right pepper, then the right admin PIN; `-Answers @()` = nobody at the console). Plan/rollback never ask.
function Invoke-Switch([string]$Verb, [string[]]$More = @(), [hashtable]$Env = $null, [string]$Stdin = '', [string]$Tag = '', [int]$TimeoutSec = 3600, [string[]]$Answers = $null) {
  if ($Env -eq $null) { $Env = Sw-Hooks }
  if (-not $Stdin) { $Stdin = Get-CloudStdin }
  if ($PSBoundParameters.ContainsKey('Answers')) { $a = @($Answers) } else { $a = Get-DefaultAnswers }
  try {
    if ($Verb -eq 'run') { Write-ConsoleAnswers $a }
    return (Invoke-Posctl (@('switch', $Verb, '--source-db-stdin') + $More) $Env $Stdin -Tag $Tag -TimeoutSec $TimeoutSec)
  } finally { Remove-ConsoleAnswers }
}
# Like Start-PosctlAsync, but the credentials are written to stdin. The Process object is the only handle (a hung run is stopped through it, by id).
# The answers file is read when the run asks (before its first journal label): callers call Remove-ConsoleAnswers once the pause flag is up; Stop-FakeTills does too.
function Start-SwitchAsync([string[]]$More, [hashtable]$Env, [string]$Tag, [switch]$WithStorage) {
  Write-ConsoleAnswers (Get-DefaultAnswers)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:Posctl
  $psi.Arguments = ConvertTo-ArgLine (@('switch', 'run', '--source-db-stdin') + $More)
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  foreach ($k in $Env.Keys) { $psi.EnvironmentVariables[[string]$k] = [string]$Env[$k] }
  $p = [System.Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  $p.StandardInput.WriteLine((Get-CloudStdin -WithStorage:$WithStorage)); $p.StandardInput.Close()
  [void]$script:AsyncPids.Add($p)
  return [pscustomobject]@{ Process = $p; Pid = $p.Id; Out = $so; Err = $se; OutFile = (Join-Path $script:OutDir "$Tag.out.txt"); ErrFile = (Join-Path $script:OutDir "$Tag.err.txt") }
}
function Get-Codes($R, [string]$Level = 'block') { if ($R.json -and $R.json.data -and $R.json.data.findings) { return @($R.json.data.findings | Where-Object { $_.level -eq $Level } | ForEach-Object { [string]$_.code }) }; return @() }
# Sorted, de-duplicated, comma-joined: compare a finding set with ONE Check against the expected set (exact equality, not 'contains').
function Join-CodeSet($Codes) { return ((@($Codes) | Where-Object { $_ } | Sort-Object -Unique) -join ',') }

# ---- the cloud fixture --------------------------------------------------------------------------------------------------
function Cq([string]$Sql) { return (Psql $script:CloudDb $Sql) }
function Get-CloudRow { return (Cq "SELECT COALESCE((SELECT state || '|' || COALESCE(op_id::text,'') || '|' || (SELECT state FROM public.store_switch_effective_state()) FROM public.store_switch_state WHERE id), 'active||active')") }
function Get-CloudStateWord { return ((Get-CloudRow) -split '\|')[0] }
function Get-CloudOp { return ((Get-CloudRow) -split '\|')[1] }
function Get-CloudEffective { return ((Get-CloudRow) -split '\|')[2] }
function Get-CloudFingerprint { return (Cq "SELECT COALESCE((SELECT state || '/' || COALESCE(op_id::text,'') || '/' || since::text || '/' || COALESCE(until_at::text,'') || '/' || COALESCE(drain_since::text,'') FROM public.store_switch_state WHERE id), 'no-row')") }
# Fixture only: put the cloud row into a state an earlier operation could have left behind.
function Set-CloudHold([string]$State, [string]$Op, [int]$Minutes = 30) {
  [void](Cq "INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING; UPDATE public.store_switch_state SET state = '$State', op_id = '$Op', since = now(), drain_since = CASE WHEN '$State' = 'draining' THEN clock_timestamp() ELSE NULL END, until_at = CASE WHEN '$State' = 'moved' THEN NULL ELSE clock_timestamp() + interval '$Minutes minutes' END WHERE id")
}
function Set-CloudTill([string]$Uuid, [string]$Label, [int]$Queue, [int]$Dead = 0, [string]$Seen = 'active', [int]$AgeSeconds = 0) {
  [void](Cq "INSERT INTO public.till_sync_report (terminal_uuid, terminal_label, queue_depth, dead_letter_depth, seen_state, reported_by, reported_at) VALUES ('$Uuid', '$Label', $Queue, $Dead, '$Seen', '$($script:CloudAdminId)', now() - interval '$AgeSeconds seconds') ON CONFLICT (terminal_uuid) DO UPDATE SET queue_depth = EXCLUDED.queue_depth, dead_letter_depth = EXCLUDED.dead_letter_depth, seen_state = EXCLUDED.seen_state, reported_at = EXCLUDED.reported_at")
}
function Clear-CloudTills { [void](Cq 'DELETE FROM public.till_sync_report') }
function Add-CloudPhotos([int]$N) {   # stored files in the cloud (the pack must carry the storage tables: Install-SwitchStore stops otherwise)
  [void](Cq "INSERT INTO storage.buckets (id, name) VALUES ('product-photos', 'product-photos') ON CONFLICT DO NOTHING")
  for ($i = 1; $i -le $N; $i++) { [void](Cq "INSERT INTO storage.objects (bucket_id, name) VALUES ('product-photos', 'zz-test/p-$i.jpg')") }
}
function Test-PhotoImporter { $r = Invoke-Posctl @('photos', 'import-from-cloud', '--help') -Tag 'importer-probe'; return ($r.exit -eq 0) }

# A fake till: reports to the cloud like the app does (explicit reported_by). 'quiet' = depth 0 always. 'stuck' = depth 0 until the cloud says
# `draining`, then depth 2 for ever. 'always2' = depth 2 always (a till that is off with work in it: only a waiver lets the run pass). The job swallows psql failures (the Postgres service restarts under it during Reset-Store).
function Start-FakeTill([string]$Uuid, [string]$Label, [string]$Mode = 'quiet') {
  $log = Join-Path $script:OutDir "faketill-$Label.log"
  $job = Start-Job -ArgumentList (Get-PsqlExe), (Get-Cfg).ports.base, (Join-Path $script:Data 'secrets\pgpass.conf'), $script:CloudDb, $script:CloudAdminId, $Uuid, $Label, $Mode, $log -ScriptBlock {
    param($psql, $port, $pgpass, $db, $rep, $uuid, $label, $mode, $log)
    $env:PGPASSFILE = $pgpass
    function Q($sql) { $o = & $psql -w -X -q -A -t -h 127.0.0.1 -p $port -U supabase_admin -d $db -c $sql 2>&1; if ($LASTEXITCODE -ne 0) { Add-Content $log "psql exit $LASTEXITCODE"; return $null }; return (($o | ForEach-Object { "$_" }) -join "`n").Trim() }
    while ($true) {
      $st = Q 'SELECT state FROM public.store_switch_effective_state()'
      if ($st) {
        $depth = 0
        if ($mode -eq 'always2') { $depth = 2 } elseif ($mode -eq 'stuck' -and $st -eq 'draining') { $depth = 2; Add-Content $log 'reported depth 2 while draining' }
        [void](Q "INSERT INTO public.till_sync_report (terminal_uuid, terminal_label, queue_depth, dead_letter_depth, seen_state, reported_by, reported_at) VALUES ('$uuid', '$label', $depth, 0, '$st', '$rep', now()) ON CONFLICT (terminal_uuid) DO UPDATE SET queue_depth = EXCLUDED.queue_depth, seen_state = EXCLUDED.seen_state, reported_at = EXCLUDED.reported_at, reported_by = EXCLUDED.reported_by")
      }
      Start-Sleep -Seconds 2
    }
  }
  [void]$script:FakeTills.Add($job)
  return $job
}
function Stop-FakeTills { Remove-ConsoleAnswers; foreach ($j in @($script:FakeTills)) { try { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue } catch { } }; $script:FakeTills.Clear() }

# ---- the store -----------------------------------------------------------------------------------------------------------
# Provision the 'new' pack (the whole base: it carries the fence migrations) prepared for the switch (mode cloud, no first admin, but TLS on the LAN like any provision, so the plan can pair), clone the
# live database into cloud_src, give the cloud one admin, then Save-Pristine (so Reset-Store resets the cloud too).
# -Probe: a BEFORE TRUNCATE trigger on local public.profiles writes the effective statement_timeout into zz_probe.t (scenario 57 reads it).
function Install-SwitchStore([switch]$Probe) {
  Use-PackKey; [void](Ensure-VcRuntime); Install-Posctl; Use-PackKey
  $i = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:PackSrc 'new.pospack')) -Tag 'switch-pack-install' -TimeoutSec 1200
  Check 'setup: the pack installs' 0 $i.exit
  $script:OldV = $script:NewV; $script:PackVersion = $script:NewV   # Reset-Store re-activates $OldV: one pack here
  $p = Invoke-Posctl @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--prepare-for-switch', '--result-file', 'C:\out\switch-provision-result.json') -Tag 'switch-provision' -TimeoutSec 1800
  Check 'setup: provision --prepare-for-switch exits 0' 0 $p.exit
  # the PRODUCT trusts its own root (provision store_trust, prepare included); read-only check by thumbprint, the harness imports nothing
  $rootFile = Join-Path $script:Data 'pki\caddy\pki\authorities\local\root.crt'
  $thumb = if (Test-Path -LiteralPath $rootFile) { (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $rootFile).Thumbprint } else { '' }
  Check 'setup: provision --prepare-for-switch put the store root in LocalMachine\Root (product trust; the https LAN probes need it)' $true ($thumb -ne '' -and (Test-Path "Cert:\LocalMachine\Root\$thumb"))
  Invoke-ParkBackupTasks
  Check 'setup: the UpdateCheck task is disabled' 0 (Set-TaskEnabled 'UpdateCheck' $false)
  Check 'setup: the mode is cloud' 'cloud' ([string](Get-Cfg).mode)
  # plan/run read storage.buckets and storage.objects on BOTH sides (copy list, closure, column signature): without them every answer is a bare refusal
  $st = Psql 'postgres' "SELECT to_regclass('storage.objects') IS NOT NULL AND to_regclass('storage.buckets') IS NOT NULL"
  Check 'setup: the base pack carries the storage tables (storage.buckets, storage.objects)' 't' $st
  if ($st -ne 't') { throw 'needs a base pack that carries the storage tables (rebuild the base from the integrated 09+10 tip); scenarios 50-58 cannot answer without them' }
  $ok = $false
  for ($k = 0; $k -lt 20 -and -not $ok; $k++) {
    [void](Psql 'template1' "DROP DATABASE IF EXISTS $($script:CloudDb) WITH (FORCE)")
    [void](Psql 'template1' "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid()")
    $r = Invoke-PsqlAs 'supabase_admin' 'template1' "CREATE DATABASE $($script:CloudDb) TEMPLATE postgres" -AllowFailure
    if ($r.exit -eq 0) { $ok = $true } else { Start-Sleep -Milliseconds 500 }
  }
  Check 'setup: the cloud fixture database exists' $true $ok
  $script:CloudAdminId = [Guid]::NewGuid().ToString(); $script:CloudAdminPin = New-Digits6   # in memory only
  $script:CloudAdminEmail = Get-CloudAdminEmail $script:CloudAdminId
  # 11H: the fixture is a HOSTED cloud after the PIN-hash migration: profiles.pin is a bcrypt hash (the profiles_hash_pin trigger hashes the 6 digits on INSERT) and the admin's Auth
  # password is the bcrypt of the password DERIVED from id + PIN + the cloud pepper, so the console proof (PIN matches the hash, derived password verifies) can pass.
  Check 'setup: the base pack carries the 11H PIN-hash migration (profiles_hash_pin trigger, profiles_pin_is_bcrypt check)' 't' (Cq "SELECT (EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_hash_pin' AND NOT tgisinternal) AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_pin_is_bcrypt'))")
  $script:CloudPepper = New-CloudPepper
  $cloudPw = Get-DerivedPassword $script:CloudAdminId $script:CloudAdminPin $script:CloudPepper   # [A-Za-z0-9._-] only: safe inside the SQL literal
  # the token columns are '' not NULL: GoTrue cannot scan a NULL token column, which breaks password sign-in
  [void](Cq "INSERT INTO auth.users (instance_id, id, email, encrypted_password, email_confirmed_at, aud, role, raw_app_meta_data, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token, raw_user_meta_data, created_at, updated_at) VALUES ('00000000-0000-0000-0000-000000000000', '$($script:CloudAdminId)', '$($script:CloudAdminEmail)', extensions.crypt('$cloudPw', extensions.gen_salt('bf', 8)), now(), 'authenticated', 'authenticated', jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')), '', '', '', '', '', '', '', '', '{}'::jsonb, now(), now());INSERT INTO public.profiles (id, name, role, pin) VALUES ('$($script:CloudAdminId)', 'Switch Admin', 'admin', '$($script:CloudAdminPin)')")
  Check 'setup: the cloud admin PIN is stored as a bcrypt hash, not 6 digits' 't' (Cq "SELECT pin ~ '^\`$2[aby]\`$' AND pin !~ '^[0-9]{6}`$' FROM public.profiles WHERE id = '$($script:CloudAdminId)'")
  Check 'setup: the cloud admin Auth row holds a bcrypt hash' 't' (Cq "SELECT encrypted_password ~ '^\`$2[aby]\`$' FROM auth.users WHERE id = '$($script:CloudAdminId)'")
  Check 'setup: the cloud pepper is 64 lower-case hex' $true ($script:CloudPepper -cmatch '^[0-9a-f]{64}$')
  Check 'setup: the cloud pepper differs from this store''s own' $true ($script:CloudPepper -ne (Get-Pepper))
  Check 'setup: the cloud holds the fence (state table, report table, effective-state function)' 't' (Cq "SELECT to_regclass('public.store_switch_state') IS NOT NULL AND to_regclass('public.till_sync_report') IS NOT NULL AND to_regprocedure('public.store_switch_effective_state()') IS NOT NULL")
  Check 'setup: the cloud row reads active' 'active' (Get-CloudStateWord)
  if ($Probe) {
    [void](Psql 'postgres' "CREATE SCHEMA zz_probe; CREATE TABLE zz_probe.t (v bigint, at timestamptz DEFAULT clock_timestamp()); CREATE FUNCTION zz_probe.f() RETURNS trigger LANGUAGE plpgsql AS `$`$ BEGIN INSERT INTO zz_probe.t (v) SELECT setting::bigint FROM pg_settings WHERE name = 'statement_timeout'; RETURN NULL; END `$`$; CREATE TRIGGER zz_probe BEFORE TRUNCATE ON public.profiles FOR EACH STATEMENT EXECUTE FUNCTION zz_probe.f()")
  }
  Save-Pristine
}

# ---- local-side assertions -----------------------------------------------------------------------------------------------
function Get-SwitchSnapshot { return @{ StartTypes = (Get-StartTypes); Rows = (Get-RowCounts); Level = (Get-Level); AuthLevel = (Get-AuthLevel); Pepper = (Get-Pepper) } }   # Pepper: in memory only, compared, never printed
function Get-StagingResidue { return @(@(Get-ChildItem (Join-Path $script:Data 'backups') -Directory -Filter 'switch-*' -ErrorAction SilentlyContinue) + @(Get-ChildItem (Join-Path $script:Data 'state\update') -Directory -Filter 'cloud-pgpass-*' -ErrorAction SilentlyContinue)) }
# The local server is as it was before a switch that did not happen (refused, rolled back, or recovered back).
function Assert-LocalIntact([string]$Label, $Pre, [switch]$KeepFailedDb) {   # -KeepFailedDb: a failure after the swap keeps the failed database (pos_failed_*) on purpose
  $dbs = Get-DbNames
  Check "$Label : mode is still cloud" 'cloud' ([string](Get-Cfg).mode)
  Check "$Label : journal is gone" $false (Test-Path (Get-UpdateReadPath 'journal.json'))
  Check "$Label : $(if ($KeepFailedDb) { 'no pos_next / pos_prev_* database; exactly one pos_failed_* is kept' } else { 'no pos_next / pos_prev_* / pos_failed_* database' })" 0 @($dbs | Where-Object { $_ -eq 'pos_next' -or $_ -like 'pos_prev_*' -or (-not $KeepFailedDb -and $_ -like 'pos_failed_*') }).Count
  if ($KeepFailedDb) { Check "$Label : exactly one pos_failed_* database is kept" 1 @($dbs | Where-Object { $_ -like 'pos_failed_*' }).Count }
  Check "$Label : no staging folder left (backups\switch-*, state\update\cloud-pgpass-*)" 0 (Get-StagingResidue).Count
  Check "$Label : fence marker is gone" $false (Test-Path (Join-Path $script:Data 'conf\Caddyfile.live'))
  Check "$Label : migration level unchanged" $Pre.Level (Get-Level)
  Check "$Label : this store's own staff pepper is still the installed one, and no .prev is kept (11H: a refusal or rollback never leaves the cloud pepper in)" $true (($Pre.Pepper -eq (Get-Pepper)) -and -not (Test-Path (Join-Path $script:Data 'secrets\staff-password-pepper.txt.prev')))
  Check "$Label : local row counts unchanged" $Pre.Rows (Get-RowCounts)
  Check "$Label : start types are the pre-switch ones" (Format-Types $Pre.StartTypes) (Format-Types (Get-StartTypes))
  foreach ($r in $script:ServiceDbRoles) { Check "$Label : $r can log in" 't' (Get-RoleCanLogin $r) }
  Assert-GatewayPackVersion $Label $script:NewV
}
function Assert-PrivateFolder([string]$Label, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { Add-Check "$Label : exists" 'present' 'missing' $false; return }
  $s = Get-AclState $Path
  Check "$Label : owner is Administrators" 'S-1-5-32-544' $s.Owner
  Check "$Label : DACL is protected (no inheritance)" 'True' $s.Protected
  Check "$Label : only SYSTEM and Administrators have an entry" 'S-1-5-18,S-1-5-32-544' ((Get-AceSids $Path) -join ',')
}
function Get-SwitchProgress { return (Read-JsonFile (Get-UpdateReadPath 'switch-progress.json')) }
function Get-AlertCodes { $s = Get-StatusDoc; if ($s -and $s.alerts) { return @($s.alerts | ForEach-Object { [string]$_.code }) }; return @() }
function Write-SwitchProgress([string]$Phase, [string]$Cloud, [string]$Op) {   # fixture: a record an earlier run left (the real-run paths are 53/54/57)
  Write-JsonNoBom (Get-UpdateFilePath 'switch-progress.json') ([pscustomobject]@{ phase = $Phase; cloud = $Cloud; updated_ms = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); op_id = $Op })
}
function Set-LocalMode([string]$Mode) {
  $f = Join-Path $script:Data 'conf\posctl.json'
  $t = [IO.File]::ReadAllText($f)
  [IO.File]::WriteAllText($f, ($t -replace '"mode"\s*:\s*"[^"]*"', ('"mode": "' + $Mode + '"')), (New-Object Text.UTF8Encoding($false)))
}
function Assert-NoCloudSecrets([string]$Label, [string[]]$Values) {
  Reset-FindScan; $hits = @()
  foreach ($root in @((Join-Path $script:Data 'state'), (Join-Path $script:Data 'logs\posctl'), (Join-Path $script:OutDir 'evidence'))) { foreach ($v in $Values) { if ($v) { $hits += Find-Text $root $v } } }
  foreach ($f in @(Get-ChildItem $script:OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(out|err)\.txt$' })) { foreach ($v in $Values) { if ($v) { $hits += Find-Text $f.FullName $v } } }   # async runs (u50.*, u57*) write here
  Close-FindScan $Label 'cloud-secret'
  Check "$Label : the cloud password and the storage key appear in no state, posctl log or posctl output file" '' (($hits | Sort-Object -Unique) -join ',')
}
# the 6-digit admin PIN is NOT scanned for: a bare number matches timestamps and ports; the cloud password and the storage key are long and unique
function Get-AllSecretValues { return @((Get-CloudPassword), $script:StorageKey, $script:CloudPepper | Where-Object { $_ }) }   # the cloud pepper is 64 hex: unique, scanned for everywhere
# Independent proof that a re-derived admin can sign in on the NEW local server (derivation re-implemented in lib.ps1), plus a wrong-password control.
function Get-CloudAdminEmail([string]$Id) { return "$Id@barpos.local" }   # = crate::firstadmin::staff_email
# "HTTP 400 invalid_credentials: <msg>" from a GoTrue reply: error_code / msg fields only (a success body holds tokens and is never echoed)
function Format-GrantResult($R) {
  $code = ''; $msg = ''
  try { $j = [string]$R.Body | ConvertFrom-Json; if ($j.error_code) { $code = [string]$j.error_code } elseif ($j.error) { $code = [string]$j.error }; if ($j.msg) { $msg = [string]$j.msg } elseif ($j.error_description) { $msg = [string]$j.error_description } } catch { $msg = 'unparseable body' }
  if ($R.Status -eq 200) { return 'HTTP 200' }
  return (@("HTTP $($R.Status)", $code, $msg) | Where-Object { $_ }) -join ' '
}
function Assert-LocalSignIn([string]$Label) {
  $pw = Get-DerivedPassword $script:CloudAdminId $script:CloudAdminPin (Get-Pepper)
  $good = Invoke-Grant $script:CloudAdminEmail $pw
  $diag = ''
  if ($good.Status -ne 200) {   # best-effort row conditions GoTrue filters on; booleans only, no hashes or tokens
    try { $diag = '; local row (instance_id_null|aud|is_sso_user|not_deleted|confirmed|has_password): ' + (Psql 'postgres' "SELECT instance_id IS NULL, aud, is_sso_user, deleted_at IS NULL, email_confirmed_at IS NOT NULL, length(encrypted_password) > 0 FROM auth.users WHERE id = '$($script:CloudAdminId)'") } catch { $diag = '; local row query failed' }
  }
  Check "$Label : the cloud admin signs in on this server with the derived password (HTTP 200; got: $(Format-GrantResult $good)$diag)" 200 $good.Status
  # a lone 400 is no proof: GoTrue answers an unknown user and a wrong password with the same invalid_credentials, so the control only means
  # something after the right password was accepted above (same user, same server)
  $bad = Invoke-Grant $script:CloudAdminEmail ($pw + 'x')
  Check "$Label : control: a wrong password is refused (HTTP 400 invalid_credentials; got: $(Format-GrantResult $bad))" 'HTTP 400 invalid_credentials' ((Format-GrantResult $bad) -replace '^(HTTP \d+ \S+).*$', '$1')
}
function Get-CopiedRowCounts([string]$Db) { return (((Get-RowCounts $Db) -split "`r?`n" | Where-Object { $l = $_; $l -and -not ($script:SkipCopy | Where-Object { $l -like "$_=*" -or $l -like "public.$_=*" }) } | Sort-Object) -join ';') }

# ---- the one label-to-direction table (conventions: where record_move / committed_at happen) ---------------------------------
#  B0  cloud NEVER touched (steps strictly before Work): recovery quiet, cloud active, progress released, no alert
#  B0W work intent written right before begin_draining: it may or may not have run, the cloud row is still active at the kill, rollback frees nothing;
#      recovery quiet, progress `held` + op id, alert SWITCH_CLOUD_NOT_RELEASED (work.rs proves_never_drained is false at (Work, Intent))
#  B1  cloud held (draining/frozen) before the move window: recovery quiet (exit 0), alert SWITCH_CLOUD_NOT_RELEASED, `switch rollback` frees it
#  BW  in the move window (Swap, Activate, VerifyLive intent, before_mark_moved), cloud frozen: recovery LOUD (exit 17 CLOUD_MAY_BE_MOVED), local rolled back
#  M   cloud already moved, local rolled back (after_mark_moved, journal:verify_live:done): LOUD exit 17, `switch rollback <op>` returns the cloud
#  Leftover DBs after recovery: BW/M (swap done, except journal:swap:intent) keep exactly one pos_failed_* (rollback never drops it), no pos_next/pos_prev_*;
#      F keeps pos_prev_* instead (Assert-SwitchedStore).
#  F   from the Reopen intent on: recovery rolls FORWARD, cloud stays moved
function Get-SwitchLabelClass([string]$L) {
  if ($L -match '^journal:(started:done|fence:(intent|done)|backup:(intent|done)|repair_collation:(intent|done)|clone_db:(intent|done))$') { return 'B0' }
  if ($L -eq 'journal:work:intent') { return 'B0W' }
  if ($L -match '^journal:(work:done|verify_clone:(intent|done))$') { return 'B1' }
  if ($L -match '^journal:(swap|activate):(intent|done)$' -or $L -eq 'journal:verify_live:intent' -or $L -eq 'before_mark_moved') { return 'BW' }
  if ($L -eq 'journal:verify_live:done' -or $L -eq 'after_mark_moved') { return 'M' }
  if ($L -match '^journal:(reopen|finalize):(intent|done)$' -or $L -match '^(before|after):finish_unfence$' -or $L -eq 'after:reopen_gateway') { return 'F' }
  return $null
}
function Get-SwitchLabels { return (@(Get-KillLabels) + @('before_mark_moved', 'after_mark_moved')) }
function Assert-LabelTable([string]$Id) {
  $all = @(Get-SwitchLabels)
  Check "$Id the build lists 25 kill labels and the switch adds 2 hooks" 27 $all.Count
  Check "$Id every label is classified by the one table" '' ((@($all | Where-Object { -not (Get-SwitchLabelClass $_) })) -join ',')
  return $all
}

# ---- kill matrix for a switch ------------------------------------------------------------------------------------------------
function Get-FailCount { return @($script:Results | Where-Object { $_.pass -eq $false }).Count }
function Invoke-SwitchKillMatrix([string[]]$Labels, [string]$Tag) {
  $pre = Get-SwitchSnapshot
  [void](Start-FakeTill $script:TillA 'till-a' 'quiet')
  Check "$Tag setup: the fake till reported to the cloud" $true (Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 60 1)
  $first = $true
  foreach ($label in $Labels) {
    $cls = Get-SwitchLabelClass $label
    if (-not $first) { Reset-Store; [void](Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 90 1) }
    $first = $false
    $f0 = Get-FailCount
    $t = ($label -replace '[^A-Za-z0-9]', '_')
    $poll = Join-Path $script:OutDir ("poll-$Tag-$t.jsonl"); Remove-Item $poll -Force -ErrorAction SilentlyContinue
    $job = Start-FencePoller $poll
    Assert-PollerConnects "$label" $poll
    $r = Invoke-Switch 'run' @('--wait-minutes', '1') (Sw-Hooks @{ exit_at = $label }) -Tag "$Tag-$t"
    Check "$label [$cls] : the process was killed (137)" 137 $r.exit
    $j = Get-JournalDoc
    Check "$label [$cls] : a switch journal is on disk" 'switch' $(if ($j) { ([string]$j.kind).ToLower() } else { 'none' })
    if ($label -like 'journal:*') { Assert-JournalAt $label $label }
    $op = ''; if ($j) { $op = [string]$j.op_id }
    $h = Invoke-Posctl @('health', '--write') -Tag "$Tag-health-$t"
    Check "$label [$cls] : health exits 17 with the journal left behind" 17 $h.exit
    $alerts = Get-AlertCodes
    Check "$label [$cls] : the held alert is suppressed while the journal is open" $false ($alerts -contains 'SWITCH_CLOUD_NOT_RELEASED')
    if ($cls -eq 'M') { Check "$label [$cls] : status alerts SWITCH_CLOUD_MAY_BE_MOVED while the journal is open" $true ($alerts -contains 'SWITCH_CLOUD_MAY_BE_MOVED') }
    $blk = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag "$Tag-blocked-$t"
    if ($cls -ne 'F') { Assert-Exit "$label [$cls] : switch run refuses on top of the open journal" $blk 'RECOVERY_NEEDED' 'OPERATION_INCOMPLETE' }
    if ($cls -eq 'M') {
      $rb = Invoke-Switch 'rollback' @($op) -Tag "$Tag-rb-open-$t"
      Assert-Exit "$label [$cls] : rollback refuses while the journal is open and the cloud is moved" $rb 'SWITCH_REFUSED' 'OPEN_JOURNAL_CLOUD_MOVED'
    }
    if ($cls -eq 'F') {
      $rb = Invoke-Switch 'rollback' @($op) -Tag "$Tag-rb-open-$t"
      Check "$label [$cls] : rollback refuses past the point of no return (exit 40)" 40 $rb.exit
      Check "$label [$cls] : ... as PAST_POINT_OF_NO_RETURN or ALREADY_COMMITTED" $true (@('PAST_POINT_OF_NO_RETURN', 'ALREADY_COMMITTED') -contains [string]$rb.json.data.reason)
    }
    $rec = Invoke-Posctl @('update', '--recover') (Sw-Hooks) -Tag "$Tag-recover-$t"
    Start-Sleep -Seconds 2; Stop-LanPoller $job; Assert-KilledFenceWindow $label $poll
    switch ($cls) {
      'B0' {
        Assert-Exit "$label [B0] : --recover is quiet" $rec 'OK'
        Check "$label [B0] : the cloud was never touched (row active, no operation)" 'active|' ((Get-CloudRow) -replace '\|active$', '')
        Assert-LocalIntact "$label [B0]" $pre
        # Owner ruling (Alt 2): a clean recovery before the cloud was touched records `released`, so status raises no alert.
        Check "$label [B0] : progress cloud is released, with the operation id" "released/$op" "$([string](Get-SwitchProgress).cloud)/$([string](Get-SwitchProgress).op_id)"
        Check "$label [B0] : status raises no SWITCH_CLOUD_NOT_RELEASED (the cloud was never touched)" $false ((Get-AlertCodes) -contains 'SWITCH_CLOUD_NOT_RELEASED')
      }
      'B0W' {
        Assert-Exit "$label [B0W] : --recover is quiet" $rec 'OK'
        Check "$label [B0W] : the cloud row is still active (no operation)" 'active|' ((Get-CloudRow) -replace '\|active$', '')
        Assert-LocalIntact "$label [B0W]" $pre
        Check "$label [B0W] : progress cloud is held, with the operation id (begin_draining may have run)" "held/$op" "$([string](Get-SwitchProgress).cloud)/$([string](Get-SwitchProgress).op_id)"
        Check "$label [B0W] : status alerts SWITCH_CLOUD_NOT_RELEASED" $true ((Get-AlertCodes) -contains 'SWITCH_CLOUD_NOT_RELEASED')
      }
      'B1' {
        Assert-Exit "$label [B1] : --recover is quiet" $rec 'OK'
        Check "$label [B1] : the cloud is still held by this operation until it is given back" $true ((Get-CloudStateWord) -in @('draining', 'frozen') -and (Get-CloudOp) -eq $op)
        Assert-LocalIntact "$label [B1]" $pre
        Check "$label [B1] : status alerts SWITCH_CLOUD_NOT_RELEASED once the journal is gone" $true ((Get-AlertCodes) -contains 'SWITCH_CLOUD_NOT_RELEASED')
        $rb = Invoke-Switch 'rollback' @() -Tag "$Tag-rb-$t"
        Assert-Exit "$label [B1] : switch rollback (op from the progress record) frees the cloud" $rb 'OK'
        Check "$label [B1] : the cloud row reads active" 'active' (Get-CloudStateWord)
        Check "$label [B1] : progress cloud is released" 'released' ([string](Get-SwitchProgress).cloud)
        Check "$label [B1] : the alert is gone" $false ((Get-AlertCodes) -contains 'SWITCH_CLOUD_NOT_RELEASED')
      }
      { $_ -eq 'BW' -or $_ -eq 'M' } {
        Assert-Exit "$label [$cls] : --recover is LOUD (CLOUD_MAY_BE_MOVED)" $rec 'RECOVERY_NEEDED'
        Check "$label [$cls] : the report names the exact command" $true (($rec.raw + $rec.err) -match [regex]::Escape("posctl switch rollback $op"))
        $pg = Get-SwitchProgress
        Check "$label [$cls] : progress cloud is unknown, with the operation id" "unknown/$op" "$([string]$pg.cloud)/$([string]$pg.op_id)"
        Check "$label [$cls] : the cloud row is $(if ($cls -eq 'M') { 'moved' } else { 'frozen' }) by this operation" $(if ($cls -eq 'M') { "moved|$op" } else { "frozen|$op" }) ((Get-CloudStateWord) + '|' + (Get-CloudOp))
        # Leftover DB, per label: the loud recovery ROLLS BACK, and rollback keeps the failed live database as pos_failed_* (7-day prune).
        # The swap is complete at every M label and at every BW label except journal:swap:intent (killed before the swap ran: nothing to keep).
        $keepFailed = ($label -ne 'journal:swap:intent')
        Assert-LocalIntact "$label [$cls]" $pre -KeepFailedDb:$keepFailed
        Check "$label [$cls] : status alerts SWITCH_CLOUD_MAY_BE_MOVED" $true ((Get-AlertCodes) -contains 'SWITCH_CLOUD_MAY_BE_MOVED')
        $again = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag "$Tag-again-$t"
        Assert-Exit "$label [$cls] : switch run refuses while progress reads unknown" $again 'SWITCH_REFUSED' 'CLOUD_STATE_UNKNOWN'
        $rb = Invoke-Switch 'rollback' @($op) -Tag "$Tag-rb-$t"
        Assert-Exit "$label [$cls] : switch rollback <op> returns the cloud" $rb 'OK'
        Check "$label [$cls] : the cloud row reads active" 'active' (Get-CloudStateWord)
        Check "$label [$cls] : progress cloud is released" 'released' ([string](Get-SwitchProgress).cloud)
        Check "$label [$cls] : the alert is gone" $false ((Get-AlertCodes) -contains 'SWITCH_CLOUD_MAY_BE_MOVED')
        Assert-LocalIntact "$label [$cls] after rollback" $pre -KeepFailedDb:$keepFailed
      }
      'F' {
        Assert-Exit "$label [F] : --recover rolls forward" $rec 'OK'
        Assert-SwitchedStore "$label [F]" $op $rec
      }
    }
    $nf = (Get-FailCount) - $f0
    Add-Check "$label : class $cls ends as designed (all checks of this label)" '0 failed' "$nf failed" ($nf -eq 0)
  }
  Stop-FakeTills
  Assert-NoSecrets $Tag
  Assert-NoCloudSecrets $Tag (Get-AllSecretValues)
}
# The VITE_STORE_MODE value of a client store.env text ('' when absent). Only this one line is ever read out of the file or recorded.
function Get-StoreEnvMode([string]$Text) { $m = [regex]::Match($Text, '(?m)^VITE_STORE_MODE=(.*?)\s*$'); if ($m.Success) { return $m.Groups[1].Value } else { return '' } }
# After a switch that is done (success, or rolled forward by recovery). Used by 50, 55 B, 57 D and the class F (roll-forward) rows of the matrices 53/54/58.
# $R = the run/recovery result that finished the switch (optional): it must not carry SELF_PAIR_FAILED.
function Assert-SwitchedStore([string]$Label, [string]$Op, $R = $null) {
  # on_commit's server_self_pair (paircmd -> pairing/join.rs) wrote the server PC's client\store.env; the mode line is the only value recorded
  $envFile = Join-Path $script:Data 'client\store.env'
  $envText = if (Test-Path $envFile) { [string](Get-Content $envFile -Raw -ErrorAction SilentlyContinue) } else { '' }
  Check "$Label : the server PC has client\store.env after the switch" $true (Test-Path $envFile)
  Check "$Label : client\store.env mode line" 'offline-only' (Get-StoreEnvMode $envText)
  if ($R) { Check "$Label : no SELF_PAIR_FAILED in the finishing result" $false ((($R | ConvertTo-Json -Depth 8 -Compress) -match 'SELF_PAIR_FAILED')) }
  Check "$Label : mode is offline-only" 'offline-only' ([string](Get-Cfg).mode)
  Check "$Label : the cloud row is moved by this operation" "moved|$Op" ((Get-CloudStateWord) + '|' + (Get-CloudOp))
  Check "$Label : journal is gone" $false (Test-Path (Get-UpdateReadPath 'journal.json'))
  Check "$Label : the previous local database is kept" 1 @(Get-DbNames | Where-Object { $_ -like 'pos_prev_*' }).Count
  Check "$Label : no pos_next left" $false ((Get-DbNames) -contains 'pos_next')
  Check "$Label : no staging folder left" 0 (Get-StagingResidue).Count
  Check "$Label : fence marker is gone" $false (Test-Path (Join-Path $script:Data 'conf\Caddyfile.live'))
  Check "$Label : local copied row counts equal the cloud's" (Get-CopiedRowCounts $script:CloudDb) (Get-CopiedRowCounts 'postgres')
  Check "$Label : the CLOUD's pepper is now this store's pepper, and the machine's old one is dropped (no .prev)" $true (((Get-Pepper) -eq $script:CloudPepper) -and -not (Test-Path (Join-Path $script:Data 'secrets\staff-password-pepper.txt.prev')))
  Assert-LocalSignIn $Label
  $r = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag "again-$($Label -replace '[^A-Za-z0-9]', '_')"
  Assert-Exit "$Label : a second run is refused" $r 'SWITCH_REFUSED' 'ALREADY_SWITCHED'
  $rb = Invoke-Switch 'rollback' @($Op) -Tag "rb-$($Label -replace '[^A-Za-z0-9]', '_')"
  Assert-Exit "$Label : rollback is refused (the store runs here)" $rb 'SWITCH_REFUSED' 'ALREADY_COMMITTED'
  Check "$Label : the cloud is still moved after both refusals" "moved|$Op" ((Get-CloudStateWord) + '|' + (Get-CloudOp))
}
# Fixture: make a live holder look older than RUN_CEILING_MS (6 h 7 min) so `status` calls it hung. Only the info file's started_ms moves.
function Set-LockAge([int]$Seconds = 23000) {
  $f = Get-UpdateFilePath 'update.lock.info'
  $i = Read-JsonFile $f
  $i.started_ms = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) - ([int64]$Seconds * 1000)
  Write-JsonNoBom $f $i
  return [int]$i.pid
}

# ---- no unexpected public table (PM addition, Stage 1) ------------------------------------------------------------------------
# The expected set is DERIVED from the packaged migrations of the installed pack (CREATE TABLE / DROP TABLE in file order, schema public or
# unqualified), never listed by hand. Any public table (pg_class relkind r,p) that no migration creates fails BY NAME. Service images were not
# audited in code: this check is the evidence that none of them adds a public table. A table made by dynamic SQL inside a migration would show
# up here as unexpected: that is a finding to explain, not a check to loosen.
# Get-MigrationTables lives in lib-update.ps1 (shared with Assert-ConsistentStore).
function Assert-NoUnexpectedPublicTables([string]$Label) {
  $dir = Join-Path $script:Prog ("packs\" + (Get-Cfg).pack.current + '\migrations')
  $expected = @(Get-MigrationTables $dir)
  Check "$Label : the migrations of the installed pack yield a table set to compare with" $true ($expected.Count -gt 20)
  $live = @((Psql 'postgres' "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1") -split "`r?`n" | Where-Object { $_ })
  $extra = @($live | Where-Object { $expected -notcontains $_ })
  Save-Evidence "tables-$Label" ("expected=$($expected.Count) live=$($live.Count)`nextra: " + ($extra -join ', '))
  Check "$Label : no public table exists that a packaged migration does not create (extras named)" '' ($extra -join ',')
}

# A plan that answered: exit 0 or 40 AND a findings list. Without this, "finding X is not present" is vacuous (a bare refusal has no findings).
function Assert-PlanAnswered([string]$Label, $R) {
  Check "${Label}: the plan answered (exit 0 or 40)" $true (@(0, 40) -contains [int]$R.exit)
  Check "${Label}: the answer carries a findings list" $true ($R.json -ne $null -and $R.json.data -ne $null -and $R.json.data.findings -ne $null)
}
