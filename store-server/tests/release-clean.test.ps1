<#
.SYNOPSIS
  A release build of posctl contains no test hook (conventions 17.G). Builds it twice, with and without the
  `test-hooks` feature, and looks for the hook strings in both exes: absent from the first, present in the second
  (so the search itself is shown to work).
.PARAMETER Exe
  Check this already-built exe (the shipped artifact) instead of building the plain release exe. The hooked build
  that serves as the positive control is still built.
.DESCRIPTION
  Windows PowerShell 5.1 compatible. Uses separate target folders under %TEMP% so it never disturbs the normal
  build. It only builds and reads binaries: nothing is installed, no service, firewall rule or task is touched.
  Hook names are READ FROM THE SOURCE (every POSCTL_TEST_* name in non-test code under src\), so a hook added later is
  searched for without editing this file, and the list must equal what `posctl dev hook-env` prints in the hooked
  build: a hook missing from `packcmd::hook_env()` fails here.
#>
param([string]$Crate = (Join-Path $PSScriptRoot '..'), [string]$Exe = '')
$ErrorActionPreference = 'Continue'   # cargo writes progress to stderr; exit codes are checked explicitly
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('posctl-clean-' + [Guid]::NewGuid().ToString('N'))
$manifest = Join-Path $Crate 'Cargo.toml'

function Contains-Text([string]$Path, [string]$Needle) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $ascii = [Text.Encoding]::ASCII.GetString($bytes)
  return $ascii.Contains($Needle)
}

# Every hook name in non-test code: text before the first #[cfg(test...)] of each source file.
function Get-SourceHooks([string]$Crate) {
  $names = @{}
  foreach ($f in Get-ChildItem (Join-Path $Crate 'src') -Filter *.rs -Recurse) {
    $text = [IO.File]::ReadAllText($f.FullName)
    $m0 = [regex]::Match($text, '#\[cfg\((all\()?test\b')   # #[cfg(test)] and #[cfg(all(test, windows))]
    if ($m0.Success) { $text = $text.Substring(0, $m0.Index) }
    foreach ($m in [regex]::Matches($text, 'POSCTL_TEST_[A-Z0-9_]+')) { $names[$m.Value] = $true }
  }
  return @($names.Keys | Sort-Object)
}

# `posctl dev hook-env` must exit 0 and print the JSON envelope; returns the labels it lists.
function Get-HookLabels([string]$Exe, [ref]$Problems) {
  $text = (& $Exe dev hook-env) -join "`n"
  if ($LASTEXITCODE -ne 0) { $Problems.Value += "dev hook-env exited $LASTEXITCODE ($Exe)"; return @() }
  try { $obj = $text | ConvertFrom-Json } catch { $Problems.Value += "dev hook-env printed no JSON ($Exe): $text"; return @() }
  if (-not $obj.ok) { $Problems.Value += "dev hook-env reported ok=false ($Exe)"; return @() }
  return @($obj.data.labels | Where-Object { $_ })
}

try {
  $failures = @()
  $hooks = Get-SourceHooks $Crate
  if ($hooks.Count -eq 0) { $failures += 'no POSCTL_TEST_* hook name found in src (the source scan is blind)' }
  if ($Exe) {
    if (-not (Test-Path $Exe)) { throw "-Exe $Exe does not exist" }
    $plain = (Resolve-Path $Exe).Path
  } else {
    & cargo build --release --manifest-path $manifest --target-dir (Join-Path $tmp 'plain') 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'plain release build failed' }
    $plain = Join-Path $tmp 'plain\release\posctl.exe'
  }
  & cargo build --release --features test-hooks --manifest-path $manifest --target-dir (Join-Path $tmp 'hooked') 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'test-hooks release build failed' }
  $hooked = Join-Path $tmp 'hooked\release\posctl.exe'
  foreach ($h in $hooks) { if (Contains-Text $plain $h) { $failures += "the release exe contains '$h'" } }
  # negative control: the search must be able to find a hook that IS there
  foreach ($h in $hooks) { if (-not (Contains-Text $hooked $h)) { $failures += "negative control: the test-hooks build does not contain its own hook name '$h' (the search is blind)" } }
  # FR11: the SQL smoke command is a dev hook too; its strings must be in the hooked exe only
  foreach ($h in 'sql-smoke', 'pos_smoke_role', 'pos_smoke_next') {
    if (Contains-Text $plain $h) { $failures += "the release exe contains the SQL-smoke string '$h'" }
    if (-not (Contains-Text $hooked $h)) { $failures += "negative control: the test-hooks build does not contain the SQL-smoke string '$h' (the search is blind)" }
  }
  $plainLabels = Get-HookLabels $plain ([ref]$failures)
  if ($plainLabels.Count -ne 0) { $failures += "dev hook-env lists hooks in the release exe: $($plainLabels -join ',')" }
  $hookedLabels = Get-HookLabels $hooked ([ref]$failures)
  # the source and the listing must agree, both ways
  foreach ($h in $hooks) { if ($hookedLabels -notcontains $h) { $failures += "hook '$h' is in the source but not in hook_env()" } }
  foreach ($l in $hookedLabels) { if ($hooks -notcontains $l) { $failures += "hook_env() lists '$l', which no non-test source mentions" } }
  if ($failures.Count) { $failures | ForEach-Object { Write-Host "FAIL $_" -ForegroundColor Red }; exit 1 }
  Write-Host ('ok   the release exe has no test hook; the hooked build has all of: ' + ($hooks -join ', '))
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
