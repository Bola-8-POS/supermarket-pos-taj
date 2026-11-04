# Memory-sampler row formatting, shared by the guest sampler (agent.ps1, pwsh 7) and the host sampler (run-scenario.ps1, 5.1).
# Pure: a sample source is a scriptblock returning { FreeMB; CommitMB; Procs (Name, WorkingSet64) }. A source that throws
# yields a note row, never an exception: a sampler must not fail a run. Names only, no PIDs, nothing is ever stopped.
function Get-MemHeader([string]$Kind) { if ($Kind -eq 'guest') { 'utc,freeMB,commitMB,top5' } else { 'utc,freeMB,top5' } }

function Format-TopProcs($Procs) {
  $top = @($Procs | Sort-Object WorkingSet64 -Descending | Select-Object -First 5)
  (@($top | ForEach-Object { '{0}:{1}' -f ($_.Name -replace '[,;:\r\n]', '_'), [int][math]::Round($_.WorkingSet64 / 1MB) }) -join ';')
}

function Format-MemRow([string]$Kind, [string]$Utc, $FreeMB, $CommitMB, [string]$Top5) {
  if ($Kind -eq 'guest') { "$Utc,$FreeMB,$CommitMB,$Top5" } else { "$Utc,$FreeMB,$Top5" }
}

function Format-MemNoteRow([string]$Kind, [string]$Utc, $Err) {
  $m = ('' + $Err) -replace '[,\r\n]', ';'
  if ($Kind -eq 'guest') { "$Utc,,,ERROR $m" } else { "$Utc,,ERROR $m" }
}

function New-GuestMemRow([scriptblock]$Sample) {
  $utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  try { $s = & $Sample; Format-MemRow 'guest' $utc $s.FreeMB $s.CommitMB (Format-TopProcs $s.Procs) }
  catch { Format-MemNoteRow 'guest' $utc $_.Exception.Message }
}

# $State = @{ Low = [int]::MaxValue }: top5 only when freeMB < 6144 AND a new low for the run.
function New-HostMemRow([scriptblock]$Sample, [hashtable]$State) {
  $utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  try {
    $s = & $Sample
    $free = [int]$s.FreeMB
    $top = ''
    if ($free -lt 6144 -and $free -lt $State.Low) { $top = Format-TopProcs $s.Procs }
    if ($free -lt $State.Low) { $State.Low = $free }
    Format-MemRow 'host' $utc $free $null $top
  } catch { Format-MemNoteRow 'host' $utc $_.Exception.Message }
}

# Real sample source (OS counters); only the samplers call it, the host test never does.
function Get-MemSample {
  $os = Get-CimInstance Win32_OperatingSystem
  $commit = $null
  try { $commit = [int][math]::Round((Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).CommittedBytes / 1MB) } catch { }
  [pscustomobject]@{ FreeMB = [int][math]::Round($os.FreePhysicalMemory / 1024); CommitMB = $commit; Procs = @(Get-Process -ErrorAction SilentlyContinue) }
}
