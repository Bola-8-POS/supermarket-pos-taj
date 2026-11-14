<#
.SYNOPSIS
  Host-side check of the pure parsing helpers in sandbox\lib-update.ps1 (no services, no elevation, no Sandbox). Exit 0 = every expectation held.
.DESCRIPTION
  Loads only the named functions out of lib-update.ps1 through the PowerShell AST, so the rest of the library (which needs the Sandbox) is not executed.
#>
$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot '..\sandbox\lib-update.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($lib, [ref]$null, [ref]$null)
foreach ($name in 'Get-FailureActionList', 'Assert-CatalogSqlHash', 'ConvertTo-UtcDateTime', 'Read-LanPoll', 'Get-LanTarget', 'Get-LanName', 'Read-JsonFile', 'Assert-LanFenced', 'Assert-LanNeverServed', 'Assert-FenceDrops', 'Assert-RollbackFenceWindow', 'Get-Health', 'Get-CountsDiff') {
  $f = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $f) { throw "function $name not found in lib-update.ps1" }
  . ([scriptblock]::Create($f.Extent.Text))
}
$fail = 0
# Get-Health keeps curl's exit and err (scenario 51: status 0 with no evidence)
function Invoke-LanCurl { return @{ status = 0; ra = ''; body = ''; err = 'curl exit 35 schannel'; exit = 35 } }
$gh = Get-Health
function Expect($label, $want, $got) { if ("$want" -ne "$got") { $script:fail++; Write-Host "FAIL $label : want '$want' got '$got'" } else { Write-Host "ok   $label" } }

$restart3 = @"
[SC] QueryServiceConfig2 SUCCESS

SERVICE_NAME: SupermarketPOS-Rest
        RESET_PERIOD (in seconds)    : 3600
        REBOOT_MESSAGE               :
        COMMAND_LINE                 :
        FAILURE_ACTIONS              : RESTART -- Delay = 5000 milliseconds.
                                       RESTART -- Delay = 5000 milliseconds.
                                       RESTART -- Delay = 5000 milliseconds.
"@
$none = @"
SERVICE_NAME: SupermarketPOS-Rest
        RESET_PERIOD (in seconds)    : 0
        REBOOT_MESSAGE               :
        COMMAND_LINE                 :
