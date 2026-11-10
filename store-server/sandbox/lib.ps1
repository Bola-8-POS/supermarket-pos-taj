# Helpers for the scenarios. Dot-sourced by agent.ps1 inside the sandbox (PowerShell 7, elevated).
# Inside the sandbox the "never create real services / HKLM / accounts / ACLs" rule is lifted: that is the point.
$ErrorActionPreference = 'Stop'
$script:Payload = 'C:\payload'
$script:ProgRoot = 'C:\Program Files\SupermarketPOS'
$script:PosctlDir = Join-Path $script:ProgRoot 'posctl'
$script:Posctl = Join-Path $script:PosctlDir 'posctl.exe'
$script:DataRoot = 'C:\ProgramData\SupermarketPOS'
$script:OutDir = 'C:\out'
$script:Evidence = 'C:\out\evidence'
$script:Base = 47300
$script:PackVersion = ''
$script:Results = New-Object System.Collections.ArrayList
$script:Seq = 0
$script:Svc = [ordered]@{ Postgres = 'SupermarketPOS-Postgres'; Auth = 'SupermarketPOS-Auth'; Rest = 'SupermarketPOS-Rest'; Functions = 'SupermarketPOS-Functions'; Gateway = 'SupermarketPOS-Gateway' }
$script:SidSystem = 'S-1-5-18'; $script:SidAdmins = 'S-1-5-32-544'; $script:SidUsers = 'S-1-5-32-545'
New-Item -ItemType Directory -Force $script:Evidence | Out-Null

function Log([string]$m) { Add-Content (Join-Path $script:OutDir 'agent.log') ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $m) }

# ---- checks ---------------------------------------------------------------------------------------------
function Add-Check([string]$Id, [string]$Expected, $Actual, [bool]$Pass) {
  $c = [pscustomobject]@{ id = $Id; expected = $Expected; actual = [string]$Actual; pass = $Pass }
  [void]$script:Results.Add($c)
  Add-Content (Join-Path $script:OutDir 'checks.jsonl') (ConvertTo-Json -InputObject $c -Compress)
  Log ("CHECK {0} {1}" -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Id)
}
function Check-Equal([string]$Id, $Expected, $Actual) { Add-Check $Id ([string]$Expected) $Actual ([string]$Expected -eq [string]$Actual) }
function Check-True([string]$Id, [bool]$Condition, [string]$Detail = '') { Add-Check $Id 'true' $(if ($Condition) { 'true' } else { "false $Detail" }) $Condition }
function Get-Results { $r = @($script:Results); $script:Results = New-Object System.Collections.ArrayList; return $r }
function Save-Evidence([string]$Name, [string]$Text) {
  $script:Seq++
  $f = Join-Path $script:Evidence ('{0:D3}-{1}.txt' -f $script:Seq, ($Name -replace '[^A-Za-z0-9._-]', '_'))
  Set-Content $f $Text -Encoding UTF8
}

# ---- randomness / derivation (independent re-implementation, cross-checks the Rust one) --------------------
function New-RandomBytes([int]$Count) {
  $b = New-Object byte[] $Count
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b)
  if (-not ($b | Where-Object { $_ -ne 0 })) { throw 'the random source returned zeros' }
  return , $b
}
function New-Digits6 {
  # a non-trivial PIN: at least four distinct digits, no ascending or descending run of three
  while ($true) {
    do { $x = [BitConverter]::ToUInt32((New-RandomBytes 4), 0) } while ($x -ge 4294000000)
    $d = ($x % 1000000).ToString('D6')
    if (($d.ToCharArray() | Select-Object -Unique).Count -ge 4 -and $d -notmatch '012|123|234|345|456|567|678|789|987|876|765|654|543|432|321|210') { return $d }
  }
}
function New-RandomToken([int]$Bytes = 18) { [Convert]::ToBase64String((New-RandomBytes $Bytes)).TrimEnd('=').Replace('+', 'a').Replace('/', 'b') }
function Get-DerivedPassword([string]$StaffId, [string]$Digits, [string]$Pepper) {
  $h = New-Object Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes($Pepper))
  $mac = $h.ComputeHash([Text.Encoding]::UTF8.GetBytes("barpos-staff-password|v1|$($StaffId.ToLower())|$Digits"))
  return 'v1.' + [Convert]::ToBase64String($mac).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Get-ServiceSid([string]$Name) {
  $h = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant()))
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($h, 4 * $_) }) -join '-')
}

