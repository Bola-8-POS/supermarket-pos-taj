# 121 - the started llama-server listens only on 127.0.0.1 and enforces the per-launch key (Plan 29-04, ASSIST-02).
# Rows read the listener table of the child's PID directly (L103). Positive control: the right key gets 200, so the 401 rows
# are key enforcement and not a broken server. Two red-once rows inject a fault through test-only probe flags
# (--test-host 0.0.0.0, --test-no-key) and assert the checks DETECT it. Also records `llama-server --help` as evidence
# (the flag/env names Plan 29-02 marked ASSUMED are confirmed against it in Plan 29-07).
. C:\scenarios\lib-assistant.ps1

function Start-AssistantProbe([string[]]$Extra) {
  Invoke-Probe (@('--install-dir', $script:AsstDir, '--pubkey-file', $script:AsstPubkey, '--hold-seconds', '900') + $Extra) 240
}
# Stops a started probe (its Job closing ends the child) and, as a backstop, the child by PID.
function Stop-ProbeTree($Probe, [int]$ChildPid) {
  Stop-ByPid $Probe.Pid
  if ($ChildPid) {
    [void](Wait-Until { -not (Test-PidAlive $ChildPid) } 10 0.5)
    if (Test-PidAlive $ChildPid) { Stop-ByPid $ChildPid }
  }
}

function Invoke-Scenario([int]$Phase) {
  Initialize-AssistantEnv
  $i = Install-Assistant
  Check-Equal '121 setup: installer.exe /S exits 0' 0 $i.Exit
  if ($i.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }

  $r = Start-AssistantProbe @('--test-print-key')
  $j = $r.Json
  Save-Evidence 'probe-start' ((Get-Content $r.Out -Raw -ErrorAction SilentlyContinue) -replace '"key":"[^"]*"', '"key":"<redacted>"')   # the key never goes to evidence
  Save-Evidence 'probe-start-stderr' (Get-Content $r.Err -Raw -ErrorAction SilentlyContinue)
  Check-True '121 the probe verified, spawned llama-server and /health answered (json ok)' ($j -and $j.ok -eq $true) $(if ($j) { "reason=$($j.reason)" } else { 'no json' })
  if (-not ($j -and $j.ok -eq $true)) { Stop-ByPid $r.Pid; return @{ Results = (Get-Results); Reboot = $false } }
  $childPid = [int]$j.childPid; $port = [int]$j.port; $key = [string]$j.key
  [void]$script:AsstStarted.Add($childPid)

  $rows = Get-ListenerRows $childPid
  Add-Check '121 the child has a listener and every one is 127.0.0.1' '127.0.0.1 only' (($rows | ForEach-Object { "$($_.Addr):$($_.Port)" }) -join ',') (Test-LoopbackOnly $rows)
  Check-True '121 the child listens on the port the probe reported' (@($rows | Where-Object { $_.Port -eq $port }).Count -gt 0) "port=$port"
  $health = Get-AssistantHttp 'GET' "http://127.0.0.1:$port/health"
  Add-Check '121 GET /health is 200 without a key' '200' $health ($health -eq 200)
  $noAuth = Get-CompletionCode $port
  Add-Check '121 POST /v1/chat/completions without Authorization is 401' '401' $noAuth ($noAuth -eq 401)
  $bad = Get-CompletionCode $port 'not-the-key'
  Add-Check '121 POST /v1/chat/completions with a wrong Bearer key is 401' '401' $bad ($bad -eq 401)
  $good = Get-CompletionCode $port $key
  Add-Check '121 positive control: the right Bearer key gets 200' '200' $good ($good -eq 200)

  $cl = Get-ProcessCommandLine $childPid
  Check-True '121 the key is not in the child command line (env only) and no --api-key flag' (($cl -ne '') -and (-not $cl.Contains($key)) -and ($cl -notmatch '--api-key')) ''
  Check-True '121 the Sandbox session environment holds no key' ([string]::IsNullOrEmpty($env:LLAMA_API_KEY)) ''
  Check-True '121 the child command line pins --host 127.0.0.1, --offline and --no-webui' ($cl -match '--host 127\.0\.0\.1' -and $cl -match '--offline' -and $cl -match '--no-webui') ''

  # evidence for Plan 29-07 (ASSUMED names): the pinned binary's own help text; short, killed by PID if it hangs
  try {
    $ho = Join-Path $script:AsstLocal 'help.txt'
    $he = Join-Path $script:AsstLocal 'help-err.txt'
    $hp = Start-Process -FilePath (Join-Path $script:AsstDir 'runtime\llama-server.exe') -ArgumentList '--help' -RedirectStandardOutput $ho -RedirectStandardError $he -PassThru -WindowStyle Hidden
    [void]$script:AsstStarted.Add($hp.Id)
    if (-not $hp.WaitForExit(60000)) { Stop-ByPid $hp.Id }
    $help = (Get-Content $ho -Raw -ErrorAction SilentlyContinue) + (Get-Content $he -Raw -ErrorAction SilentlyContinue)
    Save-Evidence 'llama-server-help' $help
    $names = 'LLAMA_API_KEY', '--reasoning-budget', '--sleep-idle-seconds', '--prio', '--no-slots', '--offline', '--no-webui', '--api-key-file'
    Info '121 llama-server --help mentions (ASSUMED names, for Plan 29-07)' (($names | ForEach-Object { "$_=$($help.Contains($_))" }) -join ' ')
  } catch { Info '121 llama-server --help could not be captured' $_.Exception.Message }

  Stop-ProbeTree $r $childPid

  # red once (1): bind to all interfaces -> the listener check must DETECT a non-loopback address
  $r2 = Start-AssistantProbe @('--test-host', '0.0.0.0')
  Check-True '121 red setup: the probe with --test-host 0.0.0.0 started' ($r2.Json -and $r2.Json.ok -eq $true) $(if ($r2.Json) { "reason=$($r2.Json.reason)" } else { 'no json' })
  if ($r2.Json -and $r2.Json.ok -eq $true) {
    $c2 = [int]$r2.Json.childPid; [void]$script:AsstStarted.Add($c2)
    $rows2 = Get-ListenerRows $c2
    Add-Check '121 red once: a server bound to 0.0.0.0 is reported as NOT loopback-only' 'detected (not loopback-only)' (($rows2 | ForEach-Object { "$($_.Addr):$($_.Port)" }) -join ',') (-not (Test-LoopbackOnly $rows2))
    Stop-ProbeTree $r2 $c2
  } else { Stop-ByPid $r2.Pid }

  # red once (2): no key in the child's environment -> an unauthenticated completion must NOT be 401
  $r3 = Start-AssistantProbe @('--test-no-key')
  Check-True '121 red setup: the probe with --test-no-key started' ($r3.Json -and $r3.Json.ok -eq $true) $(if ($r3.Json) { "reason=$($r3.Json.reason)" } else { 'no json' })
  if ($r3.Json -and $r3.Json.ok -eq $true) {
    $c3 = [int]$r3.Json.childPid; [void]$script:AsstStarted.Add($c3)
    $code3 = Get-CompletionCode ([int]$r3.Json.port)
    Add-Check '121 red once: a server started without a key answers an unauthenticated completion with something other than 401' 'not 401' $code3 ($code3 -ne 401 -and $code3 -ne 0)
    Stop-ProbeTree $r3 $c3
  } else { Stop-ByPid $r3.Pid }
  return @{ Results = (Get-Results); Reboot = $false }
}