"@
Expect 'three restarts' 'RESTART/5000,RESTART/5000,RESTART/5000' (Get-FailureActionList $restart3)
Expect 'no actions (REBOOT_MESSAGE / COMMAND_LINE labels are not actions)' '' (Get-FailureActionList $none)
Expect 'mixed' 'RESTART/1000,REBOOT/60000' (Get-FailureActionList "FAILURE_ACTIONS : RESTART -- Delay = 1000 milliseconds.`n REBOOT -- Delay = 60000 milliseconds.")
Expect 'Get-Health keeps curl exit' 35 $gh.exit
Expect 'Get-Health keeps curl err' 'curl exit 35 schannel' $gh.err
function Throws($label, [scriptblock]$b) { $t = $false; try { & $b } catch { $t = $true }; Expect $label 'throws' $(if ($t) { 'throws' } else { 'no throw' }) }
$h1 = ('a' * 64); $h2 = ('b' * 64)
Throws 'FR15b: a missing sqlSha256 throws' { Assert-CatalogSqlHash '' $h1 'x' }
Throws 'FR15b: a null sqlSha256 throws' { Assert-CatalogSqlHash $null $h1 'x' }
Throws 'FR15b: a different sqlSha256 throws' { Assert-CatalogSqlHash $h2 $h1 'x' }
$ok = 'passes'; try { Assert-CatalogSqlHash $h1.ToUpper() $h1 'x' } catch { $ok = 'threw' }
Expect 'FR15b: an equal hash (case-insensitive) passes' 'passes' $ok
# the same function in New-TestPacks.ps1 must be the same text as in lib-update.ps1
$a2 = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\sandbox\New-TestPacks.ps1'), [ref]$null, [ref]$null)
$f2 = $a2.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-CatalogSqlHash' }, $true)
$f1 = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-CatalogSqlHash' }, $true)
Expect 'FR15b: New-TestPacks.ps1 carries the same Assert-CatalogSqlHash text' $f1.Extent.Text.Replace("`r",'') $f2.Extent.Text.Replace("`r",'')
# FR16 (g): a poll row's "t" is a [datetime] on PS 7 (ConvertFrom-Json) and a string on PS 5.1; either way the UTC value must be 15:24:03 (the old [DateTime]::Parse($_.t) shifted it by the host's offset)
$row = '{"t":"2026-10-21T15:24:03Z","m":"GET","p":"/rest/v1/x","s":503}' | ConvertFrom-Json
$u = ConvertTo-UtcDateTime $row.t
Expect "FR16: JSON t ($($row.t.GetType().Name), PS $($PSVersionTable.PSVersion.Major)) -> 15:24:03 UTC" '2026-10-21T15:24:03Z' $u.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
Expect 'FR16: the result is Kind Utc' 'Utc' $u.Kind
$u2 = ConvertTo-UtcDateTime '2026-10-21T15:24:03.1234567Z'
Expect 'FR16: an ISO string with fraction (the PS 5.1 shape) -> 15:24:03 UTC' '15:24:03' $u2.ToString('HH:mm:ss')
$u3 = ConvertTo-UtcDateTime ([datetime]::SpecifyKind([datetime]'2026-10-21T15:24:03', 'Local'))
Expect 'FR16: a Local-kind [datetime] is converted, not re-read' ([datetime]'2026-10-21T15:24:03').ToUniversalTime().ToString('HH:mm:ss') $u3.ToString('HH:mm:ss')
$u4 = ConvertTo-UtcDateTime ([datetime]::SpecifyKind([datetime]'2026-10-21T15:24:03', 'Unspecified'))
Expect 'FR16: an Unspecified-kind value is taken as UTC' '15:24:03' $u4.ToString('HH:mm:ss')
# FR18: Assert-RollbackFenceWindow takes the window from the first/last data-path 503 STORE_UPDATING in the poll file.
$checks = New-Object System.Collections.ArrayList
function Check([string]$Id, $Expected, $Actual) { [void]$checks.Add([pscustomobject]@{ id = $Id; pass = ("$Expected" -eq "$Actual") }) }
function Add-Check([string]$Id, [string]$Expected, $Actual, [bool]$Pass) { [void]$checks.Add([pscustomobject]@{ id = $Id; pass = $Pass; actual = "$Actual" }) }
function New-PollFile([string[]]$Lines) { $f = Join-Path ([IO.Path]::GetTempPath()) ("fr18-poll-" + [Guid]::NewGuid().ToString('N') + '.jsonl'); [IO.File]::WriteAllLines($f, $Lines); return $f }
function PollRow($sec, $m, $p, $s) {
  $b = ''; $ra = ''; if ($s -eq 503) { $b = '{"code":"STORE_UPDATING"}'; $ra = '30' }
  return (@{ t = ([datetime]'2026-10-21T10:00:00Z').AddSeconds($sec).ToString('o'); m = $m; p = $p; s = $s; ra = $ra; b = $b } | ConvertTo-Json -Compress)
}
function PollRound($sec, $s) {
  $out = @()
  foreach ($x in @(@('GET', '/rest/v1/a'), @('POST', '/rest/v1/b'), @('GET', '/auth/v1/c'), @('POST', '/auth/v1/d'), @('GET', '/functions/v1/e'), @('POST', '/functions/v1/f'))) { $out += (PollRow $sec $x[0] $x[1] $s) }
  return $out + (PollRow $sec 'GET' '/_store/status' 200)
}
$good = New-PollFile (@(PollRound 0 200) + @(PollRound 1 503) + @(PollRound 2 503) + @(PollRound 3 503) + @(PollRound 4 200))
$checks.Clear(); Assert-RollbackFenceWindow 'T' $good
Expect 'FR18: a clean fence window passes every check' 0 @($checks | Where-Object { -not $_.pass }).Count
Expect 'FR18: the window helper reports the LanFenced and NeverServed checks too' $true (@($checks | Where-Object { $_.id -like '*never served*' }).Count -eq 1 -and @($checks | Where-Object { $_.id -like '*while fenced*' }).Count -ge 2)
$leak = New-PollFile (@(PollRound 0 200) + @(PollRound 1 503) + @(PollRow 2 'GET' '/rest/v1/a' 200) + @(PollRound 3 503))
$checks.Clear(); Assert-RollbackFenceWindow 'T' $leak
Expect 'FR18: a 2xx inside the fence window fails NeverServed' 1 @($checks | Where-Object { $_.id -like '*never served*' -and -not $_.pass }).Count
$none = New-PollFile (@(PollRound 0 200) + @(PollRound 1 200))
$checks.Clear(); Assert-RollbackFenceWindow 'T' $none
Expect 'FR18: no 503 at all fails (no fence seen)' 1 @($checks | Where-Object { $_.id -like '*saw a fence window*' -and -not $_.pass }).Count
Remove-Item $good, $leak, $none -Force

