# 21 - every #[ignore] test of the crate, run elevated in a clean sandbox: the ACL owner test (SeTakeOwnership),
# the real pack loads, the real run-order, and the real throwaway cluster (initdb + psql + loopback-only hba).
# POS_PACK_DIR points at the MAPPED pack (read-only). A failure there is re-run against a local copy to tell a harness
# limit (read-only share) from a product bug.
function Invoke-TestExe([string]$Exe, [string[]]$TestArgs, [string]$Tag, [int]$TimeoutSec = 900) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  foreach ($a in $TestArgs) { [void]$psi.ArgumentList.Add($a) }
  $p = [Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill($true); $timedOut = $true } else { $timedOut = $false; $p.WaitForExit() }
  $text = "args: $($TestArgs -join ' ')`nexit: $(if ($timedOut) { 'TIMEOUT' } else { $p.ExitCode })`n--- stdout ---`n$($so.Result)`n--- stderr ---`n$($se.Result)"
  Save-Evidence "tests-$Tag" $text
  [pscustomobject]@{ Exit = $(if ($timedOut) { -1 } else { $p.ExitCode }); Out = $so.Result; Err = $se.Result; TimedOut = $timedOut }
}

# Per-test verdicts from libtest output. A test that starts postgres/psql interleaves their stdout with libtest's "test <name> ... ", and the
# status (ok|FAILED|ignored) then lands as a bare line after that noise, so each test's verdict is read from ITS OWN segment (from its
# "test <name> ... " marker to the next marker, "failures:" or "test result:"), never from the whole output.
#  - a name in libtest's final failures list is FAILED whatever its segment says; otherwise the LAST bare status line of the segment wins
#  - a segment that runs to the end of the output (timeout, crash) has no verdict: status 'aborted'
#  - no marker at all = the caller reports 'not run'
# Passed is the "N passed" of the summary line (or -1 when there is none), for the caller's ok-count guard.
function Get-TestVerdicts([string]$Out) {
  $v = [hashtable]::new([StringComparer]::Ordinal)
  $ms = [regex]::Matches($Out, '(?m)^test (\S+) \.\.\. ')
  $ends = @([regex]::Matches($Out, '(?m)^(?:successes:|failures:|test result:)') | ForEach-Object { $_.Index })
  $failed = @{}
  $lastFail = [regex]::Matches($Out, '(?m)^failures:')
  $sum = [regex]::Match($Out, '(?m)^test result: \w+\. (\d+) passed')
  if ($lastFail.Count -gt 0) {
    $from = $lastFail[$lastFail.Count - 1].Index
    $to = $Out.Length
    $tm = [regex]::Match($Out.Substring($from), '(?m)^test result:')
    if ($tm.Success) { $to = $from + $tm.Index }
    foreach ($l in ($Out.Substring($from, $to - $from) -split "`r?`n")) { if ($l -match '^    (\S+)\s*$') { $failed[$Matches[1]] = $true } }
  }
  for ($i = 0; $i -lt $ms.Count; $i++) {
    $name = $ms[$i].Groups[1].Value
    $start = $ms[$i].Index; $end = $Out.Length; $closed = $false
    if ($i + 1 -lt $ms.Count) { $end = $ms[$i + 1].Index; $closed = $true }
    foreach ($e in $ends) { if ($e -gt $start -and $e -lt $end) { $end = $e; $closed = $true } }
    $st = 'not run'
    foreach ($l in ($Out.Substring($start, $end - $start) -split "`r?`n")) { if ($l -match '^(?:test \S+ \.\.\. )?(ok|FAILED|ignored)\s*$') { $st = $Matches[1] } }
    if ($failed.ContainsKey($name)) { $st = 'FAILED' }
    elseif (-not $closed) { $st = 'aborted' }
    $panic = ''
    if ($st -eq 'FAILED') {
      $pm = [regex]::Match($Out, '(?ms)^---- ' + [regex]::Escape($name) + ' stdout ----\r?\n(.*?)(?=^---- |^failures:)')
      $panic = (@($pm.Groups[1].Value -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 6) -join ' | ')
    }
    $v[$name] = [pscustomobject]@{ Status = $st; Panic = $panic }
  }
  $passed = -1; if ($sum.Success) { $passed = [int]$sum.Groups[1].Value }
  return [pscustomobject]@{ Verdicts = $v; Passed = $passed }
}

