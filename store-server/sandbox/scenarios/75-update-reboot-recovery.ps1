# 75 - an update killed, the whole stack hard-stopped, the machine REBOOTED; the store must stay fenced until `update --recover` (Plan 07 Task 11;
# obligations 1, 5, 7, 9; delta rows for 75). Uses agent.ps1's phase mechanism (Reboot = $true -> state.json phase+1 -> Restart-Computer -> Invoke-Scenario -Phase N).
#   phase 1  setup, Recover task DISABLED (so the boot cannot finish the job before the assertions), kill at journal:swap:done (point A), hard-stop by service PID, reboot
#   phase 2  boot A: fenced-state assertions, wait >= 5 min after boot, assertions again (the boot Canary ran), `--recover`, consistent -> reset, kill at journal:activate:done (B), reboot
#   phase 3  boot B: same, kill at journal:verify_live:intent (C), reboot            (C: NOLOGIN is already lifted, the demand-start fence is what holds)
#   phase 4  boot C: same, kill at journal:reopen:done (D), reboot                  (D: committed (on_commit re-registered the services: auto + failure actions, the SCM starts Auth/Rest/Functions at boot); only the Caddy side is still fenced, rolls forward)
#   phase 5  boot D: same, `--recover`, Recover task re-enabled
# A literal power cut is impossible in a Sandbox (shutdown discards state); this is the closest: kill -9 of every service process, then Restart-Computer. Plan 13 owns the real cut.
# Estimated 55 minutes (long timeout in scenarios.json).
. C:\scenarios\lib-update.ps1
$script:S75 = 'C:\out\s75-state.json'
$script:Points = @(
  @{ Name = 'A'; Label = 'journal:swap:done';          Step = 'swap';        Phase = 'done';   RolesMayLogin = $false },
  @{ Name = 'B'; Label = 'journal:activate:done';      Step = 'activate';    Phase = 'done';   RolesMayLogin = $false },
  @{ Name = 'C'; Label = 'journal:verify_live:intent'; Step = 'verify_live'; Phase = 'intent'; RolesMayLogin = $true },
  @{ Name = 'D'; Label = 'journal:reopen:done';        Step = 'reopen';      Phase = 'done';   RolesMayLogin = $true })

$script:LogSvcs = @('Auth', 'Rest', 'Functions')
function Get-LogFiles([string]$Svc) { return @(Get-ChildItem (Join-Path $script:Data "logs\SupermarketPOS-$Svc") -File -Recurse -ErrorAction SilentlyContinue) }
function Get-LogSnapshot {   # every file under the service log dirs: path, LastWriteTime ticks (UTC), length (strings, so the JSON round trip is exact)
  $o = @(); foreach ($svc in $script:LogSvcs) { foreach ($f in (Get-LogFiles $svc)) { $o += @{ svc = $svc; p = $f.FullName; t = [string]$f.LastWriteTimeUtc.Ticks; l = [string]$f.Length } } }
  return $o
}
function Get-LogChanges([string]$Svc, $Before) {   # non-empty files that are new or changed (time or length) vs the pre-reboot snapshot
  $b = @{}; foreach ($e in @($Before)) { $b[[string]$e.p] = "$($e.t)|$($e.l)" }
  return @(Get-LogFiles $Svc | Where-Object { $_.Length -gt 0 -and (-not $b.ContainsKey($_.FullName) -or $b[$_.FullName] -ne "$($_.LastWriteTimeUtc.Ticks)|$($_.Length)") })
}
function Format-LogChanges($Files) {   # name, LastWriteTime, Length and the last 5 lines of each file, redacted with Assert-NoSecrets' own patterns (Protect-SecretText)
  $vals = @(Get-SecretValues)
  return (@($Files | ForEach-Object {
    $tail = ''; try { $tail = ((Get-Content -LiteralPath $_.FullName -Tail 5 -ErrorAction Stop | ForEach-Object { $x = Protect-SecretText ([string]$_) $vals; $x.Substring(0, [Math]::Min(300, $x.Length)) }) -join ' // ') } catch { $tail = "unreadable: $($_.Exception.Message)" }
    "{name=$($_.Name) lastWrite=$($_.LastWriteTime.ToString('o')) len=$($_.Length) tail5=[$tail]}" }) -join ' ')
}
function Get-RawServiceStates {   # raw Get-Service Status / StartType strings, not booleans
  return ((@('Postgres', 'Auth', 'Rest', 'Functions', 'Gateway') | ForEach-Object { $g = Get-Service -Name "SupermarketPOS-$_" -ErrorAction SilentlyContinue; if ($g) { "$_=Status:$($g.Status)/StartType:$($g.StartType)" } else { "$_=absent" } }) -join ' ')
}

