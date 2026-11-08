# 78 - update.lock across real processes (Plan 07 Task 11; obligations 3a-3c). The lock is an OS lock (LockFileEx on state\update\update.lock), so:
#   a  a FOREIGN exclusive holder and a FOREIGN shared holder (our own handle; no posctl command takes a shared lock today, a backup/verify would) both refuse
#      `update` with LOCK_HELD (exit 10); the status writer does not count them as an operation; an exclusive request waits for a shared holder that lets go
#      (`pack install --wait-lock`), and gives up with exit 10 after the wait while a real update holds it.
#   b  a real update held at before:run_backup holds the lock and names itself in update.lock.info.
#   c  that holder is killed (Process.Kill of the posctl WE started): the OS releases the lock at once, the stale .info is ignored, but journal.json remains:
#      health says recovery-needed (17), `update --dry-run` refuses (17 RECOVERY_NEEDED, recoveryPending), `update --recover` finishes (0).
#   d  a plain `update` after a crash recovers first, then updates (data.recoveryNote).
#   e  two `--recover` processes at once on one journal: the lock is taken first and the journal read after it (TOCTOU) - never both acting on it.
# Estimated 25 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $pre = New-PreSnapshot
  $cp = @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows }
  Initialize-PosLock

  # ---- a: foreign holders -------------------------------------------------------------------------------------------------------
  $x = Open-ForeignLock $true
  Check '78a we hold update.lock exclusive' $true ($x -ne $null)
  $r = Invoke-Posctl @('update', '--pack', $script:NewV, '--dry-run') (Hooks @{}) -Tag 'u78-fx'
  Assert-LockHeld '78a foreign exclusive' $r
  Assert-Exit '78a foreign exclusive' $r 'LOCK_HELD'
  Check '78a health --write is not blocked by a holder without an operation' 0 (Invoke-Posctl @('health', '--write') -Tag 'u78-health-fx').exit
  $x.Dispose()
  $s = Open-ForeignLock $false
  Check '78a we hold update.lock shared' $true ($s -ne $null)
  $r = Invoke-Posctl @('update', '--pack', $script:NewV, '--dry-run') (Hooks @{}) -Tag 'u78-fs'
  Assert-LockHeld '78a foreign shared' $r
  Assert-Exit '78a foreign shared' $r 'LOCK_HELD'
  Check '78a ... the message says a backup or verify run holds it' $true ([string]$r.json.message -match 'backup or verify')
  $c = Invoke-Posctl @('health', '--canary', '--write') -Tag 'u78-canary-fs'
  Check '78a the canary is skipped while someone holds the lock' $true ([string]$c.json.message -match 'canary did not run')
  $s.Dispose()
  # an exclusive request waits for a shared holder that is about to finish
  $s = Open-ForeignLock $false; $s.ReleaseAfter(8000)
  $t0 = Get-Date
  $w = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:PackSrc 'old.pospack'), '--wait-lock', '40') -Tag 'u78-wait'
  $el = ((Get-Date) - $t0).TotalSeconds
  Check '78a an exclusive request waited for the shared holder (>= 5 s) ...' $true ($el -ge 5)
  Check '78a ... and got the lock before its own limit (exit is not 10)' $true ($w.exit -ne 10)
  $free = Open-ForeignLock $true
  Check '78a the lock is free again after both' $true ($free -ne $null)
  if ($free) { $free.Dispose() }

  # ---- b + c: a real holder, killed ---------------------------------------------------------------------------------------------
  $poll = Join-Path $script:OutDir 'poll78.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '78' $poll
  $a = Start-PausedUpdate 'before:run_backup' 120000 @() 'u78-A'
  $info = Read-JsonFile (Get-UpdateFilePath 'update.lock.info')
  Check '78b update.lock.info names the update and its pid' "update/$($a.Pid)" "$($info.kind)/$($info.pid)"
  $blk = Invoke-Posctl @('update', '--pack', $script:NewV, '--dry-run') (Hooks @{}) -Tag 'u78-b'
  Assert-Exit '78b a second updater' $blk 'LOCK_HELD'
  $wt = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:PackSrc 'old.pospack'), '--wait-lock', '3') -Tag 'u78-wait3'
  Check '78b an exclusive request gives up with exit 10 after its wait' 10 $wt.exit
  Check '78b --recover is refused while the holder runs' 10 (Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag 'u78-rec-held').exit
  [void](Assert-StatusState '78b' 'updating')
  Check '78b the journal exists (the holder wrote Started before pausing)' $true (Test-Path (Get-UpdateReadPath 'journal.json'))
  try { $a.Process.Kill() } catch { }                    # the posctl we started, by its Process object
  [void]$a.Process.WaitForExit(30000)
  $now = Open-ForeignLock $true
  Check '78c the OS released the lock the moment the holder died' $true ($now -ne $null)
  if ($now) { $now.Dispose() }
  Check '78c the stale update.lock.info is still on disk (no destructor ran)' $true (Test-Path (Get-UpdateFilePath 'update.lock.info'))
  Check '78c ... and names a dead process' $false (Test-ProcessAlive $a.Pid)
  Check '78c the journal is still there' $true (Test-Path (Get-UpdateReadPath 'journal.json'))
  $h = Invoke-Posctl @('health', '--write') -Tag 'u78-health-crashed'
  Check '78c health exits 17 (a journal and nobody running it)' 17 $h.exit
  [void](Assert-StatusState '78c' 'recovery-needed')
  $d = Invoke-Posctl @('update', '--pack', $script:NewV, '--dry-run') (Hooks @{}) -Tag 'u78-dry'
  Assert-Exit '78c journal-present guard (dry run)' $d 'RECOVERY_NEEDED'
  Check '78c ... recoveryPending' $true $d.json.data.recoveryPending
  Check '78c ... nothing was changed by the dry run' $true (Test-Path (Get-UpdateReadPath 'journal.json'))
  $rec = Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag 'u78-recover'
  Assert-Exit '78c --recover' $rec 'OK'
  Assert-ConsistentStore '78c after recover' $false $cp
  Check '78c rolled back to OLD' $script:OldV ([string](Get-Cfg).pack.current)
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-KilledFenceWindow '78c fence window' $poll
  $fr = Get-FenceRowCount $poll
  Check "78c fence-window rows > 0 (data-path 503 STORE_UPDATING; a poller that saw no fence must not pass vacuously) ($fr)" $true ($fr -gt 0)

  # ---- d: a plain update after a crash recovers first ---------------------------------------------------------------------------------
  Reset-Store
  $k = Invoke-KilledUpdate 'journal:fence:done' @() 'u78-kill-d'
  Check '78d killed after the fence' 137 $k.exit
  $u = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u78-d'
  Assert-Exit '78d a plain update after a crash' $u 'OK'
  Check '78d it recovered the interrupted one first (recoveryNote)' $true ([bool]$u.json.data.recoveryNote)
  Check '78d ... and then updated' $true $u.json.data.updated
  Assert-ConsistentStore '78d' $true $cp

  # ---- e: two recoveries at once ------------------------------------------------------------------------------------------------------
  Reset-Store
  $k = Invoke-KilledUpdate 'journal:clone_db:done' @() 'u78-kill-e'
  Check '78e killed after the clone' 137 $k.exit
  $r1 = Start-PosctlAsync @('update', '--recover') @{} 'u78-e1'
  $r2 = Start-PosctlAsync @('update', '--recover') @{} 'u78-e2'
  $o1 = Wait-PosctlAsync $r1 900; $o2 = Wait-PosctlAsync $r2 900
  Check '78e each recovery exits 0 or 10 (never anything else)' $true ((@(0, 10) -contains $o1.exit) -and (@(0, 10) -contains $o2.exit))
  Check '78e at least one recovery ran' $true ($o1.exit -eq 0 -or $o2.exit -eq 0)
  $both = ($o1.json.data.recovered -eq $true) -and ($o2.json.data.recovered -eq $true)
  Check '78e the journal was acted on by one process only' $false $both
  Assert-ConsistentStore '78e' $false $cp
  Assert-NoSecrets '78'
  Stop-AsyncPosctl
  return @{ Results = (Get-Results); Reboot = $false }
}
