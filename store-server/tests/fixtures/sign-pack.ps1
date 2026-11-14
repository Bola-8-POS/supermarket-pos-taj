<#
.SYNOPSIS
  Signs a pack folder's manifest.json with a THROWAWAY minisign key and zips it as a .pospack. Windows PowerShell 5.1 compatible.
.DESCRIPTION
  Generates a key with `npx tauri signer generate` in a temp folder, signs <PackDir>\manifest.json, zips the folder (any existing
  manifest.json.minisig is replaced by the new signature) and writes ONLY the public key next to it. The private key never leaves the
  temp folder and is deleted. Used by make-pack-fixture.ps1 and by the Windows Sandbox runner (stage-payload.ps1) to turn the
  unsigned test pack into one posctl built with `--features test-hooks` accepts via POSCTL_TEST_UPDATER_PUBKEY.
  Example:  powershell -NoProfile -File sign-pack.ps1 -PackDir D:\x\pack-0.0.0-r1 -OutZip D:\x\pack-ok.pospack -OutPub D:\x\signer.pub
#>
param(
  [Parameter(Mandatory)][string]$PackDir,
  [Parameter(Mandatory)][string]$OutZip,
  [Parameter(Mandatory)][string]$OutPub,
  [string]$RepoRoot = '',
  [string]$KeyDir = ''   # reuse (or create, and keep) the throwaway key in this folder so several packs share one public key; the caller deletes it
)
$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }  # computed here: $PSScriptRoot was empty inside the param default when run through -File
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$PackDir = (Resolve-Path $PackDir).Path.TrimEnd('\')
$work = Join-Path ([IO.Path]::GetTempPath()) ("posctl-sign-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
try {
  # An empty password argument is dropped by Windows PowerShell 5.1 when calling a native command, so the
  # signer is run from a one-line .cmd file where `-p ""` reaches it intact.
  function Invoke-Signer([string]$Line) {
    $cmd = Join-Path $work 'signer.cmd'
    Set-Content -Path $cmd -Value ("@echo off`r`ncd /d `"$RepoRoot`"`r`ncall " + $Line) -Encoding ASCII
    & $cmd | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tauri signer failed: $Line" }
  }
  $keyHome = $work
  if ($KeyDir) { New-Item -ItemType Directory -Force $KeyDir | Out-Null; $keyHome = (Resolve-Path $KeyDir).Path.TrimEnd('\') }
  if (-not (Test-Path "$keyHome\signer.key")) { Invoke-Signer "npx tauri signer generate --ci -w `"$keyHome\signer.key`" -p `"`"" }
  # sign a copy: the signer writes <file>.sig next to its input and PackDir may be read-only (the sandbox payload is)
  Copy-Item "$PackDir\manifest.json" "$work\manifest.json"
  Invoke-Signer "npx tauri signer sign -f `"$keyHome\signer.key`" -p `"`" `"$work\manifest.json`""
  Copy-Item "$keyHome\signer.key.pub" $OutPub -Force
  if (Test-Path $OutZip) { Remove-Item $OutZip }
  $zip = [IO.Compression.ZipFile]::Open($OutZip, 'Create')
  try {
    foreach ($f in Get-ChildItem $PackDir -Recurse -File) {
      $rel = $f.FullName.Substring($PackDir.Length + 1).Replace('\', '/')
      if ($rel -eq 'manifest.json.minisig') { continue }
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [IO.Compression.CompressionLevel]::Fastest)
    }
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$work\manifest.json.sig", 'manifest.json.minisig', [IO.Compression.CompressionLevel]::Fastest)
  } finally { $zip.Dispose() }
  Write-Host "wrote $OutZip and $OutPub"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
