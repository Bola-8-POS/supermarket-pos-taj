# 50 - the switch that works, observed from every side (Plan 09 Task 13).
# STAGE 2: needs the INTEGRATED 09+10 build (a pack with the storage module so the copy list loads, and `photos import-from-cloud` for the
#   photo step). It cannot pass on the current 09 branch (PM ruling b). The photo copy is real: lib-cloud-storage-stub.ps1 serves 2 objects per bucket
#   (product-photos, store-branding) over loopback http, the run is given its url and key on stdin, and the checks read the files on disk; 52 covers the photo gate.
# One refused run first (fresh till queue): local untouched. Then the real run, paused at the first journal label to inspect the staging folders,
# then to the end: moved, re-derived admin signs in, cloud moved, staging gone, a second run and a rollback are refused.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
. C:\scenarios\lib-cloud-storage-stub.ps1
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $pre = Get-SwitchSnapshot
  Check '50 Stage 2 prerequisite: the importer is in this build' $true (Test-PhotoImporter)
  $plan = Invoke-Switch 'plan' -Tag '50-plan'
  Assert-Exit '50 baseline plan is clean' $plan 'OK'

  # a refusal leaves everything alone
  Set-CloudTill $script:TillA 'till-a' 3
  $fp = Get-CloudFingerprint
  $ref = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag '50-refused'
  Assert-Exit '50 refused run (fresh queue)' $ref 'SWITCH_REFUSED' 'PLAN_BLOCKED'
  Check '50 refused run: the cloud row is untouched' $fp (Get-CloudFingerprint)
  Assert-LocalIntact '50 after the refusal' $pre
  Clear-CloudTills
  [void](Start-CloudStorageStub)
  [void](Add-StubCloudPhotos 2)

  # the real run, with a quiet fake till that answers the drain
  [void](Start-FakeTill $script:TillA 'till-a' 'quiet')
  Check '50 setup: the fake till reported' $true (Wait-Until { (Cq 'SELECT count(*) FROM public.till_sync_report') -ne '0' } 60 1)
  $flag = Join-Path $script:OutDir 'u50.flag'; Remove-Item $flag -Force -ErrorAction SilentlyContinue
  $poll = Join-Path $script:OutDir 'poll50.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '50' $poll
  $h = Start-SwitchAsync @('--wait-minutes', '1') (Sw-Hooks @{ pause_at = @{ label = 'journal:started:done'; flag = $flag; ms = 45000 } }) 'u50' -WithStorage
  Check '50 the run reached journal:started:done' $true (Wait-FlagFile $flag 300)
  Remove-ConsoleAnswers   # the run read its console answers before its first journal label
  $res = @(Get-StagingResidue)
  Check '50 staging exists: one dump folder and one cloud-pgpass folder' 2 $res.Count
  foreach ($d in $res) { Assert-PrivateFolder "50 staging $($d.Name)" $d.FullName }
  $j = Get-JournalDoc
  $op = [string]$j.op_id
  Check '50 the journal is a switch journal' 'switch' ([string]$j.kind).ToLower()
  $r = Wait-PosctlAsync $h 3600
  Stop-LanPoller $job
  Assert-Exit '50 switch run' $r 'OK'
  Check '50 report: switched' 'True' ([string]$r.json.data.switched)
  Check '50 report: the operation id is the journal''s' $op ([string]$r.json.data.opId)
  Check '50 report: the previous database is named' $true ([bool]$r.json.data.previousDatabase)
  Check '50 report: rederive counts are present' $true ($r.json.data.rederive -ne $null)
  foreach ($k in @('fence', 'backup', 'clone', 'drain', 'copy', 'rederive', 'verify_clone', 'swap', 'activate', 'verify_live')) { Info "50 timing $k (seconds)" ([string]$r.json.data.elapsedSeconds.$k) }
  Save-Evidence '50-elapsed' ($r.json.data.elapsedSeconds | ConvertTo-Json -Compress)
  Assert-SwitchedStore '50' $op $r
  Check '50 progress record: cloud moved' 'moved' ([string](Get-SwitchProgress).cloud)
  Assert-GatewayPackVersion '50 reopened' $script:NewV
  Assert-LanNeverServed '50 fence' $poll ([DateTime]::UtcNow.AddMinutes(-60)) ([DateTime]::UtcNow)
  $arch = @(Get-ChildItem (Join-Path $script:Data 'logs\posctl\ops') -Filter "*$op*.journal.json" -ErrorAction SilentlyContinue)
  Check '50 the finished journal is archived' 1 $arch.Count
  Assert-StubPhotosCopied '50'
  Stop-CloudStorageStub
  Stop-FakeTills
  Assert-NoSecrets '50'
  Assert-NoCloudSecrets '50' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