# ---- waiting ------------------------------------------------------------------------------------------------
function Wait-Until([scriptblock]$Condition, [int]$TimeoutSec = 120, [double]$IntervalSec = 1) {
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $end) { try { if (& $Condition) { return $true } } catch { }; Start-Sleep -Milliseconds ([int]($IntervalSec * 1000)) }
  return $false
}

# ---- posctl -------------------------------------------------------------------------------------------------
function New-PosctlStartInfo([string[]]$PosctlArgs) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:Posctl
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  foreach ($a in $PosctlArgs) { [void]$psi.ArgumentList.Add($a) }
  return $psi
}
function Invoke-Posctl([string[]]$PosctlArgs, [string]$Stdin = $null, [int]$TimeoutSec = 1800, [string]$Name = '') {
  $p = [Diagnostics.Process]::Start((New-PosctlStartInfo $PosctlArgs))
  if ($null -ne $Stdin) { $p.StandardInput.WriteLine($Stdin) }
  $p.StandardInput.Close()
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill($true); throw "posctl $($PosctlArgs -join ' ') timed out after $TimeoutSec s" }
  $p.WaitForExit()
  $raw = $so.Result.Trim()
  $json = $null
  try { $json = $raw | ConvertFrom-Json } catch { }
  if (-not $Name) { $Name = ($PosctlArgs | Select-Object -First 2) -join '-' }
  Save-Evidence ("posctl-$Name") ("args: $($PosctlArgs -join ' ')`nexit: $($p.ExitCode)`n--- stdout ---`n$raw`n--- stderr ---`n$($se.Result)")
  return [pscustomobject]@{ Exit = $p.ExitCode; Raw = $raw; Json = $json; Stderr = $se.Result }
}
function Format-Envelope($R) { if ($R.Json) { "exit=$($R.Exit) code=$($R.Json.code) msg=$($R.Json.message)" } else { "exit=$($R.Exit) raw=$($R.Raw) err=$($R.Stderr)" } }

