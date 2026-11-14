# 86 - FR19 item 6 on a real provisioned store: the updater's control files live in the protected <data>\state\update\ folder.
#   a  a pre-FR19 update-result.json and update-rolled-back.json planted in state\ (where the Gateway RX ACE reaches them) are MOVED into
#      state\update\ by the first exclusive lock (`posctl update --recover`, exit 0): bytes preserved, legacy copy gone, the new file carries the
#      protected folder's ACL (no Gateway ACE). A second legacy update-result with different content is dropped: the file already in state\update\ wins.
#      (A legacy journal.json is not planted: it would be an interrupted operation and `--recover` would act on it. The conflict rule for two
#      different journals is a host unit test, ops::journal.)
#   b  state\update\ is exactly: owner Administrators, protected, SYSTEM + Administrators full control (OI)(CI), nothing else (acl::update_dir_acl).
#   c  a standard user can neither list, read, create, overwrite nor delete in it (positive control: with a Users ACE added the same probe lists it).
#   d  tamper is REPAIRED, not refused: acquire_for -> acl::protect_update_dir -> apply_one rewrites the exact DACL on every exclusive lock
#      (a Users ACE; inheritance switched back on). The run still exits 0.
#   e  the scheduled tasks are current: status carries no TASKS_STALE alert.
# Not covered here: the fail-closed exit 17 for an UNREADABLE state (needs a non-elevated reader of the folder; host unit tests with injected readers).
# The Health + Canary scheduled tasks are paused (schtasks /DISABLE) from before the legacy plant until section e, so a scheduled `health --write` cannot repair a tamper before the probe sees it.
# Windows PowerShell 5.1 syntax only. Estimated 12 minutes (one fresh provision, as scenario 20, plus about eight posctl runs of a few seconds each).
$script:P86 = 'C:\Users\Public\p86'
$script:Upd86 = Join-Path $script:DataRoot 'state\update'
$script:State86 = Join-Path $script:DataRoot 'state'

