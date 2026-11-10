# 55 - the drain: a till that never empties, and the waiver (Plan 09 Task 13).
# STAGE 2: part B is a full switch (integrated 09+10 build). Part A only reaches begin_draining and could run earlier if the baseline plan is
#   clean (56 probes that); it stays here so the pair shares one fixture.
# A: two fake tills report an empty queue until the cloud reads `draining`, then depth 2 for ever. The pre-check passes (fresh queue is 0),
#    the drain times out: exit 41 DRAIN_TIMEOUT, cloud released (active), local untouched, no journal.
# B: tills that ALWAYS report depth 2 (off, with work in them), waived by install id with --waive-reason: the pre-check passes (waived), the run
#    succeeds; the archived journal holds extra.switch.waivedQueueDepth.<install id> = 2 for both (parsed, not matched as text).
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $pre = Get-SwitchSnapshot
  [void](Start-FakeTill $script:TillA 'till-a' 'stuck'); [void](Start-FakeTill $script:TillB 'till-b' 'stuck')
  Check '55 setup: both tills reported (queue 0, active)' $true (Wait-Until { (Cq "SELECT count(*) FROM public.till_sync_report WHERE queue_depth = 0 AND seen_state = 'active'") -eq '2' } 60 1)
  $a = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '55-a' -TimeoutSec 1800
  Assert-Exit '55 A: the drain times out' $a 'SWITCH_FAILED_ROLLED_BACK' 'DRAIN_TIMEOUT'
  foreach ($l in @('till-a', 'till-b')) { Check "55 A: $l saw the hold and reported depth 2 (its job log)" $true ((Test-Path (Join-Path $script:OutDir "faketill-$l.log")) -and ((Get-Content (Join-Path $script:OutDir "faketill-$l.log") -Raw) -match 'reported depth 2 while draining')) }
  Check '55 A: the cloud was given back (active, no operation)' 'active' (Get-CloudStateWord)
  Check '55 A: progress cloud is released' 'released' ([string](Get-SwitchProgress).cloud)
  Assert-LocalIntact '55 A' $pre

  Stop-FakeTills
  Reset-Store
  [void](Start-FakeTill $script:TillA 'till-a' 'always2'); [void](Start-FakeTill $script:TillB 'till-b' 'always2')
  Check '55 B setup: both tills report depth 2' $true (Wait-Until { (Cq "SELECT count(*) FROM public.till_sync_report WHERE queue_depth = 2") -eq '2' } 90 1)
  $b = Invoke-Switch 'run' @('--wait-minutes', '1', '--waive-terminal', $script:TillA, '--waive-terminal', $script:TillB, '--waive-reason', 'scenario 55: both tills are off') -Tag '55-b' -TimeoutSec 3600
  Assert-Exit '55 B: the waived run succeeds' $b 'OK'
  $op = [string]$b.json.data.opId
  Check '55 B: the report lists both waived tills' ($script:TillA + ',' + $script:TillB) ((@($b.json.data.waived) | Sort-Object) -join ',')
  $arch = @(Get-ChildItem (Join-Path $script:Data 'logs\posctl\ops') -Filter "*$op*.journal.json" -ErrorAction SilentlyContinue)
  Check '55 B: the finished journal is archived' 1 $arch.Count
  if ($arch.Count -eq 1) {
    $jt = [IO.File]::ReadAllText($arch[0].FullName)
    Check '55 B: the journal records the waiver reason' $true ($jt -match 'scenario 55: both tills are off')
    $jd = $jt | ConvertFrom-Json
    $depths = $jd.extra.switch.waivedQueueDepth
    foreach ($u in @($script:TillA, $script:TillB)) {
      $pr = $null; if ($depths -ne $null) { $pr = $depths.PSObject.Properties[$u] }
      Check "55 B: extra.switch.waivedQueueDepth for ${u} is 2" 2 $(if ($pr) { [int]$pr.Value } else { 'missing' })
    }
  }
  Assert-SwitchedStore '55 B' $op
  Stop-FakeTills
  Assert-NoSecrets '55'
  Assert-NoCloudSecrets '55' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
