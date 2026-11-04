<#
.SYNOPSIS
  Compiles windows/hooks.nsh with the NSIS that Tauri downloads, expanding every hook macro once, and proves
  the check can fail (a copy with one ${EndIf} removed must NOT compile).
.DESCRIPTION
  Windows PowerShell 5.1 compatible. NSIS is %LOCALAPPDATA%\tauri\NSIS (present after any `tauri build`);
  override with -MakeNsis. Nothing is installed or executed: the harness only compiles.
#>
param(
  [string]$Hooks = (Join-Path $PSScriptRoot '..\..\windows\hooks.nsh'),
  [string]$MakeNsis = (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\Bin\makensis.exe')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $MakeNsis)) { throw "makensis not found at $MakeNsis. Run a `tauri build` once (it downloads NSIS) or pass -MakeNsis." }
$work = Join-Path ([IO.Path]::GetTempPath()) ('hooks-compile-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
try {
  Copy-Item (Join-Path $PSScriptRoot 'hooks-compile.nsi') $work
  Copy-Item $Hooks (Join-Path $work 'hooks.nsh')
  Push-Location $work
  $out = & $MakeNsis /V2 '/DHOOKS_NSH=hooks.nsh' hooks-compile.nsi 2>&1
  $good = $LASTEXITCODE
  if ($good -ne 0) { $out | Write-Host; throw "hooks.nsh does not compile (exit $good)" }
  Write-Host 'ok   hooks.nsh compiles with every hook macro expanded'

  $text = Get-Content 'hooks.nsh' -Raw
  $i = $text.LastIndexOf('${EndIf}')
  Set-Content 'hooks-broken.nsh' $text.Remove($i, 8) -Encoding ASCII
  $ErrorActionPreference = 'Continue'   # makensis reports the expected error on stderr
  $null = & $MakeNsis /V1 '/DHOOKS_NSH=hooks-broken.nsh' hooks-compile.nsi 2>&1
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -eq 0) { throw 'negative control failed: a hooks file with an unbalanced ${If} compiled' }
  Write-Host 'ok   negative control: an unbalanced ${If} is rejected'
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
