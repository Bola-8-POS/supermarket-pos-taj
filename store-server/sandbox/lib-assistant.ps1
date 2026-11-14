# lib-assistant.ps1 - shared helpers of Sandbox 120-123 (Plan 29-04, local assistant add-on). Dot-sourced by the scenarios
# AFTER lib.ps1 (the agent loads lib.ps1 first). Runs inside the Sandbox only (PowerShell 7, elevated).
# Processes: only PIDs this scenario started are ever stopped (Stop-ByPid refuses any other); never a kill by image name.
$script:AsstDir = 'C:\Program Files\Supermarket POS Assistant'
$script:AsstPay = 'C:\payload\assistant'
$script:AsstLocal = 'C:\assistant-test'   # local copies: an exe on the mapped (Intranet-zone) share draws a security prompt
$script:AsstProbe = Join-Path $script:AsstLocal 'assistant_probe.exe'
$script:AsstInstaller = Join-Path $script:AsstLocal 'installer.exe'
$script:AsstPubkey = Join-Path $script:AsstLocal 'test-pubkey.txt'
$script:AsstStarted = New-Object System.Collections.ArrayList
$script:AsstSeq = 0
$script:AsstBudget = 1000000000

# Copies the staged files to local disk and installs the VC++ runtime the way the POS installer does (the add-on needs it too).
function Initialize-AssistantEnv {
  New-Item -ItemType Directory -Force $script:AsstLocal | Out-Null
  foreach ($f in 'installer.exe', 'assistant_probe.exe', 'test-pubkey.txt') { Copy-Item (Join-Path $script:AsstPay $f) (Join-Path $script:AsstLocal $f) -Force }
  try { [void](Ensure-VcRuntime) } catch { Info 'FINDING env: VC++ runtime step could not run' $_.Exception.Message }
}

function Stop-ByPid([int]$ProcId) {
  if (-not $script:AsstStarted.Contains($ProcId)) { throw "refusing to stop pid ${ProcId}: this scenario did not start it" }
  Stop-Process -Id $ProcId -Force -ErrorAction SilentlyContinue
}
function Test-PidAlive([int]$ProcId) { [bool](Get-Process -Id $ProcId -ErrorAction SilentlyContinue) }

# `installer.exe /S`, waited for by PID. Returns @{ Exit; TimedOut }.
function Install-Assistant([int]$TimeoutMin = 20) {
  $p = Start-Process -FilePath $script:AsstInstaller -ArgumentList '/S' -PassThru -WindowStyle Hidden
  $null = $p.Handle   # keeps the exit code readable after exit
  [void]$script:AsstStarted.Add($p.Id)
  if (-not $p.WaitForExit($TimeoutMin * 60 * 1000)) { Stop-ByPid $p.Id; return @{ Exit = -1; TimedOut = $true } }
  $p.WaitForExit()
  return @{ Exit = $p.ExitCode; TimedOut = $false }
}

