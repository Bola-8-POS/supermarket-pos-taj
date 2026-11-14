# 82 - the scheduled Recover task (BootTrigger, `update --recover --quiet --scheduled`, ExecutionTimeLimit derived in update::limits, 250 min) finishes an interrupted update by itself after a reboot
# (Plan 07 Task 11, second reboot scenario; free id 82). Unlike 75 the task is left ENABLED and nothing runs --recover by hand.
#   phase 1  setup, kill at journal:swap:done, AGE the journal to two hours old (recovery is never held back by time: the boot task must not
#            care how long ago the update began), hard-stop by service PID, reboot
#   phase 2  wait (<= 20 min) for journal.json to go; then the task's Last Result is 0, the store is on NEW and fully unfenced
# Estimated 20 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Use-PackKey
  $st = 'C:\out\s82-state.json'
  if ($Phase -eq 1) {
    Install-OldStore -Variant 'new'
    $t = Get-TaskInfo 'Recover'
    Check '82 the Recover task is registered' $true $t.Exists
    Check '82 ... and enabled' 'Enabled' $t.State
    $pre = New-PreSnapshot
    $k = Invoke-KilledUpdate 'journal:swap:done' @() 'u82'
    Check '82 killed right after the swap' 137 $k.exit
    $jp = Get-UpdateReadPath 'journal.json'
    Check '82 the journal is on disk' $true (Test-Path $jp)
    # started_ms two hours back: an unattended recovery used to give up 30 minutes after the start of the update
    $jd = Get-Content $jp -Raw | ConvertFrom-Json
    $jd.started_ms = [int64]$jd.started_ms - 7200000
    [IO.File]::WriteAllText($jp, (ConvertTo-Json -InputObject $jd -Depth 20), (New-Object Text.UTF8Encoding $false))
    Check '82 the journal now claims to be two hours old' $true (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64](Get-Content $jp -Raw | ConvertFrom-Json).started_ms) -ge 7200000)
    Stop-StoreProcesses
    ConvertTo-Json -InputObject @{ boot = (Get-BootTime).ToString('o'); rows = $pre.Rows; types = $pre.StartTypes } -Depth 5 | Set-Content $st -Encoding UTF8
    return @{ Results = (Get-Results); Reboot = $true }
  }
  $S = Get-Content $st -Raw | ConvertFrom-Json
  Check '82 the machine really restarted' $true ((Get-BootTime).ToString('o') -ne $S.boot)
  $gone = Wait-Until { -not (Test-Path (Get-UpdateReadPath 'journal.json')) } 1200 5
  $t = Get-TaskInfo 'Recover'
  Add-Check '82 RECORDED the Recover task after the boot' 'recorded' ("lastRun=$($t.LastRun) result=$($t.LastResult) state=$($t.State)") $true
  Check '82 the boot task finished the interrupted update however old the journal was (journal gone within 20 min)' $true $gone
  Check '82 the Recover task reports Last Result 0' '0' $t.LastResult
  [void](Wait-Until { Test-AllRunning } 300 3)
  $types = @{}; foreach ($k in $script:SvcShort) { $types[$k] = [string]$S.types.$k }
  Assert-ConsistentStore '82 after the boot recovery' $true @{ StartTypes = $types; Rows = [string]$S.rows }
  Check '82 the swap was visible, so it rolled forward to NEW' $script:NewV ([string](Get-Cfg).pack.current)
  [void](Assert-StatusState '82' 'running')
  Assert-NoSecrets '82'
  return @{ Results = (Get-Results); Reboot = $false }
}
