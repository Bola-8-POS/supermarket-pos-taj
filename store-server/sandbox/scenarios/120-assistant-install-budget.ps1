# 120 - the separate local-assistant installer on a clean Windows machine (Plan 29-04, ASSIST-12 / D-05):
#  installs silently under 1,000,000,000 bytes, standard users cannot write into the install dir, and a one-byte tamper of the model
#  makes the verified start refuse (HASH_MISMATCH, no child). The tamper row is the in-scenario red proof; a second red-once row
#  proves the standard-user write probe can see a writable folder. The probe is src-tauri\examples\assistant_probe.rs (test-only).
. C:\scenarios\lib-assistant.ps1

function Invoke-Scenario([int]$Phase) {
  Initialize-AssistantEnv
  $dir = $script:AsstDir

  $i = Install-Assistant
  Check-Equal '120 installer.exe /S exits 0' 0 $i.Exit
  if ($i.Exit -ne 0) { Save-Evidence 'install-failed' ("exit=$($i.Exit) timedOut=$($i.TimedOut)"); return @{ Results = (Get-Results); Reboot = $false } }
  Check-True '120 manifest.json, its signature, the runtime and the uninstaller are in Program Files' ((Test-Path "$dir\manifest.json") -and (Test-Path "$dir\manifest.json.sig") -and (Test-Path "$dir\runtime\llama-server.exe") -and (Test-Path "$dir\uninstall.exe")) ''

  $bytes = Get-AssistantDirBytes
  Add-Check '120 install dir total bytes (uninstaller included) is below 1000000000' '< 1000000000' $bytes ($bytes -lt $script:AsstBudget)
  Check-True '120 the HKLM uninstall key exists' (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SupermarketPOSAssistant') ''

  # ACL: no Users / Everyone / Authenticated Users write ACE on the dir, its manifest or the model
  $model = (Get-ChildItem "$dir\models" -File | Select-Object -First 1).FullName
  foreach ($t in @($dir, "$dir\manifest.json", $model)) {
    $aces = @(Get-UserWriteAces $t)
    Add-Check "120 no Users/Everyone write ACE on $($t.Substring($dir.Length))" 'none' $(if ($aces.Count) { $aces -join '; ' } else { 'none' }) ($aces.Count -eq 0)
  }
  # effective access: a real standard user can neither create a file in the dir nor append to the manifest
  $w = Test-StandardUserWrite $dir "$dir\manifest.json"
  Add-Check '120 a standard user cannot create a file in the install dir' 'CREATE_DENIED' $w.Create ($w.Create -eq 'CREATE_DENIED')
  Add-Check '120 a standard user cannot append to manifest.json' 'APPEND_DENIED' $w.Append ($w.Append -eq 'APPEND_DENIED')
  # red once: the same probe against a folder Users may modify must report CREATED, so the two denied rows above are not vacuous
  $open = 'C:\Users\Public\asst-w'
  $wOpen = Test-StandardUserWrite $open "$open\run.cmd"
  Add-Check '120 red once: the standard-user probe sees a writable folder as CREATED' 'CREATED' $wOpen.Create ($wOpen.Create -eq 'CREATED')

  # verified start: signature + every hash + listed/unlisted + budget
  $v = Invoke-ProbeVerify
  Save-Evidence 'probe-verify-clean' ((Get-Content $v.Out -Raw -ErrorAction SilentlyContinue) + (Get-Content $v.Err -Raw -ErrorAction SilentlyContinue))
  Check-True '120 probe --verify-only says ok on the fresh install' ($v.Json -and $v.Json.ok -eq $true) $(if ($v.Json) { "reason=$($v.Json.reason)" } else { 'no json' })
  Add-Check '120 probe total bytes equals the directory total' $bytes $(if ($v.Json) { $v.Json.totalBytes } else { 'n/a' }) ($v.Json -and [long]$v.Json.totalBytes -eq $bytes)

  # in-scenario red proof: one flipped byte of the model
  $off = Edit-OneByte $model
  $t = Invoke-ProbeVerify
  Add-Check "120 red: one byte flipped at offset $off of the model, --verify-only refuses" 'ok=false reason=HASH_MISMATCH' $(if ($t.Json) { "ok=$($t.Json.ok) reason=$($t.Json.reason)" } else { 'no json' }) ($t.Json -and $t.Json.ok -eq $false -and $t.Json.reason -eq 'HASH_MISMATCH')
  # the real start path refuses too and never spawns the server (no childPid, no listener on a port)
  $s = Invoke-Probe @('--install-dir', $dir, '--pubkey-file', $script:AsstPubkey, '--hold-seconds', '5') 120
  [void]$s.Proc.WaitForExit(30000)
  Check-True '120 the start path refuses the tampered install and never spawns the server' ($s.Json -and $s.Json.ok -eq $false -and $s.Json.reason -eq 'HASH_MISMATCH' -and -not $s.Json.childPid) $(if ($s.Json) { "reason=$($s.Json.reason)" } else { 'no json' })

  # restore by reinstall (also proves an upgrade leaves exactly the listed files)
  $i2 = Install-Assistant
  Check-Equal '120 reinstall over the tampered install exits 0' 0 $i2.Exit
  $r = Invoke-ProbeVerify
  Check-True '120 probe --verify-only is ok again after the reinstall' ($r.Json -and $r.Json.ok -eq $true) $(if ($r.Json) { "reason=$($r.Json.reason)" } else { 'no json' })
  return @{ Results = (Get-Results); Reboot = $false }
}
