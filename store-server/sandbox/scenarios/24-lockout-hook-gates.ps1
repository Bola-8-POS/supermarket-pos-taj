# 24 - the PIN-lockout hook gates.
#  A: with a hook variable missing / false / duplicated in gotrue.env, start and restart are refused (UNHEALTHY, exit 20)
#     and nothing is stopped; restoring the file lets restart through.
#  B: independent proof (not posctl's code) that the live hook locks the fifth wrong guess of a throwaway account.
#  C: CANARY_FAILED for real: kill provision while the canary step runs, drop the hook function, resume -> exit 22.
function New-ThrowawayUser {
  $k = Get-StoreKeys
  $email = ([guid]::NewGuid().ToString()) + '@barpos.local'
  $pw = 'tmp-' + (New-RandomToken 24)
  $h = @{ apikey = $k.service_role; Authorization = "Bearer $($k.service_role)" }
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Base + 5)/auth/v1/admin/users" -Method Post -Headers $h -ContentType 'application/json' -Body (@{ email = $email; password = $pw; email_confirm = $true } | ConvertTo-Json -Compress) -SkipHttpErrorCheck -TimeoutSec 30
  $id = $null; try { $id = ($r.Content | ConvertFrom-Json).id } catch { }
  [pscustomobject]@{ Email = $email; Id = $id; Status = [int]$r.StatusCode }
}
function Get-FiveWrongGrants([string]$Email) {
  1..5 | ForEach-Object { $x = Invoke-Grant $Email 'not-the-account-password' ($script:Base + 1); "$($x.Status) $($x.Body)" }
}
# The per-minute Health task holds update.lock for a few seconds: a command that finds it busy answers exit 10; retry.
function Invoke-PosctlRetry([string[]]$A, [string]$Name) {
  for ($i = 1; $i -le 8; $i++) { $r = Invoke-Posctl $A -Name $Name; if ($r.Exit -ne 10) { return $r }; Start-Sleep -Seconds 4 }
  return $r
}
function Set-GotrueEnv([string]$Text) { [IO.File]::WriteAllText((Join-Path $script:DataRoot 'secrets\gotrue.env'), $Text) }