# Fix 1 (run 8): a probe with status 0 (no reply) used to slip through every window assert, which only counted answers. Assert-LanNeverServed (the one assert every
# window path calls) now records "<label> : dropped connections = k" and fails on k > 2, more than 1 drop at one boundary, or a drop that is not at a boundary.
function DropCheck($lines, [double]$from, [double]$to) {
  $f = New-PollFile $lines; $checks.Clear()
  Assert-LanNeverServed 'T' $f ([datetime]'2026-10-21T10:00:00Z').AddSeconds($from) ([datetime]'2026-10-21T10:00:00Z').AddSeconds($to)
  Remove-Item $f -Force
  return (DropResult)
}
function DropResult {
  $m = @($checks | Where-Object { $_.id -like 'T : dropped connections = *' })
  if ($m.Count -eq 0) { return [pscustomobject]@{ Count = 0; id = '(none)'; pass = '(none)'; actual = '' } }
  return [pscustomobject]@{ Count = $m.Count; id = $m[0].id; pass = $m[0].pass; actual = $m[0].actual }
}
$d0 = DropCheck (@(PollRound 0 200) + @(PollRound 1 503) + @(PollRound 2 503) + @(PollRound 3 200)) 1 2
Expect 'drops: k = 0 records one check, label has the count, passes' '1|T : dropped connections = 0|True' "$($d0.Count)|$($d0.id)|$($d0.pass)"
# the run-8 scenario-72 shape, verbatim rows (20:03:56.7278 503 -> POST rpc status 0 curl 52 -> 20:03:57.3152 401): an exit-boundary drop
$run8 = @(
  '{"ra":"30","t":"2026-10-21T20:03:55.9000000Z","p":"/rest/v1/products?select=id&limit=1","s":503,"b":"{\"code\":\"STORE_UPDATING\"}","m":"GET"}',
  '{"ra":"30","t":"2026-10-21T20:03:56.3652008Z","p":"/functions/v1/s7-probe","s":503,"b":"{\"code\":\"STORE_UPDATING\",\"message\":\"The store is updating. Try again in a few minutes.\"}","m":"POST"}',
  '{"ra":"","t":"2026-10-21T20:03:56.4142417Z","p":"/_store/status","s":401,"b":"{\"message\":\"Invalid API key\"}","m":"GET"}',
  '{"ra":"30","t":"2026-10-21T20:03:56.7278437Z","p":"/rest/v1/products?select=id&limit=1","s":503,"b":"{\"code\":\"STORE_UPDATING\",\"message\":\"The store is updating. Try again in a few minutes.\"}","m":"GET"}',
  '{"ra":"","t":"2026-10-21T20:03:56.7685258Z","p":"/rest/v1/rpc/s7_probe","s":0,"b":"NOANSWER curl: (52) Empty reply from server","m":"POST"}',
  '{"ra":"","t":"2026-10-21T20:03:57.3152615Z","p":"/auth/v1/health","s":401,"b":"{\"message\":\"No API key found in request\"}","m":"GET"}',
  '{"ra":"","t":"2026-10-21T20:03:57.4861656Z","p":"/_store/health","s":200,"b":"{\"status\":\"ok\"}","m":"GET"}')
