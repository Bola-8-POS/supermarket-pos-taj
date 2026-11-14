<#
.SYNOPSIS
  Host side: stage the local-assistant Sandbox payload (Plan 29-04, scenarios 120-123) into <PayloadDir>\assistant\.
.DESCRIPTION
  Builds the test-only probe (src-tauri\examples\assistant_probe.rs), generates a THROWAWAY minisign key in -KeyDir (host temp,
  outside the repo and outside the payload), builds the candidate assistant installer with it (scripts\assistant-build-installer.mjs
  --allow-candidate) from the artifacts already downloaded and hash-checked on the host, and copies installer.exe, the probe and the
  PUBLIC key into <PayloadDir>\assistant\. Refuses if a private key file would land in the payload.
  The payload root (posctl.exe, payload.json, pack\) is left as the normal stage-payload.ps1 wrote it: run-scenario.ps1 needs it.
  Windows PowerShell 5.1 compatible. Never installs or runs the installer (compile only; running it is Sandbox-only).
.EXAMPLE
  powershell -NoProfile -File store-server\sandbox\stage-assistant-payload.ps1 -Artifacts E:\cache\assistant-artifacts
#>
param(
  [Parameter(Mandatory)][string]$Artifacts,
  [string]$PayloadDir = 'E:\tmp\two-mode-sandbox\payload',
  [string]$AllowedRoot = 'E:\tmp\two-mode-sandbox\payload',
  [string]$OutDir = 'E:\tmp\two-mode-sandbox\assistant-build',
  [string]$KeyDir = (Join-Path ([IO.Path]::GetTempPath()) 'pos-assistant-test-key'),
  [switch]$SkipProbeBuild,
  [switch]$SkipInstaller   # reuse the installer already in -OutDir (same key must still be in -KeyDir)
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')).Path
$allowed = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')
$payload = [IO.Path]::GetFullPath($PayloadDir).TrimEnd('\')
if ($payload -ne $allowed -and -not $payload.StartsWith($allowed + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "PayloadDir $payload is not under $allowed" }
$keyFull = [IO.Path]::GetFullPath($KeyDir).TrimEnd('\')
if ($keyFull.StartsWith($payload, [StringComparison]::OrdinalIgnoreCase) -or $keyFull.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw 'KeyDir must be outside the payload and outside the repo' }
if (-not (Test-Path (Join-Path $payload 'posctl.exe'))) { throw "No base payload at $payload. Run stage-payload.ps1 first (run-scenario.ps1 needs it)." }
$config = Get-Content (Join-Path $repo 'assistant-installer\assistant.config.json') -Raw | ConvertFrom-Json
foreach ($f in @($config.runtime.zip, $config.model.file)) { if (-not (Test-Path (Join-Path $Artifacts $f))) { throw "artifact $f is missing from $Artifacts" } }

$ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 turns native stderr into errors under 'Stop'
Push-Location $repo
try {
  if (-not $SkipProbeBuild) {
    # debug build of the example: the dependency graph is already built by the unit-test runs and a release build needs several GB more disk
    $env:TAURI_CONFIG = '{"bundle":{"resources":null}}'   # the build needs no bundle resources; env only, no file changes
    & cargo build --manifest-path src-tauri\Cargo.toml --example assistant_probe 2>&1 | Out-Host
    $cargoExit = $LASTEXITCODE
    Remove-Item Env:\TAURI_CONFIG -ErrorAction SilentlyContinue
    if ($cargoExit -ne 0) { throw 'cargo build --example assistant_probe failed' }
  }
  $probe = Join-Path $repo 'src-tauri\target\debug\examples\assistant_probe.exe'
  if (-not (Test-Path $probe)) { throw "probe not built: $probe" }

  $key = Join-Path $keyFull 'assistant-test.key'
  $installer = Join-Path $OutDir ('SupermarketPOSAssistant-{0}-{1}.exe' -f $config.version, $config.runtime.tag)
  if (-not $SkipInstaller) {
    if (Test-Path $keyFull) { Remove-Item $keyFull -Recurse -Force }
    New-Item -ItemType Directory -Force $keyFull | Out-Null
    $tauri = Join-Path $repo 'node_modules\@tauri-apps\cli\tauri.js'
    # a throwaway non-empty password: Windows cannot hold an empty environment variable, and `signer sign` would otherwise wait for a prompt
    $pw = [guid]::NewGuid().ToString('N')
    & node $tauri signer generate --ci -p $pw -w $key 2>&1 | Out-Null
    if (-not (Test-Path $key) -or -not (Test-Path "$key.pub")) { throw 'tauri signer generate did not write the throwaway key' }
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $key
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw
    try { & node (Join-Path $repo 'scripts\assistant-build-installer.mjs') --artifacts $Artifacts --out $OutDir --allow-candidate 2>&1 | Out-Host; $buildExit = $LASTEXITCODE }
    finally { Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue }
    if ($buildExit -ne 0) { throw 'assistant-build-installer.mjs failed' }
  }
  if (-not (Test-Path $installer)) { throw "installer not built: $installer" }
  if (-not (Test-Path "$key.pub")) { throw "public key missing: $key.pub" }
} finally { Pop-Location; $ErrorActionPreference = 'Stop' }

$dest = Join-Path $payload 'assistant'
New-Item -ItemType Directory -Force $dest | Out-Null
Get-ChildItem $dest -File -Force -ErrorAction SilentlyContinue | Remove-Item -Force   # only this folder's own generated files
Copy-Item $installer (Join-Path $dest 'installer.exe') -Force
Copy-Item $probe (Join-Path $dest 'assistant_probe.exe') -Force
Copy-Item "$key.pub" (Join-Path $dest 'test-pubkey.txt') -Force   # PUBLIC half only

# T-29-22: no private key in the payload (by name or by content marker)
$bad = @(Get-ChildItem $dest -Recurse -File | Where-Object {
    $_.Name -like '*.key' -or ($_.Length -lt 4096 -and ([IO.File]::ReadAllText($_.FullName) -match 'secret key'))
  })
if ($bad.Count -gt 0) { Remove-Item $dest -Recurse -Force; throw "refusing: private key material would be in the payload: $($bad.Name -join ', ')" }

$meta = [ordered]@{
  stagedAt = (Get-Date -Format o)
  commit = (& git -C $repo rev-parse HEAD).Trim()
  runtimeZip = $config.runtime.zip
  runtimeZipSha256 = (Get-FileHash (Join-Path $Artifacts $config.runtime.zip) -Algorithm SHA256).Hash.ToLower()
  modelFile = $config.model.file
  modelSha256 = (Get-FileHash (Join-Path $Artifacts $config.model.file) -Algorithm SHA256).Hash.ToLower()
  installerSha256 = (Get-FileHash (Join-Path $dest 'installer.exe') -Algorithm SHA256).Hash.ToLower()
  installerBytes = (Get-Item (Join-Path $dest 'installer.exe')).Length
  probeSha256 = (Get-FileHash (Join-Path $dest 'assistant_probe.exe') -Algorithm SHA256).Hash.ToLower()
}
$meta | ConvertTo-Json | Set-Content (Join-Path $dest 'staged.json') -Encoding UTF8
Write-Host "Assistant payload staged at $dest (installer $($meta.installerBytes) bytes, sha256 $($meta.installerSha256))"
