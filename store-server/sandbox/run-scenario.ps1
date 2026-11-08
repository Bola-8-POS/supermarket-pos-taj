<#
.SYNOPSIS
  Host side of the Windows Sandbox runner (conventions section 13). Runs one scenario in a fresh
  sandbox and exits non-zero if any check failed.
.DESCRIPTION
  Windows PowerShell 5.1 compatible. Stage the payload first (stage-payload.ps1). One sandbox at a time:
  the script refuses to start while any Windows Sandbox process exists. The sandbox runs agent.ps1 at
  logon; the agent runs the scenario, writes C:\out\result.json (array of { id, expected, actual, pass })
  and then C:\out\done.flag. This script waits for the flag, prints the table and closes ONLY the sandbox
  processes that did not exist before it launched (by process id, never by image name).
  The host is never provisioned: nothing here touches ProgramData, Program Files, services or the registry.
.EXAMPLE
  powershell -NoProfile -File store-server\sandbox\run-scenario.ps1 -Id 20
#>
param(
  [Parameter(Mandatory)][string]$Id,
  [string]$PayloadDir = 'E:\tmp\two-mode-sandbox\payload',
  [string]$RunsRoot = 'E:\tmp\two-mode-sandbox',
  [string]$PwshDir = 'C:\Program Files\PowerShell\7',
  [int]$TimeoutMinutes = 40,
  [ValidateSet('off','on')][string]$FirewallNotify = 'off'   # 'on' leaves the firewall allow-access dialog enabled in the guest
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib-mem.ps1')

# A row a scenario only RECORDS (lib-backup.ps1 Info: `info` = true, `pass` = null) is shown as INFO and is neither a PASS nor a FAIL. Every other row keeps its meaning.
function Get-RowWord($r) { if ($r.info -eq $true) { return 'INFO' } elseif ($r.pass) { return 'PASS' } else { return 'FAIL' } }

function Get-SandboxProcs { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'WindowsSandbox*' -or $_.ProcessName -like 'vmmemWindowsSandbox*' }) }

# Best effort, never changes the outcome: one PNG of the Sandbox client window (screen copy of its rectangle; no click, no input).
function Save-SandboxWindowPng([string]$Path) {
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -Namespace Win -Name Rect -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; } [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out R r);' -ErrorAction SilentlyContinue
    $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'WindowsSandbox*' -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
    if (-not $p) { Write-Host 'stall: no Sandbox window to capture'; return }
    $r = New-Object Win.Rect+R
    if (-not [Win.Rect]::GetWindowRect($p.MainWindowHandle, [ref]$r)) { Write-Host 'stall: GetWindowRect failed'; return }
    $w = $r.Rt - $r.L; $h = $r.B - $r.T
    if ($w -le 0 -or $h -le 0) { Write-Host 'stall: Sandbox window is minimised or empty'; return }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    try { $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $g.Dispose(); $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
  } catch { Write-Host ('stall: window screenshot failed: ' + $_.Exception.Message) }
}

if ((Get-SandboxProcs).Count -gt 0) { throw 'A Windows Sandbox is already running: one at a time. Close it first.' }
if (-not (Test-Path (Join-Path $PayloadDir 'posctl.exe'))) { throw "No payload at $PayloadDir. Run stage-payload.ps1 first." }
if (-not (Test-Path (Join-Path $PwshDir 'pwsh.exe'))) { throw "PowerShell 7 not found at $PwshDir (the sandbox agent uses it; the product never does)." }

$all = Get-Content (Join-Path $here 'scenarios.json') -Raw | ConvertFrom-Json
$scenario = $all | Where-Object { $_.id -eq $Id }
if (-not $scenario) { throw "No scenario '$Id' in scenarios.json." }
if (-not (Test-Path (Join-Path $here $scenario.file))) { throw "Scenario file $($scenario.file) is missing." }
# a long scenario (kill matrices, reboots) declares its own limit in scenarios.json unless -TimeoutMinutes was given
if (-not $PSBoundParameters.ContainsKey('TimeoutMinutes') -and $scenario.timeoutMinutes) { $TimeoutMinutes = [int]$scenario.timeoutMinutes }

$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$Id"
$run = Join-Path $RunsRoot $runId
$out = Join-Path $run 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$scenario | Add-Member -NotePropertyName firewallNotify -NotePropertyValue $FirewallNotify -Force -PassThru | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $out 'request.json') -Encoding UTF8

$wsb = (Get-Content (Join-Path $here 'scenario.wsb.template') -Raw).
  Replace('@@PAYLOAD@@', $PayloadDir).Replace('@@SCENARIOS@@', $here).Replace('@@OUT@@', $out).Replace('@@PWSH@@', $PwshDir)
$wsbPath = Join-Path $run 'scenario.wsb'
Set-Content $wsbPath $wsb -Encoding UTF8

