# 31 - the real `provision` serves the store over TLS on the shop LAN and the server PC trusts its own certificate authority.
# Proves (Plan 06 Task 9 carries 1, 2, 3, 6): provision renders `tls internal` on tcp4/0.0.0.0 with the machine's own names and runs the
# store_trust step (self-pair: LocalMachine\Root + client\store.env, written by that step only); every site name answers through the
# operating system's trust store; an unlisted name, plain HTTP and UDP are refused; the CA key and secrets keep their exact ACLs;
# `pki status` reports address drift and `pki reissue` fixes it in place; `pack activate` refuses to turn a TLS store back into
# plain HTTP when state\gateway.json is gone; `unprovision` removes the root from LocalMachine\Root again.
# Uses the test-hooks build (R15): the release posctl refuses the throwaway-signed pack.
function Get-GatewayJson { Get-Content (Join-Path $script:DataRoot 'state\gateway.json') -Raw | ConvertFrom-Json }

function Invoke-Scenario([int]$Phase) {
  [void](Install-Posctl)
  [void](Ensure-VcRuntime)
  $version = Install-Pack
  $computer = $env:COMPUTERNAME.ToLower()
  $digits = New-Digits6
  # no --server-host: the production path derives the name from COMPUTERNAME
  $r = Invoke-Posctl @('provision', '--pack', 'auto', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', 'C:\out\r31.json') $digits -Name '31-provision'
  Add-Check '31 provision exits 0' '0' (Format-Envelope $r) ($r.Exit -eq 0)
  Save-DataEvidence 'after-provision'
  if ($r.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; park them before the lifecycle commands (tick race, run 20261025-000013-20)
  $d = $script:DataRoot
  $lan = $script:Base + 4

  # ---- what provision decided ----------------------------------------------------------------------------------------------------------
  $gw = Get-GatewayJson
  Check-Equal '31 state\gateway.json: tls internal' 'internal' $gw.tls
  Check-Equal '31 state\gateway.json: the LAN bind is tcp4/0.0.0.0 (IPv4 only)' 'tcp4/0.0.0.0' $gw.extBind
  Check-Equal '31 state\gateway.json: the LAN port is base+4' $lan $gw.extPort
  $wantHosts = @($computer, "$computer.local", 'localhost', '127.0.0.1')
  $missingHosts = @($wantHosts | Where-Object { @($gw.hosts) -notcontains $_ })
  Add-Check '31 the certificate names include this computer, computer.local, localhost and 127.0.0.1' 'none missing' ("hosts=$(@($gw.hosts) -join ',') missing=$($missingHosts -join ',')") ($missingHosts.Count -eq 0)
  $caddyfile = Get-Content (Join-Path $d 'conf\Caddyfile') -Raw
  Check-True '31 the live Caddyfile binds tcp4/0.0.0.0 and says tls internal' ($caddyfile -match 'bind tcp4/0\.0\.0\.0' -and $caddyfile -match '(?m)^\s*tls internal') ''
  Check-True '31 journal: store_trust Done, after canary and before first_admin' ((@(Get-JournalSteps | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ') -match 'canary=done.*store_trust=done.*first_admin=done') ((Get-JournalSteps | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ')
  Check-StoreUp '31 after provision:'

  # ---- trust: the server PC trusts its own CA, exactly the CA Caddy made ---------------------------------------------------------------------
  $caRoot = Join-Path $d 'pki\caddy\pki\authorities\local\root.crt'
  Check-True '31 Caddy issued its root certificate' (Test-Path $caRoot) $caRoot
  $caDer = ConvertFrom-PemCert ([IO.File]::ReadAllText($caRoot))
  $sha1 = Get-DerSha1 $caDer; $sha256 = Get-DerSha256 $caDer
  $inStore = @(Get-TrustedRootDer $sha1)
  Check-Equal '31 exactly that root is in LocalMachine\Root (bytes equal to the CA file)' $sha256 $(if ($inStore.Count -eq 1) { Get-DerSha256 $inStore[0] } else { "count=$($inStore.Count)" })
  $v = Invoke-Posctl @('pki', 'verify-trust') -Name 'verify-trust'
  Check-True '31 pki verify-trust exits 0 and says trusted' ($v.Exit -eq 0 -and $v.Json.data.trusted -eq $true) (Format-Envelope $v)
  $exp = Invoke-Posctl @('pki', 'export-root') -Name 'export-root'
  Check-Equal '31 pki export-root names the same hash' $sha256 $exp.Json.data.sha256
  $envText = [IO.File]::ReadAllText((Join-Path $d 'client\store.env'))
  Check-True '31 store.env: offline-only, https on this computer and the LAN port, the CA hash' ($envText -match '(?m)^VITE_STORE_MODE=offline-only\r?$' -and $envText -match "(?m)^VITE_SUPABASE_URL=https://${computer}:$lan\r?$" -and $envText -match "(?m)^VITE_STORE_CA_SHA256=$sha256\r?$") $envText
  Check-True '31 store.env holds no service-role key' (-not ($envText.Contains((Get-StoreKeys).service_role)))
  Check-Equal '31 store.env, client\ and client\pki are owned by Administrators' 'S-1-5-32-544' ((@((Join-Path $d 'client\store.env'), (Join-Path $d 'client'), (Join-Path $d 'client\pki')) | ForEach-Object { (Get-AclState $_).Owner } | Sort-Object -Unique) -join ',')
  $plan = Get-DataAclPlan
  foreach ($p in "$d\client", "$d\client\pki") { Check-Acl ('31 ACL ' + $p.Replace($d, 'DATA')) $p $plan[$p] }

  # ---- TLS through the operating system's trust store (the way WebView2 sees it) -----------------------------------------------------------------
  foreach ($name in @($computer, "$computer.local", 'localhost', '127.0.0.1')) {
    $c = Invoke-Curl @('--resolve', "${name}:${lan}:127.0.0.1", "https://${name}:${lan}/_store/health")
    Check-True "31 https://$name answers /_store/health through the OS trust store" ($c.Exit -eq 0 -and $c.Text -match '"status":"ok"') (($c.Text -replace '\s+', ' ').Substring(0, [Math]::Min(200, $c.Text.Length)))
  }
  $c = Invoke-Curl @('--resolve', "evil.example:${lan}:127.0.0.1", "https://evil.example:${lan}/_store/health")
  Check-True '31 a name that is not a site host is refused (certificate error or handshake failure)' ($c.Exit -ne 0 -and $c.Text -notmatch '"status":"ok"') "exit=$($c.Exit)"
  $c = Invoke-Curl @('-k', '--resolve', "evil.example:${lan}:127.0.0.1", "https://evil.example:${lan}/_store/health")
  Check-True '31 even ignoring certificate errors the unlisted name gets no store answer (no catch-all site)' ($c.Text -notmatch '"status":"ok"') "exit=$($c.Exit) $($c.Text)"
  $c = Get-HttpCode @("http://127.0.0.1:${lan}/_store/health")
  Check-True '31 plain HTTP to the TLS port is not served (400 or no answer)' ($c.Code -eq '400' -or $c.Code -eq '000') "code=$($c.Code) $($c.Text)"
  $listen = @(Get-NetTCPConnection -LocalPort $lan -State Listen -ErrorAction SilentlyContinue)
  Add-Check '31 the LAN port listens on IPv4 0.0.0.0 only (no :: listener)' 'only 0.0.0.0' (($listen | ForEach-Object { $_.LocalAddress }) -join ',') ($listen.Count -ge 1 -and @($listen | Where-Object { $_.LocalAddress -ne '0.0.0.0' }).Count -eq 0)
  Check-Equal '31 no UDP (HTTP/3) listener on the LAN port' 0 @(Get-NetUDPEndpoint -LocalPort $lan -ErrorAction SilentlyContinue).Count
  $rest = @(Get-Listeners | Where-Object { $_.Port -ge $script:Base -and $_.Port -le ($script:Base + 9) -and $_.Port -ne $lan -and $_.Addr -ne '127.0.0.1' })
  Check-Equal '31 every other store listener is on 127.0.0.1' 0 $rest.Count
  $mode = Get-HttpCode @('-s', "http://127.0.0.1:$($script:Base + 8)/_mode")
  Check-Equal '31 the maintenance mode probe is not listening on the live gateway (curl exit 7)' 7 $mode.Exit

  # ---- exact ACLs of the key material ---------------------------------------------------------------------------------------------------------------
  $gwSid = Get-ServiceSid $script:Svc.Gateway
  $want = ((@($script:SidSystem, $script:SidAdmins, $gwSid) | Sort-Object -Unique) -join ',')
  $rootKey = Get-ChildItem (Join-Path $d 'pki\caddy') -Recurse -Filter root.key -Force | Select-Object -First 1
  Check-True '31 Caddy wrote a root.key' ($null -ne $rootKey) ''
  if ($rootKey) { Check-Equal '31 pki\caddy root.key ACEs are exactly SYSTEM, Administrators, Gateway' $want ((Get-AceSids $rootKey.FullName) -join ',') }
  $pkiStray = @(Get-ChildItem (Join-Path $d 'pki') -Recurse -Force | ForEach-Object { $p = $_.FullName; Get-AceSids $p | Where-Object { @($script:SidSystem, $script:SidAdmins, $gwSid) -notcontains $_ } | ForEach-Object { "$p : $_" } })
  Check-Equal '31 nothing under pki\ is accessible to anyone but SYSTEM, Administrators and the Gateway' 0 $pkiStray.Count
  Check-Acl '31 ACL pki\caddy' (Join-Path $d 'pki\caddy') $plan[(Join-Path $d 'pki\caddy')]
  $secStray = @(Get-ChildItem (Join-Path $d 'secrets') -Recurse -Force | ForEach-Object { $p = $_.FullName; Get-AceSids $p | Where-Object { @($script:SidUsers, 'S-1-1-0', 'S-1-5-11') -contains $_ } | ForEach-Object { "$p : $_" } })
  Check-Equal '31 no secrets file or folder gives anything to Users, Everyone or Authenticated Users' 0 $secStray.Count
  $statusF = Invoke-Posctl @('pki', 'status') -Name 'pki-status'
  Check-True '31 pki status lists this computer name and the root hash' ($statusF.Exit -eq 0 -and @($statusF.Json.data.hosts) -contains $computer -and $statusF.Json.data.rootSha256 -eq $sha256) (Format-Envelope $statusF)

  # ---- address drift and `pki reissue` (an address added to / removed from this PC) ------------------------------------------------------------------
  $extraIp = '192.168.77.9'
  $loop = (Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like 'Loopback*' } | Select-Object -First 1).InterfaceAlias
  Check-True '31 harness: a loopback pseudo-interface exists to carry a test address' ([bool]$loop) ''
  $baseHosts = @($statusF.Json.data.hosts)
  if ($loop) {
    [void](New-NetIPAddress -InterfaceAlias $loop -IPAddress $extraIp -PrefixLength 32 -SkipAsSource $false)
    Check-True '31 harness: the test address is preferred on this PC' (Wait-Until { (Get-NetIPAddress -IPAddress $extraIp -ErrorAction SilentlyContinue).AddressState -eq 'Preferred' } 30 1) ''
    $s2 = Invoke-Posctl @('pki', 'status') -Name 'pki-status-added'
    Check-True '31 pki status: the new address is listed as missing from the certificate' (@($s2.Json.data.drift.missing) -contains $extraIp -and @($s2.Json.data.drift.extra).Count -eq 0) ($s2.Json.data.drift | ConvertTo-Json -Compress)
    $c = Invoke-Curl @("https://${extraIp}:${lan}/_store/health")
    Check-True '31 before the reissue https to the new address is refused by name' ($c.Exit -ne 0) "exit=$($c.Exit)"
    $ri = Invoke-Posctl @('pki', 'reissue') -Name 'pki-reissue'
    Add-Check '31 pki reissue exits 0 (in-process Gateway restart under the update lock)' '0' (Format-Envelope $ri) ($ri.Exit -eq 0)
    Check-True '31 all five services are Running after the reissue' (Wait-Until { Test-AllRunning } 60) (Get-AllServiceStates)
    $s3 = Invoke-Posctl @('pki', 'status') -Name 'pki-status-reissued'
    Check-True '31 after the reissue there is no drift and the CA root is unchanged' (@($s3.Json.data.drift.missing).Count -eq 0 -and @($s3.Json.data.drift.extra).Count -eq 0 -and $s3.Json.data.rootSha256 -eq $sha256 -and @($s3.Json.data.hosts) -contains $extraIp) ($s3.Json.data | ConvertTo-Json -Compress -Depth 4)
    $ok = Wait-Until { (Invoke-Curl @("https://${extraIp}:${lan}/_store/health")).Text -match '"status":"ok"' } 60 2
    Check-True '31 https to the new address now answers through the OS trust store (same root, no re-pairing)' $ok ''
    Remove-NetIPAddress -InterfaceAlias $loop -IPAddress $extraIp -Confirm:$false
    Check-True '31 harness: the test address is gone again' (Wait-Until { -not (Get-NetIPAddress -IPAddress $extraIp -ErrorAction SilentlyContinue) } 30 1) ''
    $s4 = Invoke-Posctl @('pki', 'status') -Name 'pki-status-removed'
    Check-True '31 pki status: the vanished address is listed as extra' (@($s4.Json.data.drift.extra) -contains $extraIp) ($s4.Json.data.drift | ConvertTo-Json -Compress)
    $r4 = Invoke-Posctl @('pki', 'reissue') -Name 'pki-reissue-no-ip'
    Add-Check '31 pki reissue with no private IPv4 left on the PC is refused (PRECONDITION, exit 12), never dropping the IP names silently' '12' (Format-Envelope $r4) ($r4.Exit -eq 12)
    Check-Equal '31 the refused reissue changed nothing: the certificate still names the vanished address' 'True' ((@((Get-GatewayJson).hosts) -contains $extraIp))
  }

  # ---- pack activate must never turn a TLS store back into plain HTTP -------------------------------------------------------------------------------------
  $gwFile = Join-Path $d 'state\gateway.json'
  $cfBefore = (Get-FileHash (Join-Path $d 'conf\Caddyfile') -Algorithm SHA256).Hash
  $saved = Get-Content $gwFile -Raw
  Remove-Item $gwFile -Force
  $a = Invoke-Posctl @('pack', 'activate', '--version', $version) -Name 'activate-no-state'
  Add-Check '31 pack activate with state\gateway.json gone is refused (PRECONDITION, GATEWAY_STATE_MISSING) because the store shows TLS evidence' '12, GATEWAY_STATE_MISSING' (Format-Envelope $a) ($a.Exit -eq 12 -and $a.Json.message -match 'GATEWAY_STATE_MISSING')
  Check-True '31 ... the Caddyfile was not rewritten and no tls:off state file appeared' (((Get-FileHash (Join-Path $d 'conf\Caddyfile') -Algorithm SHA256).Hash -eq $cfBefore) -and -not (Test-Path $gwFile)) ''
  # recovery (review I1): the refusal's own hint must work. Without names it is refused again; with --server-host the file is rebuilt.
  $rx = Invoke-Posctl @('pki', 'reissue') -Name 'reissue-no-state-no-names'
  Add-Check '31 pki reissue without names on a missing state file is refused and its hint names `pki reissue --server-host`' '12, hint' (Format-Envelope $rx) ($rx.Exit -eq 12 -and $rx.Json.message -match 'GATEWAY_STATE_MISSING' -and $rx.Json.message -match 'pki reissue --server-host')
  $rb = Invoke-Posctl @('pki', 'reissue', '--server-host', $computer) -Name 'reissue-recover'
  Add-Check '31 pki reissue --server-host <name> rebuilds the missing state file (exit 0)' '0' (Format-Envelope $rb) ($rb.Exit -eq 0)
  $gwNew = if (Test-Path $gwFile) { Get-Content $gwFile -Raw | ConvertFrom-Json } else { $null }
  Check-True '31 the rebuilt state is TLS internal on tcp4/0.0.0.0 and covers the computer name and 127.0.0.1' ($gwNew -and $gwNew.tls -eq 'internal' -and $gwNew.extBind -eq 'tcp4/0.0.0.0' -and @($gwNew.hosts) -contains $computer -and @($gwNew.hosts) -contains '127.0.0.1') ($gwNew | ConvertTo-Json -Compress)
  Check-True '31 all five services are Running and the store answers over TLS again after the recovery' ((Wait-Until { Test-AllRunning } 60) -and (Wait-Until { (Invoke-Curl @('--resolve', "${computer}:${lan}:127.0.0.1", "https://${computer}:${lan}/_store/health")).Text -match '"status":"ok"' } 60 2)) (Get-AllServiceStates)
  Remove-Item $gwFile -Force
  [IO.File]::WriteAllText($gwFile, '{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":"storepc"}')
  $a = Invoke-Posctl @('pack', 'activate', '--version', $version) -Name 'activate-damaged-state'
  Add-Check '31 pack activate with a malformed hosts field is refused (GATEWAY_STATE_DAMAGED), not narrowed' '12, GATEWAY_STATE_DAMAGED' (Format-Envelope $a) ($a.Exit -eq 12 -and $a.Json.message -match 'GATEWAY_STATE_DAMAGED')
  [IO.File]::WriteAllText($gwFile, $saved)
  $a = Invoke-Posctl @('pack', 'activate', '--version', $version) -Name 'activate-restored-state'
  Add-Check '31 pack activate with the state file restored exits 0 and the store is still TLS' '0' (Format-Envelope $a) ($a.Exit -eq 0 -and ((Get-GatewayJson).tls -eq 'internal'))
  Check-True '31 all five services are Running after the activation' (Wait-Until { Test-AllRunning } 60) (Get-AllServiceStates)

  # ---- unprovision takes the trust anchor away with the store ----------------------------------------------------------------------------------------------------
  $tok = (([string]$r.Json.data.storeId) -replace '-', '').Substring(0, 8)
  $u = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', $tok) -Name '31-unprovision'
  Add-Check '31 unprovision --delete-data exits 0' '0' (Format-Envelope $u) ($u.Exit -eq 0)
  Check-Equal '31 the store root is no longer in LocalMachine\Root' 'False' (Test-RootTrusted $sha1)
  Check-True '31 services and data are gone' ((Test-AllAbsent) -and -not (Test-Path $d)) (Get-AllServiceStates)
  return @{ Results = (Get-Results); Reboot = $false }
}