function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  $meta = Get-PayloadMeta
  $env:POS_PACK_DIR = "C:\payload\pack\$($meta.packVersion)"
  $env:POS_SIGNED_PACK = "C:\payload\$($meta.signedPack)"; $env:POS_SIGNED_PUB = (Join-Path $script:Payload 'test-pubkey.txt')   # a_real_signed_pack_installs_and_loads
  $listed = @()
  foreach ($t in $meta.testExes) {
    $exe = Join-Path $script:Payload "tests\$t"
    $l = Invoke-TestExe $exe @('--ignored', '--list') "list-$t" 120
    $names = @($l.Out -split "`r?`n" | Where-Object { $_ -match ': test$' } | ForEach-Object { $_ -replace ': test$', '' })
    $listed += @($names | ForEach-Object { [pscustomobject]@{ Exe = $exe; Name = $_ } })
  }
  Add-Check '21 the crate has ignored tests to run (expected: acl owner, real pack, pg cluster, run-order)' '>= 4' $listed.Count ($listed.Count -ge 4)
  Check-True '21 the elevated ACL-owner test is among them' (@($listed | Where-Object { $_.Name -like '*elevated_apply_sets_administrators_as_owner_and_the_exact_dacl' }).Count -eq 1) (($listed.Name) -join ', ')
  # PostgreSQL refuses to run with an administrator token, so the throwaway-cluster test runs as a standard user below
  # Task 5 CARRY: the live dev-instance test is not run elevated (it needs a standard-user token); a non-elevated scenario owns it
  $listed = @($listed | Where-Object { $_.Name -notlike '*a_real_instance_provisions_starts_seeds_and_stops' })
  # Plan 07 Task 11: every real-cluster test (pg::*, and the *::real_* tests of ops::swap and update::catalog) starts postgres.exe, which refuses an
  # administrator token, so they all run as the standard user below; the ones that need an elevated token stay in the elevated run.
  # The update::*::pg_it_* tests use ops::test_cluster (postgres.exe directly), so they go the same way. backup::pg_it::* does NOT: its Cluster
  # starts postgres through pg_ctl, which drops the administrator token, and it is the closest thing to the SYSTEM backup, so it stays elevated.
  $pgTests = @($listed | Where-Object { $_.Name -like 'pg::*' -or $_.Name -like '*::real_*' -or $_.Name -like '*::pg_it_*' })
  $listed = @($listed | Where-Object { $_.Name -notlike 'pg::*' -and $_.Name -notlike '*::real_*' -and $_.Name -notlike '*::pg_it_*' })
  foreach ($must in 'real_clone_replays_acl_and_settings_and_swaps_both_ways', 'real_collation_mismatch_is_detected_and_repaired', 'real_digest_reacts_to_a_dropped_grant_and_a_changed_function', 'real_digest_reacts_to_each_extended_section') {
    Check-True "21 the real-cluster test $must is registered (and so runs as the standard user)" (@($pgTests | Where-Object { $_.Name -like "*::$must" }).Count -eq 1) (($pgTests.Name) -join ', ')
  }
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  Check-True '21 tests run from an elevated token' ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

  foreach ($e in ($listed | Group-Object Exe)) {
    $names = @($e.Group.Name)
    $r = Invoke-TestExe $e.Name (@('--ignored', '--test-threads=1', '--skip', 'a_real_instance_provisions_starts_seeds_and_stops', '--exact', '--show-output') + $names) ("run-" + [IO.Path]::GetFileName($e.Name)) 1200
    $vr = Get-TestVerdicts $r.Out
    $verdicts = $vr.Verdicts
    $okCount = @($verdicts.Values | Where-Object { $_.Status -eq 'ok' }).Count
    $noSummary = ($vr.Passed -eq -1)
    $mismatch = ($vr.Passed -ge 0 -and $okCount -ne $vr.Passed)
    # Plan 09 T7/T10: the staging tests print `SDDL|<label>|...` (what the product reads back) and `ICACLS|<label>|...` (what icacls prints);
    # each goes into result.json so the report can quote the real ACLs, and the labels the staging tests must emit are required.
    foreach ($l in ($r.Out -split "`r?`n")) {
      if ($l -match '^(SDDL|ICACLS)\|([^|]+)\|(.*)$') { Add-Check "21 evidence $($Matches[1]) $($Matches[2])" 'recorded' $Matches[3] $true }
    }
    if ($names -contains 'switch::staging::tests::staging_real_dacl_read_back') {
      foreach ($lab in 'backups-production-entry', 'dump-switch-folder', 'pgpass-folder', 'backups-absent-created', 'absent-case-dump-folder', 'backups-inherited-refused', 'hint-before-wrong-owner-inherited', 'hint-after') {
        Check-True "21 SDDL evidence recorded for $lab" ($r.Out -match ('(?m)^SDDL\|' + [regex]::Escape($lab) + '\|')) ''
      }
    }
    foreach ($n in $names) {
      $vd = $verdicts[$n]
      $st = if ($null -ne $vd) { $vd.Status } else { 'not run' }
      $ok = ($st -eq 'ok') -and -not $mismatch -and -not $noSummary
      $detail = $st
      if ($noSummary) { $detail = if ($r.TimedOut) { 'TIMEOUT' } else { 'no test result line (run aborted)' } }
      elseif ($mismatch) { $detail = "verdict mismatch: $okCount ok verdicts parsed, cargo says $($vr.Passed) passed" }
      elseif ($st -eq 'aborted') { $detail = if ($r.TimedOut) { 'TIMEOUT' } else { 'no verdict (run aborted)' } }
      elseif ($st -eq 'not run' -and $r.TimedOut) { $detail = 'TIMEOUT' }
      elseif ($st -eq 'FAILED' -and $vd.Panic) { $detail = "FAILED | $($vd.Panic)" }
      Add-Check "21 (elevated) $n" 'ok' $detail $ok
    }
  }
  # the real-cluster test, as a standard user, with the pack on local disk (the standard user cannot read the mapped share)
  if ($pgTests.Count -gt 0) {
    $pw = 'Aa1!' + (New-RandomToken 18)
    New-StdUser 'testrunner' $pw
    $cred = New-Object Management.Automation.PSCredential('testrunner', (ConvertTo-SecureString $pw -AsPlainText -Force))
    $work = 'C:\Users\Public\t'; New-Item -ItemType Directory -Force $work | Out-Null
    & icacls.exe $work /grant 'Users:(OI)(CI)M' | Out-Null
    $copy = "C:\packcopy\$($meta.packVersion)"
    & robocopy "C:\payload\pack\$($meta.packVersion)" $copy /E /NFL /NDL /NJH /NJS /NP | Out-Null
    foreach ($t in $pgTests) {
      $exeCopy = Join-Path $work ([IO.Path]::GetFileName($t.Exe)); Copy-Item $t.Exe $exeCopy -Force
      Set-Content (Join-Path $work 'run.cmd') "@echo off`r`nset POS_PACK_DIR=$copy`r`nset TEMP=$work\tmp`r`nset TMP=$work\tmp`r`nmkdir $work\tmp 2>nul`r`n`"$exeCopy`" --ignored --test-threads=1 --exact $($t.Name) > `"$work\out.txt`" 2>&1`r`necho exit=%ERRORLEVEL% >> `"$work\out.txt`"`r`n"
      $pr = Start-Process cmd.exe -ArgumentList '/c', "$work\run.cmd" -Credential $cred -LoadUserProfile -WorkingDirectory $work -Wait -PassThru -WindowStyle Hidden
      $out = Get-Content "$work\out.txt" -Raw -ErrorAction SilentlyContinue
      Save-Evidence "tests-pg-as-standard-user" "$out"
      # FR14: a real-cluster test starts postgres.exe/psql.exe, which write to the inherited stdout, so libtest's "test <name> ... ok" is not alone at the start of its line
      # (run 3: four tests PASSED - "test result: ok. 1 passed" - and were scored failed). Cargo's summary line is the verdict: exactly one test ran, none failed, exit 0.
      $ok = ($out -match "(?m)^test result: ok\. 1 passed; 0 failed;") -and ($out -match "(?m)^exit=0\s*$")
      Add-Check "21 (standard user) $($t.Name)" 'ok' $(if ($ok) { 'ok' } else { (@($out -split "`r?`n" | Where-Object { $_ -match 'panicked|FAILED|failed|never|exit=' } | Select-Object -First 4) -join ' | ') }) $ok
    }
  }
  return @{ Results = (Get-Results); Reboot = $false }
}