function Get-AssistantDirBytes([string]$Dir = $script:AsstDir) {
  [long](Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
}

# Starts the probe by path with stdout/stderr to files; waits for its first JSON line (or its exit). The probe PID is registered.
# Returns @{ Proc; Pid; Json; Out; Err }. Json is $null if no line appeared.
function Invoke-Probe([string[]]$ProbeArgs, [int]$WaitSec = 240) {
  $script:AsstSeq++
  $o = Join-Path $script:AsstLocal ('probe-{0:D2}.out.txt' -f $script:AsstSeq)
  $e = Join-Path $script:AsstLocal ('probe-{0:D2}.err.txt' -f $script:AsstSeq)
  $argLine = ($ProbeArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $p = Start-Process -FilePath $script:AsstProbe -ArgumentList $argLine -RedirectStandardOutput $o -RedirectStandardError $e -PassThru -WindowStyle Hidden
  $null = $p.Handle
  [void]$script:AsstStarted.Add($p.Id)
  $read = { if (Test-Path $o) { $t = (Get-Content -LiteralPath $o -Raw -ErrorAction SilentlyContinue); if ($t -and $t.Trim().StartsWith('{') -and $t.Contains("`n")) { return $t.Trim() } }; return $null }
  [void](Wait-Until { $p.Refresh(); ($null -ne (& $read)) -or $p.HasExited } $WaitSec 0.5)
  $text = & $read
  if (-not $text -and (Test-Path $o)) { $text = (Get-Content -LiteralPath $o -Raw -ErrorAction SilentlyContinue) }
  $json = $null
  try { if ($text) { $json = ($text.Trim() -split "`n")[0] | ConvertFrom-Json } } catch { }
  return @{ Proc = $p; Pid = $p.Id; Json = $json; Out = $o; Err = $e }
}
# `--verify-only` probe: a short run that must exit by itself.
function Invoke-ProbeVerify {
  $r = Invoke-Probe @('--install-dir', $script:AsstDir, '--pubkey-file', $script:AsstPubkey, '--verify-only') 300
  [void]$r.Proc.WaitForExit(60000)
  return $r
}

# ACEs on $Path that let Users / Everyone / Authenticated Users create, write, delete or change permissions. Empty = read-only for them.
function Get-UserWriteAces([string]$Path) {
  $bad = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000   # CreateFiles, AppendData, DeleteSubdirs, Delete, ChangePerms, TakeOwner, GenericAll, GenericWrite
  $sids = 'S-1-5-32-545', 'S-1-1-0', 'S-1-5-11'
  $out = @()
  foreach ($ace in (Get-Acl -LiteralPath $Path).Access) {
    if ($ace.AccessControlType -ne 'Allow') { continue }
    $sid = try { $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { '' }
    if ($sids -contains $sid -and (([int]$ace.FileSystemRights) -band $bad)) { $out += ('{0} {1}' -f $ace.IdentityReference, $ace.FileSystemRights) }
  }
  return $out
}

# Runs `cmd /c` as a real local standard user (the scenario-05 pattern) that tries to create a new file and to append to an existing one under $Dir.
# Returns 'CREATED'/'CREATE_DENIED' and 'APPENDED'/'APPEND_DENIED' as a hashtable. The user is created once per sandbox.
function Test-StandardUserWrite([string]$Dir, [string]$ExistingFile) {
  $user = 'asstuser'
  if (-not (Get-LocalUser -Name $user -ErrorAction SilentlyContinue)) { $script:AsstPw = 'Aa1!' + (New-RandomToken 18); New-StdUser $user $script:AsstPw }
  $cred = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $script:AsstPw -AsPlainText -Force))
  $work = 'C:\Users\Public\asst-w'; New-Item -ItemType Directory -Force $work | Out-Null
  & icacls.exe $work /grant 'Users:(OI)(CI)M' | Out-Null
  Remove-Item (Join-Path $work 'result.txt') -ErrorAction SilentlyContinue
  $newFile = Join-Path $Dir 'std-user-new.txt'
  $cmd = @(
    '@echo off',
    ('(echo x> "{0}") 2>nul && (echo CREATED> "{1}") || (echo CREATE_DENIED> "{1}")' -f $newFile, (Join-Path $work 'result.txt')),
    ('(echo x>> "{0}") 2>nul && (echo APPENDED>> "{1}") || (echo APPEND_DENIED>> "{1}")' -f $ExistingFile, (Join-Path $work 'result.txt'))
  )
  Set-Content (Join-Path $work 'run.cmd') $cmd -Encoding ASCII
  $pr = Start-Process cmd.exe -ArgumentList '/c', (Join-Path $work 'run.cmd') -Credential $cred -LoadUserProfile -WorkingDirectory $work -Wait -PassThru -WindowStyle Hidden
  $text = if (Test-Path (Join-Path $work 'result.txt')) { Get-Content (Join-Path $work 'result.txt') -Raw } else { '' }
  Remove-Item $newFile -Force -ErrorAction SilentlyContinue
  return @{ Create = $(if ($text -match 'CREATED') { 'CREATED' } else { 'CREATE_DENIED' }); Append = $(if ($text -match 'APPENDED') { 'APPENDED' } else { 'APPEND_DENIED' }); Exit = $pr.ExitCode; Raw = $text.Trim() }
}

# Flips ONE byte in the middle of $Path in place (admin); returns the offset.
function Edit-OneByte([string]$Path) {
  $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $off = [long]($fs.Length / 2)
    $fs.Position = $off
    $b = $fs.ReadByte()
    $fs.Position = $off
    $fs.WriteByte([byte]($b -bxor 0xFF))
    return $off
  } finally { $fs.Dispose() }
}

# ---- Plan 29-04 Task 2: listener, HTTP, Job helpers (scenarios 121-123) ------------------------------------------------------
# Listener rows of one process, read directly (L103): @{ Addr; Port }.
function Get-ListenerRows([int]$ProcId) {
  @(Get-NetTCPConnection -State Listen -OwningProcess $ProcId -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Addr = [string]$_.LocalAddress; Port = [int]$_.LocalPort } })
}
# True only when the process listens (at least one row) and every row is 127.0.0.1 (the app binds IPv4 loopback only).
function Test-LoopbackOnly($Rows) { (@($Rows).Count -gt 0) -and (@($Rows | Where-Object { $_.Addr -ne '127.0.0.1' }).Count -eq 0) }

# One HTTP call, no proxy, no exception on 4xx/5xx. Returns the status code, or 0 when the connection failed.
function Get-AssistantHttp([string]$Method, [string]$Uri, [hashtable]$Headers = @{}, [string]$Body = $null, [int]$TimeoutSec = 120) {
  try {
    $a = @{ Uri = $Uri; Method = $Method; Headers = $Headers; SkipHttpErrorCheck = $true; NoProxy = $true; TimeoutSec = $TimeoutSec }
    if ($Body) { $a.Body = $Body; $a.ContentType = 'application/json' }
    return [int](Invoke-WebRequest @a).StatusCode
  } catch { return 0 }
}
# A one-token completion: 401 without the right Bearer key, 200 with it.
function Get-CompletionCode([int]$Port, [string]$Key = $null) {
  $h = @{}
  if ($Key) { $h['Authorization'] = "Bearer $Key" }
  Get-AssistantHttp 'POST' "http://127.0.0.1:$Port/v1/chat/completions" $h '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1,"temperature":0}'
}

Add-Type -ErrorAction SilentlyContinue -Namespace AsstWin -Name Job -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(System.IntPtr process, System.IntPtr job, out bool result);'
function Test-ProcessInAnyJob([int]$ProcId) {
  $p = Get-Process -Id $ProcId -ErrorAction Stop
  $r = $false
  [void][AsstWin.Job]::IsProcessInJob($p.Handle, [IntPtr]::Zero, [ref]$r)
  return $r
}

function Get-ProcessCommandLine([int]$ProcId) { [string](Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue).CommandLine }

# Every assistant file/key the installer owns is gone (used by 123, including its red-once run while still installed).
function Test-AssistantRemoved {
  (-not (Test-Path -LiteralPath $script:AsstDir)) -and (-not (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SupermarketPOSAssistant'))
}
