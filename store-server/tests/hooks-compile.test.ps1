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
  # B3: the role question is for a FRESH install only. PREINSTALL sets the flag, StoreRoleStep is guarded by it,
  # the uninstall hook forgets the StoreRoleAsked marker.
  function Get-Macro([string]$name) {
    $m = [regex]::Match($text, "(?s)!macro $name\b.*?!macroend")
    if (-not $m.Success) { throw "macro $name not found in hooks.nsh" }
    $m.Value
  }
  if ((Get-Macro 'NSIS_HOOK_PREINSTALL') -notmatch 'StrCpy \$StoreRoleUpgrade "1"') { throw 'B3: NSIS_HOOK_PREINSTALL does not set the upgrade flag' }
  if ((Get-Macro 'NSIS_HOOK_PREINSTALL') -notmatch 'FileExists\} "\$INSTDIR\\posctl"') { throw 'B3: the upgrade flag is not derived from an existing $INSTDIR\posctl' }
  if ((Get-Macro 'NSIS_HOOK_PREINSTALL') -notmatch 'ReadRegStr \$\w+ HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Supermarket POS" "UninstallString"') { throw 'B3: an install with no posctl folder (pre-posctl v1.11.x) is not detected as an upgrade through the uninstall registry key' }
  if ((Get-Macro 'StoreRoleStep') -notmatch '\$StoreRoleUpgrade != 1') { throw 'B3: StoreRoleStep is not guarded by the upgrade flag' }
  if ((Get-Macro 'NSIS_HOOK_POSTUNINSTALL') -notmatch 'DeleteRegValue HKLM "Software\\SupermarketPOS" "StoreRoleAsked"') { throw 'B3: the uninstall hook does not delete StoreRoleAsked' }
  Write-Host 'ok   B3: fresh-install flag set in PREINSTALL, StoreRoleStep guarded, StoreRoleAsked deleted on uninstall'
  if ($text -notmatch '!define BROKER_INSTALL_TIMEOUT_MS \d+') { throw 'hooks.nsh lost the BROKER_INSTALL_TIMEOUT_MS define' }
  if ($text -notmatch 'nsExec::ExecToStack /TIMEOUT=\$\{BROKER_INSTALL_TIMEOUT_MS\}') { throw 'broker install is not run with nsExec /TIMEOUT' }
  if ($text -match "BrokerStep\s+'[^']*broker\.exe`"\s+install'") { throw 'broker.exe install is run through the unbounded BrokerStep/ExecWait again' }
  Write-Host 'ok   broker install is bounded (timeout define, nsExec /TIMEOUT, no ExecWait)'
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
