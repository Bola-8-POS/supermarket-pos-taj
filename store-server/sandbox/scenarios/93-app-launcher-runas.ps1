# 93 - the app's console launcher path (Plan 11b, src-tauri posctl_open_console): ShellExecuteEx with the `runas` verb starts
# the installed posctl elevated and, in the Sandbox's already-elevated administrator session, without a consent click.
# WRITTEN ONLY: Plan 11 section 5 makes 93 conditional on `runas` launching headless in the Sandbox. The first run decides:
#  - all rows pass: keep 93 (the unit tests in src-tauri cover the argv map, trust vetting and the UAC-cancel mapping);
#  - the launch blocks on a consent prompt (the wait below times out): drop 93 and record "UAC path covered by unit tests and 91/92".
# This does not drive the app (no WebView in the Sandbox): it uses the same verb against the same fixed posctl path with a
# harmless read-only argv (`status --json --result-file`), so a pass proves the verb path, not the button. Only the process
# this scenario started is waited on; nothing is killed by image name.

function Invoke-Scenario([int]$Phase) {
  [void](Install-Machine)
  $out = 'C:\out\93-status-via-runas.json'
  Remove-Item $out -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $script:Posctl -ArgumentList @('status', '--json', '--result-file', $out) -Verb RunAs -PassThru -WindowStyle Hidden
  $done = $p.WaitForExit(120 * 1000)
  Check-True '93 the runas launch finished without a consent click (120 s)' $done 'blocked: a UAC prompt is probably waiting'
  if (-not $done) { try { $p.Kill($true) } catch { }; return @{ Results = (Get-Results); Reboot = $false } }
  Check-True '93 the elevated posctl wrote its result file' (Test-Path $out) "missing $out"
  $text = if (Test-Path $out) { Get-Content -Raw $out } else { '' }
  Save-Evidence 'posctl-93-status-via-runas' $text
  Check-True '93 the result is a posctl envelope (has a code field)' ($text -match '"code"') ''
  # "red once": a path that does not exist must make the same launch fail, so the rows above cannot pass vacuously
  $failed = $false
  try { [void](Start-Process -FilePath 'C:\ProgramData\SupermarketPOS-93-missing\posctl.exe' -Verb RunAs -PassThru -ErrorAction Stop) } catch { $failed = $true }
  Check-True '93 red once: launching a missing posctl through runas fails' $failed ''
  return @{ Results = (Get-Results); Reboot = $false }
}
