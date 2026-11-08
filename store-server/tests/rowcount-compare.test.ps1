<#
.SYNOPSIS
  Host-side check (no Sandbox) of the update scenarios' row-count comparison and the catalog line diff (sandbox\lib-update.ps1).
  Windows PowerShell 5.1: powershell.exe -NoProfile -ExecutionPolicy Bypass -File store-server\tests\rowcount-compare.test.ps1   Exit 0 = all ok.
#>
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\sandbox\lib-update.ps1'), [ref]$null, [ref]$null)
foreach ($name in 'Compare-RowCounts', 'Get-LineDiff', 'Get-MigrationTables') {
  $f = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $f) { throw "function $name not found" }
  . ([scriptblock]::Create($f.Extent.Text))
}
$fail = 0
function Expect($label, $want, $got) { if ("$want" -ne "$got") { $script:fail++; Write-Host "FAIL $label : want '$want' got '$got'" } else { Write-Host "ok   $label" } }
function Has($s, $needle) { return $(if ($s.Contains($needle)) { 'yes' } else { "no: '$s'" }) }

$pre = "products=10`r`nprofiles=3`r`ntabs=7"
$fence = @('store_switch_state', 'till_sync_report')
$real = "products=10`r`nprofiles=3`r`nstore_switch_state=1`r`ntabs=7`r`ntill_sync_report=0"
$r = Compare-RowCounts $pre $real $fence
Expect 'GREEN real shape: pre tables equal + exactly the two fence tables' '' $r.Problems
Expect 'GREEN new tables reported (Info text)' 'store_switch_state=1, till_sync_report=0' $r.NewTables
Expect 'GREEN rollback: identical, nothing expected' '' (Compare-RowCounts $pre $pre @()).Problems
Expect 'GREEN comma-joined pre (lib-backup / saved rows) parses' '' (Compare-RowCounts 'a=1,b=2' "b=2`na=1" @()).Problems
Expect 'RED a table loses one row' 'yes' (Has (Compare-RowCounts $pre ($real -replace 'products=10', 'products=9') $fence).Problems 'changed: products 10 -> 9')
Expect 'RED a surprise table appears' 'yes' (Has (Compare-RowCounts $pre ($real + "`r`nsurprise=0") $fence).Problems 'unexpected new table: surprise=0')
Expect 'RED a pre table vanishes' 'yes' (Has (Compare-RowCounts $pre ($real -replace 'tabs=7', '') $fence).Problems 'vanished: tabs')
Expect 'RED an expected new table is missing' 'yes' (Has (Compare-RowCounts $pre ($real -replace 'till_sync_report=0', '') $fence).Problems 'expected new table missing: till_sync_report')
Expect 'RED new table on a store that stayed on the old pack (nothing expected)' 'yes' (Has (Compare-RowCounts $pre $real @()).Problems 'unexpected new table: store_switch_state')

Expect 'diff: equal sets -> empty' '' (Get-LineDiff @('a', 'b') @('b', 'a'))
Expect 'diff: names the side' "- a`n+ c" (Get-LineDiff @('a', 'b') @('b', 'c'))

# pack delta from migrations on temp copies: new pack = old + a fence file; a rename in the new pack is not a "new" table
$t = Join-Path $env:TEMP ("rc-test-" + [guid]::NewGuid().ToString('N')); $o = Join-Path $t 'old'; $n = Join-Path $t 'new'
New-Item -ItemType Directory $o, $n | Out-Null
'create table public.products (id int); create table inventory_log (id int);' | Set-Content (Join-Path $o '001.sql')
Copy-Item (Join-Path $o '001.sql') $n
'alter table inventory_log rename to stock_movements; create table if not exists public.store_switch_state (x int); create table till_sync_report (x int);' | Set-Content (Join-Path $n '002.sql')
$oldT = @(Get-MigrationTables $o); $delta = @(Get-MigrationTables $n | Where-Object { $oldT -notcontains $_ })
Expect 'pack delta = tables the new migrations create (rename counted, fence tables found)' 'stock_movements,store_switch_state,till_sync_report' ($delta -join ',')
Remove-Item $t -Recurse -Force
if ($fail) { Write-Host "$fail FAILED"; exit 1 } else { Write-Host 'all ok'; exit 0 }
