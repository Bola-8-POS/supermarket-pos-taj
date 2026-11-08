# 20 - provision happy path on a clean machine, then the lifecycle commands.
# Proves (CARRY -> 05b): services/virtual accounts/binPath, exact ACLs, pgpass/registry DACLs, hook env, loopback listeners,
# live SHOW listen_addresses, canary against a real GoTrue, first admin over real HTTP (derived password works, raw PIN refused).
function Invoke-Scenario([int]$Phase) {
  Install-Posctl -Release   # the shipped binary first: version before VC++, and the one negative pack check
  $pre = Test-Path 'C:\Windows\System32\vcruntime140.dll'
  $v0 = Invoke-Posctl @('version') -Name 'version-before-vc'
  Add-Check '20 posctl version exits 0 BEFORE vc_redist is installed (static CRT)' 'exit 0 on a machine without the runtime' "exit=$($v0.Exit) runtimePresent=$pre" ($v0.Exit -eq 0 -and -not $pre)
  [void](Ensure-VcRuntime)
  $meta = Get-PayloadMeta
  $neg = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:Payload ([string]$meta.signedPack))) -Name 'release-refuses-throwaway-pack'
  Add-Check '20 the RELEASE posctl refuses the throwaway-signed pack (PACK_INVALID, exit 13)' 'exit 13, nothing installed' ((Format-Envelope $neg) + " installed=$(Test-Path (Join-Path $script:ProgRoot "packs\$($meta.packVersion)\manifest.json"))") ($neg.Exit -eq 13 -and -not (Test-Path (Join-Path $script:ProgRoot "packs\$($meta.packVersion)\manifest.json")))
  Install-Posctl   # test-hooks build for everything that loads a pack
  $waitKey = 'HKLM:\SYSTEM\CurrentControlSet\Control'
  $wait0 = (Get-ItemProperty $waitKey).WaitToKillServiceTimeout

  $p = Provision-Fresh 'C:\out\r20.json' 'provision'
  $r = $p.Result
  Add-Check '20 provision --pack auto --first-admin-pin-stdin exits 0' '0' (Format-Envelope $r) ($r.Exit -eq 0)
  Save-DataEvidence 'after-provision'
  if ($r.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks   # provision registers the Backup tasks; a tick in the next minutes holds update.lock and a lifecycle command answers LOCK_HELD (run 20261025-000013-20)

  Check-True '20 stdout is exactly one JSON object with ok=true, code OK' ((@($r.Raw -split "`r?`n").Count -eq 1) -and $r.Json.ok -eq $true -and $r.Json.code -eq 'OK') $r.Raw
  $d = $r.Json.data
  Check-Equal '20 envelope lists five services' 5 @($d.services).Count
  Check-True '20 result file exists and parses' ((Test-Path 'C:\out\r20.json') -and $null -ne (Get-Content 'C:\out\r20.json' -Raw | ConvertFrom-Json))

  # ---- services -----------------------------------------------------------------------------------------------
  foreach ($k in $script:Svc.Keys) {
    $n = $script:Svc[$k]; $i = Get-ServiceInfo $n
    if (-not $i) { Add-Check "20 service $n exists" 'exists' 'absent' $false; continue }
    Check-Equal "20 $n state" 'Running' $i.State
    Check-Equal "20 $n account is its virtual account" "NT SERVICE\$n" $i.StartName
    Check-Equal "20 $n start mode" 'Auto' $i.StartMode
    Check-True "20 $n binPath is quoted (leading quote, quoted shawl.exe)" ($i.PathName.StartsWith('"') -and $i.PathName -match '^"[^"]+shawl\.exe"') $i.PathName
    $qc = (& sc.exe qc $n) -join "`n"
    Check-True "20 $n start type is AUTO_START and not DELAYED" ($qc -match 'AUTO_START' -and $qc -notmatch 'DELAYED') $qc
    $qf = (& sc.exe qfailure $n) -join "`n"
    Check-True "20 $n failure policy: reset after 3600 s, three restarts after 5000 ms" ($qf -match 'RESET_PERIOD[^\n]*:\s*3600' -and ([regex]::Matches($qf, 'RESTART -- Delay = 5000')).Count -eq 3) $qf
    Check-True "20 $n command line carries the production log rotation (--log-rotate bytes=10485760 --log-retain 5)" ($i.PathName -match '--log-rotate bytes=10485760' -and $i.PathName -match '--log-retain 5') $i.PathName
    $sc = (& sc.exe showsid $n) -join ' '
    Check-True "20 $n service SID equals the independently computed one" ($sc -match [regex]::Escape((Get-ServiceSid $n))) $sc
  }
  $keys = Get-StoreKeys; $pepper = Get-Pepper
  $leak = @($script:Svc.Values | ForEach-Object { (Get-ServiceInfo $_).PathName } | Where-Object { $_ -and ($_.Contains($keys.service_role) -or $_.Contains($keys.anon) -or $_.Contains($pepper)) })
  Check-Equal '20 no secret appears in any binPath' 0 $leak.Count

  # ---- ACLs exactly as acl.rs plans ----------------------------------------------------------------------------------
  $plan = Get-DataAclPlan
  foreach ($path in $plan.Keys) { Check-Acl ("20 ACL " + $path.Replace('C:\ProgramData\SupermarketPOS', 'DATA').Replace('C:\Program Files\SupermarketPOS', 'PROGRAM')) $path $plan[$path] }
  # secret files: nobody but SYSTEM/Administrators and (own reader only) a service; pgpass.conf has no service ACE at all
  $svcSids = @($script:Svc.Values | ForEach-Object { Get-ServiceSid $_ })
  $reader = @{ 'gotrue.env' = (Get-ServiceSid $script:Svc.Auth); 'postgrest.conf' = (Get-ServiceSid $script:Svc.Rest) }
  foreach ($f in Get-ChildItem (Join-Path $script:DataRoot 'secrets') -File -Force) {
    $sids = @((Get-AclState $f.FullName).Aces | ForEach-Object { ($_ -split '\|')[0] })
    $allowed = @($script:SidSystem, $script:SidAdmins) + @($(if ($reader.ContainsKey($f.Name)) { $reader[$f.Name] }))
    $extra = @($sids | Where-Object { $allowed -notcontains $_ })
    if ($f.Name -like 'caddy*') { $extra = @($extra | Where-Object { $_ -ne (Get-ServiceSid $script:Svc.Gateway) }) }
    Add-Check "20 secrets\$($f.Name) has no ACE beyond the planned ones" 'none' ($extra -join ',') ($extra.Count -eq 0)
  }
  $pg = @((Get-AclState (Join-Path $script:DataRoot 'secrets\pgpass.conf')).Aces | ForEach-Object { ($_ -split '\|')[0] })
  Check-True '20 pgpass.conf has no service ACE (and no Users/Everyone)' (@($pg | Where-Object { $svcSids -contains $_ -or $_ -in 'S-1-1-0', 'S-1-5-32-545', 'S-1-5-11' }).Count -eq 0) ($pg -join ',')

  # ---- registry: the Functions service key (secrets in Environment) is SYSTEM/Administrators only ------------------------------
  foreach ($k in $script:Svc.Keys) {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$($script:Svc[$k])"
    $a = Get-Acl $key; $ids = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    if ($k -eq 'Functions') {
      Check-True "20 registry $k key DACL is SYSTEM and Administrators only, protected" ($a.AreAccessRulesProtected -and (($ids -join ',') -eq ((@($script:SidSystem, $script:SidAdmins) | Sort-Object) -join ','))) (($ids -join ',') + " protected=$($a.AreAccessRulesProtected)")
      $env1 = (Get-ItemProperty $key -Name Environment -ErrorAction SilentlyContinue).Environment
      Check-True '20 Functions Environment value exists (secrets reach the service through the registry, not the command line)' (@($env1).Count -gt 0)
    } else {
      Add-Check "20 registry $k key DACL (recorded, not asserted)" 'recorded' ($ids -join ',') $true
    }
  }

  # ---- hook env, listeners, live listen_addresses ----------------------------------------------------------------------------
  Check-StoreUp '20 after provision:'
  $ls = Get-StoreListeners
  foreach ($port in 0, 1, 2, 3, 4, 5) { Check-True ("20 something listens on base+$port") (@($ls | Where-Object { $_.Port -eq ($script:Base + $port) }).Count -gt 0) }
  # Plan 06: the one shop-network listener is Caddy's TLS port base+4 on the IPv4 wildcard; nothing else leaves loopback
  $stray = @(Get-Listeners | Where-Object { $_.Addr -ne '127.0.0.1' -and $_.Addr -ne '::1' -and -not ($_.Port -eq ($script:Base + 4) -and $_.Addr -eq '0.0.0.0') -and ((Get-Process -Id $_.Pid -ErrorAction SilentlyContinue).ProcessName -match '^(postgres|auth|postgrest|caddy|functions|deno|shawl)$') })
  Check-Equal '20 no store process listens on a non-loopback address except the LAN TLS port on 0.0.0.0' 0 $stray.Count
  $sh = Invoke-Psql 'SHOW listen_addresses'
  Check-Equal '20 live SHOW listen_addresses' '127.0.0.1' $sh.Out.Trim()

  # ---- canary and first admin (real HTTP) ----------------------------------------------------------------------------------------
  $canary = $null; try { $canary = Get-Content (Join-Path $script:DataRoot 'state\canary.json') -Raw | ConvertFrom-Json } catch { }
  Check-True '20 canary ran against the real GoTrue: state\canary.json lastOk=true' ($canary -and $canary.lastOk -eq $true) ($canary | ConvertTo-Json -Compress)
  Check-True '20 journal: canary step Done' (@(Get-JournalSteps | Where-Object { $_.name -eq 'canary' -and $_.state -eq 'done' }).Count -ge 1)
  $adminId = [string]$d.firstAdmin.id
  Check-True '20 envelope names the first admin (mustChangePin, PIN not shown)' ($adminId -match '^[0-9a-fA-F-]{36}$' -and $d.firstAdmin.mustChangePin -eq $true -and $d.firstAdmin.pinShown -eq $false) ($d.firstAdmin | ConvertTo-Json -Compress)
  $email = "$adminId@barpos.local"
  $raw = Invoke-Grant $email $p.Digits
  Check-Equal '20 raw PIN as the GoTrue password is refused (HTTP)' 400 $raw.Status
  $derived = Get-DerivedPassword $adminId $p.Digits $pepper
  $good = Invoke-Grant $email $derived
  Check-True '20 derived password grant works (HTTP 200 + access_token)' ($good.Status -eq 200 -and $good.Body -match 'access_token') "status=$($good.Status)"
  $prof = Invoke-Psql "SELECT role || '|' || must_change_pin FROM public.profiles WHERE id = '$adminId'"
  Check-Equal '20 profiles row: admin, must_change_pin' 'admin|true' ($prof.Out.Trim() -replace '\|t$', '|true')

  # ---- the PIN (and the derived password) are nowhere ---------------------------------------------------------------------------------
  $roots = @('C:\out\r20.json', (Join-Path $script:DataRoot 'logs'), (Join-Path $script:DataRoot 'state'), (Join-Path $script:DataRoot 'conf'), (Join-Path $script:DataRoot 'secrets'), (Join-Path $script:DataRoot 'client'), (Join-Path $script:DataRoot 'work'), (Join-Path $script:DataRoot 'tmp'))
  $hits = @(); foreach ($root in $roots) { $hits += @(Find-Text $root $p.Digits) }
  Check-True '20 PIN absent from result file, logs, journal/state, conf, secrets, client, work, tmp' ($hits.Count -eq 0) ($hits -join ', ')
  Check-True '20 PIN absent from posctl stdout and stderr' (-not ($r.Raw + $r.Stderr).Contains($p.Digits))
  $hits2 = @(); foreach ($root in $roots) { $hits2 += @(Find-Text $root $derived) }
  Check-True '20 derived password absent from all of those' ($hits2.Count -eq 0) ($hits2 -join ', ')
  Check-True '20 WaitToKillServiceTimeout raised to 30000 (never lowered)' ([int](Get-ItemProperty $waitKey).WaitToKillServiceTimeout -ge 30000) "was $wait0, now $((Get-ItemProperty $waitKey).WaitToKillServiceTimeout)"

  # ---- lifecycle ---------------------------------------------------------------------------------------------------------------------
  $x = Invoke-Posctl @('stop') -Name 'stop'
  Add-Check '20 stop exits 0, every service Stopped' '0 / all Stopped' ((Format-Envelope $x) + ' ' + (Get-AllServiceStates)) ($x.Exit -eq 0 -and @($script:Svc.Values | Where-Object { (Get-ServiceInfo $_).State -ne 'Stopped' }).Count -eq 0)
  $x = Invoke-Posctl @('start') -Name 'start'
  Add-Check '20 start exits 0, every service Running' '0 / all Running' ((Format-Envelope $x) + ' ' + (Get-AllServiceStates)) ($x.Exit -eq 0 -and (Test-AllRunning))
  $x = Invoke-Posctl @('restart') -Name 'restart'
  Add-Check '20 restart exits 0, every service Running' '0 / all Running' ((Format-Envelope $x) + ' ' + (Get-AllServiceStates)) ($x.Exit -eq 0 -and (Test-AllRunning))
  $x = Invoke-Posctl @('restart', '--component', 'auth') -Name 'restart-auth'
  Add-Check '20 restart --component auth exits 0, every service Running' '0 / all Running' ((Format-Envelope $x) + ' ' + (Get-AllServiceStates)) ($x.Exit -eq 0 -and (Test-AllRunning))
  $secret = 're_' + (New-RandomToken 24)
  $x = Invoke-Posctl @('secret', 'set', 'RESEND_API_KEY', '--stdin') $secret -Name 'secret-set'
  Add-Check '20 secret set RESEND_API_KEY --stdin exits 0, every service Running' '0 / all Running' ((Format-Envelope $x) + ' ' + (Get-AllServiceStates)) ($x.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120))
  Check-True '20 the secret value is in no output, log or state file' (-not ($x.Raw + $x.Stderr).Contains($secret) -and (@(Find-Text (Join-Path $script:DataRoot 'logs') $secret) + @(Find-Text (Join-Path $script:DataRoot 'state') $secret) + @(Find-Text 'C:\out' $secret)).Count -eq 0)
  Check-Equal '20 the secret reached its ACL-protected file' $true (Test-Path (Join-Path $script:DataRoot 'secrets\optional-RESEND_API_KEY.txt'))
  Check-StoreUp '20 after lifecycle:'
  $good2 = Invoke-Grant $email $derived
  Check-True '20 the derived password still signs in after stop/start/restart/secret set' ($good2.Status -eq 200) "status=$($good2.Status)"
  # ---- no firewall rule or prompt needed (busy-port check must not bind a wildcard) ----------------------------------------
  $fwRules = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -match 'posctl|SupermarketPOS' })
  Add-Check '20 no PROGRAM firewall rule exists for posctl or any store program (none auto-created by an allow prompt; the one port rule has no program)' '0 rules' ("$($fwRules.Count) rules: " + (($fwRules.Program) -join ', ')) ($fwRules.Count -eq 0)
  $fwEvents = @()
  try { $fwEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Firewall With Advanced Security/Firewall'; Id = 2004, 2005, 2006 } -ErrorAction Stop | Where-Object { $_.Message -match 'posctl|SupermarketPOS' }) } catch { }
  Add-Check '20 no firewall rule add/change/delete event mentions posctl or a store program' '0 events' "$($fwEvents.Count) events" ($fwEvents.Count -eq 0)
  $fwNotify = (& netsh.exe advfirewall show currentprofile settings | Select-String -Pattern 'InboundUserNotification' | ForEach-Object { $_.Line.Trim() }) -join ' '
  Add-Check '20 RECORDED firewall notification setting during this run' 'recorded' $fwNotify $true

  # ===== folded from 05b scenario 01 and the Task 10 CARRY list ================================================================
  Check-True '20 SPIKE_TEST_ROUTES is not set in the Functions Environment value' (@((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\SupermarketPOS-Functions').Environment | Where-Object { $_ -like 'SPIKE_TEST_ROUTES*' }).Count -eq 0)
  $coll = Invoke-Psql "select datlocprovider::text || '|' || datlocale from pg_database where datname = 'postgres'"
  Check-Equal '20 cluster locale provider and locale (ICU, es-MX)' 'i|es-MX' $coll.Out.Trim()
  $order = Invoke-Psql "select string_agg(ascii(x)::text, ',' order by x) from (values ('o'), (chr(241)), ('n')) v(x)"
  Check-Equal '20 n-tilde sorts between n and o (110,241,111)' '110,241,111' $order.Out.Trim()
  Check-Equal '20 the database time zone is UTC' 'UTC' (Invoke-Psql 'show timezone').Out.Trim()
  Check-Equal '20 the app owner role postgres is not a superuser' 'f' (Invoke-Psql "select rolsuper from pg_roles where rolname = 'postgres'").Out.Trim()
  $hbaRows = @((Invoke-Psql "select coalesce(address, '-') || ' ' || type from pg_hba_file_rules where type like 'host%'").Out -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $hbaBad = @($hbaRows | Where-Object { $_ -notmatch '^(127\.0\.0\.1|::1)' })
  Add-Check '20 live pg_hba_file_rules: every host rule is loopback (127.0.0.1 or ::1)' 'no other address' (($hbaRows) -join ' | ') ($hbaRows.Count -gt 0 -and $hbaBad.Count -eq 0)
  $hc = Invoke-Posctl @('health', '--canary', '--write') -Name 'health-canary-write'
  Add-Check '20 health --canary --write exits 0 (live canary::run against the real GoTrue)' '0' (Format-Envelope $hc) ($hc.Exit -eq 0)
  Check-True '20 health reports canaryOk=true and envOk=true' ($hc.Json.data.lockoutHook.canaryOk -eq $true -and $hc.Json.data.lockoutHook.envOk -eq $true) ($hc.Json.data.lockoutHook | ConvertTo-Json -Compress)
  $statusText = Get-Content (Join-Path $script:DataRoot 'state\status.json') -Raw
  $secretVals = @((Get-SecretText 'jwt-secret.txt'), (Get-Pepper), (Get-SecretText 'pg-postgres.pw'), (Get-StoreKeys).service_role, (Get-StoreKeys).anon)
  Check-True '20 status.json holds no secret value, no JWT and no filesystem path' (-not ($secretVals | Where-Object { $_ -and $statusText.Contains($_) }) -and $statusText -notmatch 'eyJ' -and $statusText -notmatch '[A-Za-z]:\\') ($statusText.Substring(0, [Math]::Min(300, $statusText.Length)))
  Check-Equal '20 posctl.json records the mode' 'offline-only' ((Get-Content (Join-Path $script:DataRoot 'conf\posctl.json') -Raw | ConvertFrom-Json).mode)
  Check-True '20 provisioned.json exists and the update/switch journal (state\update\journal.json) does not' ((Test-Path (Join-Path $script:DataRoot 'state\provisioned.json')) -and -not (Test-Path (Get-UpdateReadPath 'journal.json'))) ''
  # R13 flip (Plan 06 Task 9): the store_trust step self-pairs, so provision now writes the server PC's own client\store.env
  $se = Join-Path $script:DataRoot 'client\store.env'
  $seText = if (Test-Path $se) { [IO.File]::ReadAllText($se) } else { '' }
  Check-True '20 client\store.env is written by provision (store_trust): offline-only, https on the LAN port, a 64-hex CA hash' ($seText -match '(?m)^VITE_STORE_MODE=offline-only\r?$' -and $seText -match "(?m)^VITE_SUPABASE_URL=https://sandbox-pc:$($script:Base + 4)\r?$" -and $seText -match '(?m)^VITE_STORE_CA_SHA256=[0-9a-f]{64}\r?$') $seText
  # review I2: the certificate names come from the --server-host provision recorded, not from COMPUTERNAME
  $pst = Invoke-Posctl @('pki', 'status') -Name 'pki-status-server-host'
  Check-True '20 pki status after --server-host sandbox-pc: the certificates cover sandbox-pc and there is no drift' ($pst.Exit -eq 0 -and @($pst.Json.data.hosts) -contains 'sandbox-pc' -and @($pst.Json.data.drift.missing).Count -eq 0 -and @($pst.Json.data.drift.extra).Count -eq 0) ((Format-Envelope $pst) + ' ' + ($pst.Json.data | ConvertTo-Json -Compress -Depth 4))
  Check-True '20 journal: store_trust step Done' (@(Get-JournalSteps | Where-Object { $_.name -eq 'store_trust' -and $_.state -eq 'done' }).Count -ge 1)
  $packMax = (Get-Content (Get-PackPath 'manifest.json') -Raw | ConvertFrom-Json).migrations.max
  Check-Equal '20 state\schema-max was persisted after run_order (the pack''s newest migration)' $packMax (((Get-Content (Join-Path $script:DataRoot 'state\schema-max') -Raw -ErrorAction SilentlyContinue) + '').Trim())
  Check-Acl '20 ACL state\update\update.lock (lock_file_acl: SYSTEM + Administrators only, protected)' (Get-UpdateFilePath 'update.lock') @((G $script:SidSystem 'F' 0), (G $script:SidAdmins 'F' 0))
  # network: the one port rule (Public-profile refusal cannot be exercised: sandbox networking is off)
  $rule = @(Get-NetFirewallRule -PolicyStore PersistentStore -DisplayName 'Supermarket POS Store Server (LAN)' -ErrorAction SilentlyContinue)
  Check-Equal '20 exactly one firewall rule named "Supermarket POS Store Server (LAN)"' 1 $rule.Count
  if ($rule.Count -eq 1) {
    $pf = $rule[0] | Get-NetFirewallPortFilter; $af = $rule[0] | Get-NetFirewallAddressFilter; $apf = $rule[0] | Get-NetFirewallApplicationFilter
    $facts = "enabled=$($rule[0].Enabled) dir=$($rule[0].Direction) action=$($rule[0].Action) profile=$($rule[0].Profile) proto=$($pf.Protocol) lport=$($pf.LocalPort) raddr=$($af.RemoteAddress) prog=$($apf.Program)"
    Add-Check '20 the rule is inbound Allow TCP on base+4, Private+Domain only, RemoteAddress LocalSubnet, no program' 'True/Inbound/Allow/Domain, Private/TCP/47304/LocalSubnet/Any' $facts ("$($rule[0].Enabled)" -eq 'True' -and "$($rule[0].Direction)" -eq 'Inbound' -and "$($rule[0].Action)" -eq 'Allow' -and "$($rule[0].Profile)" -eq 'Domain, Private' -and "$($pf.Protocol)" -eq 'TCP' -and "$($pf.LocalPort)" -eq "$($script:Base + 4)" -and "$($af.RemoteAddress)" -eq 'LocalSubnet' -and "$($apf.Program)" -eq 'Any')
  }
  $nc = Invoke-Posctl @('net', 'check') -Name 'net-check'
  Add-Check '20 net check exits 0 (rule right, no Public profile; the Public refusal is unit-tested only)' '0' (Format-Envelope $nc) ($nc.Exit -eq 0)
  # tasks: installed; the scratch folder is SYSTEM + Administrators only while `tasks install` runs; the Health task rewrites status.json
  $ts = Invoke-Posctl @('tasks', 'status') -Name 'tasks-status'
  Check-True '20 Health and Canary tasks are installed' (@($ts.Json.data.tasks | Where-Object { $_.installed -and ($_.name -eq 'Health' -or $_.name -eq 'Canary') }).Count -eq 2) $ts.Raw
  $sddlSeen = $null; $tries = 0
  while (-not $sddlSeen -and $tries -lt 4) {
    $tries++
    $h = [Diagnostics.Process]::Start((New-PosctlStartInfo @('tasks', 'install')))
    $h.StandardInput.Close(); $so = $h.StandardOutput.ReadToEndAsync(); $se = $h.StandardError.ReadToEndAsync()
    while (-not $h.HasExited) {
      foreach ($d in [IO.Directory]::GetDirectories('C:\ProgramData', 'posctl-tasks-*')) {
        try {
          $a = Get-Acl -LiteralPath $d
          if (-not $sddlSeen) { $sddlSeen = [pscustomobject]@{ Path = $d; Protected = $a.AreAccessRulesProtected; Owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value; Sids = (@($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) -join ',') } }
        } catch { }
      }
      Start-Sleep -Milliseconds 5
    }
    $h.WaitForExit()
    Save-Evidence "tasks-install-$tries" "exit=$($h.ExitCode)`n$($so.Result)`n$($se.Result)"
    if ($h.ExitCode -ne 0) { Add-Check '20 tasks install (re-run as administrator) exits 0' '0' "exit=$($h.ExitCode)" $false; break }
  }
  Check-True '20 the tasks scratch folder was observed while tasks install ran' ($null -ne $sddlSeen) "not seen in $tries attempts"
  if ($sddlSeen) {
    Add-Check '20 the tasks scratch folder is protected, SYSTEM + Administrators only' 'protected, S-1-5-18,S-1-5-32-544' "protected=$($sddlSeen.Protected) owner=$($sddlSeen.Owner) sids=$($sddlSeen.Sids)" ($sddlSeen.Protected -and $sddlSeen.Sids -eq 'S-1-5-18,S-1-5-32-544')
    Check-True '20 the scratch folder is gone after tasks install' (@([IO.Directory]::GetDirectories('C:\ProgramData', 'posctl-tasks-*')).Count -eq 0)
  }
  $beforeStatus = (Get-Item (Join-Path $script:DataRoot 'state\status.json')).LastWriteTimeUtc
  & schtasks.exe /Run /TN '\SupermarketPOS\Health' | Out-Null
  Check-True '20 the Health task rewrites status.json when run' (Wait-Until { (Get-Item (Join-Path $script:DataRoot 'state\status.json')).LastWriteTimeUtc -gt $beforeStatus } 90 1) 'status.json not rewritten in 90 s'
  # TASKS_MISSING: delete the Health task; the next measurement carries the alert; tasks install restores it
  & schtasks.exe /Delete /TN '\SupermarketPOS\Health' /F | Out-Null
  $st = Invoke-Posctl @('status', '--refresh') -Name 'status-tasks-missing'
  Check-True '20 with the Health task deleted, status carries the TASKS_MISSING alert' (@($st.Json.data.alerts | Where-Object { $_.code -eq 'TASKS_MISSING' }).Count -eq 1) ($st.Json.data.alerts | ConvertTo-Json -Compress -Depth 4)
  # STATUS_STALE (CR-I2): with no Health task nothing rewrites status.json; a file whose generatedAt is 10 minutes old is flagged
  $sf = Join-Path $script:DataRoot 'state\status.json'
  $sj = Get-Content $sf -Raw | ConvertFrom-Json
  $sj.generatedAt = [DateTime]::UtcNow.AddMinutes(-10).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
  [IO.File]::WriteAllText($sf, ($sj | ConvertTo-Json -Depth 12))
  $stale = Invoke-Posctl @('status') -Name 'status-stale'
  Check-True '20 with an old status.json, status carries the STATUS_STALE alert and exits 0' ($stale.Exit -eq 0 -and @($stale.Json.data.alerts | Where-Object { $_.code -eq 'STATUS_STALE' }).Count -eq 1) ((Format-Envelope $stale) + ' ' + ($stale.Json.data.alerts | ConvertTo-Json -Compress -Depth 4))
  $ti = Invoke-Posctl @('tasks', 'install') -Name 'tasks-reinstall'
  Add-Check '20 tasks install restores the deleted task (exit 0)' '0' (Format-Envelope $ti) ($ti.Exit -eq 0)
  $hw = Invoke-Posctl @('health', '--write') -Name 'health-write-after-reinstall'
  $fresh = Invoke-Posctl @('status') -Name 'status-after-health-write'
  Check-True '20 after tasks install and health --write the STATUS_STALE alert is gone' (@($fresh.Json.data.alerts | Where-Object { $_.code -eq 'STATUS_STALE' }).Count -eq 0) ((Format-Envelope $hw) + ' ' + ($fresh.Json.data.alerts | ConvertTo-Json -Compress -Depth 4))
  $st2 = Invoke-Posctl @('status', '--refresh') -Name 'status-tasks-restored'
  Check-True '20 ... and the TASKS_MISSING alert is gone' (@($st2.Json.data.alerts | Where-Object { $_.code -eq 'TASKS_MISSING' }).Count -eq 0) ($st2.Json.data.alerts | ConvertTo-Json -Compress -Depth 4)
  $second = Invoke-Posctl @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin') (New-Digits6) -Name 'provision-second'
  Add-Check '20 a second provision answers ALREADY_PROVISIONED (exit 5)' '5' (Format-Envelope $second) ($second.Exit -eq 5)
  Save-DataEvidence 'end'
  return @{ Results = (Get-Results); Reboot = $false }
}