function Write-Utf8NoBom([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false))) }
function Get-Sha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() } else { 'absent' } }
function Get-Sids([string]$Path) { if (Test-Path -LiteralPath $Path) { (@(Get-AceSids $Path) -join ',') } else { 'absent' } }
# Is this SID's ACE on the file INHERITED (Get-AclState line: sid|type|mask|inheritance|propagation|inh=True)? An absent file is false.
function Test-InheritedAce([string]$Path, [string]$Sid) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  return (@(@((Get-AclState $Path).Aces) | Where-Object { $_ -like "$Sid|*|inh=True" }).Count -gt 0)
}
# The Health and Canary tasks run `health --write`, which can take the exclusive update.lock and repair the DACL (protect_update_dir) between a tamper
# and the probe/trigger that is supposed to see it. Paused around the whole scenario body. The Enabled flag is not part of TASKS_STALE
# (tasks::scheduled_flag_via compares only <Arguments> --scheduled and <ExecutionTimeLimit>, and only for Recover + UpdateCheck), so re-enabling changes nothing there.
function Set-Task86([string]$Id, [string]$Name, [bool]$On) {
  $ErrorActionPreference = 'Continue'   # function-scoped: a native stderr line (PS 5.1 + 2>&1) must not abort the scenario
  $flag = '/DISABLE'; if ($On) { $flag = '/ENABLE' }
  [void](& schtasks.exe /Change /TN ("\SupermarketPOS\" + $Name) $flag 2>&1)
  Check-Equal $Id 0 $LASTEXITCODE
}

# the same shape as scenario 30's Invoke-AsUser (a local helper there too): a script run as the standard user, powershell.exe 5.1
function Invoke-AsStdUser($Cred, [string]$Name, [string]$ScriptText) {
  New-Item -ItemType Directory -Force $script:P86 | Out-Null
  & icacls.exe $script:P86 /grant 'Users:(OI)(CI)M' | Out-Null
  $f = Join-Path $script:P86 "$Name.ps1"
  Set-Content $f $ScriptText -Encoding ASCII
  $p = Start-Process -FilePath "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $f) -Credential $Cred -LoadUserProfile -WorkingDirectory $script:P86 -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}

# One probe run as the standard user; returns the result table (operation -> ALLOWED | DENIED | ERROR ...), or $null when it did not write one.
function Invoke-DirProbe($Cred, [string]$Tag) {
  $out = Join-Path $script:P86 "$Tag.json"
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  $probe = @'
$ErrorActionPreference = 'Continue'
$d = 'C:\ProgramData\SupermarketPOS\state\update'
$r = [ordered]@{}
function Try-It([string]$Name, [scriptblock]$Do) {
  try { & $Do; $r[$Name] = 'ALLOWED' }
  catch [System.UnauthorizedAccessException] { $r[$Name] = 'DENIED' }
  catch { $r[$Name] = 'ERROR ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
}
Try-It 'list the folder' { $null = Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop }
Try-It 'read update-result.json' { $null = [IO.File]::ReadAllBytes("$d\update-result.json") }
Try-It 'open update.lock' { $s = [IO.File]::Open("$d\update.lock", 'Open', 'Read', 'ReadWrite'); $s.Dispose() }
Try-It 'create a file' { [IO.File]::WriteAllText("$d\planted-by-user.txt", 'x') }
Try-It 'overwrite update-result.json' { [IO.File]::WriteAllText("$d\update-result.json", 'x') }
Try-It 'delete update-result.json' { Remove-Item -LiteralPath "$d\update-result.json" -Force -ErrorAction Stop }
$r | ConvertTo-Json | Set-Content '__OUT__' -Encoding ASCII
'@
  $probe = $probe.Replace('__OUT__', $out)
  $rc = Invoke-AsStdUser $Cred ("probe-" + $Tag) $probe
  if ($rc -ne 0 -or -not (Test-Path -LiteralPath $out)) { return $null }
  try { return (Get-Content -LiteralPath $out -Raw | ConvertFrom-Json) } catch { return $null }
}

function Check-UpdateDirAcl([string]$Id) {
  Check-Acl $Id $script:Upd86 @((G $script:SidSystem 'F' 3), (G $script:SidAdmins 'F' 3))
}

# `update --recover` with no journal: takes update.lock exclusive (acquire_for: protect_update_dir, then migrate_legacy), recovers nothing, exits 0
function Invoke-Trigger([string]$Tag) {
  $r = Invoke-Posctl @('update', '--recover') -Name $Tag
  $tries = 0   # the Health task's status writer may hold update.lock for an instant (exit 10, retryable): wait it out, never count it as the product failing
  while ($r.Exit -eq 10 -and $tries -lt 8) { $tries++; Start-Sleep -Seconds 5; $r = Invoke-Posctl @('update', '--recover') -Name $Tag }
  Add-Check "86 $Tag : update --recover exits 0 and recovers nothing" 'exit 0, recovered=false' ((Format-Envelope $r) + " recovered=$($r.Json.data.recovered)") ($r.Exit -eq 0 -and $r.Json.data.recovered -eq $false)
  return $r
}

function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  $p = Provision-Fresh 'C:\out\r86.json' 'provision'
  Add-Check '86 setup: provision exits 0' '0' (Format-Envelope $p.Result) ($p.Result.Exit -eq 0)
  if ($p.Result.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; a tick in the next minutes holds update.lock and a lifecycle command answers LOCK_HELD (run 20261025-000013-20)
  $gw = Get-ServiceSid $script:Svc['Gateway']
  $newResult = Join-Path $script:Upd86 'update-result.json'
  $newRolled = Join-Path $script:Upd86 'update-rolled-back.json'
  $oldResult = Join-Path $script:State86 'update-result.json'
  $oldRolled = Join-Path $script:State86 'update-rolled-back.json'

  # ---- b (as provisioned) ---------------------------------------------------------------------------------------------------------------
  Check-UpdateDirAcl '86b ACL state\update after provision (owner Administrators, protected, SYSTEM + Administrators F (OI)(CI) only)'
  Check-True '86b state\ itself still gives the Gateway its RX ACE (status.json)' ((Get-AceSids $script:State86) -contains $gw) ((Get-AceSids $script:State86) -join ',')

  # ---- a: plant pre-FR19 files in state\ --------------------------------------------------------------------------------------------------
  # pause Health + Canary so the explicit `update --recover` below, not a scheduled health run, is what migrates
  Set-Task86 '86a harness: schtasks /Change Health /DISABLE exits 0' 'Health' $false
  Set-Task86 '86a harness: schtasks /Change Canary /DISABLE exits 0' 'Canary' $false
  foreach ($f in $newResult, $newRolled) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }   # a clean slate; provision may have written none
  $legacyResult = '{"lastAtMs":1,"lastResult":"none","lastCode":"OK","lastReason":null,"lastMessage":"fr19-legacy-marker-one","packFrom":null,"packTo":null,"failedDb":null,"pending":null}'
  $plantedRolledVersion = '9.9.9-r9'
  $legacyRolled = '{"packVersion":"' + $plantedRolledVersion + '","sinceMs":1,"code":"MIGRATION_FAILED","reason":"fr19-legacy-marker"}'
  Write-Utf8NoBom $oldResult $legacyResult
  Write-Utf8NoBom $oldRolled $legacyRolled
  $h1 = Get-Sha $oldResult; $h2 = Get-Sha $oldRolled
  Check-True '86a harness: both planted hashes are real (the files were written)' (($h1 -ne 'absent') -and ($h2 -ne 'absent')) "h1=$h1 h2=$h2"
  Check-True '86a harness: the legacy files sit in state\ and carry the Gateway ACE state\ hands them' ((Test-Path -LiteralPath $oldResult) -and (Test-Path -LiteralPath $oldRolled) -and ((Get-AceSids $oldResult) -contains $gw)) (Get-Sids $oldResult)
  Check-True '86a harness: nothing is in state\update\ yet' (-not (Test-Path -LiteralPath $newResult) -and -not (Test-Path -LiteralPath $newRolled)) ''

  $r1 = Invoke-Trigger 'u86-migrate'
  Check-Equal '86a update-result.json arrived in state\update\ byte for byte' $h1 (Get-Sha $newResult)
  Check-Equal '86a update-rolled-back.json arrived in state\update\ byte for byte' $h2 (Get-Sha $newRolled)
  Check-Equal '86a the legacy update-result.json is gone from state\ (moved, not copied)' 'absent' (Get-Sha $oldResult)
  Check-Equal '86a the legacy update-rolled-back.json is gone from state\' 'absent' (Get-Sha $oldRolled)
  $want = (@($script:SidSystem, $script:SidAdmins) | Sort-Object) -join ','
  Check-Equal '86a the migrated update-result.json carries only SYSTEM + Administrators (rewritten, not renamed: no Gateway ACE)' $want (Get-Sids $newResult)
  Check-Equal '86a the migrated update-rolled-back.json carries only SYSTEM + Administrators' $want (Get-Sids $newRolled)

  # a second, different legacy update-result: the file already in state\update\ wins and the legacy one is dropped (migrate_legacy)
  Write-Utf8NoBom $oldResult ($legacyResult.Replace('fr19-legacy-marker-one', 'fr19-legacy-marker-two'))
  Check-True '86a harness: the second legacy update-result.json is planted' (Test-Path -LiteralPath $oldResult) ''
  $r2 = Invoke-Trigger 'u86-new-wins'
  Check-Equal '86a when both places hold an update-result.json the new one wins (content unchanged)' $h1 (Get-Sha $newResult)
  Check-Equal '86a ... and the stale legacy copy is dropped' 'absent' (Get-Sha $oldResult)

  # ---- b (after the migrations) -------------------------------------------------------------------------------------------------------------
  Check-UpdateDirAcl '86b ACL state\update after two exclusive locks and two migrations (exact, protected, owner Administrators)'

  # ---- c: a standard user ---------------------------------------------------------------------------------------------------------------------
  $user = 'fr19user'
  $pw = 'Aa1!' + (New-RandomToken 18)
  New-StdUser $user $pw
  $cred = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $pw -AsPlainText -Force))
  $names = 'list the folder', 'read update-result.json', 'open update.lock', 'create a file', 'overwrite update-result.json', 'delete update-result.json'
  $res = Invoke-DirProbe $cred 'denied'
  if ($res) {
    Save-Evidence '86-probe-denied' ($res | ConvertTo-Json)
    foreach ($n in $names) { Check-Equal "86c a standard user cannot: $n" 'DENIED' $res.$n }
  } else { Add-Check '86c the standard-user probe wrote its result' 'denied.json' 'missing' $false }
  Check-Equal '86c the probe changed nothing: update-result.json is intact' $h1 (Get-Sha $newResult)
  Check-True '86c the probe planted nothing' (-not (Test-Path -LiteralPath (Join-Path $script:Upd86 'planted-by-user.txt'))) ''

  # ---- d: tamper 1, an extra Users ACE ------------------------------------------------------------------------------------------------------
  & icacls.exe $script:Upd86 /grant '*S-1-5-32-545:(OI)(CI)R' | Out-Null
  Check-True '86d harness: the Users ACE is on the folder' ((Get-AceSids $script:Upd86) -contains $script:SidUsers) (Get-Sids $script:Upd86)
  Check-True '86d harness: update-result.json carries the Users ACE as INHERITED (the precondition the repair must undo)' (Test-InheritedAce $newResult $script:SidUsers) (Get-Sids $newResult)
  $pos = Invoke-DirProbe $cred 'users-ace'
  if ($pos) {
    Save-Evidence '86-probe-users-ace' ($pos | ConvertTo-Json)
    Check-Equal '86c positive control: with a Users ACE the same probe CAN list the folder (the probe can see an ACL hole)' 'ALLOWED' $pos.'list the folder'
    Check-Equal '86c positive control: with a Users ACE the same probe CAN read update-result.json' 'ALLOWED' $pos.'read update-result.json'
  } else { Add-Check '86c the positive-control probe wrote its result' 'users-ace.json' 'missing' $false }
  $r3 = Invoke-Trigger 'u86-repair-users-ace'
  Check-UpdateDirAcl '86d after a Users ACE was added, the next exclusive lock repaired the folder to the exact DACL'
  Check-True '86d ... the Users ACE is gone from the folder and from update-result.json (propagated)' ((Test-Path -LiteralPath $newResult) -and ((Get-Sids $script:Upd86) -notmatch $script:SidUsers) -and ((Get-Sids $newResult) -notmatch $script:SidUsers)) ((Get-Sids $script:Upd86) + ' / ' + (Get-Sids $newResult))
  $again = Invoke-DirProbe $cred 'after-repair'
  if ($again) { Check-Equal '86d after the repair the standard user is denied again' 'DENIED' $again.'list the folder' } else { Add-Check '86d the after-repair probe wrote its result' 'after-repair.json' 'missing' $false }

  # ---- d: tamper 2, inheritance switched back on (the Gateway RX ACE of state\ flows in) -------------------------------------------------------
  & icacls.exe $script:Upd86 /inheritance:e | Out-Null
  $t2 = Get-AclState $script:Upd86
  Check-True '86d harness: the folder is no longer protected and inherits the Gateway ACE' ((-not $t2.Protected) -and ((Get-AceSids $script:Upd86) -contains $gw)) ("protected=$($t2.Protected) sids=" + (Get-Sids $script:Upd86))
  Check-True '86d harness: update-result.json carries the Gateway ACE as INHERITED (the precondition the repair must undo)' (Test-InheritedAce $newResult $gw) (Get-Sids $newResult)
  $r4 = Invoke-Trigger 'u86-repair-inheritance'
  Check-UpdateDirAcl '86d after inheritance was switched back on, the next exclusive lock made it protected and exact again'
  Check-True '86d ... the Gateway ACE is not on the folder or on update-result.json' ((Test-Path -LiteralPath $newResult) -and ((Get-Sids $script:Upd86) -notmatch $gw) -and ((Get-Sids $newResult) -notmatch $gw)) ((Get-Sids $script:Upd86) + ' / ' + (Get-Sids $newResult))
  Check-Equal '86d the repairs never touched the content: update-result.json is intact' $h1 (Get-Sha $newResult)

  # ---- e: tasks ----------------------------------------------------------------------------------------------------------------------------------
  Set-Task86 '86e harness: schtasks /Change Health /ENABLE exits 0' 'Health' $true
  Set-Task86 '86e harness: schtasks /Change Canary /ENABLE exits 0' 'Canary' $true
  $hw = Invoke-Posctl @('health', '--write') -Name 'health-write-86'
  $st = Invoke-Posctl @('status') -Name 'status-86'
  Save-Evidence '86-status-alerts' ($st.Json.data.alerts | ConvertTo-Json -Compress -Depth 4)
  # The migrated update-rolled-back.json (planted in 86a, deliberately still there) is a live UPDATE_ROLLED_BACK warn alert: health --write is DEGRADED (21), not 0.
  # `status` always exits 0 (Outcome::ok, status.rs status_with), so it still reports the alert without a gate code.
  Check-Equal '86e health --write exits 21 (DEGRADED: the migrated rolled-back record is the one warn alert)' 21 $hw.Exit
  Check-Equal '86e status exits 0 (status never carries a health code)' 0 $st.Exit
  $hd = if ($null -ne $hw.Json) { $hw.Json.data } else { $null }
  $hAlerts = $null; if ($null -ne $hd -and (@($hd.PSObject.Properties.Name) -contains 'alerts')) { $hAlerts = @($hd.alerts) }
  Check-True '86e health --write carries data.alerts (so the alert checks are not vacuous)' ($null -ne $hAlerts) (Format-Envelope $hw)
  if ($null -ne $hAlerts) {
    Check-Equal '86e health --write has exactly one alert' 1 $hAlerts.Count
    Check-Equal '86e that alert is UPDATE_ROLLED_BACK' 'UPDATE_ROLLED_BACK' ([string]$hAlerts[0].code)
    Check-Equal '86e ... at level warn' 'warn' ([string]$hAlerts[0].level)
  } else { foreach ($n in 'has exactly one alert', 'that alert is UPDATE_ROLLED_BACK', '... at level warn') { Add-Check "86e health --write $n" 'present' 'data.alerts missing' $false } }
  $hu = if ($null -ne $hd) { $hd.update } else { $null }
  Check-Equal '86e health --write reports the planted rolled-back version (data.update.rolledBackVersion)' $plantedRolledVersion $(if ($null -ne $hu) { [string]$hu.rolledBackVersion } else { '<no data.update>' })
  Check-Equal '86e health --write lockoutHook.canaryOk is true (the recorded canary from provision passed, so the only reason for 21 is the rolled-back record)' 'True' $(if ($null -ne $hd -and $null -ne $hd.lockoutHook) { [string]$hd.lockoutHook.canaryOk } else { '<no data.lockoutHook>' })
  $svcNames = @(); if ($null -ne $hd -and $null -ne $hd.services) { $svcNames = @($hd.services.PSObject.Properties.Name) }
  Check-True '86e health --write lists services' ($svcNames.Count -gt 0) (Format-Envelope $hw)
  $badSvc = @($svcNames | Where-Object { $hd.services.$_.healthy -ne $true })
  Check-Equal '86e every listed service is healthy' '' ($badSvc -join ',')
  Check-True '86e status carries an alerts property (so the two alert checks below are not vacuous)' (($null -ne $st.Json) -and ($null -ne $st.Json.data) -and (@($st.Json.data.PSObject.Properties.Name) -contains 'alerts')) (Format-Envelope $st)
  Check-True '86e status ran and reads the migrated update state' ($null -ne $st.Json -and $st.Json.data.update -ne $null) (Format-Envelope $st)
  Check-Equal '86e no TASKS_STALE alert (the UpdateCheck and Recover tasks carry --scheduled)' 0 @($st.Json.data.alerts | Where-Object { $_.code -eq 'TASKS_STALE' }).Count
  Check-Equal '86e no TASKS_MISSING alert' 0 @($st.Json.data.alerts | Where-Object { $_.code -eq 'TASKS_MISSING' }).Count
  return @{ Results = (Get-Results); Reboot = $false }
}