function Start-Point($Point, $Pre) {   # kill the update at the point, hard-stop every service by PID, remember what must hold after the boot
  $r = Invoke-KilledUpdate $Point.Label @() ("u75" + $Point.Name)
  Check "75 $($Point.Name) : the update was killed at $($Point.Label)" 137 $r.exit
  Assert-JournalAt "75 $($Point.Name) before the stop" $Point.Label
  $side = Get-UpdateReadPath 'fence-start-types.json'
  $st = @{ point = $Point.Name; sidecar = (Get-FileHashOrEmpty $side); marks = (Get-AuthWriteMarks); canary = (Get-FileHashOrEmpty (Join-Path $script:Data 'state\canary.json'))
           liveHash = $Pre.LiveHash; startTypes = $Pre.StartTypes; rows = $Pre.Rows; boot = (Get-BootTime).ToString('o') }
  Check "75 $($Point.Name) : the sidecar exists before the reboot" $true ($st.sidecar -ne '')
  Stop-StoreProcesses                       # kills by service PID (sc queryex), never by image name
  # the kill lands ~15-20 s before the boot and the wrapper writes a line while dying: baseline every service log file NOW, after the kill and before Restart-Computer
  $st.logs = @(Get-LogSnapshot)
  Check "75 $($Point.Name) : harness: the pre-reboot log baseline holds files for Auth, Rest and Functions (compare is not vacuous)" $true ((@($st.logs | Where-Object { $_.svc -eq 'Auth' }).Count -gt 0) -and (@($st.logs | Where-Object { $_.svc -eq 'Rest' }).Count -gt 0) -and (@($st.logs | Where-Object { $_.svc -eq 'Functions' }).Count -gt 0))
  Save-DataEvidence "s75-$($Point.Name)-before-reboot"
  ConvertTo-Json -InputObject $st -Depth 6 | Set-Content $script:S75 -Encoding UTF8
}

