# Runs INSIDE the Windows Sandbox (PowerShell 7 from the host, mapped read-only at C:\pwsh7).
# Reads C:\out\request.json, dot-sources lib.ps1 and the scenario file, runs Invoke-Scenario and writes
# C:\out\result.json (array of { id, expected, actual, pass }) and then C:\out\done.flag.
# A scenario that needs a reboot returns Reboot = $true; the agent stores the next phase in C:\out\state.json,
# reboots, and is started again by the logon command. Earlier phases' results accumulate in results-partial.json.
$ErrorActionPreference = 'Stop'
$out = 'C:\out'
$log = Join-Path $out 'agent.log'
function Log($m) { Add-Content $log ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $m) }

# ---- sandbox-only test-agent setup: no permission prompts (unattended runs) ----------------------------------------
# Runs only inside this disposable sandbox at logon, before any payload exe starts. The product never relies on any of it:
# a real customer PC keeps the normal installer / UAC / SmartScreen flow (the signed installer is Plan 13's job).
try {
  $sys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'   # UAC: elevate silently, no secure-desktop consent
  Set-ItemProperty $sys ConsentPromptBehaviorAdmin 0 -Type DWord
  Set-ItemProperty $sys PromptOnSecureDesktop 0 -Type DWord
  # "Open File - Security Warning" for exes launched from the mapped (Intranet-zone) C:\payload: no zone prompt for exe/ps1
  $att = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Attachments'
  New-Item $att -Force | Out-Null
  Set-ItemProperty $att SaveZoneInformation 1 -Type DWord
  $asc = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Associations'
  New-Item $asc -Force | Out-Null
  Set-ItemProperty $asc LowRiskFileTypes '.exe;.msi;.ps1;.bat;.cmd' -Type String
  [Environment]::SetEnvironmentVariable('SEE_MASK_NOZONECHECKS', '1', 'Process')   # inherited by every child the agent starts
  $ss = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'                    # SmartScreen "Windows protected your PC"
  New-Item $ss -Force | Out-Null
  Set-ItemProperty $ss EnableSmartScreen 0 -Type DWord
} catch { Add-Content $log ("no-prompt setup failed: " + $_.Exception.Message) }

# ---- guest memory sampler: a background job, every 30 s into C:\out\mem.csv. Never fails or blocks the run. --------------
# A reboot phase ends the job with the guest; each phase starts a new one and appends to the same file.
$memJob = $null
try {
  $memJob = Start-Job -ArgumentList $out -ScriptBlock {
    param($o)
    $csv = Join-Path $o 'mem.csv'
    try {
      . 'C:\scenarios\lib-mem.ps1'
      if (-not (Test-Path $csv)) { Add-Content $csv (Get-MemHeader 'guest') }
      while ($true) {
        try { Add-Content $csv (New-GuestMemRow { Get-MemSample }) } catch { Add-Content (Join-Path $o 'mem-sampler-note.txt') ("write failed: " + $_.Exception.Message) }
        Start-Sleep -Seconds 30
      }
    } catch { Add-Content (Join-Path $o 'mem-sampler-note.txt') ("sampler stopped: " + $_.Exception.Message) }
  }
} catch { try { Add-Content (Join-Path $out 'mem-sampler-note.txt') ("sampler could not start: " + $_.Exception.Message) } catch { } }
function Stop-MemSampler { if ($memJob) { try { Stop-Job $memJob -ErrorAction SilentlyContinue; Remove-Job $memJob -Force -ErrorAction SilentlyContinue } catch { } } }

$allResults = @()
try {
  Log ("agent start, user=" + [Security.Principal.WindowsIdentity]::GetCurrent().Name + ", pwsh " + $PSVersionTable.PSVersion)
  $req = Get-Content (Join-Path $out 'request.json') -Raw | ConvertFrom-Json
  $statePath = Join-Path $out 'state.json'
  $phase = 1
  if (Test-Path $statePath) { $phase = [int]((Get-Content $statePath -Raw | ConvertFrom-Json).phase) }
  $partialPath = Join-Path $out 'results-partial.json'
  if (Test-Path $partialPath) { $allResults = @(Get-Content $partialPath -Raw | ConvertFrom-Json) }

  # test-agent setup, sandbox only (the product must not rely on it): no Windows Defender Firewall "allow access" dialog,
  # so runs are unattended. The request can leave notifications ON (firewallNotify = on) to prove posctl raises none.
  if ($req.firewallNotify -ne 'on') { & "$env:windir\System32\netsh.exe" advfirewall set allprofiles settings inboundusernotification disable | Out-Null }
  . 'C:\scenarios\lib.ps1'
  . (Join-Path 'C:\scenarios' $req.file)
  Log "running scenario $($req.id) phase $phase"
  $r = Invoke-Scenario -Phase $phase
  if (Get-Command Save-JournalArchive -ErrorAction SilentlyContinue) { try { Save-JournalArchive } catch { } }   # update scenarios only (lib-update.ps1): keep the archived journals
  $allResults += @($r.Results)
  if ($r.Reboot) {
    ConvertTo-Json -InputObject @($allResults) -Depth 6 | Set-Content $partialPath -Encoding UTF8
    @{ phase = $phase + 1 } | ConvertTo-Json | Set-Content $statePath -Encoding UTF8
    Log 'rebooting for the next phase'
    Stop-MemSampler
    Restart-Computer -Force
    exit 0
  }
} catch {
  Log ("scenario crashed: " + $_.Exception.Message + " at " + $_.ScriptStackTrace)
  try { $allResults = @($allResults) + @(Get-Results) } catch { }
  # FR14 (D): a crash used to lose the journal, update-result.json and the ops logs (run 3, scenario 70). Whatever the scenario had when it died goes to evidence\crash.
  try { Save-DataEvidence 'crash' } catch { }
  $allResults = @($allResults) + @([pscustomobject]@{ id = 'agent: scenario crashed'; expected = 'no exception'; actual = ($_.Exception.Message + ' @ ' + ($_.ScriptStackTrace -split "`n")[0]); pass = $false })
}
Stop-MemSampler
ConvertTo-Json -InputObject @($allResults) -Depth 6 | Set-Content (Join-Path $out 'result.json') -Encoding UTF8
# Every run (not only a crash): posctl logs to out\ so the evidence holds the last tick line. After result.json so it can never block it; /R:0 /W:0 because robocopy's default is a million 30 s retries on a sharing violation; failure is non-fatal.
try { $pl = 'C:\ProgramData\SupermarketPOS\logs\posctl'; if (Test-Path $pl) { & robocopy $pl (Join-Path $out 'posctl-logs') /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null } } catch { }
Set-Content (Join-Path $out 'done.flag') (Get-Date -Format o)
Log 'done; shutting the sandbox down (a clean guest shutdown closes the sandbox; the host never has to kill it)'
Start-Sleep -Seconds 3
& "$env:windir\System32\shutdown.exe" /s /t 3 /f
