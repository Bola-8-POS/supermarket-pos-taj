# 44 - who the backup runs as, and how it is scheduled (Plan 08 Task 13; Q7 of conventions 14).
# Part B  the Backup task really runs as SYSTEM through the scheduler: it takes a caja-close backup in the SYSTEM-owned folder (assert_private passes on what SYSTEM made),
#         writes its own whitelisted log line under logs\posctl, logs a repeated skip once (dedupe over real ticks), is a quiet skip (exit 0) when an update holds update.lock
#         while a person gets LOCK_HELD (10); a standard Windows user gets NOT_ELEVATED (3).
# Part A  `tasks install` registered Backup and BackupVerify with the documented XML (SYSTEM, highest, IgnoreNew, 5-minute repetition, two actions for BackupVerify);
#         the scheduler's read-back of the time limit (PT430M may come back as PT7H10M) does not read as TASKS_STALE; a changed maintenance window makes
#         TASKS_STALE until `tasks install` re-times BackupVerify (window end + 5 min).
# Part C  Q7: can the job run as NT SERVICE\SupermarketPOS-Backup? Recorded as Info rows and a verdict row; it never fails on the verdict (Task 14 acts on it).
# Estimated 30 minutes.
. C:\scenarios\lib-backup.ps1
$script:Q7Acct = 'NT SERVICE\SupermarketPOS-Backup'
function Register-Q7Task([string]$Name, [string]$UserId, [string]$CmdFile) {
  $argText = [Security.SecurityElement]::Escape("/c `"$CmdFile`"")
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers /><Principals><Principal id="Author"><UserId>$UserId</UserId><LogonType>ServiceAccount</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><ExecutionTimeLimit>PT10M</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>$argText</Arguments></Exec></Actions></Task>
"@
  $f = Join-Path $env:TEMP "$Name.xml"; [IO.File]::WriteAllText($f, $xml, [Text.Encoding]::Unicode)
  $o = (& schtasks.exe /Create /TN "\SupermarketPOS\$Name" /XML $f /F 2>&1 | Out-String)
  return @{ ok = ($LASTEXITCODE -eq 0); out = $o.Trim() }
}
function Run-Q7Task([string]$Name, [string]$DoneFile) {
  & schtasks.exe /Run /TN "\SupermarketPOS\$Name" 2>&1 | Out-Null
  for ($i = 0; $i -lt 120 -and -not (Test-Path $DoneFile); $i++) { Start-Sleep -Seconds 1 }
  return (Test-Path $DoneFile)
}
function Write-Q7Cmd([string]$File, [string[]]$Lines) { Set-Content -LiteralPath $File -Value (@('@echo off') + $Lines) -Encoding ASCII }

function Invoke-Scenario([int]$Phase) {
  Install-BackupStore
  Seed-Probe
  $ts = Bk @('tasks', 'status') 'tasks-status'
  $names = @($ts.json.data.tasks | Where-Object { $_.installed } | ForEach-Object { $_.name })
  Check '44 provisioning registered the Backup and BackupVerify tasks (tasks status)' $true (($names -contains 'Backup') -and ($names -contains 'BackupVerify'))
  Info '44 tasks installed' ($names -join ',')

  # ---- Part B: the scheduler runs the tick as SYSTEM -----------------------------------------------------------------------------------------------------------
  [void](Backup-Now 'manual' 'backup-first')   # an Administrator's first backup: repo and pos_backup role exist
  Close-Caja
  $logBefore = @(Get-BackupLogLines).Count
  $ran = Invoke-TaskNow 'Backup' 900
  Check '44 the Backup task ran under the scheduler and finished' $true $ran
  $ti = Get-TaskInfo 'Backup'
  Check '44 the Backup task result is 0' '0' ([string]$ti.LastResult)
  $snaps = Get-Snapshots
  Check '44 the SYSTEM tick took a caja-close backup' $true (@($snaps | Where-Object { $_.reason -eq 'caja-close' }).Count -ge 1)
  $tickLines = @(Get-BackupLogLines | Select-Object -Skip $logBefore | Where-Object { $_ -ne $null -and $_ -ne '' -and $_.command -eq 'backup run' })
  if ($tickLines.Count -eq 0) { Add-Check '44 the tick wrote a log line under logs\posctl (no tick line)' 'at least one tick line' 'no tick line' $false }
  Check '44 the tick wrote one whitelisted log line under logs\posctl (backup-<day>.log)' $true ($tickLines.Count -ge 1 -and [string]$tickLines[0].code -eq 'OK' -and [string]$tickLines[0].reason -eq 'caja-close')
  $keys = @(); if ($tickLines.Count -ge 1) { $keys = @($tickLines[0].PSObject.Properties.Name) }
  Check '44 the log line holds only whitelisted keys' 0 @($keys | Where-Object { @('at', 'command', 'code', 'message', 'reason', 'outcome', 'snapshotId', 'seconds', 'dumpBytes', 'stepSeconds', 'destinations', 'repos', 'warnings') -notcontains $_ }).Count
  $newest = Get-ChildItem (Join-Path $script:Data 'backups\repo\snapshots') -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($null -eq $newest) { Add-Check '44 a snapshot file exists in the repository after the SYSTEM tick' 'a snapshot file' 'no snapshot found' $false }
  else { Info '44 owner of the newest repository file written by the SYSTEM task' (Get-AclState $newest.FullName).Owner }
  Assert-BackupsPrivate '44 after the SYSTEM tick' -Expect 'cache','repo','tmp'
  $again = Backup-Now 'manual' 'backup-after-system'
  Check '44 an Administrator can still back up after SYSTEM made content in backups\ (assert_private passes on both)' 0 $again.exit
  Test-Clean '44 after the SYSTEM tick'

  # skip-log dedupe: three scheduler ticks with nothing due log the skip once
  $mark = @(Get-BackupLogLines).Count
  for ($i = 0; $i -lt 3; $i++) { [void](Invoke-TaskNow 'Backup' 600) }
  $skips = @(Get-BackupLogLines | Select-Object -Skip $mark | Where-Object { $_.command -eq 'backup run' -and $_.outcome -eq 'skipped' })
  Check '44 three real ticks with nothing due logged the skip exactly once (dedupe on a changed reason)' 1 $skips.Count
  Info '44 the skip word logged' (@($skips | ForEach-Object { $_.message }) -join ' | ')

  # tick vs update.lock: an update holding the lock exclusively -> the tick is a quiet skip, a person is refused with LOCK_HELD
  $lock = Open-ForeignLock $true
  Check '44 setup: the foreign exclusive update.lock is held' $true ($lock -ne $null)
  try {
    $t0 = Get-Date
    $tick = Tick 'tick-locked'
    Check '44 a scheduled tick against a held update.lock is a quiet skip (exit 0)' 0 $tick.exit
    Check '44 ... reported as skipped' 'skipped' ([string]$tick.json.data.outcome)
    $man = Bk @('backup', 'run', '--reason', 'manual') 'run-locked'
    Check '44 a manual backup against a held update.lock: LOCK_HELD (10)' 10 $man.exit
    Check '44 ... retryable' $true ($man.json.retryable -eq $true)
    $vf = Bk @('backup', 'verify', '--read-data', '--scheduled', '--quiet') 'verify-locked'
    Check '44 the scheduled verify against a held update.lock is a quiet skip (exit 0)' 0 $vf.exit
    Info '44 seconds the three locked calls took' ([int]((Get-Date) - $t0).TotalSeconds)
  } finally { $lock.Dispose() }
  Check '44 once the lock is released a manual backup works again' 0 (Backup-Now 'manual' 'backup-unlocked').exit

  # a standard Windows user is NOT_ELEVATED
  $user = 'posbk44'; $upw = 'Aa1!' + (New-RandomToken 18)
  New-StdUser $user $upw
  $cred = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $upw -AsPlainText -Force))
  $work = 'C:\Users\Public\p44'; New-Item -ItemType Directory -Force $work | Out-Null
  & icacls.exe $work /grant 'Users:(OI)(CI)M' | Out-Null
  $so = Join-Path $work 'out.txt'; $se = Join-Path $work 'err.txt'; Remove-Item $so, $se -Force -ErrorAction SilentlyContinue
  $pp = Start-Process -FilePath $script:Posctl -ArgumentList @('backup', 'list') -Credential $cred -LoadUserProfile -WorkingDirectory $work -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $so -RedirectStandardError $se
  $su = $null; try { $su = (Get-Content $so -Raw) | ConvertFrom-Json } catch { }
  Save-Evidence '44-standard-user-backup-list' ("exit=$($pp.ExitCode)`n" + (Get-Content $so -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $se -Raw -ErrorAction SilentlyContinue))
  Add-Check '44 a standard user running `backup list` gets NOT_ELEVATED (exit 3) and no snapshot data' 'exit 3, NOT_ELEVATED' ("exit=$($pp.ExitCode) code=$($su.code)") ($pp.ExitCode -eq 3 -and $su.code -eq 'NOT_ELEVATED' -and -not ((Get-Content $so -Raw) -match 'snapshots'))
  # the drive picker is open to a standard user on a provisioned PC: it lists drives and nothing else
  Remove-Item $so, $se -Force -ErrorAction SilentlyContinue
  $pc = Start-Process -FilePath $script:Posctl -ArgumentList @('backup', 'dest', 'candidates') -Credential $cred -LoadUserProfile -WorkingDirectory $work -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $so -RedirectStandardError $se
  $pcOut = Get-Content $so -Raw -ErrorAction SilentlyContinue
  $pcj = $null; try { $pcj = $pcOut | ConvertFrom-Json } catch { }
  Save-Evidence '44-standard-user-dest-candidates' ("exit=$($pc.ExitCode)`n" + $pcOut + "`n" + (Get-Content $se -Raw -ErrorAction SilentlyContinue))
  Add-Check '44 a standard user running `backup dest candidates` gets exit 0, a drive list, no snapshot ids and no secret data' 'exit 0, ok, no snapshots/recovery/key/secret' ("exit=$($pc.ExitCode) ok=$($pcj.ok)") ($pc.ExitCode -eq 0 -and $pcj.ok -eq $true -and $pcOut -notmatch '(?i)snapshot|recovery|"key"|secret|password|\bpin\b')

  # ---- Part A: the registered tasks, read back ---------------------------------------------------------------------------------------------------------------
  $bx = Get-TaskXml 'Backup'; $vx = Get-TaskXml 'BackupVerify'
  Check '44 Backup runs as SYSTEM (S-1-5-18 or SYSTEM)' $true ($bx -match '<UserId>(S-1-5-18|SYSTEM)</UserId>')
  Check '44 Backup runs with the highest available privileges' $true ($bx -match '<RunLevel>HighestAvailable</RunLevel>')
  Check '44 Backup does not start a second copy (MultipleInstancesPolicy IgnoreNew)' $true ($bx -match '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
  Check '44 Backup catches up a missed run (StartWhenAvailable)' $true ($bx -match '<StartWhenAvailable>true</StartWhenAvailable>')
  Check '44 Backup repeats every 5 minutes' $true ($bx -match '<Interval>PT5M</Interval>')
  Check '44 Backup action: backup run --reason hourly --scheduled --quiet' $true ($bx -match 'backup run --reason hourly --scheduled --quiet')
  Check '44 BackupVerify has two actions in one task' 2 ([regex]::Matches($vx, '<Exec>')).Count
  Check '44 BackupVerify: verify --read-data --scheduled --quiet first, drill --scheduled --quiet second' $true ($vx -match 'backup verify --read-data --scheduled --quiet' -and $vx -match 'backup drill --scheduled --quiet' -and $vx.IndexOf('backup verify') -lt $vx.IndexOf('backup drill'))
  Check '44 BackupVerify starts daily at the default window end + 5 minutes (05:05)' $true ($vx -match 'T05:05:00')
  Check '44 BackupVerify runs as SYSTEM, highest' $true ($vx -match '<UserId>(S-1-5-18|SYSTEM)</UserId>' -and $vx -match '<RunLevel>HighestAvailable</RunLevel>')
  Info '44 the time limit as the scheduler echoes it (Backup / BackupVerify)' ((([regex]::Match($bx, '<ExecutionTimeLimit>([^<]*)</ExecutionTimeLimit>')).Groups[1].Value) + ' / ' + (([regex]::Match($vx, '<ExecutionTimeLimit>([^<]*)</ExecutionTimeLimit>')).Groups[1].Value))
  $h0 = Get-BackupStatus
  Check '44 installed tasks read back as current: no TASKS_STALE (the echoed PTnHnM spelling is parsed, not compared as text)' $false ((Alert-Codes $h0) -contains 'TASKS_STALE')
  Check '44 ... and no TASKS_MISSING' $false ((Alert-Codes $h0) -contains 'TASKS_MISSING')
  Set-MaintenanceWindow '07:00' '09:00'
  $h1 = Get-BackupStatus
  Check '44 a changed maintenance window makes BackupVerify stale: TASKS_STALE' $true ((Alert-Codes $h1) -contains 'TASKS_STALE')
  $ti2 = $null
  for ($try = 1; $try -le 3 -and ($ti2 -eq $null -or $ti2.exit -ne 0); $try++) { $ti2 = Bk @('tasks', 'install') "tasks-install-$try" }
  Check '44 tasks install exits 0' 0 $ti2.exit
  $vx2 = Get-TaskXml 'BackupVerify'
  Check '44 BackupVerify was re-timed to the custom window end + 5 minutes (09:05)' $true ($vx2 -match 'T09:05:00')
  $h2 = Get-BackupStatus
  Check '44 after tasks install the custom-window task reads back as current: no TASKS_STALE' $false ((Alert-Codes $h2) -contains 'TASKS_STALE')
  foreach ($t in 'Backup', 'BackupVerify') { Check "44 the $t task is parked again for the rest of the scenario" 0 (Set-TaskEnabled $t $false) }

  # ---- Part C: Q7 - NT SERVICE\SupermarketPOS-Backup instead of SYSTEM -------------------------------------------------------------------------------------------------
  $q = 'C:\q7'; New-Item -ItemType Directory -Force $q | Out-Null
  $run = "$q\run.txt"; $done = "$q\done.txt"; $who = "$q\who.txt"; $read = "$q\pgpass.txt"
  Write-Q7Cmd "$q\job.cmd" @("whoami > `"$who`"", "`"$script:Posctl`" backup run --reason manual --quiet > `"$run`" 2>&1", "echo %ERRORLEVEL%> `"$done`"")
  # readability is judged by the exit code of `type` into nul: the file is never copied anywhere
  Write-Q7Cmd "$q\leak.cmd" @("type `"$script:Data\secrets\pgpass.conf`" > nul 2>&1", "echo %ERRORLEVEL%> `"$done`"")
  $a = Register-Q7Task 'Q7A' $script:Q7Acct "$q\job.cmd"
  Info 'q7: the task registers without a service of that name' $a.ok
  if (-not $a.ok) { Info 'q7: schtasks said' $a.out }
  [void](& sc.exe create SupermarketPOS-Backup binPath= 'C:\Windows\System32\cmd.exe' start= demand 2>&1)
  $b = Register-Q7Task 'Q7B' $script:Q7Acct "$q\job.cmd"
  Info 'q7: the task registers with a (never started) service of that name' $b.ok
  if (-not $b.ok) { Info 'q7: schtasks said' $b.out }
  $sidT = ''; $script:Q7Grants = @()
  try { $sidT = (((& sc.exe showsid SupermarketPOS-Backup | Out-String) -split "`r?`n" | Where-Object { $_ -match 'STATUS|SERVICE SID' } | Select-Object -First 1) -replace '.*:\s*', '').Trim() } catch { }
  if (-not $sidT) { $sidT = Get-ServiceSid 'SupermarketPOS-Backup' }
  Info 'q7: the account SID' $sidT
  $verdict = 'retain-SYSTEM'
  if ($a.ok -or $b.ok) {
    & icacls.exe $q /grant "*${sidT}:(OI)(CI)M" | Out-Null
    foreach ($g in @(
        @("$script:Data\secrets\restic-password.txt", '(R)'), @("$script:Data\secrets\pgpass-backup.conf", '(R)'), @("$script:Data\secrets\pg-pos_backup.pw", '(R)'),
        @("$script:Data\conf\posctl.json", '(R)'), @("$script:Data\photos", '(OI)(CI)(RX)'), @("$script:Data\work", '(OI)(CI)(M)'),
        @("$script:Data\backups", '(OI)(CI)(M)'), @("$script:Data\state", '(OI)(CI)(M)'), @("$script:Data\state\update", '(OI)(CI)(M)'),
        @("$script:Data\logs\posctl", '(OI)(CI)(M)'))) {
      if (Test-Path $g[0]) { & icacls.exe $g[0] /grant "*${sidT}:$($g[1])" | Out-Null; $script:Q7Grants += $g[0] }
    }
    $name = 'Q7A'; if ($b.ok) { $name = 'Q7B' }
    Remove-Item $done, $run, $who -Force -ErrorAction SilentlyContinue
    $finished = Run-Q7Task $name $done
    Info 'q7: the task ran to completion' $finished
    $identity = ''; if (Test-Path $who) { $identity = (Get-Content $who -Raw).Trim() }
    Info 'q7: identity seen by the job' $identity
    $code = ''; if (Test-Path $done) { $code = (Get-Content $done -Raw).Trim() }
    Info 'q7: posctl backup run exit code under that identity' $code
    if (Test-Path $run) { Info 'q7: first 300 characters of the job output' ((Get-Content $run -Raw).Substring(0, [Math]::Min(300, (Get-Content $run -Raw).Length)) -replace '\s+', ' ') }
    Info 'q7: snapshots after the run' @(Get-Snapshots).Count
    [void](Register-Q7Task 'Q7C' $script:Q7Acct "$q\leak.cmd")
    Remove-Item $done -Force -ErrorAction SilentlyContinue
    $ranC = Run-Q7Task 'Q7C' $done
    $leak = $ranC -and ((Get-Content $done -Raw).Trim() -eq '0')
    Info 'q7: the account can read the superuser pgpass.conf (must be False to adopt)' $leak
    if ($finished -and ($code -eq '0') -and ($identity -match 'supermarketpos-backup') -and $ranC -and -not $leak) { $verdict = 'adopt-virtual-account' }
  }
  Info 'q7-verdict' $verdict
  # take every grant back before the secret scan: the service SID must not stay on the data folder (state\update included)
  if ($sidT) { foreach ($g in $script:Q7Grants) { if (Test-Path $g) { & icacls.exe $g /remove "*$sidT" 2>&1 | Out-Null } }; & icacls.exe $q /remove "*$sidT" 2>&1 | Out-Null }
  $left = @($script:Q7Grants | Where-Object { (Test-Path $_) -and ((& icacls.exe $_) -join ' ') -match [regex]::Escape($sidT) }).Count
  Check '44 q7: every grant to the service SID was removed again (folders still naming it)' 0 $left
  foreach ($t in 'Q7A', 'Q7B', 'Q7C') { & schtasks.exe /Delete /TN "\SupermarketPOS\$t" /F 2>&1 | Out-Null }
  & sc.exe delete SupermarketPOS-Backup 2>&1 | Out-Null
  Assert-NoSecrets '44'
  return @{ Results = (Get-Results); Reboot = $false }
}
