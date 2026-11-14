# 23 - a data folder that somebody else prepared before provision: owned by a standard local user with Everyone:F,
# a junction to another folder, and an Administrators-owned folder that is not a posctl installation.
# posctl must refuse each with PRECONDITION (exit 12) and leave the folder (or the junction target) exactly as it was.
function Get-Fingerprint([string]$Path) {
  $sd = (Get-Acl -LiteralPath $Path).GetSecurityDescriptorSddlForm('All')
  $items = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object { '{0}|{1}|{2}' -f $_.FullName, $_.Length, $_.LastWriteTimeUtc.Ticks })
  return "$sd`n" + ($items -join "`n")
}
function Test-Refused([string]$Tag, [string]$Path, [string]$Watch, [string]$Pattern) {
  $before = Get-Fingerprint $Watch
  $beforeWatch = Get-AllServiceStates
  $p = Provision-Fresh "C:\out\r23-$Tag.json" "23-$Tag-provision"
  $r = $p.Result
  Add-Check "23[$Tag] provision is refused with PRECONDITION, exit 12" '12 PRECONDITION' (Format-Envelope $r) ($r.Exit -eq 12 -and $r.Json.code -eq 'PRECONDITION')
  Check-True "23[$Tag] the message names the problem (/$Pattern/)" ($r.Json.message -match $Pattern) $r.Json.message
  Check-True "23[$Tag] stdout is one JSON object, ok=false" ((@($r.Raw -split "`r?`n").Count -eq 1) -and $r.Json.ok -eq $false) $r.Raw
  Check-True "23[$Tag] the folder is byte-for-byte untouched (owner, DACL, contents)" ((Get-Fingerprint $Watch) -eq $before) 'fingerprint changed'
  Check-True "23[$Tag] no service was registered" (Test-AllAbsent) (Get-AllServiceStates)
  Check-True "23[$Tag] no journal, no secrets written by the refused run" (-not (Test-Path (Join-Path $Watch 'secrets')) -and -not (Test-Path (Join-Path $Watch 'state\provision-journal.json'))) ''
  Check-True "23[$Tag] the PIN is not in the refusal's output" (-not ($r.Raw + $r.Stderr).Contains($p.Digits))
}

function Invoke-Scenario([int]$Phase) {
  [void](Install-Posctl)
  [void](Ensure-VcRuntime)
  $d = $script:DataRoot

  # --- A: owned by a standard user, Everyone:F --------------------------------------------------------------
  $pw = 'Aa1!' + (New-RandomToken 18)
  New-StdUser 'planter' $pw
  Check-True '23 harness: local standard user created' ($null -ne (Get-LocalUser -Name planter -ErrorAction SilentlyContinue))
  New-Item -ItemType Directory $d | Out-Null
  Set-Content (Join-Path $d 'planted.txt') 'planted'
  & icacls.exe $d /setowner planter | Out-Null
  $setOwner = $LASTEXITCODE
  & icacls.exe $d /grant '*S-1-1-0:(OI)(CI)F' | Out-Null
  $o = (Get-Acl $d).GetOwner([Security.Principal.NTAccount]).Value
  Add-Check '23 harness: the folder is owned by the standard user and carries Everyone:F' 'owner *\planter, Everyone ACE' "$o setowner=$setOwner" ($o -like '*\planter' -and ((Get-Acl $d).Access | Where-Object { $_.IdentityReference.Value -eq 'Everyone' }).Count -ge 1)
  Test-Refused 'foreign-owner' $d $d 'owned by S-1-5-21-\d+-\d+-\d+-\d+, not Administrators or SYSTEM.*planted'
  Remove-Item $d -Recurse -Force

  # --- B: a junction at the data root -------------------------------------------------------------------------------
  $target = 'C:\jtarget'
  New-Item -ItemType Directory $target | Out-Null
  Set-Content (Join-Path $target 'marker.txt') 'target'
  & icacls.exe $target /grant '*S-1-1-0:(OI)(CI)F' | Out-Null
  & cmd.exe /c mklink /J "$d" "$target" | Out-Null
  Check-True '23 harness: the data root is a junction' ((Get-Item $d -Force).LinkType -eq 'Junction')
  Test-Refused 'junction' $d $target 'reparse point'
  Check-True '23[junction] the junction itself is still there and points at the target' (((Get-Item $d -Force).LinkType -eq 'Junction') -and (Test-Path (Join-Path $target 'marker.txt')))
  & cmd.exe /c rmdir "$d" | Out-Null
  Check-True '23 harness: the junction was removed without touching the target' ((-not (Test-Path $d)) -and (Test-Path (Join-Path $target 'marker.txt')))

  # --- C: Administrators-owned, Everyone:F, but not a posctl installation ------------------------------------------------------
  New-Item -ItemType Directory $d | Out-Null
  Set-Content (Join-Path $d 'planted.txt') 'planted'
  & icacls.exe $d /grant '*S-1-1-0:(OI)(CI)F' | Out-Null
  Test-Refused 'not-a-posctl-folder' $d $d 'not a posctl installation'
  # after an administrator clears the planted folder, provisioning works
  Remove-Item $d -Recurse -Force
  $ok = Provision-Fresh 'C:\out\r23-after-cleanup.json' '23-after-cleanup-provision'
  Add-Check '23 after the planted folder is removed, provisioning works (exit 0, five services Running)' '0 / all Running' ((Format-Envelope $ok.Result) + ' ' + (Get-AllServiceStates)) ($ok.Result.Exit -eq 0 -and (Wait-Until { Test-AllRunning } 120 1))
  Save-DataEvidence 'end'
  return @{ Results = (Get-Results); Reboot = $false }
}
