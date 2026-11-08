<#
.SYNOPSIS
  Host-side mutation check (no Sandbox, no services, no packs): the digests file is bound to its BASE pack, and scenario 72's intent proof is strict.
  Exit 0 = every expectation held. Expected output: 8 behaviour cases + 1 text-sync case = 9 "ok" lines.
.DESCRIPTION
  Loads only the named functions out of sandbox\lib-update.ps1 / New-TestPacks.ps1 through the PowerShell AST. Windows PowerShell 5.1:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File store-server\tests\digest-binding.test.ps1
#>
$ErrorActionPreference = 'Stop'
$libAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\sandbox\lib-update.ps1'), [ref]$null, [ref]$null)
$ntpAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\sandbox\New-TestPacks.ps1'), [ref]$null, [ref]$null)
function Get-Fn($ast, $name) {
  $f = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $f) { throw "function $name not found" }
  return $f
}
foreach ($name in 'Assert-DigestsBoundToBase', 'Test-MismatchPackIntent') { . ([scriptblock]::Create((Get-Fn $libAst $name).Extent.Text)) }
$fail = 0
function Expect($label, $want, $got) { if ("$want" -ne "$got") { $script:fail++; Write-Host "FAIL $label : want '$want' got '$got'" } else { Write-Host "ok   $label" } }
function Outcome([scriptblock]$blk) { try { & $blk; return 'accepted' } catch { return 'refused: ' + $_.Exception.Message } }

$A = ('a' * 64); $B = ('b' * 64)
$bound = [pscustomobject]@{ sqlSha256 = ('c' * 64); baseManifestSha256 = $A; new = ('1' * 64) }
$legacy = [pscustomobject]@{ sqlSha256 = ('c' * 64); new = ('1' * 64) }
Expect 'binding 1: digests bound to base A are accepted for base A' 'accepted' (Outcome { Assert-DigestsBoundToBase $bound $A 'x' })
function Refusal($label, [string[]]$needles, [scriptblock]$blk) { $o = Outcome $blk; $ok = $o.StartsWith('refused: '); foreach ($n in $needles) { if (-not $o.Contains($n)) { $ok = $false } }; Expect $label 'refused' $(if ($ok) { 'refused' } else { $o }) }
Refusal 'binding 2: digests bound to base A are refused for base B, naming both hashes' @($A, $B) { Assert-DigestsBoundToBase $bound $B 'x' }
Refusal 'binding 3: a legacy file with no baseManifestSha256 is refused by the LEGACY guard (message says so)' @('no baseManifestSha256') { Assert-DigestsBoundToBase $legacy $A 'x' }

$real = ('d' * 64); $other = ('e' * 64)
Expect 'intent 1: placeholder digest fails' 'False' (Test-MismatchPackIntent $real $true $real 'CATALOG_MISMATCH').Pass
Expect 'intent 2: digest differing from the real harvested one fails' 'False' (Test-MismatchPackIntent $other $false $real 'CATALOG_MISMATCH').Pass
Expect 'intent 3: any other failure code fails' 'False' (Test-MismatchPackIntent $real $false $real 'MIGRATION_FAILED').Pass
Expect 'intent 4: real digest + CATALOG_MISMATCH passes (the only intended case)' 'True' (Test-MismatchPackIntent $real $false $real 'CATALOG_MISMATCH').Pass

Expect 'intent 5: no real harvested base digest fails, and says so' 'False|True' (($x = Test-MismatchPackIntent $real $false '' 'CATALOG_MISMATCH').Pass.ToString() + '|' + $x.Why.Contains('no real harvested base digest'))

# New-TestPacks.ps1 carries a copy (it cannot dot-source the Sandbox library): the two must stay the same text
Expect 'sync: New-TestPacks.ps1 carries the same Assert-DigestsBoundToBase text' (Get-Fn $libAst 'Assert-DigestsBoundToBase').Extent.Text.Replace("`r", '') (Get-Fn $ntpAst 'Assert-DigestsBoundToBase').Extent.Text.Replace("`r", '')
if ($fail -gt 0) { Write-Host "$fail failed"; exit 1 }
Write-Host 'all held'; exit 0
