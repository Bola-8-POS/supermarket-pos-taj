<#
.SYNOPSIS
  Builds the signed test pack used by the posctl pack tests. Windows PowerShell 5.1 compatible.
.DESCRIPTION
  Builds a tiny pack (every file posctl requires, a few bytes each, plus the real sql\run-order.json), then has sign-pack.ps1 sign it
  with a THROWAWAY key. Only public artifacts are written to tests\fixtures\: pack-ok.pospack, signer.pub, other.pub (an unrelated
  second key). No private key is ever written outside a temp folder that is deleted.
  Run:  powershell -NoProfile -File store-server\tests\fixtures\make-pack-fixture.ps1
#>
param([string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path)
$ErrorActionPreference = 'Stop'
$out = $PSScriptRoot
$work = Join-Path ([IO.Path]::GetTempPath()) ("posctl-fixture-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
try {
  $required = @('bin/auth.exe','bin/postgrest.exe','bin/caddy.exe','bin/functions.exe','bin/shawl.exe','pg/bin/postgres.exe','pg/bin/initdb.exe','pg/bin/psql.exe','pg/bin/pg_isready.exe','tools/supabase.exe','sql/run-order.json','sql/01-pre-gotrue.sql','sql/02-shim-after-gotrue.sql','sql/03-owner-role.sql','sql/03b-storage.sql','sql/03c-database-grants.sql','sql/04-nonsuper-fixups.sql','sql/20-pos-lockout-hook.sql','sql/30-store-schema-version.sql','migrations/20260101000001_a.sql','migrations/20260101000002_b.sql','sql/stub-extensions/vector.control','sql/stub-extensions/vector--0.0.1.sql','pg/share/extension/pg_net.control','pg/share/extension/pg_net--1.0.sql','licenses/README.txt')
  $runOrder = Get-Content (Join-Path $RepoRoot 'store-server\pack\sql\run-order.json') -Raw
  $pack = Join-Path $work 'pack'
  New-Item -ItemType Directory -Force $pack | Out-Null
  $files = @()
  $sha = [Security.Cryptography.SHA256]::Create()
  foreach ($rel in $required) {
    $p = Join-Path $pack ($rel -replace '/', '\')
    New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
    $content = "x " + $rel
    if ($rel -eq 'sql/run-order.json') { $content = $runOrder }
    if ($rel -like '*.control') { $content = "trusted = true`n" }
    [IO.File]::WriteAllBytes($p, [Text.Encoding]::ASCII.GetBytes($content))
    $bytes = [IO.File]::ReadAllBytes($p)
    $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
    $files += [ordered]@{ path = $rel; sha256 = $hash; size = $bytes.Length }
  }
  $manifest = [ordered]@{ schema = 1; packVersion = '1.0.0-r1'; appVersion = '1.0.0'; platform = 'win-x64'; migrations = [ordered]@{ count = 2; max = '20260101000002' }; files = $files }
  [IO.File]::WriteAllText((Join-Path $pack 'manifest.json'), ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  & (Join-Path $PSScriptRoot 'sign-pack.ps1') -PackDir $pack -OutZip (Join-Path $out 'pack-ok.pospack') -OutPub (Join-Path $out 'signer.pub') -RepoRoot $RepoRoot
  # an unrelated key, for the "signed by another key" tests (its zip is discarded)
  & (Join-Path $PSScriptRoot 'sign-pack.ps1') -PackDir $pack -OutZip (Join-Path $work 'other.zip') -OutPub (Join-Path $out 'other.pub') -RepoRoot $RepoRoot
  Write-Host "wrote pack-ok.pospack, signer.pub, other.pub"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
