# 28 - sandbox smoke: the environment the other scenarios rely on (elevation, payload, tools, VC++ runtime).
function Invoke-Scenario([int]$Phase) {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Check-True '28 agent runs elevated (admin token)' $admin $id.Name
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Check '28 OS' 'Windows build recorded' "$($os.Caption) $($os.BuildNumber)" $true
  Check-True '28 payload posctl.exe visible' (Test-Path (Join-Path $script:Payload 'posctl.exe'))
  $meta = Get-PayloadMeta
  Check-True '28 payload pack visible' (Test-Path (Join-Path $script:Payload ("pack\" + $meta.packVersion + '\manifest.json')))
  Check-True '28 sc.exe / netsh / icacls present' ((Test-Path 'C:\Windows\System32\sc.exe') -and (Test-Path 'C:\Windows\System32\netsh.exe') -and (Test-Path 'C:\Windows\System32\icacls.exe'))
  Check-True '28 Get-NetTCPConnection works' ($null -ne (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue))
  Check-True '28 no network adapter with an address (Networking Disable)' $true ((Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress }) -join ',')
  $free = (Get-PSDrive C).Free
  Add-Check '28 free disk on C: for a 580 MB pack + a cluster' '>= 4 GB' ([math]::Round($free / 1GB, 1).ToString() + ' GB') ($free -ge 4GB)
  Add-Check '28 free RAM' 'recorded' ([math]::Round($os.FreePhysicalMemory / 1MB, 2).ToString() + ' GB') $true
  $pw = 'Aa1!' + (New-RandomToken 18)
  try { New-StdUser 'probeuser' $pw; Add-Check '28 local standard user can be created (New-LocalUser)' 'created' 'created' $true } catch { Add-Check '28 local standard user can be created (New-LocalUser)' 'created' $_.Exception.Message $false }
  $before = Test-Path 'C:\Windows\System32\vcruntime140.dll'
  Install-Posctl
  # posctl is a dynamically linked MSVC binary: without the VC++ runtime it cannot even start (FINDING if so)
  $r = $null; try { $r = Invoke-Posctl @('version') -Name 'version-before-vc' } catch { Add-Check '28 posctl version exits 0 BEFORE vc_redist is installed (static CRT)' 'exit 0' $_.Exception.Message $false }
  Add-Check '28 posctl version exits 0 BEFORE vc_redist is installed (static CRT)' 'exit 0' $(if ($r) { "exit=$($r.Exit) runtimePresent=$before" } else { 'did not start' }) ($r -and $r.Exit -eq 0 -and -not $before)
  [void](Ensure-VcRuntime)
  $r = Invoke-Posctl @('version') -Name 'version'
  Check-Equal '28 posctl version exits 0 after the runtime is there' 0 $r.Exit
  Check-True '28 version prints one JSON object' ($null -ne $r.Json -and $r.Json.ok -eq $true) $r.Raw
  return @{ Results = (Get-Results); Reboot = $false }
}
