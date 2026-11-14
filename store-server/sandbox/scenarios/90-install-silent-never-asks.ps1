# 90 - the installer's store-role question (windows/hooks.nsh StoreRoleStep, Plan 11a) is never asked, and nothing is provisioned,
# by a silent install or by a passive updater-style reinstall.
# Needs the real NSIS installer staged in the payload: copy src-tauri\target\release\bundle\nsis\*-setup.exe to <payload>\installer\
# (the runner maps the payload folder to C:\payload). Without it the scenario FAILS on purpose (a skipped proof is not a pass).
# An installer that DID ask would block on a modal MessageBox: the wait below is bounded, a timeout is a failed row, and only the
# process this scenario started is stopped (by id, never by image name).
# The "red once" rows plant a store.env / marker / log line and show each detector reports it, so the clean result is not vacuous.

# The NSIS installer is a 32-bit process: its HKLM writes land in the 32-bit view, HKLM:\SOFTWARE\WOW6432Node\SupermarketPOS. Reading the 64-bit view would
# make every 'no marker' row vacuously green, so the key is the WOW6432Node one and a detector row proves it is the 32-bit view.
$script:MarkerKey = 'HKLM:\SOFTWARE\WOW6432Node\SupermarketPOS'
function Test-RoleMarker32View { try { $k = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry32').OpenSubKey('SOFTWARE\SupermarketPOS'); $null -ne $k -and $null -ne $k.GetValue('StoreRoleAsked') } catch { $false } }
function Test-RoleMarker { try { $null -ne (Get-ItemProperty -Path $script:MarkerKey -Name 'StoreRoleAsked' -ErrorAction Stop).StoreRoleAsked } catch { $false } }
function Test-StoreEnv { Test-Path (Join-Path $script:DataRoot 'client\store.env') }
function Test-ProvisionLogLine {
  $logs = @(Get-ChildItem (Join-Path $script:DataRoot 'logs\posctl') -Filter 'posctl-*.log' -ErrorAction SilentlyContinue)
  return (@($logs | Where-Object { Select-String -LiteralPath $_.FullName -Pattern '"command":"provision"' -Quiet }).Count -gt 0)
}
function Get-StoreRoleState { "storeEnv=$(Test-StoreEnv) marker=$(Test-RoleMarker) servicesAbsent=$(Test-AllAbsent) provisionLog=$(Test-ProvisionLogLine) provisionedJson=$(Test-Path (Join-Path $script:DataRoot 'state\provisioned.json'))" }

# Pure: the root PID plus every descendant, from rows that carry ProcessId / ParentProcessId (Win32_Process shape). Cycle-safe.
function Get-TreePids($Rows, [int]$RootPid) {
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$seen.Add($RootPid)
  $queue = New-Object System.Collections.Queue; $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    foreach ($r in @($Rows | Where-Object { [int]$_.ParentProcessId -eq $cur })) { if ($seen.Add([int]$r.ProcessId)) { $queue.Enqueue([int]$r.ProcessId) } }
  }
  return @($seen)
}

# Best-effort: windows owned by the given PIDs (title, class, visibility, owner PID, and for '#32770' dialogs the child control texts).
function Get-OwnedWindows([int[]]$Pids) {
  if (-not ('PosWin90' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Text; using System.Runtime.InteropServices;
public class PosWin90 {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  static string T(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  static string C(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static List<string[]> Find(uint[] pids) {
    var want = new HashSet<uint>(pids); var res = new List<string[]>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (want.Contains(pid)) {
        string cls = C(h); var kids = new List<string>();
        if (cls == "#32770") EnumChildWindows(h, (k, l2) => { string t = T(k); if (t.Length > 0) kids.Add(C(k) + "=" + t); return true; }, IntPtr.Zero);
        res.Add(new[] { pid.ToString(), T(h), cls, IsWindowVisible(h) ? "visible" : "hidden", string.Join(" | ", kids) });
      }
      return true; }, IntPtr.Zero);
    return res;
  }
}
'@
  }
  return @([PosWin90]::Find([uint32[]]$Pids) | ForEach-Object { [pscustomobject]@{ Pid = $_[0]; Title = $_[1]; Class = $_[2]; Visible = ($_[3] -eq 'visible'); Children = $_[4] } })
}

# Pure: classify `sc.exe query PrintBrokerService` -> exists | absent | query-timeout (1060 = service does not exist).
function Get-BrokerServiceVerdict([bool]$TimedOut, [string]$QueryText) {
  if ($TimedOut) { return 'query-timeout' }
  if ($QueryText -match '1060|does not exist') { return 'absent' }
  if ($QueryText -match 'SERVICE_NAME') { return 'exists' }
  return 'absent'
}

# Pure, null-safe: the code on the first "result:" line of broker-install.log (hooks.nsh BrokerInstallStep writes "broker.exe install, result: <code>");
# 'missing' when the file is absent or empty, 'no-result-line' when it has text but no such line. Never calls a method on $null.
function Get-BrokerInstallResult([AllowNull()][string]$LogText) {
  if ([string]::IsNullOrWhiteSpace($LogText)) { return 'missing' }
  foreach ($l in ($LogText -split "`r?`n")) {
    $m = [regex]::Match([string]$l, 'result:\s*(\S+)')
    if ($m.Success) { return $m.Groups[1].Value }
  }
  return 'no-result-line'
}
# Pure, null-safe: the ACE lines of `icacls <file>` output (a line ending in ":(F)" / ":(I)(M)" etc.). Empty array for $null, empty text, or a DACL with no ACEs
# (icacls then prints only "Successfully processed 1 files").
function Get-IcaclsAces([AllowNull()][string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
  return @(($Text -split "`r?`n") | Where-Object { $_ -match ':\([A-Za-z,()]+\)\s*$' })
}
# Pure, null-safe: 'absent' when there is no service, else its Status as text.
function Get-ServiceStatusText($Service) {
  if ($null -eq $Service) { return 'absent' }
  return [string]$Service.Status
}
# Waits (bounded) for PrintBrokerService to be Running; returns the last status text.
function Wait-BrokerRunning([int]$Seconds = 20) {
  $st = 'absent'
  for ($i = 0; $i -le $Seconds; $i++) {
    $st = Get-ServiceStatusText (Get-Service -Name 'PrintBrokerService' -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($st -eq 'Running') { break }
    Start-Sleep -Seconds 1
  }
  return $st
}
# Pure, null-safe: the exe path out of a service ImagePath ('"C:\a b\x.exe" run' | 'C:\a\x.exe run'); '' when empty or not an .exe path.
function Get-ImagePathExe([AllowNull()][string]$ImagePath) {
  if ([string]::IsNullOrWhiteSpace($ImagePath)) { return '' }
  $t = $ImagePath.Trim()
  $m = if ($t.StartsWith('"')) { [regex]::Match($t, '^"([^"]+)"') } else { [regex]::Match($t, '^(.+?\.exe)(\s|$)', 'IgnoreCase') }
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}
# Pure, null-safe: the installer's $INSTDIR. hooks.nsh installs broker.exe at $INSTDIR\broker\broker.exe, so it is the parent of a folder named 'broker'
# (else the exe's own folder); with no usable ImagePath, the uninstall key's InstallLocation. '' when neither is known. Nothing hard-coded.
function Get-BrokerInstallDir([AllowNull()][string]$ImagePath, [AllowNull()][string]$InstallLocation) {
  $exe = Get-ImagePathExe $ImagePath
  if ($exe) {
    $dir = Split-Path -Parent $exe
    if ($dir -and (Split-Path -Leaf $dir) -ieq 'broker') { $dir = Split-Path -Parent $dir }
    if ($dir) { return $dir }
  }
  if (-not [string]::IsNullOrWhiteSpace($InstallLocation)) { return $InstallLocation.Trim().Trim('"').TrimEnd('\') }
  return ''
}
function Read-BrokerInstallResult {
  $img = try { [string](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\PrintBrokerService' -Name ImagePath -ErrorAction Stop).ImagePath } catch { '' }
  $loc = ''
  foreach ($k in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Supermarket POS', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Supermarket POS') {
    if (-not $loc) { $loc = try { [string](Get-ItemProperty -LiteralPath $k -Name InstallLocation -ErrorAction Stop).InstallLocation } catch { '' } }
  }
  $dir = Get-BrokerInstallDir $img $loc
  if (-not $dir) { return 'missing' }
  $f = Join-Path $dir 'logs\broker-install.log'
  if (-not (Test-Path -LiteralPath $f)) { return 'missing' }
  return (Get-BrokerInstallResult ([string](Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue)))
}
# The broker must install on every install, including a cloud-only one on a clean PC (it once died with 0xC0000135, VCRUNTIME140.dll not found).
function Test-BrokerInstalled([string]$Phase) {
  Check-Equal "90 ${Phase}: logs\broker-install.log exists and its first result line is 0" '0' (Read-BrokerInstallResult)
  $svc = @(Get-Service -Name 'PrintBrokerService' -ErrorAction SilentlyContinue)
  Check-True "90 ${Phase}: the PrintBrokerService service is registered" ($svc.Count -eq 1) "found $($svc.Count)"
  # The service must stay up: it reads broker-config.json at start, so an empty/denying DACL on it stops the service (RC7).
  Check-Equal "90 ${Phase}: PrintBrokerService is Running" 'Running' (Wait-BrokerRunning 20)
  $cfg = Join-Path $env:ProgramData 'PrintBroker\broker-config.json'
  $acl = [string](& (Join-Path $env:SystemRoot 'System32\icacls.exe') $cfg 2>&1 | Out-String)
  $aces = @(Get-IcaclsAces $acl)
  Check-True "90 ${Phase}: broker-config.json DACL is not empty" ($aces.Count -gt 0) "icacls: $acl"
  Check-True "90 ${Phase}: broker-config.json DACL grants NT SERVICE\PrintBrokerService" (@($aces | Where-Object { $_ -match 'PrintBrokerService' }).Count -gt 0) "icacls: $acl"
  Check-True "90 ${Phase}: broker-config.json DACL does not grant BUILTIN\Users (it holds the secret)" (@($aces | Where-Object { $_ -match 'BUILTIN\\Users' }).Count -eq 0) "icacls: $acl"
}

# Pure: right-trim every console row, drop empty trailing rows.
function Format-ConsoleRows([string[]]$Rows) {
  $r = @($Rows | ForEach-Object { ([string]$_).TrimEnd() })
  $n = $r.Count; while ($n -gt 0 -and $r[$n - 1] -eq '') { $n-- }
  if ($n -eq 0) { return '' }
  return ($r[0..($n - 1)] -join "`n")
}

# Reads the console text of $TargetPid from a short-lived child pwsh (so our own console is never detached). Never throws; returns text.
function Read-ConsoleText([int]$TargetPid, [int]$Seconds = 20) {
  $tmp = $null
  try {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("conread-" + [Guid]::NewGuid().ToString('N'))
    $ps1 = "$tmp.ps1"; $out = "$tmp.out"
    $code = @'
param([int]$TargetPid, [string]$Out)
try {
  Add-Type -Namespace W -Name K -MemberDefinition @"
[StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
[StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L; public short T; public short R; public short B; }
[StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD Size; public COORD Cursor; public short Attr; public SMALL_RECT Win; public COORD Max; }
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI i);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacterW(IntPtr h, System.Text.StringBuilder s, uint len, COORD at, out uint read);
"@
  [void][W.K]::FreeConsole()
  if (-not [W.K]::AttachConsole([uint32]$TargetPid)) { "ATTACH-FAILED GetLastError=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" | Set-Content $Out; return }
  $h = [W.K]::GetStdHandle(-11); $i = New-Object W.K+CSBI
  if (-not [W.K]::GetConsoleScreenBufferInfo($h, [ref]$i)) { "CSBI-FAILED GetLastError=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" | Set-Content $Out; return }
  $rows = for ($y = 0; $y -le $i.Cursor.Y -or $y -lt $i.Win.B + 1; $y++) {
    if ($y -ge $i.Size.Y) { break }
    $sb = New-Object Text.StringBuilder $i.Size.X; $c = New-Object W.K+COORD; $c.X = 0; $c.Y = $y; $n = [uint32]0
    [void][W.K]::ReadConsoleOutputCharacterW($h, $sb, [uint32]$i.Size.X, $c, [ref]$n); $sb.ToString()
  }
  ,@($rows) | ForEach-Object { $_ } | Set-Content $Out -Encoding UTF8
} catch { "READER-ERROR $_" | Set-Content $Out }
'@
    Set-Content $ps1 $code -Encoding UTF8
    $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source; if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }
    $q = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-File', $ps1, '-TargetPid', $TargetPid, '-Out', $out) -PassThru -WindowStyle Hidden
    if (-not $q.WaitForExit($Seconds * 1000)) { Stop-Process -Id $q.Id -Force -ErrorAction SilentlyContinue; return "READER-TIMEOUT after $Seconds s" }
    if (-not (Test-Path $out)) { return 'READER-NO-OUTPUT' }
    $raw = @(Get-Content $out -Encoding UTF8)
    if ($raw.Count -eq 1 -and $raw[0] -match '^(ATTACH-FAILED|CSBI-FAILED|READER-ERROR)') { return $raw[0] }
    return (Format-ConsoleRows $raw)
  } catch { return "READER-ERROR $($_.Exception.Message)" }
  finally { if ($tmp) { Remove-Item "$tmp.ps1", "$tmp.out" -Force -ErrorAction SilentlyContinue } }
}

# Best-effort evidence at timeout, BEFORE the kill. Returns @{ Tree = [pids]; Summary = 'text for the check row' }. Never throws.
function Save-InstallerTimeoutEvidence([int]$RootPid, [string]$Label) {
  $tree = @($RootPid); $summary = 'no dialog window (evidence unavailable)'
  try {
    $tag = ($Label -replace '[^A-Za-z0-9]+', '-').Trim('-')
    $dir = $script:Evidence; New-Item -ItemType Directory -Force $dir | Out-Null
    $err = Join-Path $dir "90-$tag-errors.txt"
    $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $tree = @(Get-TreePids $rows $RootPid)
    $procs = @($rows | Where-Object { $tree -contains [int]$_.ProcessId } | ForEach-Object {
      $cpu = try { [string](Get-Process -Id $_.ProcessId -ErrorAction Stop).TotalProcessorTime } catch { '?' }
      [pscustomobject]@{ Name = $_.Name; Pid = $_.ProcessId; ParentPid = $_.ParentProcessId; Started = $_.CreationDate; Cpu = $cpu; CommandLine = $_.CommandLine } })
    $procs | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $dir "90-$tag-processes.json") -Encoding UTF8
    $wins = @(try { Get-OwnedWindows $tree } catch { Add-Content $err "windows: $_"; @() })
    $wins | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $dir "90-$tag-windows.json") -Encoding UTF8
    $dlg = @($wins | Where-Object { $_.Visible })
    $kids = (@($procs | Where-Object { $_.Pid -ne $RootPid } | ForEach-Object { "$($_.Name)#$($_.Pid)" }) -join ', ')
    $summary = if ($dlg.Count -gt 0) { "$($dlg.Count) visible dialog(s): " + ((@($dlg | ForEach-Object { "'$($_.Title)' [$($_.Class)] $($_.Children)" })) -join '; ') } else { "no dialog window (children: $(if ($kids) { $kids } else { 'none' }))" }
    try {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $b = [Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
      [Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
      $bmp.Save((Join-Path $dir "90-$tag-desktop.png"), [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    } catch { Add-Content $err "screenshot: $_" }
    $verdict = 'query-timeout'
    try {
      $o = New-Object System.Collections.Generic.List[string]
      $sc = { param($a, $sec) # bounded sc.exe run: returns @(timedOut, text)
        $f = [IO.Path]::GetTempFileName()
        $q = Start-Process -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList $a -PassThru -WindowStyle Hidden -RedirectStandardOutput $f
        $ok = $q.WaitForExit($sec * 1000)
        if (-not $ok) { Stop-Process -Id $q.Id -Force -ErrorAction SilentlyContinue }
        $t = (Get-Content $f -Raw -ErrorAction SilentlyContinue); Remove-Item $f -Force -ErrorAction SilentlyContinue
        , @((-not $ok), [string]$t) }
      $sw = [Diagnostics.Stopwatch]::StartNew(); $qr = & $sc 'query PrintBrokerService' 15; $sw.Stop()
      $verdict = Get-BrokerServiceVerdict $qr[0] $qr[1]
      $o.Add("== sc.exe query PrintBrokerService (timedOut=$($qr[0]), $($sw.ElapsedMilliseconds) ms)"); $o.Add($qr[1])
      $qc = & $sc 'qc PrintBrokerService' 15; $o.Add("== sc.exe qc PrintBrokerService (timedOut=$($qc[0]))"); $o.Add($qc[1])
      $o.Add('== Get-Service PrintBrokerService'); $o.Add([string](Get-Service PrintBrokerService -ErrorAction SilentlyContinue | Format-List * | Out-String))
      $o.Add('== ProgramData\PrintBroker'); $pb = Join-Path $env:ProgramData 'PrintBroker'
      $o.Add($(if (Test-Path $pb) { (Get-ChildItem $pb -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { '{0:o}  {1,12}  {2}' -f $_.LastWriteTime, $_.Length, $_.FullName }) -join "`n" } else { 'absent' }))
      $o.Add('== broker.exe threads')
      foreach ($bp in @($procs | Where-Object { $_.Name -eq 'broker.exe' })) {
        $o.Add("pid $($bp.Pid)"); try { $o.Add(((Get-Process -Id $bp.Pid -ErrorAction Stop).Threads | ForEach-Object { "tid=$($_.Id) state=$($_.ThreadState) wait=$($_.WaitReason)" }) -join "`n") } catch { $o.Add("threads: $_") }
      }
      $o.Add('== services sanity')
      $o.Add("running services: $(@(Get-Service -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running').Count)")
      foreach ($n in 'Spooler', 'RpcSs', 'PlugPlay') { $o.Add("$n : $((Get-Service $n -ErrorAction SilentlyContinue).Status)") }
      $o | Set-Content (Join-Path $dir "90-$tag-broker-diag.txt") -Encoding UTF8
    } catch { Add-Content $err "broker-diag: $_" }
    try {
      $c = New-Object System.Collections.Generic.List[string]
      $el = (& whoami.exe /groups 2>&1 | Select-String 'S-1-16-|Mandatory Label' | ForEach-Object { $_.Line.Trim() }) -join ' | '
      $c.Add("installer integrity/elevation (whoami /groups): $el")
      $c.Add("scenario session id: $((Get-Process -Id $PID).SessionId)")
      foreach ($bp in @($procs | Where-Object { $_.Name -eq 'broker.exe' })) {
        $sid = try { (Get-Process -Id $bp.Pid -ErrorAction Stop).SessionId } catch { '?' }
        $c.Add("== broker.exe pid $($bp.Pid) session=$sid cmdline=$($bp.CommandLine)")
        $c.Add((Read-ConsoleText $bp.Pid 20))
      }
      if (@($procs | Where-Object { $_.Name -eq 'broker.exe' }).Count -eq 0) { $c.Add('no broker.exe in the installer tree') }
      $c | Set-Content (Join-Path $dir "90-$tag-broker-console.txt") -Encoding UTF8
    } catch { Add-Content $err "broker-console: $_" }
    $summary += " [broker-diag: service=$verdict]"
    try {
      $roots = @($env:TEMP, (Join-Path $env:ProgramFiles 'SupermarketPOS'), (Join-Path $env:LOCALAPPDATA 'SupermarketPOS')) | Where-Object { $_ -and (Test-Path $_) }
      $cut = (Get-Date).AddMinutes(-15)
      $roots | ForEach-Object { Get-ChildItem $_ -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $cut } | Select-Object -First 300 |
        ForEach-Object { '{0:o}  {1,12}  {2}' -f $_.LastWriteTime, $_.Length, $_.FullName } } | Set-Content (Join-Path $dir "90-$tag-recent-files.txt") -Encoding UTF8
    } catch { Add-Content $err "files: $_" }
  } catch { try { $summary = "no dialog window (evidence failed: $($_.Exception.Message))" } catch {} }
  return @{ Tree = $tree; Summary = $summary }
}

function Invoke-Installer([string]$Exe, [string[]]$InstallerArgs, [string]$Label) {
  $p = Start-Process -FilePath $Exe -ArgumentList $InstallerArgs -PassThru
  $done = $p.WaitForExit(600000)
  $what = "exit=$($p.ExitCode)"
  if (-not $done) {
    $ev = Save-InstallerTimeoutEvidence $p.Id $Label
    $what = "still running: $($ev.Summary)"
    # the whole installer tree, by the PIDs enumerated above (never by image name), children first
    foreach ($id in @($ev.Tree | Sort-Object -Descending)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  Add-Check "90 $Label finishes without waiting on a prompt (10 minutes)" 'exited' $what $done
  return $(if ($done) { $p.ExitCode } else { -1 })
}

function Invoke-Scenario([int]$Phase) {
  $setup = @(Get-ChildItem 'C:\payload\installer' -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1)
  Add-Check '90 setup: an NSIS installer is staged in the payload (installer\*.exe)' 'found' $(if ($setup.Count -eq 1) { $setup[0].Name } else { 'missing' }) ($setup.Count -eq 1)
  if ($setup.Count -ne 1) { return @{ Results = (Get-Results); Reboot = $false } }
  $exe = $setup[0].FullName

  # the detectors can fail (red once): each sees a planted state, then the plant is removed
  New-Item -ItemType Directory -Force (Join-Path $script:DataRoot 'client') | Out-Null
  Set-Content (Join-Path $script:DataRoot 'client\store.env') 'planted' -Encoding ASCII
  Check-True '90 detector: a planted store.env is seen' (Test-StoreEnv) ''
  Remove-Item (Join-Path $script:DataRoot 'client\store.env') -Force
  New-Item -Path $script:MarkerKey -Force | Out-Null
  Set-ItemProperty -Path $script:MarkerKey -Name 'StoreRoleAsked' -Value '1'
  Check-True '90 detector: a planted StoreRoleAsked marker is seen' (Test-RoleMarker) ''
  Check-True '90 detector: the planted marker is in the 32-bit registry view the installer writes to (HKLM:\SOFTWARE\WOW6432Node)' (Test-RoleMarker32View) 'the marker key is not the 32-bit view: every no-marker row would be vacuous'
  Remove-ItemProperty -Path $script:MarkerKey -Name 'StoreRoleAsked' -Force
  Check-True '90 clean start: no store.env, no marker, no services' (-not (Test-StoreEnv) -and -not (Test-RoleMarker) -and (Test-AllAbsent)) (Get-StoreRoleState)

  # ---- silent install -----------------------------------------------------------------------------------------------------------------
  $e1 = Invoke-Installer $exe @('/S') 'the silent install'
  Check-Equal '90 the silent install exits 0' 0 $e1
  Check-True '90 silent: no store.env' (-not (Test-StoreEnv)) (Get-StoreRoleState)
  Check-True '90 silent: no StoreRoleAsked marker' (-not (Test-RoleMarker)) (Get-StoreRoleState)
  Check-True '90 silent: no store server service' (Test-AllAbsent) (Get-AllServiceStates)
  Check-True '90 silent: no provision line in the posctl log, no provisioned.json' (-not (Test-ProvisionLogLine) -and -not (Test-Path (Join-Path $script:DataRoot 'state\provisioned.json'))) (Get-StoreRoleState)
  Test-BrokerInstalled 'silent'

  # ---- passive reinstall, the way the updater runs it ------------------------------------------------------------------------------------
  $e2 = Invoke-Installer $exe @('/P', '/UPDATE') 'the passive updater-style reinstall'
  Check-Equal '90 the passive reinstall exits 0' 0 $e2
  Check-True '90 passive: no store.env' (-not (Test-StoreEnv)) (Get-StoreRoleState)
  Check-True '90 passive: no StoreRoleAsked marker' (-not (Test-RoleMarker)) (Get-StoreRoleState)
  Check-True '90 passive: no store server service' (Test-AllAbsent) (Get-AllServiceStates)
  Check-True '90 passive: no provision line in the posctl log, no provisioned.json' (-not (Test-ProvisionLogLine) -and -not (Test-Path (Join-Path $script:DataRoot 'state\provisioned.json'))) (Get-StoreRoleState)
  Test-BrokerInstalled 'passive'
  return @{ Results = (Get-Results); Reboot = $false }
}