function Invoke-Scenario([int]$Phase) {
  [void](Install-Posctl)
  [void](Ensure-VcRuntime)
  $envPath = Join-Path $script:DataRoot 'secrets\gotrue.env'

  # ===== A =====
  $p = Provision-Fresh 'C:\out\r24.json' '24-provision'
  Add-Check '24 provision (setup) exits 0' '0' (Format-Envelope $p.Result) ($p.Result.Exit -eq 0)
  if ($p.Result.Exit -ne 0) { Save-DataEvidence 'setup-failed'; return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; park them before the lifecycle commands (tick race, run 20261025-000013-20)
  $orig = [IO.File]::ReadAllText($envPath)
  Check-True '24 setup: the hook variables are present' (Test-HookEnv $orig)
  $authPid = (Get-ServiceInfo $script:Svc.Auth).ProcessId
  # the per-minute Health task runs the boot gate: left enabled it would stop Auth/Functions/Gateway in the middle of section A's
  # mutations. It is disabled for A and B and enabled again in D, where its own gating is the thing under test.
  foreach ($tn in 'Health', 'Canary') { & schtasks.exe /Change /TN "\SupermarketPOS\$tn" /DISABLE | Out-Null }
  $mutations = [ordered]@{
    'enabled-removed'   = ($orig -split "`r?`n" | Where-Object { $_ -notmatch '^GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=' }) -join "`n"
    'uri-removed'       = ($orig -split "`r?`n" | Where-Object { $_ -notmatch '^GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI=' }) -join "`n"
    'enabled-false'     = $orig.Replace('GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true', 'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=false')
    'enabled-duplicate' = $orig.TrimEnd() + "`nGOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=false`n"
  }
  foreach ($m in $mutations.Keys) {
    Set-GotrueEnv $mutations[$m]
    Check-True "24[$m] harness: the mutated file is no longer acceptable" (-not (Test-HookEnv $mutations[$m]))
    foreach ($cmd in @(@('restart', '--component', 'auth'), @('start', '--component', 'auth'), @('restart'), @('start'))) {
      $r = Invoke-Posctl $cmd -Name ("24-$m-" + ($cmd -join '-'))
      Add-Check "24[$m] posctl $($cmd -join ' ') is refused: UNHEALTHY, exit 20" '20 UNHEALTHY' (Format-Envelope $r) ($r.Exit -eq 20 -and $r.Json.code -eq 'UNHEALTHY')
    }
    Check-True "24[$m] a refused restart stopped nothing (all Running, same Auth process)" ((Test-AllRunning) -and ((Get-ServiceInfo $script:Svc.Auth).ProcessId -eq $authPid)) (Get-AllServiceStates)
  }
  # the boot path: SCM starts Auth by itself, without posctl (CARRY -> 05b). Recorded, not asserted.
  Set-GotrueEnv $mutations['enabled-removed']
  & sc.exe stop $script:Svc.Auth | Out-Null
  [void](Wait-Until { (Get-ServiceInfo $script:Svc.Auth).State -eq 'Stopped' } 60)
  & sc.exe start $script:Svc.Auth | Out-Null
  $bootStarted = Wait-Until { (Get-ServiceInfo $script:Svc.Auth).State -eq 'Running' } 60
  Add-Check '24 RECORDED (CARRY 05b): SCM start of Auth with a hook variable missing, no posctl involved' 'recorded: Auth Running means the boot path is not gated' "Auth Running=$bootStarted" $true
  Set-GotrueEnv $orig
  $r = Invoke-Posctl @('restart', '--component', 'auth') -Name '24-restored-restart-auth'
  Add-Check '24 after restoring the file, restart --component auth exits 0 and everything is Running' '0 / all Running' ((Format-Envelope $r) + ' ' + (Get-AllServiceStates)) ($r.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120))

  # ===== B =====
  $u = New-ThrowawayUser
  Check-Equal '24 harness: throwaway account created over the admin API' 200 $u.Status
  $g = @(Get-FiveWrongGrants $u.Email)
  Save-Evidence '24-five-wrong-grants' ($g -join "`n")
  Check-True '24 live hook: wrong guesses 1-4 are plain 400, not locked' (@($g[0..3] | Where-Object { $_ -match '^400 ' -and $_ -notmatch 'LOCKED:\d+' }).Count -eq 4) ($g[0..3] -join ' | ')
  Check-True '24 live hook: the fifth wrong guess answers LOCKED:<n>' ($g[4] -match '^400 .*LOCKED:\d+') $g[4]
  $adminId = [string]$p.Result.Json.data.firstAdmin.id
  $good = Invoke-Grant "$adminId@barpos.local" (Get-DerivedPassword $adminId $p.Digits (Get-Pepper))
  Check-Equal '24 the real first admin is not locked by the throwaway account guesses' 200 $good.Status

  # ===== D: the boot gate (Task 10 CARRY) =====
  # `health --write` (the scheduled task) with a hook variable missing stops Auth/Functions/Gateway and sets them to demand start,
  # so neither the SCM at boot nor anything else brings sign-in back until posctl itself checks and starts them.
  $sign = 'Gateway', 'Functions', 'Auth'
  # D0: the SCHEDULED path. Health task enabled, hook variable removed, nobody calls posctl: within a few minutes the task gates the stack by itself.
  & schtasks.exe /Change /TN '\SupermarketPOS\Health' /ENABLE | Out-Null
  Set-GotrueEnv $mutations['enabled-removed']
  Check-True '24[D0] the scheduled Health task alone stops Gateway, Functions and Auth (no posctl call from the harness)' (Wait-Until { @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0 } 200 2) (Get-AllServiceStates)
  & schtasks.exe /Change /TN '\SupermarketPOS\Health' /DISABLE | Out-Null
  Check-True '24[D0] their start type is Manual after the scheduled gate' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Manual' }).Count -eq 0) (($sign | ForEach-Object { "$_=$((Get-ServiceInfo $script:Svc[$_]).StartMode)" }) -join ' ')
  Set-GotrueEnv $orig
  $s0 = Invoke-PosctlRetry @('start') '24-D0-start-restored'
  Add-Check '24[D0] with the file restored posctl start brings everything back (exit 0, all Running, start type Auto)' '0 / all Running / Auto' ((Format-Envelope $s0) + ' ' + (Get-AllServiceStates)) ($s0.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120 1) -and @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Auto' }).Count -eq 0)
  # D: the same through an explicit `health --write`
  Set-GotrueEnv $mutations['enabled-removed']
  $gate = Invoke-PosctlRetry @('health', '--write') '24-D-health-write-gate'
  Add-Check '24[D] health --write with a hook variable missing exits 22 (CANARY_FAILED)' '22 CANARY_FAILED' (Format-Envelope $gate) ($gate.Exit -eq 22)
  Check-True '24[D] Gateway, Functions and Auth are Stopped' (Wait-Until { @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0 } 60 1) (Get-AllServiceStates)
  Check-True '24[D] Postgres and Rest keep running (only the sign-in stack is gated)' ((Get-ServiceInfo $script:Svc.Postgres).State -eq 'Running' -and (Get-ServiceInfo $script:Svc.Rest).State -eq 'Running') (Get-AllServiceStates)
  Check-True '24[D] the three gated services now have start type Manual (demand)' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Manual' }).Count -eq 0) (($sign | ForEach-Object { "$_=$((Get-ServiceInfo $script:Svc[$_]).StartMode)" }) -join ' ')
  Start-Sleep -Seconds 30
  Check-True '24[D] still Stopped 30 s later (nothing restarts them)' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0) (Get-AllServiceStates)
  $stj = Get-Content (Join-Path $script:DataRoot 'state\status.json') -Raw | ConvertFrom-Json
  Check-True '24[D] status.json records envOk=false and the LOCKOUT_HOOK_INACTIVE alert' ($stj.lockoutHook.envOk -eq $false -and @($stj.alerts | Where-Object { $_.code -eq 'LOCKOUT_HOOK_INACTIVE' }).Count -eq 1) ($stj.lockoutHook | ConvertTo-Json -Compress)
  $s1 = Invoke-PosctlRetry @('start') '24-D-start-refused'
  Add-Check '24[D] posctl start with the bad file is refused: UNHEALTHY, exit 20, and the three stay Stopped' '20 / Stopped' ((Format-Envelope $s1) + ' ' + (Get-AllServiceStates)) ($s1.Exit -eq 20 -and @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0)
  # SEC-I1: naming only a dependent must not slip past the gate (the SCM would start Auth for it)
  foreach ($cmd in @(@('start', '--component', 'gateway'), @('restart', '--component', 'gateway'), @('start', '--component', 'functions'))) {
    $rg = Invoke-PosctlRetry $cmd ('24-D-gated-' + ($cmd -join '-'))
    Add-Check "24[D] posctl $($cmd -join ' ') with the bad file is refused (exit 20) and Auth stays Stopped" '20 / Auth Stopped' ((Format-Envelope $rg) + ' ' + (Get-AllServiceStates)) ($rg.Exit -eq 20 -and (Get-ServiceInfo $script:Svc.Auth).State -eq 'Stopped')
  }
  Set-GotrueEnv $orig
  $s2 = Invoke-PosctlRetry @('start') '24-D-start-restored'
  Add-Check '24[D] with the file restored, posctl start exits 0 and everything is Running' '0 / all Running' ((Format-Envelope $s2) + ' ' + (Get-AllServiceStates)) ($s2.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120 1))
  Check-True '24[D] posctl start restored start type Auto on the three' (@($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Auto' }).Count -eq 0) (($sign | ForEach-Object { "$_=$((Get-ServiceInfo $script:Svc[$_]).StartMode)" }) -join ' ')

  # ===== E: a failed canary is persisted; start refuses until a canary passes =====
  $pgf = Invoke-Psql "SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pos_lockout' AND p.proname = 'password_verification_hook'"
  $sig = $pgf.Out.Trim()
  # E1: the function is GONE. GoTrue answers every sign-in with HTTP 500 (fails closed); the canary cannot judge it (Unexpected), so
  # it is UNHEALTHY (exit 20), not CANARY_FAILED (22): classify_canary treats a server error as no verdict. Recorded, not a gate.
  $off = $sig -replace 'password_verification_hook', 'password_verification_hook_off'
  $ren = Invoke-Psql "ALTER FUNCTION $sig RENAME TO password_verification_hook_off"
  Check-Equal '24[E1] harness: hook function renamed away' 0 $ren.Exit
  $cf1 = Invoke-PosctlRetry @('health', '--canary', '--write') '24-E1-health-canary-gone'
  Add-Check '24[E1] RECORDED: health --canary --write with the hook function gone (sign-in fails closed with HTTP 500)' 'exit 20 UNHEALTHY, canary could not be judged' (Format-Envelope $cf1) ($cf1.Exit -eq 20 -and $cf1.Json.code -eq 'UNHEALTHY')
  $bad = Invoke-Grant "$adminId@barpos.local" 'not-the-password'
  Add-Check '24[E1] with the hook function gone no sign-in succeeds (the real admin with a wrong password gets a non-200)' 'status != 200' $bad.Status ($bad.Status -ne 200)
  $back1 = Invoke-Psql "ALTER FUNCTION $off RENAME TO password_verification_hook"
  Check-Equal '24[E1] harness: hook function renamed back' 0 $back1.Exit

  # E2: the hook function EXISTS but never locks (the bypass the canary exists for): replace its body, keep the signature and grants
  $defFile = 'C:\hook-def.sql'
  $def = (Invoke-Psql "SELECT pg_get_functiondef('$sig'::regprocedure)").Out
  [IO.File]::WriteAllText($defFile, $def.Trim() + ";`n")
  Check-True '24[E2] harness: the original hook definition was saved' ($def -match 'CREATE OR REPLACE FUNCTION pos_lockout\.password_verification_hook') $def.Substring(0, [Math]::Min(120, $def.Length))
  $hookArgs = (Invoke-Psql "SELECT pg_get_function_arguments('$sig'::regprocedure)").Out.Trim()
  $noop = "CREATE OR REPLACE FUNCTION pos_lockout.password_verification_hook($hookArgs) RETURNS jsonb LANGUAGE sql AS 'select jsonb_build_object(''decision'', ''continue'')'"
  $rep = Invoke-Psql $noop
  Check-Equal '24[E2] harness: hook replaced by one that never locks' 0 $rep.Exit
  $cf = Invoke-PosctlRetry @('health', '--canary', '--write') '24-E2-health-canary-fail'
  Add-Check '24[E2] health --canary --write with a hook that never locks exits 22 (CANARY_FAILED)' '22 CANARY_FAILED' (Format-Envelope $cf) ($cf.Exit -eq 22 -and $cf.Json.code -eq 'CANARY_FAILED')
  $cj = $null; try { $cj = Get-Content (Join-Path $script:DataRoot 'state\canary.json') -Raw | ConvertFrom-Json } catch { }
  Check-True '24[E2] state\canary.json now records lastOk=false' ($cj -and $cj.lastOk -eq $false) ($cj | ConvertTo-Json -Compress)
  Check-True '24[E2] the sign-in stack is gated (Gateway, Functions, Auth Stopped)' (Wait-Until { @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0 } 60 1) (Get-AllServiceStates)
  $s3 = Invoke-PosctlRetry @('start') '24-E2-start-refused'
  Add-Check '24[E2] posctl start is refused on the persisted failed canary (exit 22) and the stack stays Stopped' '22 / Stopped' ((Format-Envelope $s3) + ' ' + (Get-AllServiceStates)) ($s3.Exit -eq 22 -and @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0)
  foreach ($cmd in @(@('start', '--component', 'gateway'), @('restart', '--component', 'gateway'))) {
    $rg = Invoke-PosctlRetry $cmd ('24-E2-gated-' + ($cmd -join '-'))
    Add-Check "24[E2] posctl $($cmd -join ' ') on the persisted failed canary is refused (exit 22) and Auth stays Stopped" '22 / Auth Stopped' ((Format-Envelope $rg) + ' ' + (Get-AllServiceStates)) ($rg.Exit -eq 22 -and (Get-ServiceInfo $script:Svc.Auth).State -eq 'Stopped')
  }
  $s3b = Invoke-PosctlRetry @('start', '--canary') '24-E2-start-canary-still-bad'
  Add-Check '24[E2] start --canary while the hook still never locks is refused too (exit 22) and the stack is gated again' '22 / Stopped' ((Format-Envelope $s3b) + ' ' + (Get-AllServiceStates)) ($s3b.Exit -eq 22 -and (Wait-Until { @($sign | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0 } 60 1))
  $psqlExe = Get-PackPath 'pg\bin\psql.exe'
  $env:PGPASSFILE = Join-Path $script:DataRoot 'secrets\pgpass.conf'
  $restore = & $psqlExe -h 127.0.0.1 -p $script:Base -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 -f $defFile 2>&1
  Check-Equal '24[E2] harness: original hook definition restored' 0 $LASTEXITCODE
  $s4 = Invoke-PosctlRetry @('start', '--canary') '24-E2-start-canary'
  Add-Check '24[E2] with the real hook back, start --canary passes the canary: exit 0, everything Running' '0 / all Running' ((Format-Envelope $s4) + ' ' + (Get-AllServiceStates)) ($s4.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120 1))
  $cj2 = $null; try { $cj2 = Get-Content (Join-Path $script:DataRoot 'state\canary.json') -Raw | ConvertFrom-Json } catch { }
  Check-True '24[E2] state\canary.json is lastOk=true again' ($cj2 -and $cj2.lastOk -eq $true) ($cj2 | ConvertTo-Json -Compress)
  $good2 = Invoke-Grant "$adminId@barpos.local" (Get-DerivedPassword $adminId $p.Digits (Get-Pepper))
  Check-Equal '24[E2] the first admin signs in again' 200 $good2.Status
  Remove-Item $defFile -Force -ErrorAction SilentlyContinue

  # ===== C =====
  $sid = [string]$p.Result.Json.data.storeId
  $c = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', (($sid -replace '-', '').Substring(0, 8))) -Name '24-cleanup-A'
  Add-Check '24 cleanup A: unprovision --delete-data' '0, services gone' ((Format-Envelope $c) + ' ' + (Get-AllServiceStates)) ($c.Exit -eq 0 -and (Test-AllAbsent))

  $digits = New-Digits6
  $a = @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', 'C:\out\r24-c-first.json')
  $h = [Diagnostics.Process]::Start((New-PosctlStartInfo $a)); $h.StandardInput.WriteLine($digits); $h.StandardInput.Close()
  $so = $h.StandardOutput.ReadToEndAsync(); $se = $h.StandardError.ReadToEndAsync()
  $hit = $false; $end = (Get-Date).AddSeconds(900)
  while ((Get-Date) -lt $end -and -not $h.HasExited) {
    $steps = @(Get-JournalSteps)
    if (@($steps | Where-Object { $_.name -eq 'canary' -and $_.state -eq 'started' }).Count -gt 0 -and @($steps | Where-Object { $_.name -eq 'start_stack' -and $_.state -eq 'done' }).Count -gt 0) { $h.Kill($true); $hit = $true; break }
    Start-Sleep -Milliseconds 50
  }
  [void]$h.WaitForExit(30000)
  Check-True '24[C] provision killed while the canary step was Started (stack up, hook not yet exercised)' $hit "ended early, exit $($h.ExitCode)"
  if ($hit) {
    Start-Sleep -Seconds 3
    $pg = Invoke-Psql "SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pos_lockout' AND p.proname = 'password_verification_hook'"
    $fn = $pg.Out.Trim()
    Check-True '24[C] harness: the hook function exists (found via psql as supabase_admin)' ($pg.Exit -eq 0 -and $fn.Length -gt 0) $pg.Out
    $cDefFile = 'C:\hook-def-c.sql'
    [IO.File]::WriteAllText($cDefFile, (Invoke-Psql "SELECT pg_get_functiondef('$fn'::regprocedure)").Out.Trim() + ";`n")
    $drop = Invoke-Psql "DROP FUNCTION $fn"
    Check-Equal '24[C] harness: hook function dropped' 0 $drop.Exit
    $res = Invoke-Posctl @('provision', '--resume', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', 'C:\out\r24-c-resume.json') $digits -Name '24-C-resume-hook-dropped'
    # a missing function is HTTP 500 on every sign-in (fails closed): the canary has no verdict (Unexpected) -> UNHEALTHY (20); the provision step still stops the sign-in stack
    Add-Check '24[C] resume with the hook function gone: UNHEALTHY (exit 20), canary could not be judged, the sign-in stack was stopped' '20 UNHEALTHY, "were stopped"' (Format-Envelope $res) ($res.Exit -eq 20 -and $res.Json.code -eq 'UNHEALTHY' -and $res.Json.message -match 'were stopped')
    Check-True '24[C] Auth, Functions and Gateway are Stopped after the failed canary step' ((@('Gateway', 'Functions', 'Auth') | Where-Object { (Get-ServiceInfo $script:Svc[$_]).State -ne 'Stopped' }).Count -eq 0) (Get-AllServiceStates)
    Add-Check '24[C] state after the canary failure (recorded: the stack should be stopped)' 'recorded' (Get-AllServiceStates) $true
    Check-True '24[C] no first admin was created on a failed canary' ((@(Get-JournalSteps | Where-Object { $_.name -eq 'first_admin' -and $_.state -eq 'done' }).Count) -eq 0) ((Get-JournalSteps | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ')
    Save-DataEvidence 'C-after-canary-failure'
    # CR-I1: restore the hook and resume: the services the failed canary set to manual start must be back on automatic start
    $env:PGPASSFILE = Join-Path $script:DataRoot 'secrets\pgpass.conf'
    $cRestore = & (Get-PackPath 'pg\bin\psql.exe') -h 127.0.0.1 -p $script:Base -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 -f $cDefFile 2>&1
    $cRc = $LASTEXITCODE
    if ($cRc -ne 0) { throw "24[C] harness: restoring the original hook definition failed (psql exit $cRc): $((($cRestore | ForEach-Object { "$_" }) -join "`n").Trim())" }
    Check-Equal '24[C] harness: original hook definition restored' 0 $cRc
    $res2 = Invoke-Posctl @('provision', '--resume', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', 'C:\out\r24-c-resume2.json') $digits -Name '24-C-resume-hook-restored'
    $three = 'Gateway', 'Functions', 'Auth'
    Add-Check '24[C] resume with the hook restored exits 0 and everything is Running' '0 / all Running' ((Format-Envelope $res2) + ' ' + (Get-AllServiceStates)) ($res2.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120 1))
    if ($res2.Exit -eq 0) { Invoke-ParkBackupTasks -Label ' [C] resumed store' }   # park only a store whose provision completed (the tasks are registered)
    Check-True '24[C] after the resume Auth, Functions and Gateway have start type Auto (CR-I1)' (@($three | Where-Object { (Get-ServiceInfo $script:Svc[$_]).StartMode -ne 'Auto' }).Count -eq 0) (($three | ForEach-Object { "$_=$((Get-ServiceInfo $script:Svc[$_]).StartMode)" }) -join ' ')
    Remove-Item $cDefFile -Force -ErrorAction SilentlyContinue
    $sid2 = Get-StoreId
    if ($sid2) {
      $c2 = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', (($sid2 -replace '-', '').Substring(0, 8))) -Name '24-cleanup-C'
      Add-Check '24 cleanup C: unprovision --delete-data after a failed canary' '0, services gone' ((Format-Envelope $c2) + ' ' + (Get-AllServiceStates)) ($c2.Exit -eq 0 -and (Test-AllAbsent))
    }
  }
  return @{ Results = (Get-Results); Reboot = $false }
}
