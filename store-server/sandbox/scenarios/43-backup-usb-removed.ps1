# 43 - the stick is pulled, another drive appears under its letter, the stick returns; and every drive the product must refuse (Plan 08 Task 13).
# Proves: BACKUP_DEST_DOWN within one tick while the tick still exits 0 and local caja-close backups go on; a foreign drive under the same letter is flagged
# (BACKUP_DEST_FOREIGN) and nothing is written to it; the returning stick is caught up by a copy-only tick; 25 h and 73 h later without the stick the owner sees
# BACKUP_STALE_24H and then BACKUP_STALE_72H (clock moved forward, restored in a finally block); dest add on an unplugged drive is refused; every network spelling
# (UNC, //, \\?\UNC, \\.\, own computer name) and a mapped network drive are refused with the exact sentence "network shares are not supported; use a USB drive or R2";
# a FAT32 drive is added with the filesystem warning. status.json stays fixed words only throughout.
# Estimated 25 minutes.
. C:\scenarios\lib-backup.ps1
$script:NetSentence = 'network shares are not supported; use a USB drive or R2'
function Get-FreshFiles([string]$Letter) { return @(Get-ChildItem "${Letter}:\" -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'System Volume*' -and $_.Name -notlike '$RECYCLE*' }).Count }
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore
  Seed-Probe
  New-TestUsb 'E'
  [void](Add-Usb)
  $k = Export-RecoveryKey -Label '43 key-export'
  [void](Backup-Now 'manual')
  $s0 = Get-BackupStatus
  Check '43 healthy before the stick is pulled' 'none' ([string]$s0.backup.alert)
  $snapBefore = (Get-Snapshots)[0].id

  # ---- the stick is pulled ---------------------------------------------------------------------------------------------------------------------------------------
  Remove-TestUsb
  $t = Tick
  Check '43 the tick still exits 0 with the drive gone' 0 $t.exit
  $s = Get-BackupStatus
  Check '43 the owner is told within one tick: BACKUP_DEST_DOWN' $true ((Alert-Codes $s) -contains 'BACKUP_DEST_DOWN')
  Check '43 status names the drive as not ok' $false (@($s.backup.destinations | Where-Object { $_.name -eq 'usb-e' })[0].ok)
  Check '43 the reason says so' 'destination-down' ([string]$s.backup.reason)
  Assert-StatusBackupSafe '43 stick pulled' $s
  Close-Caja
  $t2 = Tick
  Check '43 a caja-close backup still happens locally' 'caja-close' ([string]$t2.json.data.reason)
  Check '43 ... and the missing drive is reported skipped, not failed' $true (@($t2.json.data.destinations | Where-Object { $_.name -eq 'usb-e' })[0].skipped -eq $true)
  $un = Bk @('backup', 'dest', 'add', '--kind', 'device', '--path', 'E:\', '--allow-fixed', '--name', 'usb-z', '--key-stdin') 'dest-add-unplugged' $null $k.Key
  Check '43 dest add on an unplugged drive is refused (USAGE 2 or PRECONDITION 12)' $true (@(2, 12) -contains $un.exit)
  Check '43 ... and nothing was configured' 1 @(((Bk @('backup', 'dest', 'list') 'dest-list-unplugged').json.data.destinations)).Count

  # ---- a different drive under the same letter: flagged, never written to ---------------------------------------------------------------------------------------
  New-TestUsb 'E' 'C:\usb-2.vhdx' 1024 'OTHERDRIVE'
  $t3 = Tick
  Check '43 the tick with a foreign drive under the letter exits 0' 0 $t3.exit
  Check '43 nothing was created on the foreign drive' 0 (Get-FreshFiles 'E')
  $sf = Get-BackupStatus
  Check '43 the owner is told the drive is not theirs: BACKUP_DEST_FOREIGN' $true ((Alert-Codes $sf) -contains 'BACKUP_DEST_FOREIGN')
  Check '43 ... with the reason destination-foreign' 'destination-foreign' ([string]$sf.backup.reason)
  Assert-StatusBackupSafe '43 foreign drive' $sf
  Remove-TestUsb 'C:\usb-2.vhdx'

  # ---- the stick returns: the missing snapshots are copied, no new dump --------------------------------------------------------------------------------------------
  Attach-TestUsb 'E'
  $t4 = Tick
  Check '43 the returning drive is caught up by a copy-only tick' 'copied' ([string]$t4.json.data.outcome)
  $s4 = Get-BackupStatus
  Check '43 the alert is gone' $false ((Alert-Codes $s4) -contains 'BACKUP_DEST_DOWN' -or (Alert-Codes $s4) -contains 'BACKUP_DEST_FOREIGN')
  Check '43 the newest snapshot is on the drive again' $true (@((Get-Snapshots)[0].on) -contains 'usb-e')
  Check '43 the snapshot taken before the stick was pulled is still on it' $true (@((Get-Snapshots) | Where-Object { $_.id -eq $snapBefore -and @($_.on) -contains 'usb-e' }).Count -eq 1)
  Test-Clean '43 after the stick returned'

  # ---- a stick that stays away: stale at 24 h, critical at 72 h ----------------------------------------------------------------------------------------------------
  Remove-TestUsb
  try {
    Set-ClockForward 25
    $a = Get-BackupStatus; Info-StatusStamp $a '43 after +25 h'
    Check '43 25 h without the stick: BACKUP_STALE_24H (warn)' $true ((Alert-Codes $a) -contains 'BACKUP_STALE_24H' -and -not ((Alert-Codes $a) -contains 'BACKUP_STALE_72H'))
    Assert-StatusBackupSafe '43 stale 24h' $a
    Set-ClockForward 48
    $c = Get-BackupStatus
    Check '43 73 h without the stick: BACKUP_STALE_72H (critical), not both' $true ((Alert-Codes $c) -contains 'BACKUP_STALE_72H' -and -not ((Alert-Codes $c) -contains 'BACKUP_STALE_24H'))
    Check '43 ... and the overall level is critical' 'critical' ([string]$c.backup.alert)
    Assert-StatusBackupSafe '43 stale 72h' $c
  } finally { Restore-Clock }
  Attach-TestUsb 'E'

  # ---- every network spelling is refused with one sentence ------------------------------------------------------------------------------------------------------
  $own = '\\' + $env:COMPUTERNAME + '\share'
  foreach ($p in @('\\nas\backups', '\\nas\backups\pos', '//nas/backups', '\\localhost\share', '\\127.0.0.1\share', $own, '\\?\UNC\nas\share\b', '\\?\E:\b', '\\.\E:\b')) {
    $r = Bk @('backup', 'dest', 'add', '--kind', 'device', '--path', $p, '--allow-fixed', '--name', 'net') 'dest-add-net'
    Add-Check "43 dest add --path $p is refused with the exact sentence (USAGE 2)" "exit 2, '$script:NetSentence'" ("exit=$($r.exit) message=$($r.json.message)") ($r.exit -eq 2 -and [string]$r.json.message -ceq $script:NetSentence)
  }
  $rr = Bk @('backup', 'restore', '--snapshot', 'latest', '--repo', '\\nas\backups\pos') 'restore-unc'
  Add-Check '43 restore --repo with a UNC path is refused with the exact sentence (USAGE 2)' "exit 2, '$script:NetSentence'" ("exit=$($rr.exit) message=$($rr.json.message)") ($rr.exit -eq 2 -and [string]$rr.json.message -ceq $script:NetSentence)
  Check '43 no network destination was configured' 1 @(((Bk @('backup', 'dest', 'list') 'dest-list-net').json.data.destinations)).Count

  # ---- a mapped network drive (a loopback SMB share, if the Sandbox can make one) -----------------------------------------------------------------------------
  $shareDir = 'C:\posbk-share'; New-Item -ItemType Directory -Force $shareDir | Out-Null
  $o1 = (& net.exe share posbk="$shareDir" '/grant:Everyone,FULL' 2>&1 | Out-String); $e1 = $LASTEXITCODE
  $mapped = $false
  if ($e1 -eq 0) {
    $o2 = (& net.exe use Z: '\\localhost\posbk' '/persistent:no' 2>&1 | Out-String); $e2 = $LASTEXITCODE
    $mapped = ($e2 -eq 0 -and (New-Object IO.DriveInfo 'Z').DriveType -eq 'Network')
    if (-not $mapped) { Info '43 mapped drive: could not map a loopback share' ($o2.Trim()) }
  } else { Info '43 mapped drive: could not create a loopback SMB share (no Server service in the Sandbox?)' ($o1.Trim()) }
  if ($mapped) {
    $m = Bk @('backup', 'dest', 'add', '--kind', 'device', '--path', 'Z:\', '--allow-fixed', '--name', 'z', '--key-stdin') 'dest-add-mapped' $null $k.Key
    Check '43 a mapped network drive is refused (USAGE 2) with the network-share sentence' $true ($m.exit -eq 2 -and [string]$m.json.message -match 'network shares are not supported')
    $cand = Bk @('backup', 'dest', 'candidates') 'dest-candidates'
    $zc = @($cand.json.data.candidates | Where-Object { $_.letter -eq 'Z' })
    Check '43 dest candidates lists Z: as network and not usable' $true ($zc.Count -eq 1 -and $zc[0].usable -eq $false -and $zc[0].kind -eq 'remote')
    & net.exe use Z: /delete /y 2>&1 | Out-Null
  } else { Info '43 not automated here: mapped network drive refusal' 'the Sandbox cannot map a network drive; the refusal is pinned by dest::validate_device_path unit tests' }
  & net.exe share posbk /delete /y 2>&1 | Out-Null
  Check '43 dest list still shows only the USB drive' 1 @(((Bk @('backup', 'dest', 'list') 'dest-list-end').json.data.destinations)).Count

  # ---- a FAT32 drive: added, with the filesystem warning ---------------------------------------------------------------------------------------------------------
  New-TestUsb 'F' 'C:\usb-fat.vhdx' 2048 'POSFAT' 'fat32'
  Check '43 the second test drive is FAT32' 'FAT32' (Get-UsbFs 'F')
  $fat = Add-Usb 'F' 'usb-fat' $k.Key
  Check '43 a FAT32 drive is added (exit 0)' 0 $fat.exit
  Check '43 ... with one filesystem warning (power cuts can corrupt FAT)' 1 @($fat.json.data.warnings).Count
  Info '43 the FAT32 warning text' (@($fat.json.data.warnings) -join ' | ')
  [void](Bk @('backup', 'dest', 'remove', '--name', 'usb-fat') 'dest-remove-fat')
  Assert-StatusBackupSafe '43 end' (Get-BackupStatus)
  Assert-KeyNowhere '43' $k.Key
  Info '43 not automated: BACKUP_DEST_FAILING and BACKUP_DEST_NO_RECOVERY_KEY' 'FAILING needs a drive that is present but failing for 6 h (a full or write-protected VHD); NO_RECOVERY_KEY cannot be produced through the CLI (key-export refuses unless every drive is connected). Both are pinned by the status unit tests.'
  Assert-NoSecrets '43'
  return @{ Results = (Get-Results); Reboot = $false }
}
