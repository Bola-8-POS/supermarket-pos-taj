# Runs the hosted-fence DB tests (store-server/src/switch/fence_sql_tests.rs, cargo feature `fence-db-tests`) against a THROWAWAY native
# instance. Windows PowerShell 5.1 compatible. dev2 (56322) is only READ by new-switch-instance.ps1 (pg_dump); nothing here writes to it.
#   1. cargo build --features test-hooks   (`cargo test` alone would rebuild posctl.exe WITHOUT test-hooks, and the instance script needs them)
#   2. dot-source new-switch-instance.ps1  (sets $env:POS_SWITCH_* in this session; the instance carries every migration of this branch,
#      so both fence files are already applied to cloud_src, which is asserted below instead of applying them a second time)
#   3. cargo test --features fence-db-tests switch::fence_sql_tests -- --test-threads=1
#   4. finally: posctl dev destroy --slot <n>, then delete the scratch pack (pack-switch-<n>); both skipped with -Keep (red-check sessions).
#      0. Before anything: an exclusive lock <InstanceRoot>\slot<n>.lock (holder PID inside); a second runner exits 3 untouched.
#      A failing destroy is reported loudly (a leftover instance holds its ports and exes).
# -PackDir (the unpacked dev pack) is required: pass it, or set POS_BASE_PACK_DIR.
param(
  [int]$Slot = 4,
  [string]$PackDir = $env:POS_BASE_PACK_DIR,
  [string]$InstanceRoot = 'E:\tmp\two-mode-instances',
  [string]$PgBin = 'C:\Program Files\PostgreSQL\17\bin',
  [string]$Filter = 'switch::',
  [switch]$Keep,
  [switch]$NoCapture   # pass --nocapture to the test binary (shows println! output of passing tests)
)
$eapCaller = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
if (-not $PackDir) { throw 'PackDir is required: pass -PackDir <unpacked dev pack> or set POS_BASE_PACK_DIR' }
$store = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$posctl = Join-Path $store 'target\debug\posctl.exe'
$manifest = Join-Path $store 'Cargo.toml'
$provisioned = $false
$code = 1
# Exclusive slot lock, held for the WHOLE run (released in finally): a second runner on the same slot must fail before it touches the
# pack dir or destroys anything. FileShare.None; the holder writes its PID to slot<n>.lock.pid so the loser can name it.
New-Item -ItemType Directory -Force $InstanceRoot | Out-Null
$lockPath = Join-Path $InstanceRoot "slot$Slot.lock"
try {
  $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  # FileShare.None also blocks reads, so the PID lives in a sidecar file the holder writes after taking the lock.
  $holder = '?'
  try { $holder = (Get-Content -Raw "$lockPath.pid").Trim() } catch {}
  [Console]::Error.WriteLine("slot $Slot busy: locked by PID $holder ($lockPath); free it explicitly first")
  exit 3
}
Set-Content -Path "$lockPath.pid" -Value "$PID" -NoNewline
try {
  & cargo build --manifest-path $manifest --features test-hooks
  if ($LASTEXITCODE -ne 0) { throw "cargo build --features test-hooks failed ($LASTEXITCODE)" }
  $provisioned = $true
  . (Join-Path $PSScriptRoot 'new-switch-instance.ps1') -Slot $Slot -PackDir $PackDir -Posctl $posctl -InstanceRoot $InstanceRoot -PgBin $PgBin
  if (-not $env:POS_SWITCH_PORT -or -not $env:POS_SWITCH_PSQL -or -not $env:POS_SWITCH_PGPASS) { throw 'new-switch-instance.ps1 did not set POS_SWITCH_*' }
  $env:PGPASSFILE = $env:POS_SWITCH_PGPASS
  $guard = & $env:POS_SWITCH_PSQL -X -q -A -t -h 127.0.0.1 -p $env:POS_SWITCH_PORT -U supabase_admin -d cloud_src -c "SELECT pg_get_functiondef('public.store_fence_guard()'::regprocedure) LIKE '%FOR SHARE%'"
  if ("$guard".Trim() -ne 't') { throw 'cloud_src does not carry the 000002 hardening guard (FOR SHARE)' }
  # Capture the output: a green run that executed ZERO tests (a filter typo, every test #[ignore]d) must fail, and so must a filter
  # that reaches one of the two DB test modules with no executed test. No #[ignore] is left in these modules, so no --ignored.
  $eapRun = $ErrorActionPreference; $ErrorActionPreference = 'Continue'   # PS 5.1 turns cargo's stderr progress into errors under Stop
  $log = & cargo test --manifest-path $manifest --features fence-db-tests $Filter -- --test-threads=1 $(if ($NoCapture) { '--nocapture' }) 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $eapRun
  $log | ForEach-Object { Write-Host $_ }
  $passed = 0; $failed = 0; $ignored = 0
  foreach ($l in $log) { if ($l -match '^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored') { $passed += [int]$Matches[1]; $failed += [int]$Matches[2]; $ignored += [int]$Matches[3] } }
  Write-Host "DB TEST COUNT for filter '$Filter': passed=$passed failed=$failed ignored=$ignored"
  if ($code -eq 0 -and $passed -eq 0) { Write-Host 'NO TESTS EXECUTED: failing the run' -ForegroundColor Red; $code = 5 }
  if ($code -eq 0 -and $Filter -eq 'switch::') {
    foreach ($m in 'switch::fence_sql_tests::', 'switch::plan_tests::', 'switch::load_sql_tests::', 'switch::rederive_db::', 'switch::verify_db_tests::', 'switch::work_tests::') {
      # A test counts when its line is `test <name> ... ` and does not end in FAILED/ignored. With -NoCapture a passing test's own output
      # follows the `...` and the bare `ok` lands on the NEXT line, so `... ok$` alone would undercount; the run's exit code (0 above)
      # already rules out a failure, and a module with no started test still fails closed (n = 0 -> exit 5).
      $n = @($log | Where-Object { $_ -match ('^test ' + [regex]::Escape($m) + '.* \.\.\. ') -and $_ -notmatch ' (FAILED|ignored)$' }).Count
      Write-Host "  $m executed ok: $n"
      if ($n -eq 0) { Write-Host "NO TESTS EXECUTED in ${m} failing the run" -ForegroundColor Red; $code = 5 }
    }
  }
} finally {
  $ErrorActionPreference = 'Continue'
  if ($provisioned -and -not $Keep) {
    $out = & $posctl dev destroy --slot $Slot --json 2>&1
    Write-Host "finally destroy slot $Slot exit $LASTEXITCODE : $out"
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "posctl dev destroy --slot $Slot FAILED (exit $LASTEXITCODE): the throwaway instance may still be running; scratch pack left in place"
      Write-Host "!!! LEFTOVER INSTANCE: slot $Slot under $InstanceRoot !!!" -ForegroundColor Red
    } else {
      Remove-Item (Join-Path $InstanceRoot "pack-switch-$Slot") -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue
  $lock.Dispose()
  Remove-Item "$lockPath.pid" -ErrorAction SilentlyContinue
  $ErrorActionPreference = $eapCaller
}
exit $code
