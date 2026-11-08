# 25 - unprovision: keep data, refuse to re-provision onto kept data, confirm-guarded deletion, clean re-provision.
function Get-TopLevel { @(Get-ChildItem $script:DataRoot -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ',' }
function Invoke-Scenario([int]$Phase) {
  [void](Install-Posctl)
  [void](Ensure-VcRuntime)
  $waitKey = 'HKLM:\SYSTEM\CurrentControlSet\Control'
  $wait0 = [string](Get-ItemProperty $waitKey).WaitToKillServiceTimeout

  $p = Provision-Fresh 'C:\out\r25.json' '25-provision'
  Add-Check '25 provision (setup) exits 0' '0' (Format-Envelope $p.Result) ($p.Result.Exit -eq 0)
  if ($p.Result.Exit -ne 0) { Save-DataEvidence 'setup-failed'; return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; a tick in the next minutes holds update.lock and a lifecycle command answers LOCK_HELD (run 20261025-000013-20)
  $sid = [string]$p.Result.Json.data.storeId
  $tok = ($sid -replace '-', '').Substring(0, 8)
  Check-True '25 setup: store id is a UUID, confirm token is its first 8 hex digits' ($sid -match '^[0-9a-fA-F-]{36}$' -and $tok -match '^[0-9a-fA-F]{8}$') $sid

  # --- refusals while the store is live: nothing may be stopped or deleted -----------------------------------------------------------
  foreach ($case in @(
      @{ n = 'delete-data without --confirm'; a = @('unprovision', '--delete-data') },
      @{ n = 'delete-data with a wrong --confirm'; a = @('unprovision', '--delete-data', '--confirm', '00000000') },
      @{ n = '--keep-data and --delete-data together'; a = @('unprovision', '--keep-data', '--delete-data', '--confirm', $tok) })) {
    $r = Invoke-Posctl $case.a -Name ('25-refused-' + ($case.n -replace '[^a-z]', '-'))
    Add-Check "25 refused: $($case.n)" 'exit 2 USAGE, nothing changed' ((Format-Envelope $r) + ' ' + (Get-AllServiceStates)) ($r.Exit -eq 2 -and (Test-AllRunning) -and (Test-Path (Join-Path $script:DataRoot 'pgdata\PG_VERSION')))
  }

  # --- unprovision, data kept ----------------------------------------------------------------------------------------------------------
  $top0 = Get-TopLevel
  $u = Invoke-Posctl @('unprovision') -Name '25-unprovision-keep'
  Add-Check '25 unprovision (keep data) exits 0' '0' (Format-Envelope $u) ($u.Exit -eq 0)
  Check-True '25 all five services are gone from the SCM' (Test-AllAbsent) (Get-AllServiceStates)
  Check-Equal '25 nothing listens in the store port block any more' 0 (Get-StoreListeners).Count
  Check-Equal '25 the LAN firewall rule is gone' 0 @(Get-NetFirewallRule -PolicyStore PersistentStore -DisplayName 'Supermarket POS Store Server (LAN)' -ErrorAction SilentlyContinue).Count
  $left = @(& schtasks.exe /Query /FO CSV /NH 2>$null | Where-Object { $_ -match 'SupermarketPOS' })
  Check-True '25 the Health and Canary scheduled tasks are gone' ($left.Count -eq 0) ($left -join ' | ')
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$($script:ProgRoot)\packs\*" } | ForEach-Object { "$($_.ProcessName):$($_.Id)" })
  Check-True '25 no component process from the pack is left running' ($procs.Count -eq 0) ($procs -join ',')
  Check-True '25 the data is kept: pgdata, secrets and state\unprovisioned.json exist' ((Test-Path (Join-Path $script:DataRoot 'pgdata\PG_VERSION')) -and (Test-Path (Join-Path $script:DataRoot 'secrets\keys.json')) -and (Test-Path (Join-Path $script:DataRoot 'state\unprovisioned.json'))) (Get-TopLevel)
  Check-True '25 the packs under Program Files are kept' (Test-Path (Join-Path $script:ProgRoot "packs\$($p.PackVersion)\manifest.json"))
  Check-Equal '25 WaitToKillServiceTimeout is back to the value it had before provision' $wait0 ([string](Get-ItemProperty $waitKey).WaitToKillServiceTimeout)
  $unprov = Get-Content (Join-Path $script:DataRoot 'state\unprovisioned.json') -Raw | ConvertFrom-Json
  Check-Equal '25 unprovisioned.json keeps the store id' $sid $unprov.storeId

  # --- provision again onto kept data is refused ------------------------------------------------------------------------------------------
  $topKept = Get-TopLevel
  $again = Provision-Fresh 'C:\out\r25-again.json' '25-provision-again'
  Add-Check '25 provision onto kept data is refused (PRECONDITION, exit 12)' '12 PRECONDITION' (Format-Envelope $again.Result) ($again.Result.Exit -eq 12 -and $again.Result.Json.code -eq 'PRECONDITION')
  Check-True '25 the refused re-provision created no service and changed nothing' ((Test-AllAbsent) -and ((Get-TopLevel) -eq $topKept) -and (Test-Path (Join-Path $script:DataRoot 'pgdata\PG_VERSION'))) (Get-TopLevel)

  # --- confirm-guarded deletion on the kept data -------------------------------------------------------------------------------------------------
  $w = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', '12345678') -Name '25-delete-wrong-confirm'
  Add-Check '25 delete-data with a wrong confirm is refused (exit 2) and deletes nothing' 'exit 2, data intact' ((Format-Envelope $w) + ' ' + (Get-TopLevel)) ($w.Exit -eq 2 -and (Test-Path (Join-Path $script:DataRoot 'pgdata\PG_VERSION')) -and (Test-Path (Join-Path $script:DataRoot 'secrets\keys.json')))
  $d = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', $tok) -Name '25-delete-right-confirm'
  Add-Check '25 unprovision --delete-data --confirm <8 hex> exits 0' '0' (Format-Envelope $d) ($d.Exit -eq 0)
  Check-True '25 the data root is gone' (-not (Test-Path $script:DataRoot)) (Get-TopLevel)
  Check-True '25 services still gone, program files and packs kept' ((Test-AllAbsent) -and (Test-Path (Join-Path $script:ProgRoot "packs\$($p.PackVersion)\manifest.json")))

  # --- a clean machine again: provision works, then a delete-data of a live store --------------------------------------------------------------------
  $p2 = Provision-Fresh 'C:\out\r25-second.json' '25-provision-second'
  Add-Check '25 provision after delete-data exits 0 (names, ports and paths were released)' '0' (Format-Envelope $p2.Result) ($p2.Result.Exit -eq 0)
  if ($p2.Result.Exit -eq 0) {
    Invoke-ParkBackupTasks -Label ' (second store)'   # a live store again: same tick race before the live unprovision
    Check-True '25 second store has a different store id' ([string]$p2.Result.Json.data.storeId -ne $sid) ([string]$p2.Result.Json.data.storeId)
    $tok2 = (([string]$p2.Result.Json.data.storeId) -replace '-', '').Substring(0, 8)
    $d2 = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', $tok2) -Name '25-delete-live'
    Add-Check '25 unprovision --delete-data on a LIVE store: exit 0, services and data gone' '0 / gone' ((Format-Envelope $d2) + ' ' + (Get-AllServiceStates)) ($d2.Exit -eq 0 -and (Test-AllAbsent) -and -not (Test-Path $script:DataRoot))
    Check-Equal '25 WaitToKillServiceTimeout restored again' $wait0 ([string](Get-ItemProperty $waitKey).WaitToKillServiceTimeout)
  }
  return @{ Results = (Get-Results); Reboot = $false }
}