function Assert-AfterBoot($Point, $Saved) {
  $n = "75 boot $($Point.Name)"
  Check "$n : the machine really restarted" $true ((Get-BootTime).ToString('o') -ne $Saved.boot)
  Add-Check "75 RECORDED $($Point.Name) : raw Get-Service state at the first post-boot probe" 'recorded' (Get-RawServiceStates) $true
  # the services that start by themselves are up; wait for Postgres and the gateway only (point D: the SCM also auto-starts Auth/Rest/Functions, wait for them too)
  [void](Wait-Until { (Get-ServiceInfo 'SupermarketPOS-Postgres').State -eq 'Running' -and (Get-ServiceInfo 'SupermarketPOS-Gateway').State -eq 'Running' } 300 2)
  if ($Point.Name -eq 'D') { [void](Wait-Until { @('Auth', 'Rest', 'Functions' | Where-Object { (Get-ServiceInfo "SupermarketPOS-$_").State -ne 'Running' }).Count -eq 0 } 180 2) }
  Start-Sleep -Seconds 20
  Add-Check "75 RECORDED $($Point.Name) : raw Get-Service state after the settle wait" 'recorded' (Get-RawServiceStates) $true
  # A/B/C: the fence holds (demand, no failure actions, stopped). D (reopen:done): on_commit already re-registered the services, only the Caddy side is still fenced.
  $ex = @{}; if ($Point.RolesMayLogin) { $ex['RolesMayLogin'] = $true }; if ($Point.Name -eq 'D') { $ex['ScmRestored'] = $true }
  Assert-Fenced $n '' @ex
  Check "$n : journal.json step/phase is the reboot point" "$($Point.Step)/$($Point.Phase)" ("$((Get-JournalDoc).step)/$((Get-JournalDoc).phase)")
  Check "$n : the start-type sidecar is byte-identical to before the reboot (write-once)" $Saved.sidecar (Get-FileHashOrEmpty (Get-UpdateReadPath 'fence-start-types.json'))
  Check "$n : Caddyfile.live exists and is not the maintenance config" $true ((Test-Path (Join-Path $script:Data 'conf\Caddyfile.live')) -and -not (Test-ConfTorn 'Caddyfile.live') -and ((Get-FileHashOrEmpty (Join-Path $script:Data 'conf\Caddyfile.live')) -ne (Get-FileHashOrEmpty (Join-Path $script:Data 'conf\Caddyfile.maintenance'))))
  if ($Point.Name -eq 'A') { Check "$n : Caddyfile.live is the pre-update render" $Saved.liveHash (Get-FileHashOrEmpty (Join-Path $script:Data 'conf\Caddyfile.live')) }
  Assert-LanFencedFor $n 10
  Assert-LanPortsClosed $n
  if (-not $Point.RolesMayLogin) { Assert-LoginRefused $n }
  $null = Assert-StatusState $n 'recovery-needed'
  $h = Invoke-Posctl @('health', '--canary') -Tag "u75-health-$($Point.Name)"
  Check "$n : health exits 17" 17 $h.exit
  Check "$n : the canary is skipped while the journal exists ('update in progress')" $true ([string]$h.json.message -match 'update in progress|canary did not run')
  # nothing wrote anywhere before --recover, up to boot + 5 minutes (the boot Canary fires at boot + 3)
  Wait-AfterBoot 5.5
  Check "$n : harness: saved auth.users marks are well-formed 'users=<n>;...' (compare is not vacuous)" $true ([string]$Saved.marks -match '^users=\d+;')
  Check "$n : harness: saved canary.json hash is non-empty or file was absent before (compare is not vacuous)" $true ($null -ne $Saved.canary)
  Check "$n : auth.users / auth.schema_migrations / lockout tables unchanged at boot+5 min" $Saved.marks (Get-AuthWriteMarks)
  Check "$n : canary.json untouched" $Saved.canary (Get-FileHashOrEmpty (Join-Path $script:Data 'state\canary.json'))
  # Start detector = Security 4688 (auditing armed in phase 1; it also sees a start that already stopped). Postgres (automatic) always starts at boot -> its postgres.exe 4688 is the positive control.
  # SCM 7036 is a recorded known gap (this build logs none) and, if it ever shows starts, must agree with 4688.
  $au = Get-ProcessCreationAuditState
  Check "$n : Process Creation auditing (Success) is still armed after the reboot" $true $au.Armed
  Check "$n : ProcessCreationIncludeCmdLine_Enabled still reads 1 after the reboot" 1 $au.CmdLineKey
  $svcList = @('Postgres', 'Auth', 'Rest', 'Functions')
  $unresolved = @($svcList | Where-Object { -not (Get-ServiceDisplayName $_) })
  Check "$n : harness: every service resolved a display name (the 7036 comparison and the PathName match need it)" '' ($unresolved -join ',')
  $cov = Get-SecurityLogCoverage
  Add-Check "$n : harness: the Security log has not rolled over since the boot" 'True' $cov.Text $cov.Ok
  $starts = @(Get-ServiceStartsSinceBoot $svcList)   # window starts exactly at the boot time: pre-reboot starts are excluded
  $mode = [string]$script:StartDiag['Mode']
  Add-Check "$n : harness: 4688 attribution mode is usable (shared shawl.exe needs a captured CommandLine)" 'True' "mode=$mode" ($mode -ne 'cmdline-missing')
  Check "$n : harness: a PathName resolved for every service in the list (count)" $svcList.Count $script:StartDiag['PathNames']
  Check "$n : harness: no shawl.exe 4688 event lacks a command line (count; an empty one would silently drop starts)" 0 $script:StartDiag['ShawlEmptyCmd']
  $viaPath = @('4688:cmdline', '4688:exe')
  $cnt = @{}; $inn = @{}
  foreach ($svc in 'Auth', 'Rest', 'Functions') {
    $cnt[$svc] = @($starts | Where-Object { $_.Short -eq $svc -and $viaPath -contains $_.Source }).Count
    $inn[$svc] = @($starts | Where-Object { $_.Short -eq $svc -and $_.Source -eq '4688:inner' }).Count
  }
  $pgc = @($starts | Where-Object { $_.Short -eq 'Postgres' -and $_.Source -eq '4688:postgres.exe' }).Count
  $pgm = @($starts | Where-Object { $_.Short -eq 'Postgres' -and $viaPath -contains $_.Source }).Count
  $pgNote = "raw 4688 since boot: $($script:StartDiag['Raw4688'])"
  Add-Check "$n : harness: the 4688 query sees the Postgres start since the boot (positive control, postgres.exe, not vacuous)" '>=1' $(if ($au.Armed) { "$pgc ($pgNote)" } else { 'source not armed' }) ($au.Armed -and $pgc -ge 1)
  Add-Check "$n : harness: the 4688 attribution matches the Postgres shawl wrapper started by the SCM (proves the matcher, covers early boot)" '>=1' $(if ($au.Armed) { "$pgm (mode=$mode; $pgNote)" } else { 'source not armed' }) ($au.Armed -and $pgm -ge 1)
  Add-Check "75 RECORDED $($Point.Name) : start query diagnostics" 'recorded' (Get-StartQueryDiagnostics) $true
  $r7 = @(Get-ServiceStarts7036 $svcList)
  $gap = if ($r7.Count -eq 0) { ' (known gap: this build logs no SCM 7036)' } else { ' (this build does log 7036: cross-checked against 4688)' }
  Add-Check "75 RECORDED $($Point.Name) : 7036 source" 'recorded' "$($r7.Count) events$gap" $true
  if ($r7.Count -gt 0) {
    $missed = @($r7 | ForEach-Object { $_.Short } | Select-Object -Unique | Where-Object { $sh = $_; @($starts | Where-Object { $_.Short -eq $sh -and $viaPath -contains $_.Source }).Count -eq 0 })
    Check "$n : every start seen by 7036 is also seen by 4688" '' ($missed -join ',')
  }
  Add-Check "75 RECORDED $($Point.Name) : running now (NOT a start detector)" 'recorded' ((Get-ServicesRunningNow $svcList) -join ',') $true
  if ($Point.Name -eq 'D') {
    foreach ($svc in 'Auth', 'Rest', 'Functions') { Add-Check "$n : $svc start since the boot is DETECTED by 4688 (SCM auto-start, positive control)" '>=1' "$($cnt[$svc]) (source 4688:$mode)" ($au.Armed -and $cnt[$svc] -ge 1) }
    foreach ($svc in 'Auth', 'Rest', 'Functions') { Add-Check "$n : $svc inner image start since the boot is seen by 4688 (proves the inner-name backstop can see it)" '>=1' "$($inn[$svc]) (source 4688:inner)" ($au.Armed -and $inn[$svc] -ge 1) }
  } else {
    foreach ($svc in 'Auth', 'Rest', 'Functions') {
      if ($au.Armed) { Check "$n : $svc inner image (4688:inner) was not started since the boot" 0 $inn[$svc] } else { Add-Check "$n : $svc inner image (4688:inner) was not started since the boot" 0 'source not armed' $false }
      if ($au.Armed) { Check "$n : $svc was not started by anything since the boot (4688)" 0 $cnt[$svc] }
      else { Add-Check "$n : $svc was not started by anything since the boot (4688)" 0 'source not armed' $false }
    }
  }
  # service logs vs the baseline taken after the kill, before the reboot (the dying wrapper's last write is in the baseline, not a "new line")
  foreach ($svc in 'Auth', 'Rest', 'Functions') {
    $ch = @(Get-LogChanges $svc $Saved.logs)
    $detail = "$($ch.Count) new/changed: $(Format-LogChanges $ch)"
    # D: SCM failure actions (restart/5000) can restart a service seconds after Stop-StoreProcesses, around the snapshot, so this is a consistency check only; the real D proof is Assert-Fenced -ScmRestored (Running) + the 7036 DETECTED check above
    if ($Point.Name -eq 'D') { Add-Check "$n : the $svc log has new/changed content since the pre-reboot baseline (consistency only, not evidence of a boot start)" '>=1 new or changed log file' $detail ($ch.Count -ge 1) }
    else { Add-Check "$n : the $svc log has no new/changed content since the pre-reboot baseline (no login, no migration)" '0 new or changed log files' $detail ($ch.Count -eq 0) }
  }
  $ct = Get-TaskInfo 'Canary'
  Add-Check "75 RECORDED $($Point.Name) : Canary task" 'recorded' ("exists=$($ct.Exists) state=$($ct.State) lastRun=$($ct.LastRun) result=$($ct.LastResult)") $true
  Assert-LanFencedFor "$n (boot+5)" 8
  Assert-Fenced "$n (boot+5)" '' @ex
  Assert-NoSecrets "$n before recover"
}

