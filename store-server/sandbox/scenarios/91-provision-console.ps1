# 91 - `provision --console` (Plan 11a): the first-run questions, answered on piped stdin through the test-hooks build
# (POSCTL_TEST_CONSOLE=1 lets piped input count as a terminal; the release build ignores it).
# Proves: option 1 (new shop) provisions the whole stack with one first admin who must change the generated PIN; the PIN is
# shown once in the console output and appears in no result file, log, state file or C:\out file; the shown PIN signs in
# (derived password) and a different PIN is refused (the "red once" row: the sign-in check can fail).
# The PIN is read from the console text only to be used here; it is never written to a check row or an evidence file.

function Invoke-ConsoleRun([string[]]$PosctlArgs, [string]$Answers, [int]$TimeoutSec = 1800) {
  $psi = New-PosctlStartInfo (@('--console') + $PosctlArgs)
  $psi.Environment['POSCTL_TEST_CONSOLE'] = '1'
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($Answers); $p.StandardInput.Close()
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill($true); throw "posctl --console $($PosctlArgs -join ' ') timed out after $TimeoutSec s" }
  $p.WaitForExit()
  return [pscustomobject]@{ Exit = $p.ExitCode; Text = $so.Result; Stderr = $se.Result }
}

function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  [void](Install-Machine)
  # 1 = new shop, then the first administrator's name, then (only when the network is Public) y, then Enter for the final pause
  $r = Invoke-ConsoleRun @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc') "1`nSandboxAdmin`ny`n`n"
  $pin = $null
  if ($r.Text -match '\):\s*(\d{4,8})\s') { $pin = $Matches[1] }
  $redacted = if ($pin) { $r.Text.Replace($pin, '******') } else { $r.Text }
  Save-Evidence 'posctl-91-provision-console' ("exit: $($r.Exit)`n--- stdout (PIN redacted) ---`n$redacted`n--- stderr ---`n$($r.Stderr)")
  Check-Equal '91 provision --console (answers 1, name, y) exits 0' 0 $r.Exit
  Check-True '91 the console showed one generated PIN, framed' ($null -ne $pin -and ([regex]::Matches($r.Text, [regex]::Escape($pin))).Count -eq 1) 'no PIN, or shown more than once'
  Check-True '91 the console asked for Enter before closing' ($r.Text -match 'Press Enter to close') ''
  if ($r.Exit -ne 0 -or -not $pin) { return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; a tick would hold update.lock (run 20261025-000013-20)

  Check-StoreUp '91'
  $adminCount = (Invoke-Psql "SELECT count(*) FROM public.profiles WHERE role = 'admin'").Out.Trim()
  Check-Equal '91 exactly one admin profile exists' 1 $adminCount
  $mustChange = (Invoke-Psql "SELECT count(*) FROM public.profiles WHERE role = 'admin' AND must_change_pin").Out.Trim()
  Check-Equal '91 that admin must change the PIN at first sign-in' 1 $mustChange
  $adminId = (Invoke-Psql "SELECT id FROM public.profiles WHERE role = 'admin'").Out.Trim()
  $name = (Invoke-Psql "SELECT name FROM public.profiles WHERE id = '$adminId'").Out.Trim()
  Check-Equal '91 the admin carries the typed name' 'SandboxAdmin' $name

  # sign-in with the shown PIN works; a different PIN is refused
  $email = "$adminId@barpos.local"
  $pepper = Get-Pepper
  $good = Invoke-Grant $email (Get-DerivedPassword $adminId $pin $pepper)
  Check-True '91 sign-in with the shown PIN works (HTTP 200 + access_token)' ($good.Status -eq 200 -and $good.Body -match 'access_token') "status=$($good.Status)"
  $other = New-Digits6
  while ($other -eq $pin) { $other = New-Digits6 }
  $bad = Invoke-Grant $email (Get-DerivedPassword $adminId $other $pepper)
  Check-Equal '91 sign-in with a different PIN is refused (HTTP 400)' 400 $bad.Status

  # the PIN is nowhere on disk
  $roots = @('C:\out', (Join-Path $script:DataRoot 'logs'), (Join-Path $script:DataRoot 'state'), (Join-Path $script:DataRoot 'conf'), (Join-Path $script:DataRoot 'client'))
  Reset-FindScan
  foreach ($root in $roots) {
    $hits = @(Find-Text $root $pin)
    Check-Equal "91 the PIN is not in $($root.Replace($script:DataRoot, 'DATA'))" 0 $hits.Count
  }
  Close-FindScan '91' 'PIN scan'
  $logs = @(Get-ChildItem (Join-Path $script:DataRoot 'logs\posctl') -Filter 'posctl-*.log' -ErrorAction SilentlyContinue)
  Check-True '91 the posctl log has a provision line (the scan above covered a real log)' (@($logs | Where-Object { Select-String -LiteralPath $_.FullName -Pattern '"command":"provision"' -Quiet }).Count -ge 1) "logs=$($logs.Count)"
  return @{ Results = (Get-Results); Reboot = $false }
}