$f8 = New-PollFile $run8; $checks.Clear()
Assert-LanNeverServed 'T' $f8 ([datetime]'2026-10-21T20:03:55.9Z') ([datetime]'2026-10-21T20:03:56.7278437Z')   # the window ends at the LAST 503, the drop is just after it
Remove-Item $f8 -Force
$d1 = DropResult
Expect 'drops: one exit-boundary drop (run 8, 72) passes and says so' '1|T : dropped connections = 1|True|True' "$($d1.Count)|$($d1.id)|$($d1.pass)|$($d1.actual -like '*exit-boundary*')"
$entry = @(PollRound 0 200) + @(PollRow 0.6 'POST' '/rest/v1/rpc/s7_probe' 0) + @(PollRow 0.9 'GET' '/rest/v1/a' 503) + @(PollRound 1 503) + @(PollRound 2 503) + @(PollRound 3 200)
$d2 = DropCheck $entry 0.9 2
Expect 'drops: one entry-boundary drop passes and says so' '1|T : dropped connections = 1|True|True' "$($d2.Count)|$($d2.id)|$($d2.pass)|$($d2.actual -like '*entry-boundary*')"
$mid = @(PollRound 0 200) + @(PollRound 1 503) + @(PollRow 1.5 'POST' '/rest/v1/rpc/s7_probe' 0) + @(PollRound 2 503) + @(PollRound 3 200)
$d3 = DropCheck $mid 1 2
Expect 'drops: a mid-window drop (503 before and after) fails' 'False' $d3.pass
$two = @(PollRound 0 200) + @(PollRound 1 503) + @(PollRound 2 503) + @(PollRow 2.3 'POST' '/rest/v1/rpc/s7_probe' 0) + @(PollRow 2.4 'POST' '/auth/v1/token' 0) + @(PollRound 3 200)
$d4 = DropCheck $two 1 2.2
Expect 'drops: two drops at the same boundary fail' 'False' $d4.pass
$three = @(PollRound 0 200) + @(PollRow 0.5 'POST' '/rest/v1/rpc/s7_probe' 0) + @(PollRound 1 503) + @(PollRound 2 503) + @(PollRow 2.3 'POST' '/rest/v1/rpc/s7_probe' 0) + @(PollRow 2.5 'POST' '/auth/v1/token' 0) + @(PollRound 3 200)
$d5 = DropCheck $three 1 2.2
Expect 'drops: three drops fail' 'False' $d5.pass
# ---- memory sampler rows (sandbox\lib-mem.ps1): pure formatting, a throwing sample source never throws ----
. (Join-Path $PSScriptRoot '..\sandbox\lib-mem.ps1')
function P($n, $mb) { [pscustomobject]@{ Name = $n; WorkingSet64 = [int64]$mb * 1MB } }
$procs7 = @((P 'a' 10), (P 'big' 900), (P 'c' 30), (P 'd' 40), (P 'e' 50), (P 'f' 60), (P 'mid' 300))
Expect 'mem: guest header' 'utc,freeMB,commitMB,top5' (Get-MemHeader 'guest')
Expect 'mem: host header' 'utc,freeMB,top5' (Get-MemHeader 'host')
Expect 'mem: top5 is name:MB, descending, at most 5' 'big:900;mid:300;f:60;e:50;d:40' (Format-TopProcs $procs7)
Expect 'mem: top5 of fewer than 5 and of none' 'x:5|' "$(Format-TopProcs @((P 'x' 5)))|$(Format-TopProcs @())"
Expect 'mem: guest row shape' '2026-10-21T10:00:00Z,3000,5100,big:900;mid:300' (Format-MemRow 'guest' '2026-10-21T10:00:00Z' 3000 5100 'big:900;mid:300')
Expect 'mem: host row shape' '2026-10-21T10:00:00Z,7000,' (Format-MemRow 'host' '2026-10-21T10:00:00Z' 7000 $null '')
$g = New-GuestMemRow { [pscustomobject]@{ FreeMB = 2048; CommitMB = 3500; Procs = $procs7 } }
if ($g -notmatch '^\d{4}-\d\d-\d\dT[\d:]+Z,2048,3500,big:900;mid:300;f:60;e:50;d:40$') { $fail++; Write-Host "FAIL mem: guest sample row got '$g'" }
$st = @{ Low = [int]::MaxValue }
$src = { param($free) [pscustomobject]@{ FreeMB = $free; Procs = $procs7 } }
$h1 = New-HostMemRow { & $src 7000 } $st
$h2 = New-HostMemRow { & $src 5000 } $st
$h3 = New-HostMemRow { & $src 5500 } $st
$h4 = New-HostMemRow { & $src 4000 } $st
$h5 = New-HostMemRow { & $src 6144 } $st
Expect 'mem: host above 6144 leaves top5 empty' ',7000,' "$($h1 -replace '^[^,]+', '')"
$tail = { param($r) ($r -split ',', 3)[2] }
Expect 'mem: host new low below 6144 fills top5' 'big:900;mid:300;f:60;e:50;d:40' (& $tail $h2)
Expect 'mem: host below 6144 but not a new low is empty' '' (& $tail $h3)
Expect 'mem: host deeper new low fills top5 again' 'big:900;mid:300;f:60;e:50;d:40' (& $tail $h4)
Expect 'mem: host exactly 6144 is not below the threshold' '' (& $tail $h5)
$bad = $null; $threw = $false
try { $bad = New-GuestMemRow { throw 'wmi down, really' } } catch { $threw = $true }
Expect 'mem: guest throwing source returns a note, never throws' 'False|True' "$threw|$($bad -match ',ERROR wmi down; really$')"
$bad2 = $null; $threw = $false
try { $bad2 = New-HostMemRow { throw 'cim gone' } @{ Low = [int]::MaxValue } } catch { $threw = $true }
Expect 'mem: host throwing source returns a note, never throws' 'False|True' "$threw|$($bad2 -match ',ERROR cim gone$')"
# ---- reboot stall check (sandbox\lib-mem.ps1 Test-RebootStall): the reboot line AND both agent.log and mem.csv silent for >= threshold ----
$rb = '20:27:57.123 rebooting for the next phase'
$m = [timespan]::FromMinutes(1)
Expect 'stall: fires on the reboot line, both files 6 min old' 'True' (Test-RebootStall $rb ([timespan]::FromMinutes(6)) ([timespan]::FromMinutes(6)))
Expect 'stall: not at 4 min' 'False' (Test-RebootStall $rb ([timespan]::FromMinutes(4)) ([timespan]::FromMinutes(4)))
Expect 'stall: a different last line never fires, even at 30 min' 'False' (Test-RebootStall '20:27:57.123 running scenario 75 phase 2' ([timespan]::FromMinutes(30)) ([timespan]::FromMinutes(30)))
Expect 'stall: a fresh mem.csv blocks the fire' 'False' (Test-RebootStall $rb ([timespan]::FromMinutes(30)) $m)
Expect 'stall: a fresh agent.log blocks the fire' 'False' (Test-RebootStall $rb $m ([timespan]::FromMinutes(30)))
Expect 'stall: exactly 5 min fires' 'True' (Test-RebootStall $rb ([timespan]::FromMinutes(5)) ([timespan]::FromMinutes(5)))
Expect 'stall: empty last line does not fire' 'False' (Test-RebootStall '' ([timespan]::FromMinutes(30)) ([timespan]::FromMinutes(30)))
Expect 'stall: null last line does not fire' 'False' (Test-RebootStall $null ([timespan]::FromMinutes(30)) ([timespan]::FromMinutes(30)))
# the switch stdin cloud URL must carry sslmode=disable (the Sandbox's loopback Postgres has no TLS; the product defaults a missing sslmode to require)
$sw = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\sandbox\lib-switch.ps1'), [ref]$null, [ref]$null)
. ([scriptblock]::Create($sw.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-CloudStdin' }, $true).Extent.Text))
function Get-CloudPassword { 'p:w/d' }
function Get-Cfg { [pscustomobject]@{ ports = [pscustomobject]@{ base = 56789 } } }
$script:CloudDb = 'cloud_x'
$cu = (Get-CloudStdin | ConvertFrom-Json).db.url
Expect 'switch stdin url: loopback, escaped password, db, sslmode=disable' ('postgres' + '://supabase_admin:p%3Aw%2Fd@127.0.0.1:56789/cloud_x?sslmode=disable') $cu
# the reboot startup task wrapper (agent.ps1): parses, writes a guest-local breadcrumb first, waits for the mapped paths, then starts agent.ps1 like the .wsb LogonCommand
$agPath = Join-Path $PSScriptRoot '..\sandbox\agent.ps1'
$ag = [System.Management.Automation.Language.Parser]::ParseFile($agPath, [ref]$null, [ref]$null)
. ([scriptblock]::Create($ag.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-BootTaskWrapper' }, $true).Extent.Text))
$wrap = Get-BootTaskWrapper
$wrapErr = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($wrap, [ref]$null, [ref]$wrapErr)
Expect 'boot task wrapper parses' '0' $wrapErr.Count
Expect 'boot task wrapper: breadcrumb comes before the wait' 'True' ($wrap.IndexOf("B 'task fired'") -ge 0 -and $wrap.IndexOf("B 'task fired'") -lt $wrap.IndexOf('Start-Sleep'))
Expect 'boot task wrapper: starts agent.ps1 exactly like the LogonCommand' 'True' ($wrap.Contains("& 'C:\pwsh7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\scenarios\agent.ps1'"))
Expect 'boot task wrapper: guest-local file mirrored to C:\out' 'True' ($wrap.Contains("'C:\boot-wrapper.txt'") -and $wrap.Contains("'C:\out\boot-wrapper.txt'"))
Expect 'boot task action: guest System32 PowerShell 5.1, not the mapped pwsh7' 'True' ((Get-Content $agPath -Raw).Contains('$bootTaskExe = "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"'))
# Get-LanTarget follows state\gateway.json: tls=off = plain http, no --resolve; internal / absent / unparseable = https + --resolve with the SNI name
$script:Data = Join-Path ([IO.Path]::GetTempPath()) ("lantarget-" + [guid]::NewGuid()); New-Item -ItemType Directory -Path (Join-Path $script:Data 'state') -Force | Out-Null
$gjf = Join-Path $script:Data 'state\gateway.json'
Set-Content $gjf '{"tls":"off","hosts":["sandbox-pc"]}'; $t = Get-LanTarget 47304 '127.0.0.1'
Expect 'LanTarget tls off: plain http on the IP, no --resolve' 'True|http://127.0.0.1:47304|0' "$($t.plain)|$($t.base)|$($t.pre.Count)"
Set-Content $gjf '{"tls":"internal","hosts":["Storepc"]}'; $t = Get-LanTarget 47304 '127.0.0.1'
Expect 'LanTarget tls internal: https + --resolve with the SNI name' 'False|https://storepc:47304|--resolve storepc:47304:127.0.0.1' "$($t.plain)|$($t.base)|$($t.pre -join ' ')"
Remove-Item $gjf; $t = Get-LanTarget 47304 '127.0.0.1'
Expect 'LanTarget no gateway.json: https default name' 'False|https://sandbox-pc:47304' "$($t.plain)|$($t.base)"
Set-Content $gjf 'not json'; $t = Get-LanTarget 47304 '127.0.0.1'
Expect 'LanTarget unparseable gateway.json: https' 'False' "$($t.plain)"
Remove-Item $script:Data -Recurse -Force
Expect 'the switch fixture admin insert sets instance_id (GoTrue only finds users with the nil instance_id)' 'True' ((Get-Content (Join-Path $PSScriptRoot '..\sandbox\lib-switch.ps1') -Raw) -match "INSERT INTO auth\.users \(instance_id,[^)]*\) VALUES \('00000000-0000-0000-0000-000000000000'")
# the cloud admin is keyed like the product keys staff (<id>@barpos.local); sign-in failures show GoTrue's error_code/msg, never a body with tokens
foreach ($n in 'Get-CloudAdminEmail', 'Format-GrantResult') { . ([scriptblock]::Create($sw.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true).Extent.Text)) }
Expect 'cloud admin email = <id>@barpos.local' '11111111-2222-4333-8444-555555555555@barpos.local' (Get-CloudAdminEmail '11111111-2222-4333-8444-555555555555')
Expect 'grant 400 body: status + error_code + msg' 'HTTP 400 invalid_credentials Invalid login credentials' (Format-GrantResult ([pscustomobject]@{ Status = 400; Body = '{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}' }))
Expect 'grant 200 body: tokens are never echoed' 'HTTP 200' (Format-GrantResult ([pscustomobject]@{ Status = 200; Body = '{"access_token":"SECRET-JWT","refresh_token":"SECRET-R"}' }))
Expect 'grant unparseable body is flagged, not echoed' 'HTTP 502 unparseable body' (Format-GrantResult ([pscustomobject]@{ Status = 502; Body = '<html>SECRET</html>' }))
# scenario 53: journal:work:intent is its own class (B0W), every B0 label is a journal step strictly before Work
. ([scriptblock]::Create($sw.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq 'Get-SwitchLabelClass' }, $true).Extent.Text))
Expect 'label class: journal:work:intent is B0W, not B0' 'B0W' (Get-SwitchLabelClass 'journal:work:intent')
Expect 'label class: journal:work:done is B1' 'B1' (Get-SwitchLabelClass 'journal:work:done')
$b0Steps = @('started', 'fence', 'backup', 'repair_collation', 'clone_db')
$b0Bad = @(foreach ($st in @('started', 'fence', 'backup', 'repair_collation', 'clone_db', 'work', 'verify_clone', 'swap', 'activate', 'verify_live', 'reopen', 'finalize')) { foreach ($ph in 'intent', 'done') { $l = "journal:${st}:$ph"; if ((Get-SwitchLabelClass $l) -eq 'B0' -and $b0Steps -notcontains $st) { $l } } })
Expect 'label class: every B0 label is a step before Work' '' ($b0Bad -join ',')
# scenario 53: the photos failure rolls back after the swap, so it must expect the kept pos_failed_* database
$s53 = Get-Content -Raw (Join-Path $PSScriptRoot '..\sandbox\scenarios\53-switch-kill-matrix-back.ps1')
Expect '53 photos block passes -KeepFailedDb' 'True' ([bool]($s53 -match 'Assert-LocalIntact ''53 photos'' \$pre -KeepFailedDb'))
$s57 = Get-Content -Raw (Join-Path $PSScriptRoot '..\sandbox\scenarios\57-switch-hung-run-and-budget.ps1')
Expect '57 case C (rollback after the swap) passes -KeepFailedDb' 'True' ([bool]($s57 -match 'Assert-LocalIntact ''57 C'' \$pre -KeepFailedDb'))
Expect '57 case B (rollback before the swap) expects no pos_failed_*' 'True' ([bool]($s57 -match 'Assert-LocalIntact ''57 B'' \$pre *\$|Assert-LocalIntact ''57 B'' \$pre\r?\n'))
# kill matrix: M/BW rollback keeps pos_failed_* unless the swap never ran (journal:swap:intent), before and after `switch rollback`
$swText = Get-Content -Raw (Join-Path $PSScriptRoot '..\sandbox\lib-switch.ps1')
Expect 'matrix M/BW: leftover check is per label (only journal:swap:intent keeps none)' 'True' ([bool]($swText -match "\`$keepFailed = \(\`$label -ne 'journal:swap:intent'\)"))
Expect 'matrix M/BW: both calls pass -KeepFailedDb:$keepFailed' '2' ([regex]::Matches($swText, 'Assert-LocalIntact "\$label \[\$cls\](?: after rollback)?" \$pre -KeepFailedDb:\$keepFailed')).Count.ToString()
Expect '58 expectation is per label (documented; shares the matrix helper)' 'True' ([bool]((Get-Content -Raw (Join-Path $PSScriptRoot '..\sandbox\scenarios\58-switch-kill-matrix-back-held.ps1')) -match 'except journal:swap:intent'))
# scenarios 51/52: exact block-set comparison (order/duplicates do not matter, an extra code does)
. ([scriptblock]::Create($sw.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq 'Join-CodeSet' }, $true).Extent.Text))
Expect 'Join-CodeSet: empty' '' (Join-CodeSet @())
Expect 'Join-CodeSet: order and duplicates ignored' 'A,B' (Join-CodeSet @('B', 'A', 'B'))
Expect 'Join-CodeSet: an extra block differs from the expected set' 'False' ((Join-CodeSet @('A', 'TLS')) -eq (Join-CodeSet @('A')))
# store.env mode line: only the VITE_STORE_MODE value is read
. ([scriptblock]::Create($sw.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq 'Get-StoreEnvMode' }, $true).Extent.Text))
Expect 'Get-StoreEnvMode: offline-only (CRLF, other keys ignored)' 'offline-only' (Get-StoreEnvMode "# Written by posctl`r`nVITE_STORE_MODE=offline-only`r`nVITE_SUPABASE_URL=https://h:1`r`n")
Expect 'Get-StoreEnvMode: cloud' 'cloud' (Get-StoreEnvMode "VITE_STORE_MODE=cloud`n")
Expect 'Get-StoreEnvMode: absent' '' (Get-StoreEnvMode "VITE_SUPABASE_URL=x`n")
# scenario 08: the LAN probe goes through Get-LanTarget (via Invoke-LanCurl), never a hand-built https://127.0.0.1 (no SNI -> schannel handshake failure)
$s08 = Get-Content -Raw (Join-Path $PSScriptRoot '..\sandbox\scenarios\08-pack-install-and-first-pin.ps1')
Expect '08 has no hard-coded https://127.0.0.1 LAN URL' 'False' ([string]($s08 -match 'https://127\.0\.0\.1'))
Expect '08 loads lib-update.ps1 and probes the LAN with Invoke-LanCurl' 'True' ([string](($s08 -match 'lib-update\.ps1') -and ($s08 -match "Invoke-LanCurl 'GET'")))
# B4: scenario 90 reads the 32-bit registry view (the NSIS installer is a 32-bit process), not the 64-bit one
$s90 = Get-Content -Raw (Join-Path $PSScriptRoot '..\sandbox\scenarios\90-install-silent-never-asks.ps1')
Expect 'scenario 90: marker key is the WOW6432Node view' 'True|False' ("$($s90 -match [regex]::Escape('$script:MarkerKey = ''HKLM:\SOFTWARE\WOW6432Node\SupermarketPOS'''))|$($s90 -match [regex]::Escape('$script:MarkerKey = ''HKLM:\SOFTWARE\SupermarketPOS'''))")
# B7: generate-build-cert.ps1 -NoStoreImport deletes the private key too and never removes a cert that was already in the store
$gbc = Get-Content -Raw (Join-Path $PSScriptRoot '..\..\scripts\generate-build-cert.ps1')
Expect 'build cert: cleanup uses -DeleteKey' 'True' ($gbc -match 'Remove-Item[^
]*\$cert\.Thumbprint\)[^
]*-DeleteKey')
Expect 'build cert: the store is snapshotted before create/import' 'True' $gbc.Contains('$thumbprintsBefore = @(Get-ChildItem')
Expect 'build cert: the cleanup consults the snapshot' 'True' $gbc.Contains('$thumbprintsBefore -contains $cert.Thumbprint')
Expect 'build cert: the snapshot comes before New-SelfSignedCertificate' 'True' ($gbc.IndexOf('$thumbprintsBefore =') -lt $gbc.IndexOf('New-SelfSignedCertificate'))
# scenario 90: process-tree enumeration (pure)
$s90 = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\sandbox\scenarios\90-install-silent-never-asks.ps1'), [ref]$null, [ref]$null)
. ([scriptblock]::Create($s90.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-TreePids' }, $true).Extent.Text))
$fake = @(@{ProcessId=10;ParentProcessId=1}, @{ProcessId=11;ParentProcessId=10}, @{ProcessId=12;ParentProcessId=11}, @{ProcessId=13;ParentProcessId=99}, @{ProcessId=14;ParentProcessId=10}) | ForEach-Object { [pscustomobject]$_ }
Expect 'tree90: root + descendants only' '10,11,12,14' ((Get-TreePids $fake 10 | Sort-Object) -join ',')
Expect 'tree90: leaf is just itself' '12' ((Get-TreePids $fake 12) -join ',')
Expect 'tree90: unknown root is just itself' '77' ((Get-TreePids $fake 77) -join ',')
# 11S: Read-SecretFileText (lib.ps1) unwraps a POSDPAPI1 file (machine-scope DPAPI, the entropy of store-server/src/dpapi.rs) and reads plaintext as it is. Fake value only.
$libAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\sandbox\lib.ps1'), [ref]$null, [ref]$null)
. ([scriptblock]::Create(($libAst.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-SecretFileText' }, $true)).Extent.Text))
$dpDir = Join-Path ([IO.Path]::GetTempPath()) ('dpapi-helper-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $dpDir | Out-Null
try {
  Add-Type -AssemblyName System.Security
  $fake = 'fake-not-a-secret-value'
  $blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($fake), [Text.Encoding]::ASCII.GetBytes('SupermarketPOS posctl secret file v1'), [Security.Cryptography.DataProtectionScope]::LocalMachine)
  [IO.File]::WriteAllBytes((Join-Path $dpDir 'w.txt'), ([Text.Encoding]::ASCII.GetBytes("POSDPAPI1`n") + $blob))
  [IO.File]::WriteAllText((Join-Path $dpDir 'p.txt'), $fake)
  Expect '11S: a wrapped file reads back as the value' $fake (Read-SecretFileText (Join-Path $dpDir 'w.txt'))
  Expect '11S: a legacy plaintext file reads as it is' $fake (Read-SecretFileText (Join-Path $dpDir 'p.txt'))
} finally { Remove-Item $dpDir -Recurse -Force -ErrorAction SilentlyContinue }
if ($fail -gt 0) { Write-Host "$fail failed"; exit 1 }
$s90Fn = $s90.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-BrokerServiceVerdict' }, $true).Extent.Text
. ([scriptblock]::Create($s90Fn))
Expect 'broker90: timeout' 'query-timeout' (Get-BrokerServiceVerdict $true '')
Expect 'broker90: 1060 absent' 'absent' (Get-BrokerServiceVerdict $false '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:')
Expect 'broker90: exists' 'exists' (Get-BrokerServiceVerdict $false 'SERVICE_NAME: PrintBrokerService')
foreach ($fnName in 'Format-ConsoleRows', 'Read-ConsoleText') { . ([scriptblock]::Create($s90.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $fnName }, $true).Extent.Text)) }
Expect 'console90: trims + drops trailing empties' "a`n`nb" (Format-ConsoleRows @('a   ', '', 'b  ', '   ', ''))
Expect 'console90: all blank is empty' '' (Format-ConsoleRows @('  ', ''))
Expect 'console90: invalid pid reports, never throws' 'True' ((Read-ConsoleText 999999 15) -match '^(ATTACH-FAILED|READER-)')

. ([scriptblock]::Create($s90.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-BrokerInstallResult' }, $true).Extent.Text))
Expect 'brokerlog90: result 0' '0' (Get-BrokerInstallResult ("broker.exe install, result: 0`r`nservice installed`r`n"))
Expect 'brokerlog90: nonzero code' '-1073741515' (Get-BrokerInstallResult 'broker.exe install, result: -1073741515')
Expect 'brokerlog90: timeout' 'timeout' (Get-BrokerInstallResult "broker.exe install, result: timeout`r`n")
Expect 'brokerlog90: null is missing, never throws' 'missing' (Get-BrokerInstallResult $null)
Expect 'brokerlog90: empty is missing' 'missing' (Get-BrokerInstallResult '')
Expect 'brokerlog90: text without a result line' 'no-result-line' (Get-BrokerInstallResult 'garbage')
foreach ($n in 'Get-IcaclsAces', 'Get-ServiceStatusText') { . ([scriptblock]::Create($s90.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true).Extent.Text)) }
Expect 'acl90: empty DACL (icacls prints no ACE) has zero aces' '0' (@(Get-IcaclsAces "C:\ProgramData\PrintBroker\broker-config.json`r`n`r`nSuccessfully processed 1 files; Failed processing 0 files").Count)
Expect 'acl90: null never throws' '0' (@(Get-IcaclsAces $null).Count)
$acl90 = "C:\x\broker-config.json NT AUTHORITY\SYSTEM:(F)`r`n                           BUILTIN\Administrators:(F)`r`n                           NT SERVICE\PrintBrokerService:(M)`r`n`r`nSuccessfully processed 1 files; Failed processing 0 files"
Expect 'acl90: three aces counted' '3' (@(Get-IcaclsAces $acl90).Count)
Expect 'acl90: service ace found' '1' (@(Get-IcaclsAces $acl90 | Where-Object { $_ -match 'PrintBrokerService' }).Count)
Expect 'svc90: null service is absent' 'absent' (Get-ServiceStatusText $null)
Expect 'svc90: status text' 'Running' (Get-ServiceStatusText ([pscustomobject]@{ Status = 'Running' }))

foreach ($n in 'Get-ImagePathExe', 'Get-BrokerInstallDir') { . ([scriptblock]::Create($s90.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true).Extent.Text)) }
Expect 'imagepath90: quoted with args' 'C:\Program Files\Supermarket POS\broker\broker.exe' (Get-ImagePathExe '"C:\Program Files\Supermarket POS\broker\broker.exe" run')
Expect 'imagepath90: unquoted with args' 'C:\x\broker\broker.exe' (Get-ImagePathExe 'C:\x\broker\broker.exe service')
Expect 'imagepath90: missing' '' (Get-ImagePathExe $null)
Expect 'instdir90: from a quoted ImagePath' 'C:\Program Files\Supermarket POS' (Get-BrokerInstallDir '"C:\Program Files\Supermarket POS\broker\broker.exe" run' $null)
Expect 'instdir90: exe outside a broker folder is its own folder' 'C:\app' (Get-BrokerInstallDir 'C:\app\broker.exe' $null)
Expect 'instdir90: no ImagePath falls back to InstallLocation' 'C:\Program Files\Supermarket POS' (Get-BrokerInstallDir $null '"C:\Program Files\Supermarket POS\"')
Expect 'instdir90: nothing known is empty' '' (Get-BrokerInstallDir '' $null)
# Every sandbox script must parse and carry no control char but tab/CR/LF (a stray backspace byte once crashed scenario 90 at parse). Build the pattern from escapes so this file stays clean.
$sbFiles = @(Get-ChildItem (Join-Path $PSScriptRoot '..\sandbox') -Recurse -Filter '*.ps1')
$sbBad = @(foreach ($f in $sbFiles) {
  $errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count -gt 0) { "$($f.Name): parse: $($errs[0].Message) (line $($errs[0].Extent.StartLineNumber))" }
  if ([IO.File]::ReadAllText($f.FullName) -match '[\x00-\x08\x0B\x0C\x0E-\x1F]') { "$($f.Name): control character" }
})
Expect "sandbox scripts: all $($sbFiles.Count) parse with no control chars" '' ($sbBad -join '; ')
# Get-CountsDiff names only the tables whose count differs
Expect 'counts diff: equal -> empty' '' (Get-CountsDiff "a=1`r`nb=2" "a=1`nb=2")
Expect 'counts diff: names only the changed and one-sided tables' 'b: 2 -> 3; c: (absent) -> 1' (Get-CountsDiff "a=1`nb=2" "a=1`nb=3`nc=1")
if ($fail -gt 0) { Write-Host "$fail failed"; exit 1 }
Write-Host 'all held'; exit 0
