# 92 - `pair create --lan --console` on the store server and `pair join --prompt --console` on a till (Plan 11a).
# The server is provisioned for real (test-hooks build, PIN on stdin: the PIN is not under test here). The till is a dev root on the
# same PC (--dev, loopback host 127.0.0.1: the only host a dev root may fetch from, install_trust off), so no machine trust store
# is touched; scenario 30 owns the real till join. Proves: the server console shows the pairing code, the fingerprint to type and the
# expiry; the till, given host, code and the fingerprint typed from the server's console, writes store.env; one flipped character
# exits 51 (PAIR_FINGERPRINT_MISMATCH) and writes nothing (no store.env, no client\pki, no downloaded offer left behind).
# The pairing code is never written to evidence or to a check row.

function Invoke-ConsoleRun([string[]]$PosctlArgs, [string]$Answers, [int]$TimeoutSec = 600) {
  $psi = New-PosctlStartInfo (@('--console') + $PosctlArgs)
  $psi.Environment['POSCTL_TEST_CONSOLE'] = '1'
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($Answers); $p.StandardInput.Close()
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill($true); throw "posctl --console $($PosctlArgs -join ' ') timed out after $TimeoutSec s" }
  $p.WaitForExit()
  return [pscustomobject]@{ Exit = $p.ExitCode; Text = $so.Result; Stderr = $se.Result }
}
function Get-PairShown($R) {
  $code = $null; $fp = $null; $exp = $null
  if ($R.Text -match 'Pairing code:\s*([A-Z2-7]{8})') { $code = $Matches[1] }
  if ($R.Text -match 'type this on the till\):\s*([0-9A-Fa-f]{4}(?:-[0-9A-Fa-f]{4}){3})') { $fp = $Matches[1] }
  if ($R.Text -match 'Expires:\s*(\S+)') { $exp = $Matches[1] }
  return [pscustomobject]@{ Code = $code; Fingerprint = $fp; Expires = $exp }
}
function Save-PairEvidence([string]$Name, $R, $Shown) {
  $t = $R.Text
  if ($Shown.Code) { $t = $t.Replace($Shown.Code, '********') }
  Save-Evidence $Name ("exit: $($R.Exit)`n--- stdout (pairing code redacted) ---`n$t`n--- stderr ---`n$($R.Stderr)")
}
function New-TillArgs([string]$Root, [string[]]$Tail) { @('--dev', '--data-root', $Root, '--program-root', "$Root-prog") + $Tail }

function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  $p = Provision-Fresh 'C:\out\r92.json' '92-provision'
  Check-Equal '92 setup: the server provisions' 0 $p.Result.Exit
  if ($p.Result.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks

  # ---- the server console -----------------------------------------------------------------------------------------------------------
  $s1 = Invoke-ConsoleRun @('pair', 'create', '--lan') "`n"
  $a = Get-PairShown $s1
  Save-PairEvidence '92-server-create-1' $s1 $a
  Check-Equal '92 pair create --lan --console exits 0' 0 $s1.Exit
  Check-True '92 the console shows an 8-character pairing code' ($null -ne $a.Code) 'no code'
  Check-True '92 the console shows the fingerprint as four groups of four' ($null -ne $a.Fingerprint) 'no fingerprint'
  Check-True '92 the console shows when the offer expires' ($null -ne $a.Expires) 'no expiry'
  Check-True '92 the console waits for Enter' ($s1.Text -match 'Press Enter to close') ''
  if (-not ($a.Code -and $a.Fingerprint)) { return @{ Results = (Get-Results); Reboot = $false } }

  # ---- a till types what the server showed -------------------------------------------------------------------------------------------
  $till = 'C:\till92'
  $j = Invoke-ConsoleRun (New-TillArgs $till @('pair', 'join', '--prompt')) "127.0.0.1`n$($a.Code)`n$($a.Fingerprint)`n`n"
  Save-PairEvidence '92-till-join' $j $a
  Check-Equal '92 pair join --prompt with the typed fingerprint exits 0' 0 $j.Exit
  Check-True '92 the till reports it is paired' ($j.Text -match 'till paired') ''
  Check-True '92 store.env was written on the till' (Test-Path "$till\client\store.env") ''
  Check-True '92 the downloaded offer was removed' (-not (Test-Path "$till\client\pairing\fetched-offer.pospair")) ''

  # ---- one flipped character: exit 51 and nothing written ------------------------------------------------------------------------------
  $s2 = Invoke-ConsoleRun @('pair', 'create', '--lan') "`n"
  $b = Get-PairShown $s2
  Save-PairEvidence '92-server-create-2' $s2 $b
  Check-True '92 a second offer exists for the mismatch run' ($null -ne $b.Code -and $null -ne $b.Fingerprint) 'no second offer'
  if ($b.Code -and $b.Fingerprint) {
    $first = $b.Fingerprint.Substring(0, 1)
    $flip = if ($first -eq '0') { '1' } else { '0' }
    $wrong = $flip + $b.Fingerprint.Substring(1)
    $bad = 'C:\till92b'
    $m = Invoke-ConsoleRun (New-TillArgs $bad @('pair', 'join', '--prompt')) "127.0.0.1`n$($b.Code)`n$wrong`n`n"
    Save-PairEvidence '92-till-mismatch' $m $b
    Check-Equal '92 one flipped character: exit 51 (PAIR_FINGERPRINT_MISMATCH)' 51 $m.Exit
    Check-True '92 nothing was written: no store.env' (-not (Test-Path "$bad\client\store.env")) ''
    Check-True '92 nothing was written: no client\pki' (-not (Test-Path "$bad\client\pki")) ''
    Check-True '92 the downloaded offer was removed' (-not (Test-Path "$bad\client\pairing\fetched-offer.pospair")) ''
  }

  # ---- the pairing code is nowhere on disk ----------------------------------------------------------------------------------------------
  Reset-FindScan
  foreach ($code in @($a.Code, $b.Code) | Where-Object { $_ }) {
    foreach ($root in 'C:\out', (Join-Path $script:DataRoot 'logs')) {
      Check-Equal "92 the pairing code is not in $($root.Replace($script:DataRoot, 'DATA'))" 0 @(Find-Text $root $code).Count
    }
  }
  Close-FindScan '92' 'pairing code scan'
  return @{ Results = (Get-Results); Reboot = $false }
}
