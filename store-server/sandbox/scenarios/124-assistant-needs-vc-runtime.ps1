# 124 - the assistant installer on a machine WITHOUT the VC++ 14 x64 runtime (Plan 29-09, deferred from 29-07, owner option B):
#  `installer.exe /S` must exit 3 and write nothing (no install dir, no uninstall key, nothing new under Program Files or the Uninstall hive).
#  The positive control installs the runtime and runs the same installer again: it exits 0, so the exit 3 above was the runtime gate and
#  not some other failure. Unlike 120-123 this scenario does NOT call Initialize-AssistantEnv (that installs the runtime first).
. C:\scenarios\lib-assistant.ps1

function Get-VcInstalled {
  # the same two registry views installer.nsi .onInit reads (64-bit, then 32-bit)
  $keys = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
  foreach ($k in $keys) { $v = (Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).Installed; if ($v -eq 1) { return $true } }
  return $false
}
function Get-Snapshot {
  $pf = (Get-ChildItem 'C:\Program Files' -Force -ErrorAction SilentlyContinue | ForEach-Object Name | Sort-Object) -join '|'
  $un = (Get-ChildItem 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object PSChildName | Sort-Object) -join '|'
  return @{ ProgramFiles = $pf; Uninstall = $un }
}

function Invoke-Scenario([int]$Phase) {
  New-Item -ItemType Directory -Force $script:AsstLocal | Out-Null
  Copy-Item (Join-Path $script:AsstPay 'installer.exe') $script:AsstInstaller -Force

  Check-True '124 precondition: the clean machine has no VC++ 14 x64 runtime registered (both registry views)' (-not (Get-VcInstalled)) 'the sandbox image already has the runtime; this scenario cannot prove the gate'
  $before = Get-Snapshot

  $i = Install-Assistant
  Check-Equal '124 installer.exe /S without the runtime exits 3' 3 $i.Exit
  Check-True '124 the install directory was not created' (-not (Test-Path $script:AsstDir)) $script:AsstDir
  Check-True '124 no HKLM uninstall key was written' (-not (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SupermarketPOSAssistant')) ''
  $after = Get-Snapshot
  Add-Check '124 nothing new under C:\Program Files' $before.ProgramFiles $after.ProgramFiles ($before.ProgramFiles -eq $after.ProgramFiles)
  Add-Check '124 no new key in the Uninstall hive' $before.Uninstall $after.Uninstall ($before.Uninstall -eq $after.Uninstall)

  # positive control: with the runtime present the same installer succeeds, so the exit 3 was the gate
  [void](Ensure-VcRuntime)
  Check-True '124 control: the runtime is registered after the vc_redist step' (Get-VcInstalled) 'vc_redist did not register the runtime'
  $ok = Install-Assistant
  Check-Equal '124 control: the same installer exits 0 once the runtime is present' 0 $ok.Exit
  Check-True '124 control: the install directory exists now' (Test-Path "$($script:AsstDir)\manifest.json") ''
  return @{ Results = (Get-Results); Reboot = $false }
}