Write-Host "Starting sandbox for scenario $Id ($($scenario.file)); results in $out"
$launched = Get-Date
$launcher = Start-Process -FilePath "$env:windir\System32\WindowsSandbox.exe" -ArgumentList "`"$wsbPath`"" -PassThru
$deadline = $launched.AddMinutes($TimeoutMinutes)
$flag = Join-Path $out 'done.flag'
$seen = 0
# host memory sampler: read-only, inline in this wait loop every 30 s, never fails the run (a failure is a note row or note file)
$hostMem = Join-Path $run 'host-mem.csv'
$memState = @{ Low = [int]::MaxValue }
$nextMem = Get-Date
try { Set-Content $hostMem (Get-MemHeader 'host') -Encoding UTF8 } catch { $hostMem = $null }
$everSawSandbox = $false
$gone = 0
while (-not (Test-Path $flag)) {
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Seconds 5
  if ($hostMem -and (Get-Date) -ge $nextMem) {
    $nextMem = (Get-Date).AddSeconds(30)
    try { Add-Content $hostMem (New-HostMemRow { Get-MemSample } $memState) } catch { try { Set-Content (Join-Path $run 'mem-sampler-note.txt') $_.Exception.Message } catch { } }
  }
  $n = (Get-SandboxProcs).Count
  if ($n -gt 0) { $everSawSandbox = $true; $gone = 0 } elseif ($everSawSandbox) { $gone++ }
  if ($gone -ge 36) { break }   # sandbox gone for 3 minutes: closed by hand (a guest reboot takes up to a minute or two)
  # stall: the guest rebooted and then went silent (agent.log and mem.csv both untouched for 5 minutes): stop waiting, keep evidence
  try {
    $agentLog = Join-Path $out 'agent.log'; $memCsv = Join-Path $out 'mem.csv'
    if ((Test-Path $agentLog) -and (Test-Path $memCsv)) {
      $now = Get-Date
      $last = Get-Content $agentLog -Tail 1
      $logAge = $now - (Get-Item $agentLog).LastWriteTime; $memAge = $now - (Get-Item $memCsv).LastWriteTime
      if (Test-RebootStall $last $logAge $memAge) {
        $diag = @("runId: $runId", "last agent.log line: $last", ('agent.log age (min): {0:N1}' -f $logAge.TotalMinutes), ('mem.csv age (min): {0:N1}' -f $memAge.TotalMinutes), ('detected: ' + $now.ToString('yyyy-MM-dd HH:mm:ss')))
        Set-Content (Join-Path $out 'stall-diagnostic.txt') $diag -Encoding UTF8
        Write-Host "STALL: guest silent after its reboot line for 5+ minutes; not waiting any longer (stall-diagnostic.txt)" -ForegroundColor Red
        Save-SandboxWindowPng (Join-Path $out 'stall-window.png')
        break
      }
    }
  } catch { Write-Host ('stall check failed: ' + $_.Exception.Message) }
  $checks = Join-Path $out 'checks.jsonl'
  if (Test-Path $checks) {
    $lines = @(Get-Content $checks)
    if ($lines.Count -gt $seen) {
      for ($i = $seen; $i -lt $lines.Count; $i++) { $c = $lines[$i] | ConvertFrom-Json; Write-Host ('  {0,-4} {1}' -f (Get-RowWord $c), $c.id) }
      $seen = $lines.Count
    }
  }
}
$finished = Test-Path $flag

# Close the sandbox. The agent shuts the guest down itself after done.flag, which closes the sandbox cleanly (a
# force-killed client leaves an orphan VM that only an administrator can remove). Wait for that first; only if the
# sandbox is still there after 2 minutes, close it by PID, and only processes that did not exist before the launch
# (checked at the top: none did).
for ($i = 0; $finished -and $i -lt 24 -and (Get-Process -Name 'vmmemWindowsSandbox' -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 5 }
$mine = @(Get-SandboxProcs | Where-Object { $_.ProcessName -like 'WindowsSandbox*' -and $_.StartTime -ge $launched.AddSeconds(-5) })
if ($mine.Count -gt 0) {
  $vmGone = -not (Get-Process -Name 'vmmemWindowsSandbox' -ErrorAction SilentlyContinue)
  Write-Host ("Closing the sandbox client window, pids {0} (VM already stopped: {1})" -f ($mine.Id -join ','), $vmGone)
  foreach ($p in $mine) { try { [void]$p.CloseMainWindow() } catch { } }
  Start-Sleep -Seconds 5
  foreach ($p in $mine) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
}

if (-not $finished) {
  Write-Host "NO done.flag (timeout or sandbox closed). Evidence: $out" -ForegroundColor Red
  $checks = Join-Path $out 'checks.jsonl'
  if (Test-Path $checks) { Get-Content $checks | ForEach-Object { $c = $_ | ConvertFrom-Json; Write-Host ('  {0,-4} {1} expected={2} actual={3}' -f (Get-RowWord $c), $c.id, $c.expected, $c.actual) } }
  exit 2
}
$results = @(Get-Content (Join-Path $out 'result.json') -Raw | ConvertFrom-Json | ForEach-Object { $_ })   # 5.1 does not enumerate a JSON array by itself
$lines = $results | ForEach-Object { '{0,-4} {1,-62} expected={2} actual={3}' -f (Get-RowWord $_), $_.id, $_.expected, $_.actual }
$lines | Write-Host
$real = @($results | Where-Object { $_.info -ne $true })
$info = @($results | Where-Object { $_.info -eq $true })
$failed = @($real | Where-Object { -not $_.pass })
$summary = "{0} checks, {1} failed. Evidence: {2}" -f $real.Count, $failed.Count, $out
if ($info.Count -gt 0) { $summary = "{0} checks, {1} failed, {2} recorded as INFO (not counted). Evidence: {3}" -f $real.Count, $failed.Count, $info.Count, $out }
Write-Host $summary
(@($lines) + $summary) | Set-Content (Join-Path $run 'summary.txt') -Encoding UTF8
if ($failed.Count -gt 0 -or $real.Count -eq 0) { exit 1 }
exit 0
