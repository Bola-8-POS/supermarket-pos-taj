# 42 - the restore drill, the full read, a corrupted copy, and what the owner is told (Plan 08 Task 13).
# The repository is made big enough to feel (320 MB of incompressible filler under photos\). Proves:
#  - the drill restores the newest USB backup (the real disaster path) into a scratch database, compares it and drops it; the live data is untouched; nothing is left;
#  - the till stays responsive while a local `verify --read-data` and a drill load the disk and the database (health and a PostgREST read are timed; numbers are recorded;
#    the pass threshold is no failed request, p95 < 1.5 s, worst < 5 s). The Sandbox disk is a virtual SSD: the HDD figure is Plan 13's;
#  - a corrupted data file on the USB copy: `verify --read-data` fails (BACKUP_FAILED, 30), the owner is told BACKUP_VERIFY_FAILED at critical, a restore from the copy
#    fails (RESTORE_FAILED, 31), and status.json carries fixed words only;
#  - a week later the scheduled BackupVerify task (two actions in one task) runs its second action, the drill, although the first (the verify) exited non-zero;
#    10 days after a pass the repository is BACKUP_VERIFY_OVERDUE. The system clock is moved forward for that part and restored in a finally block.
# Estimated 35 minutes.
. C:\scenarios\lib-backup.ps1
function Invoke-Scenario([int]$Phase) {
  Install-BackupStore -Hashed
  Seed-Probe
  Seed-Bulk 320
  New-TestUsb 'E'
  [void](Add-Usb)
  $k = Export-RecoveryKey -Label '42 key-export'
  $t0 = Get-Date
  $b = Backup-Now 'manual'
  Check '42 setup: the first backup of the big store exits 0' 0 $b.exit
  Info '42 setup: first backup seconds' ([int]((Get-Date) - $t0).TotalSeconds)
  Info '42 setup: dump bytes of the first backup' $b.json.data.dumpBytes
  $live = Get-Fingerprint

  # ---- the drill, with the till watched ----------------------------------------------------------------------------------------------------------------------
  $h = Start-PosctlAsync @('backup', 'drill') @{} 'drill-load'
  Measure-TillWhile $h '42 drill'
  $d = Wait-PosctlAsync $h 3600
  Check '42 the drill exits 0' 0 $d.exit
  Check '42 the drill used the USB drive, the real disaster path' 'usb-e' ([string]$d.json.data.source)
  Check '42 the drill dropped its scratch database' $true ($d.json.data.scratchDropped -eq $true)
  Check '42 the drill compared tables and photos (structure, rederive, photos verdict Ok)' 'Ok' ([string]$d.json.data.photosVerdict)
  Info '42 drill: tables / rows / seconds' ("{0}/{1}/{2}" -f $d.json.data.tables, $d.json.data.rows, $d.json.data.seconds)
  Check '42 the drill left the live data alone' $live (Get-Fingerprint)
  Test-Clean '42 after the drill'

  # ---- the full read of every connected repository, with the till watched --------------------------------------------------------------------------------------
  $hv = Start-PosctlAsync @('backup', 'verify', '--read-data') @{} 'verify-load'
  Measure-TillWhile $hv '42 verify --read-data'
  $v = Wait-PosctlAsync $hv 3600
  Check '42 verify --read-data exits 0 on healthy repositories' 0 $v.exit
  Check '42 ... and covered the local repository and the drive' 'local,usb-e' ((@($v.json.data.repos | ForEach-Object { $_.name }) | Sort-Object) -join ',')
  Info '42 till responsiveness: where the figures were taken' 'Sandbox virtual disk (SSD-like). The HDD run is a Plan 13 item; restic --limit-download would be the lever if a real HDD is slow.'
  Test-Clean '42 after the verify'
  $s = Get-BackupStatus
  Check '42 status says the drill passed' $true ($s.backup.lastDrillOk -eq $true)
  Check '42 status says the verify passed' $true ($s.backup.lastVerifyOk -eq $true)
  Check '42 no alert is raised' 'none' ([string]$s.backup.alert)
  Assert-StatusBackupSafe '42 healthy' $s

  # ---- F1: a junction where the USB repository folder was. The destination must read as a foreign drive (never reachable, never healthy) and nothing may be written through the link ---------
  $usbReal = $script:UsbRepo + '.real'
  $localRepo = Join-Path $script:Data 'backupsepo'
  $swapped = $false
  try {
    Rename-Item -LiteralPath $script:UsbRepo -NewName (Split-Path $usbReal -Leaf) -ErrorAction Stop
    $swapped = $true
    $mk = (& cmd.exe /c ('mklink /J "' + $script:UsbRepo + '" "' + $localRepo + '"') 2>&1 | Out-String)
    Check '42 F1 setup: the USB repository folder is now a junction to the local repository' $true ((Test-Path -LiteralPath $script:UsbRepo) -and ((Get-Item -LiteralPath $script:UsbRepo -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    $dc = Bk @('backup', 'dest', 'check', '--name', 'usb-e') 'f1-dest-check'
    $de = @($dc.json.data.destinations | Where-Object { $_.name -eq 'usb-e' })[0]
    Check '42 F1 dest check reports the junctioned destination foreign: true' $true ($de.foreign -eq $true)
    Check '42 F1 ... and reachable: false' $false ($de.reachable -eq $true)
    $fr = Bk @('backup', 'run', '--reason', 'manual') 'f1-backup-run'
    Info '42 F1 backup run through the junction: exit and message' (("exit={0} " -f $fr.exit) + $fr.raw.Substring(0, [Math]::Min(300, $fr.raw.Length)))
    $sf = Get-BackupStatus
    $sd = @($sf.backup.destinations | Where-Object { $_.name -eq 'usb-e' })[0]
    Check '42 F1 status reports the destination foreign: true' $true ($sd.foreign -eq $true)
    Check '42 F1 ... and reachable: false' $false ($sd.reachable -eq $true)
    Check '42 F1 ... and NOT healthy (ok is false)' $false ($sd.ok -eq $true)
    Check '42 F1 the run says the destination is a link, on the system drive or another drive, and nothing was read or written' $true ($fr.raw -match 'the destination folder is a link or is on the system drive, or a different drive is connected; nothing was read from or written to it')
    Assert-StatusBackupSafe '42 F1 junction' $sf
  } finally {
    if ($swapped) {
      if (Test-Path -LiteralPath $script:UsbRepo) { [void](& cmd.exe /c ('rmdir "' + $script:UsbRepo + '"') 2>&1) }   # rmdir on a junction removes the link only, never its target
      Rename-Item -LiteralPath $usbReal -NewName (Split-Path $script:UsbRepo -Leaf) -ErrorAction SilentlyContinue
    }
  }
  Check '42 F1 cleanup: the real USB repository folder is back and is not a link' $true ((Test-Path -LiteralPath (Join-Path $script:UsbRepo 'config')) -and (((Get-Item -LiteralPath $script:UsbRepo -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0))
  Check '42 F1 ... and the destination is reachable again' $true (@((Bk @('backup', 'dest', 'check', '--name', 'usb-e') 'f1-dest-check-after').json.data.destinations)[0].reachable -eq $true)
  $f1b = Backup-Now 'manual' 'f1-backup-after'
  Check '42 F1 a backup after the junction is gone exits 0 and clears the foreign state' 0 $f1b.exit

  # ---- a corrupted copy: every data file of the USB repository gets 64 junk bytes at offset 200 ---------------------------------------------------------------
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $n = 0
  foreach ($f in @(Get-ChildItem (Join-Path $script:UsbRepo 'data') -Recurse -File -ErrorAction SilentlyContinue)) {
    if ($f.Length -lt 400) { continue }
    $fs = [IO.File]::Open($f.FullName, 'Open', 'ReadWrite'); try { [void]$fs.Seek(200, 'Begin'); $junk = New-Object byte[] 64; $rng.GetBytes($junk); $fs.Write($junk, 0, 64) } finally { $fs.Dispose() }
    $n++
  }
  Check '42 setup: the USB copy was damaged (data files corrupted)' $true ($n -gt 0)
  $vp = Bk @('backup', 'verify') 'verify-metadata-only'
  Info '42 verify without --read-data on the corrupted copy: exit (restic may or may not notice damage without reading every blob)' $vp.exit
  $bad = Bk @('backup', 'verify', '--read-data') 'verify-corrupted'
  Check '42 a corrupted copy fails the full read (BACKUP_FAILED, exit 30)' 30 $bad.exit
  $s2 = Get-BackupStatus
  Check '42 the owner is told: BACKUP_VERIFY_FAILED' $true ((Alert-Codes $s2) -contains 'BACKUP_VERIFY_FAILED')
  Check '42 ... at critical level' 'critical' ([string]$s2.backup.alert)
  Check '42 ... and status.backup says the last verify failed' $true ($s2.backup.lastVerifyOk -eq $false)
  Assert-StatusBackupSafe '42 verify failed' $s2
  $rf = Bk @('backup', 'restore', '--snapshot', 'latest', '--repo', $script:UsbRepo) 'restore-corrupted'
  Check '42 restoring from the corrupted copy fails: RESTORE_FAILED (31)' 31 $rf.exit
  Check '42 ... and the live data is untouched' $live (Get-Fingerprint)
  Test-Clean '42 after the failed restore'

  # ---- a week later: the scheduled BackupVerify task - the second action (drill) runs although the first (verify) failed ---------------------------------------
  try {
    Set-ClockForward (7 * 24)
    $pre = Get-BackupStatus
    $drillBefore = [string]$pre.backup.lastDrillAt; $verifyBefore = [string]$pre.backup.lastVerifyAt
    $tx = Get-TaskXml 'BackupVerify'
    Check '42 BackupVerify is a task with two actions: verify --read-data --scheduled --quiet, then drill --scheduled --quiet' 2 ([regex]::Matches($tx, '<Exec>')).Count
    Check '42 ... first action' $true ($tx -match 'backup verify --read-data --scheduled --quiet')
    Check '42 ... second action' $true ($tx -match 'backup drill --scheduled --quiet')
    $started = Get-Date
    $ran = Invoke-TaskNow 'BackupVerify' 3000
    Check '42 the scheduler ran BackupVerify to the end' $true $ran
    $post = Get-BackupStatus
    Check '42 the first action ran: the verify was attempted again (lastVerifyAt advanced)' $true ([string]$post.backup.lastVerifyAt -ne $verifyBefore)
    Check '42 ... and it failed (the corrupted copy)' $true ($post.backup.lastVerifyOk -eq $false)
    Check '42 the second action ran after the non-zero first: the drill was attempted (lastDrillAt advanced)' $true ([string]$post.backup.lastDrillAt -ne $drillBefore)
    $lines = @(Get-BackupLogLines | Where-Object { $_.command -eq 'backup verify' -or $_.command -eq 'backup drill' })
    $vf = @($lines | Where-Object { $_.command -eq 'backup verify' -and $_.code -eq 'BACKUP_FAILED' })
    Check '42 the local backup log recorded the failed scheduled verify' $true ($vf.Count -ge 1)
    $dr = @($lines | Where-Object { $_.command -eq 'backup drill' })
    Check '42 ... and a drill line after it' $true ($dr.Count -ge 1 -and ($dr | Select-Object -Last 1).at -ge ($vf | Select-Object -Last 1).at)
    Assert-StatusBackupSafe '42 after the BackupVerify task' $post
    Set-ClockForward (4 * 24)
    $s3 = Get-BackupStatus
    Check '42 11 days on, a repository whose last pass is over 10 days old is BACKUP_VERIFY_OVERDUE' $true ((Alert-Codes $s3) -contains 'BACKUP_VERIFY_OVERDUE')
    Assert-StatusBackupSafe '42 overdue' $s3
  } finally { Restore-Clock }
  Assert-KeyNowhere '42' $k.Key
  Assert-NoSecrets '42'
  return @{ Results = (Get-Results); Reboot = $false }
}
