<#
.SYNOPSIS
  Host side (FR14 item E): copy the test base pack and swap in the Caddy the REPO pins (pack\components.lock.json), so the Sandbox fixture
  carries a Caddy without the 2.11.6 HTTP/2 crash (caddy#8101).
.DESCRIPTION
  The base pack (stage-payload.ps1 -PackDir) is a build output from an older worktree and still ships Caddy 2.11.6. The repo has pinned 2.11.7 since
  then; only the fixture was stale. This script never touches the source pack: it copies it, replaces bin\caddy.exe, and fixes manifest.json
  (components.caddy, the bin/caddy.exe files entry) and drops the now-stale manifest.json.minisig (stage-payload signs the manifest again with K).
  The Caddy zip is checked first against the pinned sha256 of components.lock.json AND the sha512 of the release's published checksums file.
  Windows PowerShell 5.1 compatible. Output is outside the repo and outside the payload.
.EXAMPLE
  # one-time fetch into an EMPTY folder, then:
  .\Prepare-BasePack.ps1 -CaddyZip D:\tmp\fr14-caddy\caddy.zip -Checksums D:\tmp\fr14-caddy\checksums.txt
#>
param(
  [string]$SourcePack = 'D:\Projects\Code\supermarket-pos-worktrees\two-mode-04b\store-server\pack\.work\test-pack\pack-0.0.0-r1',
  [string]$OutPack = 'E:\tmp\two-mode-sandbox\base-pack-caddy2117\pack-0.0.0-r1',
  [Parameter(Mandatory = $true)][string]$CaddyZip,
  [Parameter(Mandatory = $true)][string]$Checksums,
  [string]$Lock = ''
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not $Lock) { $Lock = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\pack\components.lock.json' }
$lockDoc = [IO.File]::ReadAllText((Resolve-Path $Lock).Path, $utf8) | ConvertFrom-Json
$c = @($lockDoc.downloads | Where-Object { $_.id -eq 'caddy' })[0]
if (-not $c) { throw 'components.lock.json has no caddy download' }
$ver = [string]$lockDoc.components.caddy
if ($ver -notmatch '^\d+\.\d+\.\d+$') { throw "could not read the pinned Caddy version from the lock ($ver)" }
$s256 = (Get-FileHash $CaddyZip -Algorithm SHA256).Hash.ToLower()
if ($s256 -ne ([string]$c.sha256).ToLower()) { throw "caddy zip sha256 $s256 is not the lock's $($c.sha256)" }
$s512 = (Get-FileHash $CaddyZip -Algorithm SHA512).Hash.ToLower()
$pub = @(Get-Content $Checksums | Where-Object { $_ -match ([regex]::Escape([string]$c.verify.name) + '$') })
if ($pub.Count -ne 1 -or $pub[0] -notmatch $s512) { throw 'caddy zip sha512 is not the one in the published checksums file' }
if (-not (Test-Path (Join-Path $SourcePack 'manifest.json'))) { throw "no pack at $SourcePack" }
if (Test-Path $OutPack) { throw "$OutPack exists; remove it by hand first (this script deletes nothing)" }
New-Item -ItemType Directory -Force (Split-Path -Parent $OutPack) | Out-Null
& robocopy $SourcePack $OutPack /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $CaddyZip).Path)
try {
  $e = @($z.Entries | Where-Object { $_.FullName -eq 'caddy.exe' })[0]
  if (-not $e) { throw 'caddy.exe not in the zip' }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $OutPack 'bin\caddy.exe'), $true)
} finally { $z.Dispose() }
$exe = Join-Path $OutPack 'bin\caddy.exe'
$m = [IO.File]::ReadAllText((Join-Path $OutPack 'manifest.json'), $utf8).TrimStart([char]0xFEFF) | ConvertFrom-Json
$m.components.caddy = $ver
$f = @($m.files | Where-Object { $_.path -eq 'bin/caddy.exe' })[0]
if (-not $f) { throw 'manifest.files has no bin/caddy.exe' }
$f.sha256 = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower(); $f.size = (Get-Item $exe).Length
# functions.exe: the source pack's one carries whatever version it was built with; rebuild it with 0.0.0-r1 from this worktree's pack tooling.
$cli = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\pack\build\cli.mjs')).Path
$fnExe = Join-Path $OutPack 'bin\functions.exe'
& node $cli functions --pack-version 0.0.0-r1 --out $fnExe
if ($LASTEXITCODE -ne 0) { throw "node cli.mjs functions failed ($LASTEXITCODE)" }
$ff = @($m.files | Where-Object { $_.path -eq 'bin/functions.exe' })[0]
if (-not $ff) { throw 'manifest.files has no bin/functions.exe' }
$ff.sha256 = (Get-FileHash $fnExe -Algorithm SHA256).Hash.ToLower(); $ff.size = (Get-Item $fnExe).Length
[IO.File]::WriteAllText((Join-Path $OutPack 'manifest.json'), ($m | ConvertTo-Json -Depth 20), $utf8)
Remove-Item (Join-Path $OutPack 'manifest.json.minisig') -Force -ErrorAction SilentlyContinue   # stale: stage-payload signs the new manifest
Write-Host "prepared $OutPack with Caddy $ver (bin\caddy.exe sha256 $($f.sha256)); pass it to stage-payload.ps1 -PackDir (it is also the new default)"