function Invoke-Recover($Point, $Saved) {
  $n = "75 boot $($Point.Name)"
  $rec = Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag "u75-recover-$($Point.Name)" -TimeoutSec 2400
  Assert-Exit "$n : update --recover" $rec 'OK'
  Check "$n : something was recovered" $true $rec.json.data.recovered
  $st = @{}; foreach ($k in $script:SvcShort) { $st[$k] = [string]$Saved.startTypes.$k }
  Assert-ConsistentStore "$n after recover" $true @{ StartTypes = $st; Rows = [string]$Saved.rows }
  Check "$n : decide() rolled forward to NEW (the swap was visible)" $script:NewV ([string](Get-Cfg).pack.current)
  Check "$n : the sidecar is gone after the final unfence" $false (Test-Path (Get-UpdateReadPath 'fence-start-types.json'))
  Check "$n : Caddyfile.live (the marker) is gone" $false (Test-Path (Join-Path $script:Data 'conf\Caddyfile.live'))
  Check "$n : the service roles can log in again" 't' (Get-RoleCanLogin 'authenticator')
  Check "$n : health exits 0" 0 (Invoke-Posctl @('health', '--write') -Tag "u75-health-after-$($Point.Name)").exit
  Assert-UpdateResult "$n after recover" 'updated' 'OK' $script:NewV
  Assert-NoSecrets "$n after recover"
}

