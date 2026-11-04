# 81 - torn gateway and fence files, what a power cut mid-write leaves (Plan 07 Task 11; obligations 1.11, 1.12, 9.4, 9.5; review I3).
# The safety property in every case: the gateway is NEVER reopened over an empty or zero-filled config, and the operator ends on a consistent store.
#   K1  update killed at journal:fence:done, conf\Caddyfile (the active one, = maintenance) torn 'empty', gateway restarted over it (what a boot does):
#       the LAN is not served (no 2xx on a data path); `--recover` re-renders maintenance and finishes.
#   K2  same with 'mixed' (the maintenance first half + the live second half).
#   K3  conf\Caddyfile.live torn 'zeros' (pre-swap rollback): `--recover` refuses (RECOVERY_NEEDED LIVE_CADDYFILE_TORN) or re-renders; either way the active Caddyfile is never
#       empty and, after the documented `pack activate` + `--recover`, the store is consistent.
#   K4  conf\Caddyfile.live torn 'empty': same.
#   K5  an EMPTY live Caddyfile is refused at the fence (backup) side: `update` does not enter maintenance over it and creates no marker.
#   K6  a corrupt start-type sidecar: recovery restores AUTOMATIC start (never leaves the stack on demand) and keeps going.
# Estimated 25 minutes.
. C:\scenarios\lib-update.ps1
# FR16 (#6): the probe goes through Invoke-LanCurl (curl --resolve <Get-LanName>:<port>:<ip>), the same call every LAN check uses. The old HttpWebRequest to https://<LAN IP> sent no SNI,
# Caddy aborted the handshake, every exception became 0 and "no 2xx" passed vacuously. Each probe keeps curl's own words, and a positive control (below) proves the path can answer 200.
function Get-DataStatuses([string]$File) {
  $ip = Get-LanIp; if ($ip -eq $null) { $ip = '127.0.0.1' }
  $res = @()
  foreach ($p in '/rest/v1/products?select=id&limit=1', '/auth/v1/health', '/functions/v1/s7-probe') {
    $r = Invoke-LanCurl 'GET' $p $ip
    $res += [pscustomobject]@{ path = $p; status = [int]$r.status; err = [string]$r.err }
  }
  return $res
}
function Assert-NeverServed([string]$Label) {
  $rows = @(Get-DataStatuses 'x')
  Check "$Label : no data path answers 2xx ($(($rows | ForEach-Object { "$($_.status)" }) -join ','))" 0 @($rows | Where-Object { $_.status -ge 200 -and $_.status -lt 300 }).Count
  Add-Check "$Label : probe detail (curl's own words per probe)" 'recorded' (($rows | ForEach-Object { "$($_.path) -> $($_.status) $($_.err)" }) -join ' | ') $true
}
# Positive control: right after a Reset-Store the store is live, so /auth/v1/health must answer 200 through the very call Assert-NeverServed uses (bounded wait for the gateway).
function Assert-ProbeCanSucceed([string]$Label) {
  $ip = Get-LanIp; if ($ip -eq $null) { $ip = '127.0.0.1' }
  $dl = [DateTime]::UtcNow.AddSeconds(60)
  do { $r = Invoke-LanCurl 'GET' '/auth/v1/health' $ip 3 (Get-StoreKeys).anon; if ($r.status -eq 200) { break }; Start-Sleep -Seconds 1 } while ([DateTime]::UtcNow -lt $dl)
  Check "$Label : positive control - /auth/v1/health is 200 through the same LAN probe ($($r.err))" 200 $r.status
}
function Assert-ActiveCaddyfileUsable([string]$Label) {
  Check "$Label : the active Caddyfile is neither empty nor zero-filled" $false (Test-ConfTorn 'Caddyfile')
}
function Start-Killed([string]$Label) {
  $k = Invoke-KilledUpdate $Label @() ("u81-" + ($Label -replace '[^A-Za-z0-9]', '_'))
  Check "81 killed at $Label" 137 $k.exit
}
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $pre = New-PreSnapshot
  $cp = @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows }
  $conf = Join-Path $script:Data 'conf'

  foreach ($kind in 'empty', 'mixed') {
    $L = "81 K1/K2 torn Caddyfile ($kind)"
    Reset-Store
    Assert-ProbeCanSucceed $L
    Start-Killed 'journal:fence:done'
    $len = Set-TornConf 'Caddyfile' $kind
    Add-Check "$L : the tear" 'recorded' "Caddyfile is now $len bytes" $true
    $s = Restart-GatewayOverConf $L
    Add-Check "$L : gateway restart over the torn file" 'recorded' ($s -replace '\s+', ' ') $true
    Assert-NeverServed $L
    $rec = Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag ("u81-rec-" + $kind)
    Assert-Exit "$L : --recover" $rec 'OK'
    Assert-ConsistentStore $L $false $cp
    Assert-ActiveCaddyfileUsable $L
    Check "$L : the old level serves again" $script:OldV ([string](Get-Cfg).pack.current)
  }

  foreach ($kind in 'zeros', 'empty') {
    $L = "81 K3/K4 torn Caddyfile.live ($kind)"
    Reset-Store
    Assert-ProbeCanSucceed $L
    Start-Killed 'journal:fence:done'
    $len = Set-TornConf 'Caddyfile.live' $kind
    Add-Check "$L : the tear" 'recorded' "Caddyfile.live is now $len bytes" $true
    $rec = Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag ("u81-rec-live-" + $kind)
    Assert-ActiveCaddyfileUsable "$L after the first --recover"
    Assert-NeverServed "$L after the first --recover"
    if ($rec.exit -eq 0) {
      Add-Check "$L : RECORDED outcome" 'recorded' 'recovery re-rendered the live config itself (exit 0)' $true
    } else {
      Assert-Exit "$L : a torn live copy is refused, not restored" $rec 'RECOVERY_NEEDED' 'LIVE_CADDYFILE_TORN'
      Check "$L : the journal is kept for the next attempt" $true (Test-Path (Get-UpdateReadPath 'journal.json'))
      $act = Invoke-Posctl @('pack', 'activate', '--version', $script:OldV, '--set-current') -Tag ("u81-activate-" + $kind)
      Check "$L : the documented fix (pack activate) exits 0" 0 $act.exit
      $rec = Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag ("u81-rec2-" + $kind)
      Assert-Exit "$L : --recover after the re-render" $rec 'OK'
    }
    Assert-ConsistentStore $L $false $cp
    Assert-ActiveCaddyfileUsable $L
  }

  # K5: an empty live config is never fenced over
  $L = '81 K5 empty live Caddyfile at the fence'
  Reset-Store
  Assert-ProbeCanSucceed $L
  [IO.File]::WriteAllBytes((Join-Path $conf 'Caddyfile'), [byte[]]@())
  $u = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u81-k5'
  Check "$L : the update does not succeed" $true ($u.exit -ne 0)
  Check "$L : no fence marker was created from an empty file" $false (Test-Path (Join-Path $conf 'Caddyfile.live'))
  Check "$L : the reason names the torn file" $true (("$($u.raw) $($u.err)") -match 'LIVE_CADDYFILE_TORN|empty')
  if (Test-Path (Get-UpdateReadPath 'journal.json')) { Assert-Exit "$L : --recover" (Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag 'u81-k5-rec') 'OK' }
  Check "$L : repair by re-rendering (pack activate)" 0 (Invoke-Posctl @('pack', 'activate', '--version', $script:OldV, '--set-current') -Tag 'u81-k5-act').exit
  Assert-ConsistentStore $L $false $cp

  # K6: a corrupt sidecar
  $L = '81 K6 corrupt start-type sidecar'
  Reset-Store
  Assert-ProbeCanSucceed $L
  Start-Killed 'journal:fence:done'
  $side = Get-UpdateReadPath 'fence-start-types.json'
  Check "$L : the sidecar exists" $true (Test-Path $side)
  [IO.File]::WriteAllText($side, '{ this is not json', (New-Object System.Text.UTF8Encoding($false)))
  $rec = Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag 'u81-k6'
  Assert-Exit "$L : --recover goes on" $rec 'OK'
  $t = Get-StartTypes
  Check "$L : Auth, Rest and Functions are back on AUTOMATIC start" 'auto,auto,auto' (@($t['Auth'], $t['Rest'], $t['Functions']) -join ',')
  Check "$L : the sidecar is gone" $false (Test-Path $side)
  Assert-ConsistentStore $L $false $cp
  Assert-NoSecrets '81'
  return @{ Results = (Get-Results); Reboot = $false }
}
