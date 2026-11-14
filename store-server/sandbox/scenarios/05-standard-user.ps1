# 05 - a standard Windows user on the server PC cannot read a secret, the database, the service key, the PKI folder, backups,
# work, state, logs or tmp, cannot read the Functions registry value, and cannot stop or reconfigure a service. client\ is public.
# The probe runs as a real local standard user (Windows PowerShell 5.1, which every user can execute) from a local folder.
function Invoke-Scenario([int]$Phase) {
  [void](Install-Posctl)
  [void](Ensure-VcRuntime)
  $p = Provision-Fresh 'C:\out\r05.json' '05-provision'
  Add-Check '05 provision (setup) exits 0' '0' (Format-Envelope $p.Result) ($p.Result.Exit -eq 0)
  if ($p.Result.Exit -ne 0) { Save-DataEvidence 'setup-failed'; return @{ Results = (Get-Results); Reboot = $false } }

  # state\status.json is written by the first health run, not by provision: make sure it exists so its ACL is really probed
  [void](Invoke-Posctl @('health', '--write') -Name '05-health-write')
  Check-True '05 setup: state\status.json exists' (Test-Path (Join-Path $script:DataRoot 'state\status.json')) ''
  # every file in secrets\ plus the other protected places, relative to the data root
  $rel = New-Object System.Collections.ArrayList
  foreach ($f in Get-ChildItem (Join-Path $script:DataRoot 'secrets') -File -Force) { [void]$rel.Add("secrets\$($f.Name)") }
  foreach ($x in 'secrets', 'conf', 'conf\posctl.json', 'pgdata', 'pgdata\postgresql.conf', 'pgdata\pg_hba.conf', 'pgdata\PG_VERSION', 'pki', 'pki\caddy', 'backups', 'work', 'packs-cache',
                 'state', 'state\provisioned.json', 'state\status.json', 'logs', 'logs\SupermarketPOS-Gateway', 'logs\SupermarketPOS-Postgres', 'logs\posctl', 'tmp', 'tmp\SupermarketPOS-Functions', 'photos') { [void]$rel.Add($x) }
  foreach ($f in Get-ChildItem (Join-Path $script:DataRoot 'conf') -File -Force -ErrorAction SilentlyContinue) { if (-not $rel.Contains("conf\$($f.Name)")) { [void]$rel.Add("conf\$($f.Name)") } }
  $tooMany = $rel.Count
  Add-Check '05 the probe covers at least 25 protected paths (every secret file + cluster, pki, backups, work, state, logs, tmp)' '>= 25' $tooMany ($tooMany -ge 25)

  $user = 'posuser'
  $pw = 'Aa1!' + (New-RandomToken 18)
  New-StdUser $user $pw
  Check-True '05 harness: a local standard user exists and is not an administrator' ((Get-LocalUser -Name $user -ErrorAction SilentlyContinue) -and -not (Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*\$user" }))
  $cred = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $pw -AsPlainText -Force))
  $work = 'C:\Users\Public\p5'; New-Item -ItemType Directory -Force $work | Out-Null
  & icacls.exe $work /grant 'Users:(OI)(CI)M' | Out-Null
  Set-Content (Join-Path $work 'paths.txt') ($rel -join "`n") -Encoding ASCII
  $probe = @'
$ErrorActionPreference = 'Continue'
$root = 'C:\ProgramData\SupermarketPOS'
$out = [ordered]@{}
foreach ($p in (Get-Content 'C:\Users\Public\p5\paths.txt')) {
  if (-not $p) { continue }
  $full = Join-Path $root $p
  try {
    if (Test-Path -LiteralPath $full -PathType Container) { $null = Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop; $out[$p] = 'READ' }
    else { $s = [IO.File]::OpenRead($full); $s.Dispose(); $out[$p] = 'READ' }
  } catch [System.UnauthorizedAccessException] { $out[$p] = 'DENIED' }
  catch [System.IO.FileNotFoundException] { $out[$p] = 'MISSING' }
  catch [System.IO.DirectoryNotFoundException] { $out[$p] = 'MISSING' }
  catch { $out[$p] = 'ERROR ' + $_.Exception.GetType().Name }
}
try { $null = Get-ChildItem -LiteralPath (Join-Path $root 'client') -Force -ErrorAction Stop; $out['client\'] = 'READ' } catch { $out['client\'] = 'DENIED' }
try { $k = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\SupermarketPOS-Functions' -ErrorAction Stop).Environment; $out['registry Environment'] = $(if ($k) { 'READ' } else { 'EMPTY' }) } catch { $out['registry Environment'] = 'DENIED' }
$out['sc stop'] = (& sc.exe stop SupermarketPOS-Gateway 2>&1 | Out-String).Trim() + ' | exit ' + $LASTEXITCODE
$out['sc config'] = (& sc.exe config SupermarketPOS-Gateway start= demand 2>&1 | Out-String).Trim() + ' | exit ' + $LASTEXITCODE
$out['sc delete'] = (& sc.exe delete SupermarketPOS-Postgres 2>&1 | Out-String).Trim() + ' | exit ' + $LASTEXITCODE
$out['whoami admin'] = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString()
$out | ConvertTo-Json | Set-Content 'C:\Users\Public\p5\probe.json' -Encoding UTF8
'@
  Set-Content (Join-Path $work 'probe.ps1') $probe -Encoding ASCII
  $proc = Start-Process -FilePath "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $work 'probe.ps1')) -Credential $cred -LoadUserProfile -WorkingDirectory $work -Wait -PassThru -WindowStyle Hidden
  Check-Equal '05 the probe ran as the standard user and finished' 0 $proc.ExitCode
  $res = $null; try { $res = Get-Content (Join-Path $work 'probe.json') -Raw | ConvertFrom-Json } catch { }
  Check-True '05 the probe wrote its result' ($null -ne $res) 'no probe.json'
  if ($res) {
    Save-Evidence '05-probe-result' ($res | ConvertTo-Json)
    Check-Equal '05 the probe really ran without an administrator token' 'False' $res.'whoami admin'
    foreach ($prop in $res.PSObject.Properties) {
      $n = $prop.Name; $v = [string]$prop.Value
      if ($n -eq 'whoami admin') { continue }
      elseif ($n -eq 'client\') { Check-Equal '05 client\ (public pairing data) is readable' 'READ' $v }
      elseif ($n -like 'sc *') { Check-True "05 $n is denied (Access is denied, exit 5)" ($v -match 'Access is denied|FAILED 5' -and $v -match 'exit 5$') $v }
      elseif ($n -eq 'registry Environment') { Check-Equal '05 the Functions registry value (secrets) is denied' 'DENIED' $v }
      else { Check-Equal "05 $n is denied" 'DENIED' $v }
    }
  }
  Check-True '05 the denied sc commands changed nothing (all five Running, Gateway start type Auto, all still registered)' ((Test-AllRunning) -and (Get-ServiceInfo $script:Svc.Gateway).StartMode -eq 'Auto') (Get-AllServiceStates)
  # the loopback API is open to local users by design; the PIN lockout, not the network layer, protects it (recorded)
  $anonRead = try { (Invoke-WebRequest "http://127.0.0.1:$($script:Base + 5)/rest/v1/profiles?select=id&limit=1" -Headers @{ apikey = (Get-StoreKeys).anon } -UseBasicParsing -TimeoutSec 10 -SkipHttpErrorCheck).StatusCode } catch { -1 }
  Add-Check '05 RECORDED: loopback gateway answers an anon read of profiles (RLS decides what it returns)' 'recorded' $anonRead $true
  & net.exe user $user /delete | Out-Null
  Save-DataEvidence 'end'
  return @{ Results = (Get-Results); Reboot = $false }
}
