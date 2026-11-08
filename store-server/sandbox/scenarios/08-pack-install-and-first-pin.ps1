# 08 - the signed pack path (verify, tamper, install, list, downgrade refusal), the release-exe vs test-hooks-exe split, the no-terminal
# and trivial-PIN refusals, a stdin first-admin PIN, the hidden `pack activate`, `config get|set`, the interrupted-operation guard (17)
# and the maintenance gateway swapped in the way the update fence will. The PIN-never-echoed / derived-password checks live in scenario 20.
. C:\scenarios\lib-update.ps1
function Get-HttpStatus([string]$Url, [hashtable]$Headers = @{}) {
  try { [int](Invoke-WebRequest -Uri $Url -Headers $Headers -UseBasicParsing -TimeoutSec 8 -SkipHttpErrorCheck).StatusCode } catch { -1 }
}
function Get-HttpBody([string]$Url) {
  try { (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8 -SkipHttpErrorCheck).Content.Trim() } catch { 'unreachable' }
}

function Invoke-Scenario([int]$Phase) {
  $meta = Get-PayloadMeta
  $pospack = Join-Path $script:Payload ([string]$meta.signedPack)
  Check-True '08 the signed pack and the two stripped variants were staged' ((Test-Path $pospack) -and (Test-Path (Join-Path $script:Payload ([string]$meta.oldPack))) -and (Test-Path (Join-Path $script:Payload ([string]$meta.lowSchemaPack)))) 'run stage-payload.ps1'

  # ---- release exe vs test-hooks exe ----------------------------------------------------------------------------------------
  Install-Posctl -Release
  $rel = Invoke-Posctl @('dev', 'hook-env') -Name 'release-hook-env'
  Check-True '08 the RELEASE posctl lists no test hook (dev hook-env labels is empty)' ($rel.Exit -eq 0 -and @($rel.Json.data.labels).Count -eq 0) (Format-Envelope $rel)
  [void](Ensure-VcRuntime)
  $relv = Invoke-Posctl @('pack', 'verify', '--file', $pospack) -Name 'release-verify-throwaway'
  Add-Check '08 the RELEASE posctl refuses to verify a pack signed by the throwaway key (exit 13)' '13 PACK_INVALID' (Format-Envelope $relv) ($relv.Exit -eq 13)
  Install-Posctl
  $hk = Invoke-Posctl @('dev', 'hook-env') -Name 'hooks-hook-env'
  Check-True '08 the test-hooks posctl lists POSCTL_TEST_UPDATER_PUBKEY' (@($hk.Json.data.labels) -contains 'POSCTL_TEST_UPDATER_PUBKEY') (Format-Envelope $hk)

  # ---- verify / tamper / install / list ------------------------------------------------------------------------------------
  $v = Invoke-Posctl @('pack', 'verify', '--file', $pospack) -Name 'verify-ok'
  Add-Check '08 pack verify accepts the signed pack (exit 0)' '0' (Format-Envelope $v) ($v.Exit -eq 0)
  # flip one byte in the middle of the archive (a stored/compressed entry) - signature or a hash must catch it
  $tampered = 'C:\tampered.pospack'
  Copy-Item $pospack $tampered -Force
  $fs = [IO.File]::Open($tampered, 'Open', 'ReadWrite')
  try { $fs.Position = [int64]($fs.Length / 2); $b = $fs.ReadByte(); $fs.Position = [int64]($fs.Length / 2); $fs.WriteByte([byte]($b -bxor 1)) } finally { $fs.Dispose() }
  $t = Invoke-Posctl @('pack', 'verify', '--file', $tampered) -Name 'verify-tampered'
  Add-Check '08 a one-byte change is PACK_INVALID (exit 13)' '13' (Format-Envelope $t) ($t.Exit -eq 13)
  Remove-Item $tampered -Force
  $before = Invoke-Posctl @('pack', 'list') -Name 'list-before'
  Check-Equal '08 pack list is empty before the first install' 0 @(@($before.Json.data.packs) | Where-Object { $_ }).Count
  $i = Invoke-Posctl @('pack', 'install', '--file', $pospack) -Name 'install'
  Add-Check '08 pack install exits 0' '0' (Format-Envelope $i) ($i.Exit -eq 0)
  $version = [string]$i.Json.data.packVersion
  $script:PackVersion = $version
  Check-True '08 the pack is under Program Files\SupermarketPOS\packs' (Test-Path (Join-Path $script:ProgRoot "packs\$version\manifest.json")) $version
  $again = Invoke-Posctl @('pack', 'install', '--file', $pospack) -Name 'install-again'
  Check-True '08 installing twice is a no-op (alreadyInstalled)' ($again.Exit -eq 0 -and $again.Json.data.alreadyInstalled -eq $true) (Format-Envelope $again)
  $list = Invoke-Posctl @('pack', 'list') -Name 'list-after'
  Check-True '08 pack list shows it valid' (@($list.Json.data.packs | Where-Object { $_.packVersion -eq $version -and $_.valid }).Count -eq 1) $list.Raw

  # ---- provision: PIN source refusals, then a stdin PIN -------------------------------------------------------------------
  $dataBefore = Test-Path $script:DataRoot
  $pargs = @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network')
  $no = Invoke-Posctl $pargs -Name 'provision-no-pin-source'
  Add-Check '08 no PIN source and no terminal is a usage error (exit 2)' '2 USAGE' (Format-Envelope $no) ($no.Exit -eq 2 -and $no.Json.code -eq 'USAGE')
  $triv = Invoke-Posctl ($pargs + '--first-admin-pin-stdin') '123456' -Name 'provision-trivial-pin'
  Add-Check '08 a trivial stdin PIN (123456) is refused with USAGE (exit 2)' '2 USAGE' (Format-Envelope $triv) ($triv.Exit -eq 2 -and $triv.Json.code -eq 'USAGE')
  Check-True '08 neither refusal created anything (data folder, services)' (((Test-Path $script:DataRoot) -eq $dataBefore) -and (Test-AllAbsent)) (Get-AllServiceStates)
  $p = Provision-Fresh 'C:\out\r08.json' '08-provision'
  Add-Check '08 provision with a stdin PIN exits 0' '0' (Format-Envelope $p.Result) ($p.Result.Exit -eq 0)
  if ($p.Result.Exit -ne 0) { Save-DataEvidence 'setup-failed'; return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; a tick in the next minutes holds update.lock and a lifecycle command answers LOCK_HELD (run 20261025-000013-20)
  $mode = (Get-Content (Join-Path $script:DataRoot 'conf\posctl.json') -Raw | ConvertFrom-Json).mode
  Check-Equal '08 a normal provision records mode offline-only' 'offline-only' $mode
  $rf = Get-Content 'C:\out\r08.json' -Raw
  Check-True '08 the result file says pinShown=false and carries no PIN' ($rf -match '"pinShown"\s*:\s*false' -and -not $rf.Contains($p.Digits)) $rf

  # ---- the schema floor and downgrade refusals (the database is now at the pack's newest migration) ----------------------------
  $smax = (Get-Content (Get-PackPath 'manifest.json') -Raw | ConvertFrom-Json).migrations.max
  $persisted = (Get-Content (Join-Path $script:DataRoot 'state\schema-max') -Raw -ErrorAction SilentlyContinue)
  Check-Equal '08 state\schema-max was written after run_order and equals the pack''s newest migration' $smax ("$persisted".Trim())
  $liveMax = (Invoke-Psql "select max(version) from supabase_migrations.schema_migrations").Out.Trim()
  Check-Equal '08 the live database is at the same version' $smax $liveMax
  $packsBefore = (Get-ChildItem (Join-Path $script:ProgRoot 'packs') -Directory | ForEach-Object Name | Sort-Object) -join ','
  $old = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:Payload ([string]$meta.oldPack))) -Name 'install-older'
  Add-Check '08 a pack with a LOWER version is refused as a downgrade (exit 13, message names it)' '13, "older than the installed"' (Format-Envelope $old) ($old.Exit -eq 13 -and $old.Json.message -match 'older than the installed')
  $low = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:Payload ([string]$meta.lowSchemaPack))) -Name 'install-lowschema'
  Add-Check '08 a HIGHER pack whose newest migration is older than the database is refused (exit 13, schema floor)' '13, "already at"' (Format-Envelope $low) ($low.Exit -eq 13 -and $low.Json.message -match 'already at')
  $packsAfter = (Get-ChildItem (Join-Path $script:ProgRoot 'packs') -Directory | ForEach-Object Name | Sort-Object) -join ','
  Check-Equal '08 neither refused pack left anything under packs\ (no staging folder either)' $packsBefore $packsAfter

  # ---- hidden activate, config ----------------------------------------------------------------------------------------------
  $a = Invoke-Posctl @('pack', 'activate', '--version', $version, '--set-current') -Name 'activate'
  Check-True '08 pack activate (hidden) exits 0 and activating the current pack changes nothing' ($a.Exit -eq 0 -and $a.Json.data.currentChanged -eq $false) (Format-Envelope $a)
  Check-True '08 the stack is still fully Running after activate' (Wait-Until { Test-AllRunning } 120 1) (Get-AllServiceStates)
  $cfg = Invoke-Posctl @('config', 'set', 'maintenance.maxSeconds', '1200') -Name 'config-set'
  Check-Equal '08 config set maintenance.maxSeconds' 0 $cfg.Exit
  Check-Equal '08 config get returns 1200' 1200 (Invoke-Posctl @('config', 'get', 'maintenance.maxSeconds') -Name 'config-get').Json.data.value
  Check-Equal '08 a key outside the allow-list is a usage error (exit 2)' 2 (Invoke-Posctl @('config', 'set', 'ports.base', '47400') -Name 'config-set-bad').Exit
  Check-Equal '08 ... and the port base did not change' 47300 ((Get-Content (Join-Path $script:DataRoot 'conf\posctl.json') -Raw | ConvertFrom-Json).ports.base)

  # ---- while an operation journal exists, lifecycle commands refuse (17) and change nothing ----------------------------------------
  $jp = Get-UpdateFilePath 'journal.json'
  Set-Content $jp '{}'
  foreach ($c in 'start', 'stop', 'restart') { Check-Equal "08 $c refuses while journal.json exists (exit 17)" 17 (Invoke-Posctl @($c) -Name "journal-$c").Exit }
  Check-Equal '08 provision --resume refuses too (exit 17)' 17 (Invoke-Posctl @('provision', '--resume', '--pack', 'auto') -Name 'journal-resume').Exit
  Check-True '08 ... and nothing was stopped' (Test-AllRunning) (Get-AllServiceStates)
  Remove-Item $jp -Force
  $rs = Invoke-Posctl @('restart') -Name 'restart-after-journal'
  Add-Check '08 restart works again once the journal is gone (exit 0, all Running)' '0 / all Running' ((Format-Envelope $rs) + ' ' + (Get-AllServiceStates)) ($rs.Exit -eq 0 -and (Test-AllRunning))

  # ---- the maintenance gateway swapped in the way the update fence will -----------------------------------------------------------------
  $conf = Join-Path $script:DataRoot 'conf'
  Copy-Item (Join-Path $conf 'Caddyfile') (Join-Path $conf 'Caddyfile.live') -Force
  Copy-Item (Join-Path $conf 'Caddyfile.maintenance') (Join-Path $conf 'Caddyfile') -Force
  $rg = Invoke-Posctl @('restart', '--component', 'gateway') -Name 'restart-gateway-maintenance'
  Add-Check '08 restart --component gateway with the maintenance config exits 0' '0' (Format-Envelope $rg) ($rg.Exit -eq 0)
  [void](Wait-Until { (Get-HttpBody "http://127.0.0.1:$($script:Base + 8)/_mode") -eq 'maintenance' } 30 1)
  Check-Equal '08 the mode probe answers "maintenance"' 'maintenance' (Get-HttpBody "http://127.0.0.1:$($script:Base + 8)/_mode")
  # Plan 06: the LAN listener is HTTPS with the store's own certificate (the root is trusted by provision's store_trust step)
  # Get-LanTarget (lib-update.ps1): https://<provisioned SNI name> + curl --resolve; a bare https-by-IP URL carries no SNI and dies at the schannel handshake
  $lan = Invoke-LanCurl 'GET' '/rest/v1/'
  Check-Equal '08 the LAN listener answers 503 during maintenance (https, OS trust store)' 503 $lan.status
  Check-Equal '08 the INTERNAL listener keeps serving during maintenance (/auth/v1/health 200)' 200 (Get-HttpStatus "http://127.0.0.1:$($script:Base + 5)/auth/v1/health" @{ apikey = (Get-StoreKeys).anon })
  Copy-Item (Join-Path $conf 'Caddyfile.live') (Join-Path $conf 'Caddyfile') -Force
  Remove-Item (Join-Path $conf 'Caddyfile.live') -Force
  [void](Invoke-Posctl @('restart', '--component', 'gateway') -Name 'restart-gateway-live')
  Check-True '08 back on the live gateway: health OK' (Wait-Until { (Invoke-Posctl @('health') -Name 'health-live').Exit -eq 0 } 60 2) (Get-AllServiceStates)
  Check-Equal '08 the mode probe is gone again on the live gateway' 'unreachable' (Get-HttpBody "http://127.0.0.1:$($script:Base + 8)/_mode")
  Save-DataEvidence 'end'
  return @{ Results = (Get-Results); Reboot = $false }
}
