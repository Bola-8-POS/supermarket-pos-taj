# 122 - the child runs under the Job Object and dies with its parent (Plan 29-04, ASSIST-10).
# Limits are read back by the probe through QueryInformationJobObject (what the OS holds, not what was asked) and compared with the
# INSTALLED manifest's profile; the below-normal priority and Job membership are also read independently from the OS here.
# Red once: --test-skip-job leaves the child outside any Job, and it must SURVIVE its parent being stopped (so the kill row is not vacuous).
. C:\scenarios\lib-assistant.ps1

function Start-AssistantProbe([string[]]$Extra) {
  Invoke-Probe (@('--install-dir', $script:AsstDir, '--pubkey-file', $script:AsstPubkey, '--hold-seconds', '900') + $Extra) 240
}

function Invoke-Scenario([int]$Phase) {
  Initialize-AssistantEnv
  $i = Install-Assistant
  Check-Equal '122 setup: installer.exe /S exits 0' 0 $i.Exit
  if ($i.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }
  $prof = (Get-Content (Join-Path $script:AsstDir 'manifest.json') -Raw | ConvertFrom-Json).profile

  $r = Start-AssistantProbe @()
  $j = $r.Json
  Save-Evidence 'probe-start' ((Get-Content $r.Out -Raw -ErrorAction SilentlyContinue) + (Get-Content $r.Err -Raw -ErrorAction SilentlyContinue))
  Check-True '122 the probe verified and started llama-server (json ok, jobLimits present)' ($j -and $j.ok -eq $true -and $j.jobLimits) $(if ($j) { "reason=$($j.reason)" } else { 'no json' })
  if (-not ($j -and $j.ok -eq $true -and $j.jobLimits)) { Stop-ByPid $r.Pid; return @{ Results = (Get-Results); Reboot = $false } }
  $childPid = [int]$j.childPid; [void]$script:AsstStarted.Add($childPid)
  $jl = $j.jobLimits

  Check-True '122 the OS reports kill-on-job-close for the Job' ($jl.killOnClose -eq $true) "killOnClose=$($jl.killOnClose)"
  $wantCpu = [int]$prof.cpu_rate_percent * 100
  Add-Check '122 the OS reports the CPU hard cap = manifest cpu_rate_percent * 100' $wantCpu $jl.cpuRateHardCap ([int]$jl.cpuRateHardCap -eq $wantCpu)
  # the OS stores the memory limit rounded down to a 4 KiB page
  $wantMem = [long]$prof.process_memory_limit_bytes; $gotMem = [long]$jl.memoryLimitBytes
  Add-Check '122 the OS reports the process memory limit = manifest value (page-rounded down)' "$wantMem (minus < 4096)" $gotMem (($wantMem - $gotMem) -ge 0 -and ($wantMem - $gotMem) -lt 4096)
  Add-Check '122 the OS reports BELOW_NORMAL as the Job priority class' 'BELOW_NORMAL' $jl.priorityClass ($jl.priorityClass -eq 'BELOW_NORMAL')
  $cp = (Get-Process -Id $childPid).PriorityClass
  Add-Check '122 independently: the child process priority class is BelowNormal' 'BelowNormal' $cp ([string]$cp -eq 'BelowNormal')
  Check-True '122 independently: IsProcessInJob says the child is in a Job' (Test-ProcessInAnyJob $childPid) ''
  Check-True '122 the child is alive before its parent is stopped' (Test-PidAlive $childPid) ''

  # parent dies -> the Job handle closes -> the child is killed
  Stop-ByPid $r.Pid
  $gone = Wait-Until { -not (Test-PidAlive $childPid) } 5 0.25
  Check-True '122 the child is gone within 5 s of the parent being stopped' $gone ''
  if (-not $gone -and (Test-PidAlive $childPid)) { Stop-ByPid $childPid }

  # red once: without the Job the child survives its parent
  $r2 = Start-AssistantProbe @('--test-skip-job')
  Check-True '122 red setup: the probe with --test-skip-job started and reports no Job limits' ($r2.Json -and $r2.Json.ok -eq $true -and -not $r2.Json.jobLimits) $(if ($r2.Json) { "reason=$($r2.Json.reason)" } else { 'no json' })
  if ($r2.Json -and $r2.Json.ok -eq $true) {
    $c2 = [int]$r2.Json.childPid; [void]$script:AsstStarted.Add($c2)
    Stop-ByPid $r2.Pid
    Start-Sleep -Seconds 5
    Check-True '122 red once: with no Job the child SURVIVES the parent being stopped (the kill row detects containment)' (Test-PidAlive $c2) ''
    Stop-ByPid $c2
  } else { Stop-ByPid $r2.Pid }
  return @{ Results = (Get-Results); Reboot = $false }
}