function Invoke-Scenario([int]$Phase) {
  Use-PackKey
  $pts = $script:Points
  if ($Phase -eq 1) {
    Install-OldStore -Variant 'new'
    Check '75 the Recover task is registered' $true (Get-TaskInfo 'Recover').Exists
    Check '75 setup: the Recover task is disabled for the assertions' 0 (Set-TaskEnabled 'Recover' $false)
    # the start detector: Security 4688 (SCM 7036 is a known gap on this build). Armed BEFORE the kill and the reboot; the CmdLine key only affects processes created after it exists.
    Check '75 setup: auditpol enables Process Creation (Success) by GUID' 0 (Set-ProcessCreationAudit)
    Check '75 setup: Security log size raised (wevtutil, sandbox only)' 0 (Set-SecurityLogSize 268435456)
    Check '75 setup: Security log overwrites as needed, not retain (wevtutil /rt:false)' 0 (Set-SecurityLogOverwrite)
    $as = Get-ProcessCreationAuditState
    Check '75 setup: Process Creation auditing reads back armed' $true $as.Armed
    Check '75 setup: ProcessCreationIncludeCmdLine_Enabled reads back 1' 1 $as.CmdLineKey
    Start-Point $pts[0] (New-PreSnapshot)
    return @{ Results = (Get-Results); Reboot = $true }
  }
  $Saved = Get-Content $script:S75 -Raw | ConvertFrom-Json
  $idx = $Phase - 2                    # phase 2 -> point A ... phase 5 -> point D
  $pt = $pts[$idx]
  Assert-AfterBoot $pt $Saved
  Invoke-Recover $pt $Saved
  if ($idx -lt $pts.Count - 1) {
    Reset-Store
    Start-Point $pts[$idx + 1] (New-PreSnapshot)
    return @{ Results = (Get-Results); Reboot = $true }
  }
  Check '75 setup undone: the Recover task is enabled again' 0 (Set-TaskEnabled 'Recover' $true)
  Check '75 the Recover task is Enabled' 'Enabled' (Get-TaskInfo 'Recover').State
  return @{ Results = (Get-Results); Reboot = $false }
}