# ---- install like a customer PC -------------------------------------------------------------------------------
function Get-PayloadMeta { Get-Content (Join-Path $script:Payload 'payload.json') -Raw | ConvertFrom-Json }
# Default = the test-hooks build (it alone accepts the throwaway-signed pack through POSCTL_TEST_UPDATER_PUBKEY, Task 4 ruling C1).
# -Release installs the shipped binary, used only for the negative check and the version-before-VC++ check.
function Install-Posctl([switch]$Release) {
  New-Item -ItemType Directory -Force $script:PosctlDir | Out-Null
  $exe = if ($Release) { 'posctl.exe' } else { 'posctl-test-hooks.exe' }
  Copy-Item (Join-Path $script:Payload $exe) $script:Posctl -Force
  if (-not $Release) {
    $key = (Get-Content (Join-Path $script:Payload 'test-pubkey.txt') -Raw).Trim()
    $env:POSCTL_TEST_UPDATER_PUBKEY = $key
    # machine scope: the services and the Health/Canary tasks run posctl too and verify the pack on every load
    [Environment]::SetEnvironmentVariable('POSCTL_TEST_UPDATER_PUBKEY', $key, 'Machine')
  }
}
# Installs the throwaway-signed pack zip the way the NSIS installer does: `pack install --file`.
function Install-Pack {
  $meta = Get-PayloadMeta
  $script:PackVersion = [string]$meta.packVersion
  $r = Invoke-Posctl @('pack', 'install', '--file', (Join-Path $script:Payload ([string]$meta.signedPack))) -Name 'pack-install' -TimeoutSec 1200
  Add-Check 'env: pack install --file <signed zip> with the test-hooks build exits 0' '0' (Format-Envelope $r) ($r.Exit -eq 0)
  if ($r.Exit -ne 0) { throw "pack install failed: $(Format-Envelope $r)" }
  return $meta.packVersion
}
# The VC++ runtime is the installer's job (pack README: tools\vc_redist.x64.exe /install /quiet /norestart, exit 0 or 3010);
# posctl never runs it. A clean sandbox that lacks it while the pack carries no DLLs is a FINDING.
function Ensure-VcRuntime {
  $meta = Get-PayloadMeta
  $present = Test-Path 'C:\Windows\System32\vcruntime140.dll'
  $carried = @(Get-ChildItem (Join-Path $script:Payload ("pack\" + $meta.packVersion + '\pg\bin')) -Filter 'vcruntime*.dll' -ErrorAction SilentlyContinue).Count -gt 0
  # recorded as a FINDING, not a failure: the installer owns this step (pass is always true so the exit code reflects posctl)
  Add-Check 'FINDING env: VC++ runtime on the clean machine' 'recorded (installer must run vc_redist before posctl or any service)' ("system32=$present packCarries=$carried" + $(if (-not $present -and -not $carried) { ' -> MISSING, installer step run below' } else { '' })) $true
  if (-not $present -and -not $carried) {
    $vc = Join-Path $script:Payload ("pack\" + $meta.packVersion + '\tools\vc_redist.x64.exe')
    # run it from local disk (an exe on the mapped Intranet-zone share draws a security prompt); same bytes as the pack's
    New-Item -ItemType Directory -Force C:\installer | Out-Null
    Copy-Item $vc 'C:\installer\vc_redist.x64.exe' -Force
    $t0 = Get-Date
    $p = Start-Process 'C:\installer\vc_redist.x64.exe' -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
    Log ("vc_redist took {0:n0} s" -f ((Get-Date) - $t0).TotalSeconds)
    Add-Check 'env: installer step tools\vc_redist.x64.exe /install /quiet /norestart' 'exit 0 or 3010' $p.ExitCode (@(0, 3010) -contains $p.ExitCode)
  }
  return $present
}
function Install-Machine { Install-Posctl; return (Install-Pack) }

# Provision with a runtime PIN on stdin (a generated PIN needs an interactive terminal, which the runner never has).
function Provision-Fresh([string]$ResultFile = 'C:\out\provision-result.json', [string]$Name = 'provision') {
  $version = Install-Machine
  $digits = New-Digits6
  $a = @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', $ResultFile)
  $r = Invoke-Posctl $a $digits -Name $Name
  return [pscustomobject]@{ Result = $r; Digits = $digits; PackVersion = $version; ResultFile = $ResultFile }
}

# ---- system probes ----------------------------------------------------------------------------------------------
function Get-ServiceInfo([string]$Name) {
  $s = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
  if (-not $s) { return $null }
  [pscustomobject]@{ Name = $s.Name; State = $s.State; StartName = $s.StartName; StartMode = $s.StartMode; PathName = $s.PathName; ProcessId = $s.ProcessId }
}
function Get-AllServiceStates { ($script:Svc.Values | ForEach-Object { $i = Get-ServiceInfo $_; "$_=$(if ($i) { $i.State } else { 'absent' })" }) -join ' ' }
function Test-AllRunning { @($script:Svc.Values | Where-Object { $i = Get-ServiceInfo $_; $i -and $i.State -eq 'Running' }).Count -eq 5 }
function Test-AllAbsent { @($script:Svc.Values | Where-Object { Get-ServiceInfo $_ }).Count -eq 0 }
function Get-Listeners { Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Addr = $_.LocalAddress; Port = [int]$_.LocalPort; Pid = $_.OwningProcess } } }
function Get-StoreListeners { @(Get-Listeners | Where-Object { $_.Port -ge $script:Base -and $_.Port -le ($script:Base + 9) }) }

# posctl-only secret files are DPAPI machine-scope wrapped (Plan 11S, store-server/src/dpapi.rs): "POSDPAPI1" line + blob, fixed entropy.
# A legacy plaintext file reads as it is. Values are returned to the caller only; nothing here prints or stores them.
function Read-SecretFileText([string]$Path) {
  $b = [IO.File]::ReadAllBytes($Path)
  $magic = [Text.Encoding]::ASCII.GetBytes("POSDPAPI1`n")
  $wrapped = ($b.Length -ge $magic.Length)
  if ($wrapped) { for ($i = 0; $i -lt $magic.Length; $i++) { if ($b[$i] -ne $magic[$i]) { $wrapped = $false; break } } }
  if (-not $wrapped) { return [Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF) }
  foreach ($asm in 'System.Security', 'System.Security.Cryptography.ProtectedData') { try { Add-Type -AssemblyName $asm -ErrorAction Stop } catch { } }   # which one exists depends on the PowerShell edition
  $blob = New-Object byte[] ($b.Length - $magic.Length); [Array]::Copy($b, $magic.Length, $blob, 0, $blob.Length)
  $entropy = [Text.Encoding]::ASCII.GetBytes('SupermarketPOS posctl secret file v1')
  return [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine))
}
function Get-SecretText([string]$Name) { (Read-SecretFileText (Join-Path $script:DataRoot "secrets\$Name")).Trim() }
function Get-PackDir { Get-PackPath '' }
function Get-PackPath([string]$Sub) { Join-Path $script:ProgRoot ("packs\$($script:PackVersion)\$Sub") }
function Invoke-Psql([string]$Sql, [string]$Db = 'postgres', [string]$User = 'supabase_admin') {
  $env:PGPASSFILE = Join-Path $script:DataRoot 'secrets\pgpass.conf'
  $o = & (Get-PackPath 'pg\bin\psql.exe') -h 127.0.0.1 -p $script:Base -U $User -d $Db -X -A -t -v ON_ERROR_STOP=1 -c $Sql 2>&1
  [pscustomobject]@{ Exit = $LASTEXITCODE; Out = (($o | ForEach-Object { "$_" }) -join "`n") }
}

# ---- ACL (independent plan: acl.rs re-written here, not imported) ----------------------------------------------------
$script:Mask = @{ F = 0x1f01ff; M = 0x1301bf; RX = 0x1200a9; R = 0x120089 }
function G([string]$Sid, [string]$Rights, [int]$Inh) { [pscustomobject]@{ Sid = $Sid; Rights = $Rights; Inh = $Inh } }
function Get-AclState([string]$Path) {
  $a = Get-Acl -LiteralPath $Path
  $rules = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  [pscustomobject]@{
    Owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Protected = $a.AreAccessRulesProtected
    Aces = @($rules | ForEach-Object { '{0}|{1}|0x{2:x}|{3}|{4}|inh={5}' -f $_.IdentityReference.Value, $_.AccessControlType, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, $_.IsInherited } | Sort-Object)
  }
}
function Format-Planned($Grants) { @($Grants | ForEach-Object { '{0}|Allow|0x{1:x}|{2}|0|inh=False' -f $_.Sid, $script:Mask[$_.Rights], $_.Inh } | Sort-Object) }
function Check-Acl([string]$Id, [string]$Path, $Grants, [string]$Owner = 'S-1-5-32-544') {
  if (-not (Test-Path -LiteralPath $Path)) { Add-Check $Id 'path exists' "missing: $Path" $false; return }
  $s = Get-AclState $Path
  $want = (Format-Planned $Grants) -join ' ; '
  $have = $s.Aces -join ' ; '
  $ok = ($s.Protected -and $s.Owner -eq $Owner -and $want -eq $have)
  Add-Check $Id "owner=$Owner protected, DACL = $want" "owner=$($s.Owner) protected=$($s.Protected), DACL = $have" $ok
}
function Get-DataAclPlan {
  $sid = @{}; foreach ($k in $script:Svc.Keys) { $sid[$k] = Get-ServiceSid $script:Svc[$k] }
  $base = @((G $script:SidSystem 'F' 3), (G $script:SidAdmins 'F' 3))
  $d = $script:DataRoot
  $plan = [ordered]@{}
  $plan[$d] = @($base) + @($script:Svc.Keys | ForEach-Object { G $sid[$_] 'RX' 0 })
  $plan["$d\conf"] = $base
  $plan["$d\pgdata"] = @($base) + @(G $sid.Postgres 'M' 3)
  $plan["$d\secrets"] = $base
  $plan["$d\photos"] = @($base) + @(G $sid.Functions 'M' 3)
  $plan["$d\logs"] = $base
  $plan["$d\logs\posctl"] = $base
  $plan["$d\tmp"] = $base
  $plan["$d\backups"] = $base
  $plan["$d\state"] = @($base) + @(G $sid.Gateway 'RX' 3)
  $plan["$d\state\update"] = $base   # FR19: the updater's control files; no Gateway ACE
  $plan["$d\pki"] = $base
  $plan["$d\pki\caddy"] = @($base) + @(G $sid.Gateway 'M' 3)
  $plan["$d\client"] = @($base) + @((G $script:SidUsers 'RX' 3), (G $sid.Gateway 'RX' 0))
  $plan["$d\client\pki"] = @($base) + @(G $script:SidUsers 'RX' 3)
  $plan["$d\client\pairing"] = @($base) + @((G $script:SidUsers 'RX' 3), (G $sid.Gateway 'RX' 0))
  $plan["$d\client\pairing\offers"] = @($base) + @(G $sid.Gateway 'R' 3)
  $plan["$d\packs-cache"] = $base
  $plan["$d\work"] = $base
  foreach ($k in $script:Svc.Keys) {
    $plan["$d\logs\$($script:Svc[$k])"] = @($base) + @(G $sid[$k] 'M' 3)
    $plan["$d\tmp\$($script:Svc[$k])"] = @($base) + @(G $sid[$k] 'M' 3)
  }
  $plan[$script:ProgRoot] = @($base) + @(G $script:SidUsers 'RX' 3) + @($script:Svc.Keys | ForEach-Object { G $sid[$_] 'RX' 3 })
  $plan["$d\secrets\gotrue.env"] = @((G $script:SidSystem 'F' 0), (G $script:SidAdmins 'F' 0), (G $sid.Auth 'R' 0))
  $plan["$d\secrets\postgrest.conf"] = @((G $script:SidSystem 'F' 0), (G $script:SidAdmins 'F' 0), (G $sid.Rest 'R' 0))
  return $plan
}

# ---- identity (GoTrue; the INTERNAL gateway listener is loopback-only and fronts /auth/v1) ---------------------------------
function Get-StoreKeys { Read-SecretFileText (Join-Path $script:DataRoot 'secrets\keys.json') | ConvertFrom-Json }
function Get-Pepper { (Read-SecretFileText (Join-Path $script:DataRoot 'secrets\staff-password-pepper.txt')).Trim() }
function Invoke-Grant([string]$Email, [string]$Password, [int]$Port = 0) {
  $prefix = '/auth/v1'
  if ($Port -eq 0) { $Port = $script:Base + 5 } elseif ($Port -eq ($script:Base + 1)) { $prefix = '' }
  $body = @{ email = $Email; password = $Password } | ConvertTo-Json -Compress
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$prefix/token?grant_type=password" -Method Post -Body $body -ContentType 'application/json' -Headers @{ apikey = (Get-StoreKeys).anon } -SkipHttpErrorCheck -TimeoutSec 30
  [pscustomobject]@{ Status = [int]$r.StatusCode; Body = [string]$r.Content }
}
# files under Path that hold Needle (a digit string must not sit inside a longer number)
function Find-Text([string]$Path, [string]$Needle) {
  $pat = if ($Needle -match '^\d+$') { "(?<!\d)$Needle(?!\d)" } else { [regex]::Escape($Needle) }
  $files = if (Test-Path -LiteralPath $Path -PathType Container) { Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue } else { @(Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue) }
  $hits = @()
  foreach ($f in $files) {
    try { if (Select-String -LiteralPath $f.FullName -Pattern $pat -Quiet -ErrorAction Stop) { $hits += $f.FullName } }
    catch {
      # a file that is still there but could not be read is a finding; one that vanished between the listing and the read is an atomic-write temp (its content is in the target)
      if (Test-ProductLockFile $f.FullName) { [void]$script:FindLockHeld.Add($f.Name) }
      elseif (Test-Path -LiteralPath $f.FullName) { [void]$script:FindUnreadable.Add("$($f.Name) ($($_.Exception.GetType().Name))") } else { [void]$script:FindVanished.Add($f.Name) }
    }
  }
  return $hits
}
$script:FindUnreadable = New-Object System.Collections.ArrayList
$script:FindVanished = New-Object System.Collections.ArrayList
$script:FindLockHeld = New-Object System.Collections.ArrayList
function Reset-FindScan { $script:FindUnreadable.Clear(); $script:FindVanished.Clear(); $script:FindLockHeld.Clear() }
# The product's operation lock files, by exact path. An in-flight posctl holds them with LockFileEx (std File::try_lock, ops/lock.rs and backup/run.rs), so no other handle can read them
# while the operation runs. They hold no secret: update.lock and backup.lock are created empty and never written to (the holder's pid, op id and start time are in the separate
# update.lock.info). An unreadable one is held by design; a readable one is scanned like any file; any other unreadable file still fails.
function Test-ProductLockFile([string]$Path) {
  $d = [string]$script:DataRoot
  foreach ($rel in @('state\update\update.lock', 'state\update.lock', 'backups\backup.lock')) {
    if ($Path -ieq (Join-Path $d $rel)) { return $true }
  }
  return $false
}
# Ends a scan made of Find-Text calls: the vanished temps are recorded, an unreadable file that still exists is a FAIL (it was not scanned).
function Close-FindScan([string]$Label, [string]$What) {
  if ($script:FindVanished.Count -gt 0) { Info "$Label : $What scan: files gone between listing and read (atomic-write temps; their content is in the target, which is scanned)" ((@($script:FindVanished) | Sort-Object -Unique) -join ', ') }
  if ($script:FindLockHeld.Count -gt 0) { Info "$Label : $What scan: lock file held by design by an in-flight posctl operation (no secret content)" ((@($script:FindLockHeld) | Sort-Object -Unique) -join ', ') }
  $u = @($script:FindUnreadable | Sort-Object -Unique)
  Add-Check "$Label : every file of the $What scan could be read" 'none unreadable' $(if ($u.Count -eq 0) { 'none unreadable' } else { 'unreadable: ' + ($u -join ', ') }) ($u.Count -eq 0)
}
# FR19: the updater's control files (journal.json, update-result.json, fence-start-types.json, update-rolled-back.json, update.lock[.info]) live in
# <data>\state\update\ (SYSTEM + Administrators only), no longer in state\ (which the Gateway can read). Get-UpdateFilePath is where the
# current posctl writes; Get-UpdateReadPath falls back to the pre-FR19 state\ copy while the new one is absent (a store not yet updated by it).
function Get-UpdateFilePath([string]$Name) { return (Join-Path $script:DataRoot (Join-Path 'state\update' $Name)) }
function Get-UpdateReadPath([string]$Name) {
  $new = Get-UpdateFilePath $Name
  if (Test-Path -LiteralPath $new) { return $new }
  $old = Join-Path $script:DataRoot (Join-Path 'state' $Name)
  if (Test-Path -LiteralPath $old) { return $old }
  return $new
}
# non-secret evidence only: posctl logs, service logs, state and conf (never secrets\ or pgdata\)
function Save-DataEvidence([string]$Tag = 'data') {
  $dest = Join-Path $script:Evidence $Tag
  foreach ($sub in 'logs', 'state', 'conf') {
    $src = Join-Path $script:DataRoot $sub
    if (Test-Path $src) { & robocopy $src (Join-Path $dest $sub) /E /NFL /NDL /NJH /NJS /NP | Out-Null }
  }
}
function Test-HookEnv([string]$Content) {
  $en = @($Content -split "`r?`n" | Where-Object { $_ -match '^GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=' })
  $uri = @($Content -split "`r?`n" | Where-Object { $_ -match '^GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI=' })
  return ($en.Count -eq 1 -and $en[0] -eq 'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true' -and $uri.Count -eq 1 -and $uri[0] -eq 'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI=pg-functions://postgres/pos_lockout/password_verification_hook')
}
# the same loopback-only / running / hook-variable facts after any lifecycle step
function Check-StoreUp([string]$Tag) {
  Check-True "$Tag all five services Running" (Wait-Until { Test-AllRunning } 120) (Get-AllServiceStates)
  $l = Get-StoreListeners
  # Plan 06: the LAN port (base+4) is the shop-network TLS listener, IPv4 wildcard; everything else stays on loopback
  $lan = $script:Base + 4
  $bad = @($l | Where-Object { if ($_.Port -eq $lan) { $_.Addr -ne '0.0.0.0' } else { $_.Addr -ne '127.0.0.1' } })
  Add-Check "$Tag every listener in the port block is 127.0.0.1, except the LAN port on IPv4 0.0.0.0 only" 'none on another address' (($l | ForEach-Object { "$($_.Addr):$($_.Port)" }) -join ',') ($bad.Count -eq 0 -and $l.Count -ge 5)
  Check-True "$Tag gotrue.env carries both lockout hook variables, once each" (Test-HookEnv (Get-Content (Join-Path $script:DataRoot 'secrets\gotrue.env') -Raw))
}
function Get-ProvisionData($R) { if ($R.Json -and $R.Json.data) { $R.Json.data } else { $null } }
function Get-StoreId {
  foreach ($f in 'provisioned.json', 'unprovisioned.json') {
    try { $v = (Get-Content (Join-Path $script:DataRoot "state\$f") -Raw | ConvertFrom-Json).storeId; if ($v) { return [string]$v } } catch { }
  }
  try { $v = (Get-Content (Join-Path $script:DataRoot 'state\provision-journal.json') -Raw | ConvertFrom-Json).params.storeId; if ($v) { return [string]$v } } catch { }
  return $null
}
function Get-JournalSteps { try { @((Get-Content (Join-Path $script:DataRoot 'state\provision-journal.json') -Raw | ConvertFrom-Json).steps) } catch { @() } }

function New-StdUser([string]$Name, [string]$Pw) {
  New-LocalUser -Name $Name -Password (ConvertTo-SecureString $Pw -AsPlainText -Force) -PasswordNeverExpires | Out-Null
  Add-LocalGroupMember -Group 'Users' -Member $Name -ErrorAction SilentlyContinue
}

# ---- TLS / trust helpers (Plan 06) ------------------------------------------------------------------------------------------
# curl.exe goes through Schannel, i.e. the operating system's trust store, the way WebView2 sees the server.
# --ssl-no-revoke: Caddy's local certificates carry no revocation endpoint and Schannel reports "revocation status unknown".
function Invoke-Curl([string[]]$CurlArgs) {
  $o = & "$env:windir\System32\curl.exe" -sS --max-time 20 --ssl-no-revoke @CurlArgs 2>&1
  [pscustomobject]@{ Exit = $LASTEXITCODE; Text = (($o | ForEach-Object { "$_" }) -join "`n") }
}
function Get-HttpCode([string[]]$CurlArgs) {
  $r = Invoke-Curl (@('-o', 'NUL', '-w', '%{http_code}') + $CurlArgs)
  [pscustomobject]@{ Exit = $r.Exit; Code = ($r.Text -replace '\D.*$', '').Trim() ; Text = $r.Text }
}
function Get-DerSha1([byte[]]$Der) { -join ([Security.Cryptography.SHA1]::Create().ComputeHash($Der) | ForEach-Object { $_.ToString('x2') }) }
function Get-DerSha256([byte[]]$Der) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($Der) | ForEach-Object { $_.ToString('x2') }) }
function ConvertFrom-PemCert([string]$Pem) { [Convert]::FromBase64String((($Pem -replace '-----[A-Z ]+-----', '') -replace '\s', '')) }
# The certificate(s) in LocalMachine\Root with this SHA-1, as raw DER blobs.
function Get-TrustedRootDer([string]$Sha1) {
  $st = New-Object Security.Cryptography.X509Certificates.X509Store 'Root', 'LocalMachine'
  $st.Open('ReadOnly')
  try { return @($st.Certificates | Where-Object { $_.Thumbprint -ieq $Sha1 } | ForEach-Object { , $_.RawData }) } finally { $st.Close() }
}
function Test-RootTrusted([string]$Sha1) { @(Get-TrustedRootDer $Sha1).Count -gt 0 }
function Remove-TrustedRoot([string]$Sha1) {
  $st = New-Object Security.Cryptography.X509Certificates.X509Store 'Root', 'LocalMachine'
  $st.Open('ReadWrite')
  try { foreach ($c in @($st.Certificates | Where-Object { $_.Thumbprint -ieq $Sha1 })) { $st.Remove($c) } } finally { $st.Close() }
}
function Get-AceSids([string]$Path) { @((Get-AclState $Path).Aces | ForEach-Object { ($_ -split '\|')[0] } | Sort-Object -Unique) }

