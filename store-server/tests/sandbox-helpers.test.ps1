<#
.SYNOPSIS
  Host-side check of the pure parsing helpers in sandbox\lib-update.ps1 (no services, no elevation, no Sandbox). Exit 0 = every expectation held.
.DESCRIPTION
  Loads only the named functions out of lib-update.ps1 through the PowerShell AST, so the rest of the library (which needs the Sandbox) is not executed.
#>
$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot '..\sandbox\lib-update.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($lib, [ref]$null, [ref]$null)
foreach ($name in 'Get-FailureActionList', 'Assert-CatalogSqlHash', 'ConvertTo-UtcDateTime', 'Read-LanPoll', 'Assert-LanFenced', 'Assert-LanNeverServed', 'Assert-FenceDrops', 'Assert-RollbackFenceWindow') {
  $f = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $f) { throw "function $name not found in lib-update.ps1" }
  . ([scriptblock]::Create($f.Extent.Text))
}
$fail = 0
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
if ($fail -gt 0) { Write-Host "$fail failed"; exit 1 }
Write-Host 'all held'; exit 0
