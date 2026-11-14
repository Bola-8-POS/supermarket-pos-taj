# 123 - uninstall removes every assistant file and its uninstall key and leaves the POS folder alone (Plan 29-04, ASSIST-01).
# `uninstall.exe /S` copies itself to %TEMP% and exits at once (NSIS), so the run is waited on by its observable result, bounded,
# plus any ~nsu.tmp uninstaller copy it started. Red once: the same removal check, run while the add-on is still installed, must say NOT removed.
. C:\scenarios\lib-assistant.ps1

function Invoke-Scenario([int]$Phase) {
  Initialize-AssistantEnv
  # a stand-in POS install folder: the uninstaller must not touch it
  $pos = 'C:\Program Files\Supermarket POS'
  New-Item -ItemType Directory -Force $pos | Out-Null
  $stub = Join-Path $pos 'stub.txt'
  Set-Content $stub 'pos stub, must survive the assistant uninstall' -Encoding ASCII
  $stubHash = (Get-FileHash $stub -Algorithm SHA256).Hash

  $i = Install-Assistant
  Check-Equal '123 setup: installer.exe /S exits 0' 0 $i.Exit
  if ($i.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }
  Check-True '123 setup: the add-on and its HKLM uninstall key are present' ((Test-Path "$($script:AsstDir)\manifest.json") -and (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SupermarketPOSAssistant')) ''

  # red once: while installed, the post-condition check must report failure
  Check-True '123 red once: the removal check reports NOT removed while the add-on is installed' (-not (Test-AssistantRemoved)) ''

  $un = Join-Path $script:AsstDir 'uninstall.exe'
  Check-True '123 setup: uninstall.exe exists' (Test-Path $un) ''
  $p = Start-Process -FilePath $un -ArgumentList '/S' -PassThru -WindowStyle Hidden
  $null = $p.Handle
  [void]$script:AsstStarted.Add($p.Id)
  [void]$p.WaitForExit(120000)
  # the original exits at once; the temp copy does the work. Wait for the result, then for any ~nsu.tmp copy to end.
  $removed = Wait-Until { Test-AssistantRemoved } 180 1
  [void](Wait-Until { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -like '*\~nsu.tmp\*' } catch { $false } }).Count -eq 0 } 60 1)

  Check-True '123 the install dir is gone' (-not (Test-Path -LiteralPath $script:AsstDir)) ''
  Check-True '123 the HKLM uninstall key is gone' (-not (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SupermarketPOSAssistant')) ''
  Check-True '123 the removal check agrees (removed = true)' $removed ''
  Check-True '123 the POS folder stub file is untouched (same SHA-256)' ((Test-Path $stub) -and ((Get-FileHash $stub -Algorithm SHA256).Hash -eq $stubHash)) ''
  return @{ Results = (Get-Results); Reboot = $false }
}