# ---- scheduled tasks ---------------------------------------------------------------------------------------------------
function Set-TaskEnabled([string]$Name, [bool]$On) {
  $flag = '/DISABLE'; if ($On) { $flag = '/ENABLE' }
  [void](schtasks.exe /Change /TN ("\SupermarketPOS\" + $Name) $flag 2>&1)
  return $LASTEXITCODE
}
function Get-TaskInfo([string]$Name) {
  $o = (schtasks.exe /Query /TN ("\SupermarketPOS\" + $Name) /V /FO LIST 2>&1 | Out-String)
  $exists = ($LASTEXITCODE -eq 0)
  $f = { param($k) if ($o -match ('(?m)^\s*' + [regex]::Escape($k) + ':[ \t]*(.*)$')) { return $Matches[1].Trim() } else { return '' } }
  return [pscustomobject]@{ Exists = $exists; State = (& $f 'Scheduled Task State'); Status = (& $f 'Status'); LastResult = (& $f 'Last Result'); LastRun = (& $f 'Last Run Time'); Raw = $o }
}

# Park the scheduled Backup and BackupVerify tasks (provision registers them, every 5 minutes, StartWhenAvailable) and wait, bounded, for any in-flight run to finish.
# A tick that fires after provision holds update.lock for several seconds, so a stop/start/update/restore right after provision answers LOCK_HELD (fail-fast is the intended UX).
# -AssertEmpty (Install-OldStore -ParkBackup, the Backup scenarios) also asserts no snapshot, no broken entry and no backups\repo: a tick before the park is NOT hidden, those checks fail loudly.
function Invoke-ParkBackupTasks([switch]$AssertEmpty, [string]$Label = '') {
  $ck = { param($id, $expected, $actual) Add-Check ([string]$id) ([string]"$expected") $actual (("$expected") -eq ("$actual")) }
  foreach ($t in 'Backup', 'BackupVerify') {
    & $ck "setup${Label}: the $t scheduled task is parked right after provision (schtasks exit)" 0 (Set-TaskEnabled $t $false)
    $ti = Get-TaskInfo $t
    Info "setup${Label}: $t status at park" $ti.Status   # a legitimate in-flight run may be Running here; the wait below is the pass/fail signal
    & $ck "setup${Label}: the $t scheduled task exists and is Disabled right after provision" 'Disabled' $(if ($ti.Exists) { $ti.State } else { 'missing' })
  }
  # /DISABLE does not stop a run already in flight (MultipleInstances IgnoreNew, wall-clock grid): wait, bounded, for both tasks to leave Running before listing snapshots
  foreach ($t in 'Backup', 'BackupVerify') {
    $idle = Wait-Until { (Get-TaskInfo $t).Status -ne 'Running' } 120 2
    & $ck "setup${Label}: the $t task is not running (any in-flight run finished within 120 s)" 'not-running' $(if ($idle) { 'not-running' } else { "still Running after 120 s" })
  }
  if (-not $AssertEmpty) { return }
  # a direct list, not Get-Snapshots: that helper hides a failed list (@($null).Count is 1) and ignores data.broken
  $pl = Bk @('backup', 'list') 'park-backup-list'
  & $ck "setup${Label}: backup list exits 0 right after provision" 0 $pl.exit
  $nSnap = @(@($pl.json.data.snapshots) | Where-Object { $_ }).Count
  $nBroken = @(@($pl.json.data.broken) | Where-Object { $_ }).Count
  & $ck "setup${Label}: no backup snapshot exists right after provision (no tick beat the park)" 0 $nSnap
  & $ck "setup${Label}: no broken backup entry exists right after provision" 0 $nBroken
  $repoDir = Join-Path $script:Data 'backups\repo'
  $repoThere = Test-Path -LiteralPath $repoDir
  & $ck "setup${Label}: backups\repo does not exist yet" $false $repoThere
  if ($pl.exit -ne 0 -or $nSnap -ne 0 -or $nBroken -ne 0 -or $repoThere) {
    # evidence only: nothing is deleted or reset here, the failing check stays visible
    $acl = 'backups\repo not present'
    if ($repoThere) { try { $ErrorActionPreference = 'Continue'; $acl = (icacls.exe $repoDir 2>&1 | Out-String) } catch { $acl = "icacls failed: $($_.Exception.Message)" } }
    Save-Evidence 'raced-backup-repo-icacls' $acl
  }
}

# A recorded observation, never counted as a pass or a fail: also how a check that cannot run says so (never a silent skip).
function Info([string]$Id, $Value) {
  $c = [pscustomobject]@{ id = $Id; expected = 'recorded'; actual = [string]$Value; pass = $null; info = $true }
  [void]$script:Results.Add($c)
  Add-Content (Join-Path $script:OutDir 'checks.jsonl') (ConvertTo-Json -InputObject $c -Compress)
  Log ('INFO ' + $Id)
}
