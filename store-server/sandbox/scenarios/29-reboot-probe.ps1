# 29 - does this Windows Sandbox survive a reboot with the mapped folders and the logon command? (gates scenario 26)
function Invoke-Scenario([int]$Phase) {
  if ($Phase -eq 1) {
    Set-Content 'C:\Users\Public\reboot-marker.txt' 'phase1'
    Add-Check '29 phase 1 ran before the reboot' 'marker written' 'written' $true
    return @{ Results = (Get-Results); Reboot = $true }
  }
  Check-True '29 phase 2 ran after the reboot (agent re-entered by the logon command)' $true
  Check-True '29 mapped folders are back (C:\payload, C:\out, C:\scenarios)' ((Test-Path 'C:\payload\posctl.exe') -and (Test-Path 'C:\out\state.json') -and (Test-Path 'C:\scenarios\agent.ps1'))
  Check-True '29 local state survived the reboot (C:\Users\Public marker)' (Test-Path 'C:\Users\Public\reboot-marker.txt')
  return @{ Results = (Get-Results); Reboot = $false }
}
