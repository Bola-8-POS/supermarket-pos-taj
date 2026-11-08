# 80 - the Canary writes an Auth user, so it must not run while an update, or its leftovers, are around (Plan 07 Task 11; obligation 7, review I2).
#   a  an update held mid-way (journal + lock):          `health --canary --write` exits 0, says "update in progress", canary.json and auth.users unchanged
#   b  the holder killed (journal, no lock):             exit 17 (recovery-needed), canary still skipped, nothing written
#   c  `--recover` done, a bare Caddyfile.live marker:   the marker alone also stops the canary (state recovery-needed), nothing written
#   d  marker removed:                                   the canary runs and passes; exit 21 (DEGRADED) with exactly the UPDATE_ROLLED_BACK warn alert left by 80b
# Estimated 12 minutes.
. C:\scenarios\lib-update.ps1
function Get-Marks { return @{ marks = (Get-AuthWriteMarks); canary = (Get-FileHashOrEmpty (Join-Path $script:Data 'state\canary.json')) } }
function Assert-CanarySkipped([string]$Label, $Before, [int]$ExitWanted) {
  $c = Invoke-Posctl @('health', '--canary', '--write') -Tag ("u80-" + ($Label -replace '[^A-Za-z0-9]', '_'))
  Check "$Label : health --canary exits $ExitWanted" $ExitWanted $c.exit
  Check "$Label : the canary did not run (update in progress)" $true ([string]$c.json.message -match 'canary did not run')
  $after = Get-Marks
  Check "$Label : auth.users, auth.schema_migrations and the lockout tables are unchanged" $Before.marks $after.marks
  Check "$Label : canary.json is untouched" $Before.canary $after.canary
}
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $pre = New-PreSnapshot
  $base = Invoke-Posctl @('health', '--canary', '--write') -Tag 'u80-baseline'
  Check '80 baseline: the canary passes on a quiet store' 0 $base.exit
  $m0 = Get-Marks
  $poll = Join-Path $script:OutDir 'poll80.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '80' $poll
  $a = Start-PausedUpdate 'journal:work:done' 90000 @() 'u80-A'
  Assert-CanarySkipped '80a mid-update' $m0 0
  [void](Assert-StatusState '80a' 'updating')
  try { $a.Process.Kill() } catch { }
  [void]$a.Process.WaitForExit(30000)
  Assert-CanarySkipped '80b crashed update' $m0 17
  Check '80b the journal is still there' $true (Test-Path (Get-UpdateReadPath 'journal.json'))
  Assert-Exit '80b --recover' (Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag 'u80-recover') 'OK'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-RollbackFenceWindow '80 fence window' $poll   # fenced from journal:work:done until --recover reopens: one episode
  $conf = Join-Path $script:Data 'conf'
  Copy-Item (Join-Path $conf 'Caddyfile') (Join-Path $conf 'Caddyfile.live') -Force     # a leftover fence marker with no journal
  [void](Assert-StatusState '80c marker only' 'recovery-needed')
  Assert-CanarySkipped '80c marker only' $m0 17
  Remove-Item (Join-Path $conf 'Caddyfile.live') -Force
  $ok = Invoke-Posctl @('health', '--canary', '--write') -Tag 'u80-final'
  # 80b's crash leg left lastResult rolled_back / RECOVERED_AFTER_INTERRUPTION and the update-rolled-back.json record (FR19 #14: record_recovery parks the version),
  # so status derives exactly one warn alert, UPDATE_ROLLED_BACK, and `health` exits 21 (DEGRADED) although the canary itself passed.
  $alerts80 = $null; $hasAlerts80 = $false
  if ($ok.json -and $ok.json.data -and (@($ok.json.data.PSObject.Properties.Name) -contains 'alerts')) { $hasAlerts80 = $true; $alerts80 = @($ok.json.data.alerts) }
  Check-True '80d health output carries an alerts property (so the alert checks are not vacuous)' $hasAlerts80 (Format-Envelope $ok)
  Check '80d without the marker the canary runs; the exit is 21 (DEGRADED) from the crash leg''s rolled-back record, not 0' 21 $ok.exit
  Check '80d the only alert is UPDATE_ROLLED_BACK' 'UPDATE_ROLLED_BACK' (@($alerts80 | ForEach-Object { [string]$_.code }) -join ',')
  Check '80d that alert is level warn' 'warn' ([string]($alerts80 | Select-Object -First 1).level)
  Check '80d lockoutHook.canaryOk is true' $true ($ok.json.data.lockoutHook.canaryOk -eq $true)
  Check '80d the canary ran this time' $false ([string]$ok.json.message -match 'canary did not run')
  $canary80 = Join-Path $script:Data 'state\canary.json'
  Check '80d canary.json was rewritten by this run' $true ((Test-Path $canary80) -and ($m0.canary -ne (Get-FileHashOrEmpty $canary80)))   # a pass rewrites lastRunAt; the baseline hash was taken before 80a
  Check '80d canary.json reports ok' $true ((Read-JsonFile (Join-Path $script:Data 'state\canary.json')).lastOk)
  Assert-ConsistentStore '80 end of run' $false @{ StartTypes = $pre.StartTypes }   # start types + recovery policy + fence marker, as the other update scenarios
  Assert-NoSecrets '80'
  return @{ Results = (Get-Results); Reboot = $false }
}
