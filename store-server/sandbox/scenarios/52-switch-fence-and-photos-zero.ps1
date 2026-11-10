# 52 - stored files and the photo prerequisite (Plan 09 Task 13; decision D2-a).
# STAGE 1 + STAGE 2 detection in one file: the importer is probed (`posctl photos import-from-cloud --help`).
#   importer ABSENT (Stage 1): a cloud with stored files is refused with PLAN10_REQUIRED at plan AND run, the cloud untouched.
#   importer PRESENT (Stage 2): PLAN10_REQUIRED must be GONE; the credentials block still applies. The photo COPY itself (a fake storage server in
#   the guest) is Plan 10's scenarios + T14, not here.
# Both stages: no credentials -> STORAGE_CREDENTIALS_NEEDED; zero stored files -> neither finding. The zero-photo switch RUN is scenario 50.
# Needs a base pack that carries the storage tables (Install-SwitchStore stops otherwise): so Stage 1 needs a storage-capable pack too.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $pre = Get-SwitchSnapshot
  $importer = Test-PhotoImporter
  Info '52 stage' $(if ($importer) { 'importer present (Stage 2 expectations)' } else { 'importer absent (Stage 1 expectations)' })

  # zero stored files: neither finding
  $p0 = Invoke-Switch 'plan' -Tag '52-zero'
  Assert-PlanAnswered '52 zero files' $p0
  Assert-Exit '52 zero files: the plan is clean (exit 0, no blocks)' $p0 'OK'
  Check '52 zero files: no block findings at all' '' (Join-CodeSet (Get-Codes $p0))
  Check '52 zero files: no PLAN10_REQUIRED' $false ((Get-Codes $p0) -contains 'PLAN10_REQUIRED')
  Check '52 zero files: no STORAGE_CREDENTIALS_NEEDED' $false ((Get-Codes $p0) -contains 'STORAGE_CREDENTIALS_NEEDED')
  Reset-Store

  Add-CloudPhotos 3
  $fp = Get-CloudFingerprint
  $pn = Invoke-Switch 'plan' -Tag '52-nocreds'
  Assert-PlanAnswered '52 no credentials' $pn
  Check '52 stored files without storage credentials: STORAGE_CREDENTIALS_NEEDED blocks' $true ((Get-Codes $pn) -contains 'STORAGE_CREDENTIALS_NEEDED')
  # exact block sets: PLAN10_REQUIRED is independent of the credentials (facts.rs), present exactly when the importer is absent
  $p10 = @(if (-not $importer) { 'PLAN10_REQUIRED' })
  Check '52 no credentials: the block findings are exactly the credentials one (+ PLAN10_REQUIRED when the importer is absent)' (Join-CodeSet (@('STORAGE_CREDENTIALS_NEEDED') + $p10)) (Join-CodeSet (Get-Codes $pn))
  $stdin = Get-CloudStdin -WithStorage
  $pc = Invoke-Switch 'plan' @() (Sw-Hooks) $stdin -Tag '52-creds'
  Assert-PlanAnswered '52 with credentials' $pc
  Check '52 stored files with credentials: STORAGE_CREDENTIALS_NEEDED is gone' $false ((Get-Codes $pc) -contains 'STORAGE_CREDENTIALS_NEEDED')
  Check '52 with credentials: the block findings are exactly the expected set' (Join-CodeSet $p10) (Join-CodeSet (Get-Codes $pc))
  $has10 = ((Get-Codes $pc) -contains 'PLAN10_REQUIRED')
  Check '52 PLAN10_REQUIRED blocks exactly when the importer is absent' (-not $importer) $has10
  if (-not $importer) {
    Assert-Exit '52 plan refused' $pc 'SWITCH_REFUSED' 'PLAN_BLOCKED'
    $r = Invoke-Switch 'run' @('--wait-minutes', '1') (Sw-Hooks) $stdin -Tag '52-run'
    Assert-Exit '52 run refused' $r 'SWITCH_REFUSED' 'PLAN_BLOCKED'
    Check '52 run names PLAN10_REQUIRED' $true ((Get-Codes $r) -contains 'PLAN10_REQUIRED')
    Check '52 the cloud row is untouched (no hold, no fence call)' $fp (Get-CloudFingerprint)
    Assert-LocalIntact '52' $pre
  }
  Assert-NoSecrets '52'
  Assert-NoCloudSecrets '52' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
