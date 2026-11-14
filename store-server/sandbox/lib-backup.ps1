# store-server/sandbox/lib-backup.ps1 - helpers for the backup scenarios 40-48 (Plan 08 Task 13). Dot-sourced by each scenario file.
# Loads Plan 07's lib-update.ps1 (which needs the agent's lib.ps1 loaded first). Windows PowerShell 5.1 syntax only: no ternary, no null-coalescing,
# no [RandomNumberGenerator]::Fill (it leaves an all-zero buffer on 5.1: RNGCryptoServiceProvider.GetBytes). The agent runs these files in PowerShell 7.
# Every credential is built at run time (New-RandomToken / New-Digits6 / the key posctl prints); nothing secret is written down here.
# Processes are only ever stopped by the Process object we started (no image-name kills).
. C:\scenarios\lib-update.ps1
$script:UsbRepo = 'E:\SupermarketPOS-Backup'
$script:UsbFile = 'C:\usb-1.vhdx'
$script:KeyShape = '[0-9A-Z]{5}(-[0-9A-Z]{5}){5}'   # XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX (backup/keys.rs)
$script:KeyShapeWide = '(?i)(?<![0-9a-z])[0-9a-z]{5}(-?[0-9a-z]{5}){5}(?![0-9a-z])'   # dashed or not, any case: what a person might have typed or pasted

# A value recorded for the report, never a verdict. The reason a thing cannot be automated goes here too (never a faked pass).
# Info rows carry `info` = true and pass = null: run-scenario.ps1 prints them as INFO and counts them neither as PASS nor as FAIL.

# ---- the admin PIN: Install-OldStore draws it from New-Digits6 and forgets it. Wrap the generator to keep the last value, in memory only. -----------------
if (-not $script:OrigNewDigits6) { $script:OrigNewDigits6 = ${function:New-Digits6} }   # once: a second dot-source must not wrap the wrapper
$script:LastPin = $null
function New-Digits6 { $d = & $script:OrigNewDigits6; $script:LastPin = $d; return $d }

function Get-Restic { return (Join-Path $script:Prog ('packs\' + (Get-Cfg).pack.current + '\bin\restic.exe')) }

# Install-OldStore, then what every backup scenario needs: the admin PIN for real sign-ins, the Backup/BackupVerify tasks parked (a 5-minute tick running
# under the scenario would race its commands), and a loud check that the pack carries the backup tools.
# $script:AdminPin / $script:AdminId stay in memory; the sign-in helpers below derive the GoTrue password from them with the pepper on disk.
# -Hashed (11H): the old pack provisions plaintext PINs, but this posctl writes the pepper into every snapshot, and a snapshot that names a pepper is restored (and drilled) in
# the hashed mode, whose proof needs bcrypt PINs: so a scenario that restores or drills its own snapshots first moves the store to the 11H pack (what 94b does by hand). Without
# -Hashed the store stays on the old pack with plaintext PINs (45 migrates it itself; 94a/94b drive their own update).
function Install-BackupStore([string]$Variant = 'new', [string]$OldPack = 'old', [switch]$LowerAuth, [switch]$KeepTasks, [switch]$Hashed) {
  $script:LastPin = $null
  # the Backup/BackupVerify tasks are parked inside Install-OldStore, right after provision (a tick during its tail left a snapshot, scenario 45)
  Install-OldStore -Variant $Variant -OldPack $OldPack -LowerAuth:$LowerAuth -ParkBackup:(-not $KeepTasks) -KeepTasks:$KeepTasks
  $script:AdminPin = $script:LastPin
  Check 'setup: the admin PIN of the first provision was captured (memory only)' $true ([bool]$script:AdminPin)
  $script:AdminId = [string](Psql 'postgres' "SELECT id FROM public.profiles WHERE role::text = 'admin' LIMIT 1")
  Check 'setup: there is an admin profile' $true ($script:AdminId -match '^[0-9a-fA-F-]{36}$')
  if ($Hashed) {
    $up = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'setup-update-to-11h' -TimeoutSec 1800   # the pre-update backup is stubbed: the store starts without a snapshot
    Assert-Exit 'setup: the update to the 11H pack' $up 'OK'
    $script:OldV = $script:NewV; $script:PackVersion = $script:NewV   # Reset-Store re-activates $OldV: this store lives on the new pack from here
    Check 'setup: no profile holds a 6-digit PIN after the update' '0' (([string](Psql 'postgres' 'SELECT count(*) FROM public.profiles WHERE pin ~ ''^[0-9]{6}$''')).Trim())
    Check 'setup: the admin PIN is a bcrypt hash after the update' 't' (([string](Psql 'postgres' "SELECT pin ~ '^\`$2[aby]\`$' FROM public.profiles WHERE id = '$($script:AdminId)'")).Trim())
    Check 'setup: the admin still signs in with the same PIN and pepper (HTTP 200)' 200 (Invoke-AdminGrant).Status
    Save-Pristine   # Reset-Store must come back to the hashed store, not the plaintext one Install-OldStore saved
  }
  # key-export refuses a build that embeds only the PLACEHOLDER escrow key. The test-hooks posctl takes a throwaway recipient from POSCTL_TEST_ESCROW_PUBKEY (the
  # POSCTL_TEST_UPDATER_PUBKEY precedent); the shipped posctl has no such code. The recipient is the public development constant of scripts/write-escrow-pubkey.mjs
  # (DEV_ESCROW_PUBKEY): its private half is NOT secret (the constant is public, see the release.yml comment), so the escrow copy it produces protects nothing in a scenario; a scenario never decrypts it anyway.
  $devEscrow = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p'
  $env:POSCTL_TEST_ESCROW_PUBKEY = $devEscrow
  [Environment]::SetEnvironmentVariable('POSCTL_TEST_ESCROW_PUBKEY', $devEscrow, 'Machine')
  $hk = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($script:Posctl))
  Add-Check 'setup: this posctl honours POSCTL_TEST_ESCROW_PUBKEY (it is the test-hooks build)' 'variable name present in posctl.exe' $(if ($hk.Contains('POSCTL_TEST_ESCROW_PUBKEY')) { 'present' } else { 'ABSENT' }) $hk.Contains('POSCTL_TEST_ESCROW_PUBKEY')
  $pk = Join-Path $script:Prog ('packs\' + (Get-Cfg).pack.current)
  foreach ($t in 'bin\restic.exe', 'pg\bin\pg_dump.exe', 'pg\bin\pg_dumpall.exe', 'pg\bin\pg_restore.exe', 'pg\bin\psql.exe') {
    Check "setup: the pack carries $t (backup tooling)" $true (Test-Path (Join-Path $pk $t))
  }
  if (-not $KeepTasks) {
    # deliberate re-assertion after the pack installs: a pack or tasks install could have re-enabled the tasks parked right after provision
    foreach ($t in 'Backup', 'BackupVerify') { Check "setup: the $t scheduled task exists and is parked for the scenario (schtasks exit)" 0 (Set-TaskEnabled $t $false) }
  }
}

# A real GoTrue password grant for the first admin on the INTERNAL listener, with the pepper currently on disk (or a given one).
function Invoke-AdminGrant([string]$Pepper = '') {
  if (-not $Pepper) { $Pepper = Get-Pepper }
  $pw = Get-DerivedPassword $script:AdminId $script:AdminPin $Pepper
  return (Invoke-Grant "$($script:AdminId)@barpos.local" $pw)
}

# ---- posctl wrappers ------------------------------------------------------------------------------------------------------------------------------
# lib-update's Invoke-Posctl returns exit/json/raw/err. Tag is the evidence name. Env = a Hooks table; Stdin = one line (the recovery key).
# TimeoutSec is above 1800 for everything: a `verify --read-data` of a large repository legitimately runs longer than the helper's default.
function Bk([string[]]$A, [string]$Tag = '', $Env = $null, $Stdin = $null, [int]$TimeoutSec = 3600) {
  $e = @{}; if ($Env -is [hashtable]) { $e = $Env }
  if ($null -ne $Stdin) { return (Invoke-Posctl $A $e ([string]$Stdin) -TimeoutSec $TimeoutSec -Tag $Tag) }
  return (Invoke-Posctl $A $e -TimeoutSec $TimeoutSec -Tag $Tag)
}
function Backup-Now([string]$Reason = 'manual', [string]$Tag = 'backup-run') { $r = Bk @('backup', 'run', '--reason', $Reason) $Tag; Assert-NoPin "after backup ($Tag)"; return $r }
function Tick([string]$Tag = 'backup-tick') { return (Bk @('backup', 'run', '--reason', 'hourly', '--scheduled', '--quiet') $Tag) }
function Get-Snapshots { $r = Bk @('backup', 'list') 'backup-list'; return @($r.json.data.snapshots) }
function Alert-Codes($Doc) { return @(@($Doc.alerts) | Where-Object { $_ } | ForEach-Object { [string]$_.code }) }
function BackupAlert-Codes($Doc) { return @(Alert-Codes $Doc | Where-Object { $_ -like 'BACKUP_*' }) }
function Get-BackupStatus { return (Get-StatusDoc) }   # lib-update: `health --write`, then state\status.json

function Add-Usb([string]$Letter = 'E', [string]$Name = 'usb-e', $Stdin = $null) {
  $a = @('backup', 'dest', 'add', '--kind', 'device', '--path', "${Letter}:\", '--allow-fixed', '--name', $Name)
  if ($null -ne $Stdin) { $a += '--key-stdin' }
  $r = Bk $a "dest-add-$Name" $null $Stdin
  Check "setup: dest add $Name exits 0" 0 $r.exit
  return $r
}

# Closes a caja the way the shop does: a session opened and closed (scenario 76's SQL; trg_caja_sessions_version needs version = old + 1).
function Close-Caja {
  [void](Psql 'postgres' "INSERT INTO public.caja_sessions(opening_cash, opened_by, status) SELECT 0, id, 'open' FROM public.profiles LIMIT 1")
  [void](Psql 'postgres' "UPDATE public.caja_sessions SET status = 'closed', closed_at = now(), closed_by = opened_by, version = version + 1 WHERE status = 'open'")
}

# ---- the virtual USB stick: a VHD attached through diskpart (a mounted VHD reports as a fixed disk, hence --allow-fixed) -------------------------------
function Invoke-DiskPart([string]$Text, [string]$Tag = 'diskpart') {
  $f = Join-Path $env:TEMP ('dp-' + [guid]::NewGuid().ToString('N') + '.txt')
  Set-Content -Path $f -Value $Text -Encoding ASCII
  $o = (& "$env:windir\System32\diskpart.exe" /s $f 2>&1 | Out-String)
  Remove-Item $f -Force -ErrorAction SilentlyContinue
  Save-Evidence $Tag $o
  return $o
}
function New-TestUsb([string]$Letter = 'E', [string]$File = $script:UsbFile, [int]$SizeMB = 3072, [string]$Label = 'POSBACKUP', [string]$Fs = 'ntfs') {
  $o = Invoke-DiskPart ("create vdisk file=`"$File`" maximum=$SizeMB type=expandable`r`nattach vdisk`r`ncreate partition primary`r`nformat fs=$Fs quick label=$Label`r`nassign letter=$Letter`r`n") "diskpart-create-$Letter"
  for ($i = 0; $i -lt 40 -and -not (Test-Path "${Letter}:\"); $i++) { Start-Sleep -Seconds 1 }
  # the plan's rule: if diskpart cannot give us a drive, STOP - a folder on C: is never a substitute (the product refuses the system drive)
  if (-not (Test-Path "${Letter}:\")) { throw "STOP: diskpart could not create the test USB ${Letter}: ($Fs). Output: $o" }
}
function Remove-TestUsb([string]$File = $script:UsbFile) { [void](Invoke-DiskPart "select vdisk file=`"$File`"`r`ndetach vdisk`r`n" 'diskpart-detach'); Start-Sleep -Seconds 2 }
function Get-UsbLabel([string]$Letter) { try { $d = New-Object IO.DriveInfo("${Letter}:"); if ($d.IsReady) { return [string]$d.VolumeLabel } } catch { }; return '' }
# No Get-Volume anywhere below: inside the Sandbox it returns nothing (Sandbox 43: empty Get-Volume / Get-Partition while diskpart listed the volume). diskpart and System.IO.DriveInfo only.
function Test-UsbBack([string]$Letter, [string]$Label) { return ((Test-Path "${Letter}:\") -and ((Get-UsbLabel $Letter) -eq $Label)) }
function Get-UsbFs([string]$Letter = 'E') { try { $d = New-Object IO.DriveInfo("${Letter}:"); if ($d.IsReady) { return [string]$d.DriveFormat } } catch { }; return '' }
# diskpart `list volume` -> Num, Ltr (blank = none), Rest (the label and the rest of the line)
function Get-DpVolumes([string]$Text) {
  $out = @()
  foreach ($l in ($Text -split "`r?`n")) {
    $m = [regex]::Match($l, '^\s*Volume\s+(\d+)\s+(.*)$')
    if (-not $m.Success) { continue }
    $rest = $m.Groups[2].Value; $ltr = ''
    $lm = [regex]::Match($rest, '^([A-Za-z])\s{2,}\S'); if ($lm.Success) { $ltr = $lm.Groups[1].Value.ToUpper() }
    $out += [pscustomobject]@{ Num = $m.Groups[1].Value; Ltr = $ltr; Rest = $rest }
  }
  return $out
}
# Re-attach a VHD by what it IS (its volume LABEL): after another VHD has held the letter the mount manager brings the volume up with another letter (D in Sandbox 43) or none.
function Attach-TestUsb([string]$Letter = 'E', [string]$File = $script:UsbFile, [string]$Label = 'POSBACKUP') {
  [void](Invoke-DiskPart "select vdisk file=`"$File`"`r`nattach vdisk`r`n" 'diskpart-attach')
  $end = (Get-Date).AddSeconds(30)
  $seen = 'the volume was never listed'
  $labelRx = '\b' + [regex]::Escape($Label) + '\b'
  while ((Get-Date) -lt $end -and -not (Test-UsbBack $Letter $Label)) {
    $lv = Invoke-DiskPart "rescan`r`nlist volume`r`n" 'diskpart-attach-poll'
    $vols = @(Get-DpVolumes $lv)
    $mine = @($vols | Where-Object { $_.Rest -match $labelRx } | Select-Object -First 1)
    if ($mine.Count -eq 1) {
      $seen = "volume $($mine[0].Num) label $Label letter '$($mine[0].Ltr)'"
      foreach ($o in @($vols | Where-Object { $_.Ltr -eq $Letter.ToUpper() -and $_.Num -ne $mine[0].Num })) {   # a stale volume holding the letter lets go first
        [void](Invoke-DiskPart "select volume $($o.Num)`r`nremove letter=$Letter noerr`r`n" 'diskpart-free-letter')
      }
      if ($mine[0].Ltr -ne $Letter.ToUpper()) {
        $cmds = "select volume $($mine[0].Num)`r`n"
        if ($mine[0].Ltr) { $cmds += "remove letter=$($mine[0].Ltr) noerr`r`n" }
        $cmds += "assign letter=$Letter noerr`r`n"
        [void](Invoke-DiskPart $cmds 'diskpart-assign-by-label')
      }
    }
    Start-Sleep -Seconds 2
  }
  if (-not (Test-UsbBack $Letter $Label)) {
    try {
      Save-Evidence 'attach-usb-failed-vol' ((& cmd.exe /c "vol ${Letter}: 2>&1") | Out-String)
      [void](Invoke-DiskPart "rescan`r`nlist volume`r`n" 'attach-usb-failed-list-volume')
      [void](Invoke-DiskPart "list vdisk`r`n" 'attach-usb-failed-list-vdisk')
      Save-Evidence 'attach-usb-failed-get-volume-optional' ((Get-Volume -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String -Width 250))
    } catch { }
    throw "STOP: the test USB $Letter (label $Label) did not come back after attach; last seen: $seen; diskpart rescan / list volume / list vdisk and vol ${Letter}: are in evidence"
  }
}

# ---- probe data: rows and photos the restore must bring back -----------------------------------------------------------------------------------------
function Seed-Probe {
  [void](Psql 'postgres' "CREATE SCHEMA IF NOT EXISTS zz_fixture; CREATE TABLE IF NOT EXISTS zz_fixture.zz_probe(id int primary key, note text); ALTER TABLE zz_fixture.zz_probe ENABLE ROW LEVEL SECURITY; INSERT INTO zz_fixture.zz_probe SELECT g, 'row-' || g FROM generate_series(1,2000) g ON CONFLICT DO NOTHING")
  $has = Psql 'postgres' "SELECT to_regclass('storage.objects') IS NOT NULL"
  Check 'setup: the pack schema has storage.objects (photo rows)' 't' $has
  if ($has -ne 't') { return }
  [void](Psql 'postgres' "INSERT INTO storage.buckets(id, name) VALUES ('product-photos','product-photos') ON CONFLICT DO NOTHING")
  $ids = @((Psql 'postgres' "INSERT INTO storage.objects(bucket_id, name) SELECT 'product-photos', 'probe/' || g FROM generate_series(1,12) g RETURNING id") -split "`r?`n" | Where-Object { $_ -match '^[0-9a-f-]{36}$' })
  New-Item -ItemType Directory -Force (Join-Path $script:Data 'photos\product-photos') | Out-Null
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  foreach ($id in $ids) { $b = New-Object byte[] 20000; $rng.GetBytes($b); [IO.File]::WriteAllBytes((Join-Path $script:Data "photos\product-photos\$id"), $b) }
  Check 'setup: 12 photo rows with 12 photo files' 12 $ids.Count
}
# Incompressible filler in an extra folder under photos\ (an orphan "bucket": harmless to the restore, but it makes the repository big enough to measure).
function Seed-Bulk([int]$MB = 320) {
  $dir = Join-Path $script:Data 'photos\bulk-load'; New-Item -ItemType Directory -Force $dir | Out-Null
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $b = New-Object byte[] (8MB)
  for ($i = 0; $i -lt [int]($MB / 8); $i++) { $rng.GetBytes($b); [IO.File]::WriteAllBytes((Join-Path $dir ('b{0:D3}.bin' -f $i)), $b) }
  Info "setup: bulk filler written (MB)" $MB
}
function Get-DbFingerprint {
  $probe = ''
  if ((Psql 'postgres' "SELECT to_regclass('zz_fixture.zz_probe') IS NOT NULL") -eq 't') {
    $probe = Psql 'postgres' "SELECT count(*) || ':' || coalesce(md5(string_agg(id || note, ',' ORDER BY id)), 'none') FROM zz_fixture.zz_probe"
  } else { $probe = 'absent' }
  $raw = Get-RowCounts
  $rows = ($raw -replace "`r?`n", ',')
  $md5 = [BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($rows))).Replace('-', '')
  if (-not $script:FpRows) { $script:FpRows = @{} }
  $script:FpRows[$md5] = $raw   # counts only, so a mismatch can name the differing tables
  return "$probe|$md5"
}
# On a database-fingerprint mismatch, record which public tables changed count (counts only). No-op when they match or the counts are unknown.
function Info-FingerprintDiff([string]$Label, [string]$Want, [string]$Got) {
  $w = (Split-Fingerprint $Want).Db; $g = (Split-Fingerprint $Got).Db
  if ($w -eq $g) { return }
  $pw = $w -split '\|', 2; $pg = $g -split '\|', 2
  $d = if ($script:FpRows -and $script:FpRows.ContainsKey($pw[1]) -and $script:FpRows.ContainsKey($pg[1])) { Get-CountsDiff $script:FpRows[$pw[1]] $script:FpRows[$pg[1]] } else { '(counts not recorded)' }
  Info "$Label : fingerprint mismatch (probe $($pw[0]) vs $($pg[0])); table counts that differ" $(if ($d) { $d } else { 'none (probe table differs)' })
}
function Get-PhotoFingerprint {
  $d = Join-Path $script:Data 'photos\product-photos'
  return (@(Get-ChildItem $d -File -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { $_.Name + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join ',')
}
function Get-Fingerprint { return ((Get-DbFingerprint) + '#' + (Get-PhotoFingerprint)) }
function Split-Fingerprint([string]$F) { $p = $F -split '#', 2; return @{ Db = $p[0]; Photos = $p[1] } }

# ---- privacy of backups\ (acl.rs: protected DACL, owner SYSTEM or Administrators, no allow ACE for anyone else, no reparse point) ----------------------
function Test-PrivatePath([string]$Path, [bool]$NeedProtected = $true) {
  $s = Get-AclState $Path
  $sids = @($s.Aces | Where-Object { $_ -match '\|Allow\|' } | ForEach-Object { ($_ -split '\|')[0] } | Sort-Object -Unique)
  $extra = @($sids | Where-Object { $_ -ne $script:SidSystem -and $_ -ne $script:SidAdmins })
  $link = [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
  $ownerOk = ($s.Owner -eq $script:SidSystem -or $s.Owner -eq $script:SidAdmins)
  return @{ Ok = (($s.Protected -or -not $NeedProtected) -and $ownerOk -and $extra.Count -eq 0 -and -not $link); Owner = $s.Owner; Protected = $s.Protected; Extra = ($extra -join ','); Link = $link }
}
function Assert-BackupsPrivate([string]$Label, [string[]]$Expect = @()) {
  $root = Join-Path $script:Data 'backups'
  if (-not (Test-Path -LiteralPath $root)) { Add-Check "$Label : DATA\backups exists" 'present' 'missing' $false; return }
  # the root and backups\tmp must be protected DACLs (acl.rs asserts both); any other child may inherit, but its owner and every allow ACE must still be SYSTEM / Administrators only
  $tmpDir = Join-Path $root 'tmp'
  $kids = @(Get-ChildItem $root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  # the loop below covers only the children that exist now: say which, so a folder the product has not created yet is visible, and -Expect turns a missing one into a FAIL
  Info "$Label : DATA\backups children present when checked" $(if ($kids.Count -gt 0) { (($kids | ForEach-Object { Split-Path $_ -Leaf }) -join ',') } else { '(none yet)' })
  foreach ($n in $Expect) {
    $there = Test-Path -LiteralPath (Join-Path $root $n)
    Add-Check "$Label : DATA\backups\$n exists" 'present' $(if ($there) { 'present' } else { 'missing' }) $there
  }
  foreach ($p in @($root) + $kids) {
    $t = Test-PrivatePath $p ($p -eq $root -or $p -eq $tmpDir)
    Add-Check "$Label : $($p.Replace($script:Data, 'DATA')) is private (protected, owner SYSTEM/Administrators, no other allow ACE)" 'private' ("owner=$($t.Owner) protected=$($t.Protected) extra=[$($t.Extra)] link=$($t.Link)") $t.Ok
  }
}

# After any run, restore or drill: nothing secret or half-finished is left behind.
function Test-Clean([string]$Label, [string[]]$Expect = @()) {
  $b = Join-Path $script:Data 'backups'
  Check "$Label : no restore folder is left" 0 @(Get-ChildItem (Join-Path $b 'restore') -Force -ErrorAction SilentlyContinue).Count
  Check "$Label : no per-run scratch folder is left (backups\tmp\run-*)" 0 @(Get-ChildItem (Join-Path $b 'tmp') -Directory -Filter 'run-*' -Force -ErrorAction SilentlyContinue).Count
  Check "$Label : no scratch database is left" 0 @((Get-DbNames) | Where-Object { $_ -like 'pos_drill_*' -or $_ -eq 'pos_next' }).Count
  Check "$Label : no journal" $false (Test-Path (Get-UpdateReadPath 'journal.json'))
  Assert-BackupsPrivate $Label -Expect $Expect
  Assert-NoPin $Label
}

# ---- status.json: fixed words only (T10) -----------------------------------------------------------------------------------------------------------------
$script:KnownBackupAlerts = @('BACKUP_STATE_UNKNOWN', 'BACKUP_STALE_24H', 'BACKUP_STALE_72H', 'BACKUP_DEST_DOWN', 'BACKUP_DEST_FOREIGN', 'BACKUP_DEST_FAILING', 'BACKUP_DEST_NO_RECOVERY_KEY',
  'BACKUP_KEY_NOT_EXPORTED', 'BACKUP_VERIFY_FAILED', 'BACKUP_VERIFY_OVERDUE', 'BACKUP_PHOTOS_UNREADABLE', 'BACKUP_RESTORE_WARNING')
$script:ErrorWordsRx = '^(disk-full|not-connected|access-denied|wrong-key|timed-out|interrupted|failed)$'
$script:TimeRx = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
$script:NameRx = '^[a-z0-9-]{1,32}$'
$script:CodeRx = '^[A-Z0-9_]{1,48}$'
# Every key status::compute can emit (backup/status.rs: the block, destinations[], photosUnreadable, lastRestore; the alert fields). Anything else is a finding.
$script:StatusKeys = @{
  'backup' = @('configured', 'readable', 'lastSuccessAt', 'lastKind', 'ageSeconds', 'alert', 'reason', 'offDisk', 'historyUnknown', 'running', 'localLastSuccessAt', 'lastAttemptAt', 'lastAttemptOk', 'lastError',
    'destinations', 'recoveryKeyIssued', 'lastVerifyAt', 'lastVerifyOk', 'lastVerifyIncomplete', 'lastDrillAt', 'lastDrillOk', 'photosUnreadable', 'lastRestore')
  'backup.destinations' = @('name', 'kind', 'ok', 'reachable', 'foreign', 'lastSuccessAt', 'verifiedAt', 'error')
  'backup.photosUnreadable' = @('count', 'since')
  'backup.lastRestore' = @('at', 'result', 'reason', 'snapshot', 'warnings')
  'alert' = @('code', 'level', 'since', 'dest', 'dests', 'what', 'count', 'warnings', 'reason', 'error', 'message')
}
# The only string a field may hold: 'time' = RFC 3339, otherwise a regex of fixed words / short names / codes. A string field not listed here is a finding.
$script:StatusRules = @{
  'backup.lastSuccessAt' = 'time'; 'backup.localLastSuccessAt' = 'time'; 'backup.lastAttemptAt' = 'time'; 'backup.lastVerifyAt' = 'time'; 'backup.lastDrillAt' = 'time'
  'backup.alert' = '^(none|warn|critical)$'; 'backup.reason' = $script:NameRx; 'backup.lastKind' = $script:NameRx; 'backup.lastError' = $script:ErrorWordsRx
  'backup.destinations.name' = $script:NameRx; 'backup.destinations.kind' = '^(local|device|r2)$'; 'backup.destinations.error' = $script:ErrorWordsRx
  'backup.destinations.lastSuccessAt' = 'time'; 'backup.destinations.verifiedAt' = 'time'
  'backup.photosUnreadable.since' = 'time'
  'backup.lastRestore.at' = 'time'; 'backup.lastRestore.result' = '^(restored|rolled_back|failed)$'; 'backup.lastRestore.reason' = $script:CodeRx
  'backup.lastRestore.snapshot' = '^[0-9a-f]{4,64}$'; 'backup.lastRestore.warnings' = $script:CodeRx
  'alert.code' = $script:CodeRx; 'alert.level' = '^(warn|critical)$'; 'alert.since' = 'time'; 'alert.dest' = $script:NameRx; 'alert.dests' = $script:NameRx
  'alert.what' = '^(verify|drill)$'; 'alert.warnings' = $script:CodeRx; 'alert.reason' = $script:NameRx; 'alert.error' = $script:ErrorWordsRx
}
function Get-StatusProblems($Node, [string]$Path, [string]$AlertCode = '') {
  $out = @()
  if ($null -eq $Node -or $Node -is [bool] -or $Node -is [int] -or $Node -is [long] -or $Node -is [double]) { return $out }
  if ($Node -is [datetime]) { if ($script:StatusRules[$Path] -ne 'time') { $out += "$Path holds a time where none is listed" }; return $out }
  if ($Node -is [string]) {
    if ($Path -eq 'alert.message') { if ($AlertCode -ne 'BACKUP_STATE_UNKNOWN') { $out += 'alert.message outside BACKUP_STATE_UNKNOWN' }; return $out }
    $rule = $script:StatusRules[$Path]
    if (-not $rule) { return @("$Path holds a string and no string is listed for it") }
    if ($rule -eq 'time') { if ($Node -notmatch $script:TimeRx) { $out += "$Path is not an RFC 3339 time" } }
    elseif ($Node -notmatch $rule) { $out += "$Path holds a value outside its fixed words" }
    return $out
  }
  if ($Node -is [System.Collections.IEnumerable]) { foreach ($x in $Node) { $out += Get-StatusProblems $x $Path $AlertCode }; return $out }
  $allowed = $script:StatusKeys[$Path]
  if (-not $allowed) { return @("$Path is an object where none is listed") }
  foreach ($pr in $Node.PSObject.Properties) {
    if ($allowed -notcontains $pr.Name) { $out += "$Path.$($pr.Name) is not a listed field"; continue }
    $out += Get-StatusProblems $pr.Value "$Path.$($pr.Name)" $AlertCode
  }
  return $out
}
# every string value in a parsed JSON tree (a [datetime] that ConvertFrom-Json made of a time is not a string and is skipped)
function Get-JsonStrings($Node) {
  if ($null -eq $Node) { return }
  if ($Node -is [string]) { $Node; return }
  if ($Node -is [System.Collections.IEnumerable]) { foreach ($x in $Node) { Get-JsonStrings $x }; return }
  if ($Node -is [pscustomobject]) { foreach ($p in $Node.PSObject.Properties) { Get-JsonStrings $p.Value } }
}
# status.backup and the BACKUP_* alerts are a full whitelist (T10): every key listed, every string an RFC 3339 time, a short name or a fixed word - never a path, a share,
# a key or free text. configured must be true so the check cannot pass on a quiet or empty block.
function Assert-StatusBackupSafe([string]$Label, $Doc) {
  Check "$Label : status.backup.configured is true (the whitelist is judging a real block)" $true ($Doc.backup.configured -eq $true)
  $problems = @(Get-StatusProblems $Doc.backup 'backup')
  $alerts = @(@($Doc.alerts) | Where-Object { $_ -and ([string]$_.code) -like 'BACKUP_*' })
  Check "$Label : every BACKUP_* alert code is a known one" 0 @($alerts | Where-Object { $script:KnownBackupAlerts -notcontains [string]$_.code }).Count
  foreach ($a in $alerts) { $problems += @(Get-StatusProblems $a 'alert' ([string]$a.code)) }
  Add-Check "$Label : status.backup and its BACKUP_* alerts pass the full field and value whitelist" 'no problem' ("$($problems.Count) problem(s): " + (($problems | Select-Object -First 3) -join '; ')) ($problems.Count -eq 0)
  $strings = @(Get-JsonStrings $Doc.backup) + @(Get-JsonStrings $alerts)
  Check "$Label : no recovery key shape (dashed or not, any case) in status.backup" 0 @($strings | Where-Object { $_ -match $script:KeyShapeWide }).Count
}

# ---- a real console for key-export (ConPTY) ---------------------------------------------------------------------------------------------------------------
# key-export prints the key only to a console (stdout AND stdin must be terminals for the Enter pause) and refuses a pipe, a file and --result-file.
# The agent has a console (the sandbox logon command), so a child can be attached to a pseudo console and its screen read back. Verified on a Windows 11
# host with cmd.exe and powershell.exe as the child: redirected=False/False, the prompt is seen, the child waits, Enter ends it.
$script:ConPtySource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class PosConPtyResult {
  public int ExitCode = -1;
  public string Output = "";
  public bool PromptSeen;
  public bool PausedBeforeEnter;
  public bool TimedOut;
}

public static class PosConPty {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, IntPtr attrs, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr hPC);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

  // When promptText shows in the output the program must still be running after probeMs (the Enter pause); then Enter is pressed once.
  public static PosConPtyResult Run(string exe, string commandLine, int timeoutMs, string promptText, int probeMs) {
    var res = new PosConPtyResult();
    IntPtr inRead, inWrite, outRead, outWrite, hPC;
    if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw new InvalidOperationException("CreatePipe(in) " + Marshal.GetLastWin32Error());
    if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw new InvalidOperationException("CreatePipe(out) " + Marshal.GetLastWin32Error());
    COORD size = new COORD(); size.X = 4000; size.Y = 50;
    int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hPC);
    if (hr != 0) throw new InvalidOperationException("CreatePseudoConsole hr=0x" + hr.ToString("x"));
    CloseHandle(inRead); CloseHandle(outWrite);

    IntPtr listSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
    IntPtr list = Marshal.AllocHGlobal(listSize);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref listSize)) throw new InvalidOperationException("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("UpdateProcThreadAttribute " + Marshal.GetLastWin32Error());
    STARTUPINFOEX si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.lpAttributeList = list;
    // A parent with REDIRECTED std handles (the Sandbox agent) leaks them to the child even with bInheritHandles=false and no flag: the child's stdout is then the parent's pipe, not the pty,
    // is_terminal() is false and the pty stays empty. Asking for STARTF_USESTDHANDLES with NULL handles makes the child take its std handles from the pseudo console.
    si.StartupInfo.dwFlags = 0x00000100; si.StartupInfo.hStdInput = IntPtr.Zero; si.StartupInfo.hStdOutput = IntPtr.Zero; si.StartupInfo.hStdError = IntPtr.Zero;
    PROCESS_INFORMATION pi;
    var cmd = new StringBuilder(commandLine);
    if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref si, out pi))
      throw new InvalidOperationException("CreateProcessW " + Marshal.GetLastWin32Error());
    CloseHandle(pi.hThread);

    var sb = new StringBuilder();
    var outStream = new FileStream(new SafeFileHandle(outRead, false), FileAccess.Read, 4096, false);
    var inStream = new FileStream(new SafeFileHandle(inWrite, false), FileAccess.Write, 1, false);
    var reader = new Thread(delegate() {
      byte[] buf = new byte[4096];
      try {
        while (true) {
          int n = outStream.Read(buf, 0, buf.Length);
          if (n <= 0) break;
          lock (sb) { sb.Append(Encoding.UTF8.GetString(buf, 0, n)); }
        }
      } catch (Exception) { }
    });
    reader.IsBackground = true; reader.Start();

    DateTime end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    bool enterSent = false;
    while (true) {
      uint w = WaitForSingleObject(pi.hProcess, 50);
      if (w == 0) break;
      if (DateTime.UtcNow > end) { res.TimedOut = true; TerminateProcess(pi.hProcess, 1); break; }
      if (!enterSent && !String.IsNullOrEmpty(promptText)) {
        string cur; lock (sb) { cur = sb.ToString(); }
        if (cur.Contains(promptText)) {
          res.PromptSeen = true;
          res.PausedBeforeEnter = WaitForSingleObject(pi.hProcess, (uint)probeMs) != 0;
          if (res.PausedBeforeEnter) { byte[] cr = new byte[] { 13 }; inStream.Write(cr, 0, 1); inStream.Flush(); }
          enterSent = true;
        }
      }
    }
    uint code; GetExitCodeProcess(pi.hProcess, out code); res.ExitCode = (int)code;
    Thread.Sleep(400);
    ClosePseudoConsole(hPC);
    reader.Join(3000);
    lock (sb) { res.Output = sb.ToString(); }
    try { inStream.Dispose(); } catch (Exception) { }
    CloseHandle(inWrite); CloseHandle(outRead); CloseHandle(pi.hProcess);
    DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list);
    return res;
  }
}
'@
function Initialize-ConPty { if ('PosConPty' -as [type]) { return }; Add-Type -TypeDefinition $script:ConPtySource }
function ConvertFrom-VtText([string]$T) { return (($T -replace '\x1b\[[0-9;?]*[A-Za-z]', '' -replace '\x1b\][^\x07]*\x07', '') -replace "`r", '') }
# Returns Exit, Text (VT stripped), PromptSeen, PausedBeforeEnter, TimedOut and Json (the envelope line). The text is NOT saved as evidence: it holds the key.
function Info-StatusStamp($S, [string]$Label) { Info "$Label : status generatedAt / now" (("generatedAt=" + [string]$S.generatedAt + " " + (Get-ClockStamp))) }
function Invoke-PosctlConsole([string[]]$PosctlArgs, [int]$TimeoutSec = 300) {
  Initialize-ConPty
  $cmd = '"' + $script:Posctl + '" ' + (ConvertTo-ArgLine $PosctlArgs)
  $r = [PosConPty]::Run($script:Posctl, $cmd, $TimeoutSec * 1000, 'Press Enter', 3000)
  $text = ConvertFrom-VtText $r.Output
  $json = $null
  $line = @($text -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
  if ($line.Count -gt 0) { try { $json = $line[0].Trim() | ConvertFrom-Json } catch { } }
  $redacted = [regex]::Replace($text, $script:KeyShapeWide, '[recovery-key]')
  Save-Evidence ('posctl-console-' + (($PosctlArgs | Select-Object -First 2) -join '-')) ("args: $($PosctlArgs -join ' ')`nexit: $($r.ExitCode) promptSeen: $($r.PromptSeen) pausedBeforeEnter: $($r.PausedBeforeEnter)`n--- console (key redacted) ---`n$redacted")
  # a failed or key-less call: the raw screen (ESC shown as <ESC>; a failure never printed a key) and the data-folder logs, so the next run shows what posctl did
  if ($r.ExitCode -ne 0 -or $text -notmatch $script:KeyShapeWide) {
    $rawEsc = ([string]$r.Output).Replace([string][char]27, '<ESC>')
    Save-Evidence ('posctl-console-RAW-' + (($PosctlArgs | Select-Object -First 2) -join '-')) ("exit: $($r.ExitCode) timedOut: $($r.TimedOut) promptSeen: $($r.PromptSeen) rawLength: $($r.Output.Length)`n--- raw conpty text ---`n$rawEsc")
    try { Save-DataEvidence 'console-failure-logs' } catch { }
  }
  return [pscustomobject]@{ exit = $r.ExitCode; Text = $text; Line = $(if ($line.Count -gt 0) { [string]$line[0] } else { '' }); PromptSeen = $r.PromptSeen; Paused = $r.PausedBeforeEnter; TimedOut = $r.TimedOut; json = $json }
}
# One-off probe: tells the harness from the product. The SAME [PosConPty]::Run runs two throwaway children; the answer is recorded as INFO rows only (never a pass/fail).
# cmd: did PTYPROBE come back through the pty, and what size does `mode con` report. powershell: [Console]::IsOutputRedirected / IsInputRedirected / WindowWidth as the child sees them.
# If PTYPROBE is missing or Redirected is True the pty attach failed (harness); if both look like a real console and key-export still said "run key-export in a console window", it is the product.
function Test-ConPtyProbe([string]$Label = 'conpty probe') {
  try {
    Initialize-ConPty
    $cmdExe = Join-Path $env:windir 'System32\cmd.exe'
    $r = [PosConPty]::Run($cmdExe, ('"' + $cmdExe + '" /c "echo PTYPROBE & mode con"'), 30000, '', 0)
    $t = ConvertFrom-VtText $r.Output
    Info "$Label : cmd.exe through the pty: exit, PTYPROBE seen, mode con" ("exit=$($r.ExitCode) seen=$($t.Contains('PTYPROBE')) timedOut=$($r.TimedOut) text=" + (($t -replace '\s+', ' ').Trim() | ForEach-Object { $_.Substring(0, [Math]::Min(300, $_.Length)) }))
    $psExe = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $r2 = [PosConPty]::Run($psExe, ('"' + $psExe + '" -NoProfile -Command "Write-Output (\"PSPROBE out_redirected=\" + [Console]::IsOutputRedirected + \" in_redirected=\" + [Console]::IsInputRedirected + \" width=\" + [Console]::WindowWidth)"'), 60000, '', 0)
    $t2 = ConvertFrom-VtText $r2.Output
    Info "$Label : powershell.exe through the pty: exit, console flags as the child sees them" ("exit=$($r2.ExitCode) text=" + (($t2 -replace '\s+', ' ').Trim() | ForEach-Object { $_.Substring(0, [Math]::Min(300, $_.Length)) }))
  } catch { Info "$Label : the probe itself failed" $_.Exception.Message }
}
# `backup key-export` on the console. Returns Key (a run-time value: never put it in a Check actual), Exit, Json, Paused.
function Export-RecoveryKey([switch]$Rotate, [string]$Label = 'key-export') {
  $a = @('backup', 'key-export'); if ($Rotate) { $a += '--rotate' }
  $r = Invoke-PosctlConsole $a
  Check "$Label : exits 0" 0 $r.exit
  $m = [regex]::Matches($r.Text, $script:KeyShape)
  $key = ''; if ($m.Count -gt 0) { $key = $m[0].Value }
  $inLine = 0; if ($r.Line) { $inLine = [regex]::Matches($r.Line, $script:KeyShape).Count }
  Check "$Label : the key has the documented shape and is in the envelope line exactly once" 1 $inLine
  Check "$Label : the console text shows it at least once (a pseudo console may redraw the screen)" $true ($m.Count -ge 1)
  Check "$Label : the key is shown through envelope field data.recovery.key" $true ($r.json -and $r.json.data.recovery.key -eq $key)
  Check "$Label : the console waits for Enter after the key is printed (the window cannot close with the key on it)" $true ($r.PromptSeen -and $r.Paused)
  return [pscustomobject]@{ Key = $key; Exit = $r.exit; Json = $r.json; Paused = $r.Paused }
}
# The key must be in no file the product or the scenario wrote: logs, state, conf, secrets, work, tmp, the posctl evidence of this run, and the escrow copy.
function Assert-KeyNowhere([string]$Label, [string]$Key) {
  $roots = @('logs', 'state', 'conf', 'secrets', 'work', 'tmp', 'client', 'backups\tmp') | ForEach-Object { Join-Path $script:Data $_ }
  $roots += @((Join-Path $script:Data 'backups\escrow.age'), (Join-Path $script:Data 'backups\backup.lock'), 'C:\out\evidence', 'C:\out\checks.jsonl', 'C:\out\result.json')
  $roots += @(Get-ChildItem 'C:\out' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(out|err)\.txt$' } | ForEach-Object { $_.FullName })
  # Select-String (Find-Text) is case-insensitive: both the dashed and the undashed spelling are searched
  Reset-FindScan
  $hits = @(); $absent = @()
  foreach ($r in $roots) { if (Test-Path $r) { foreach ($needle in @($Key, $Key.Replace('-', ''))) { $hits += @(Find-Text $r $needle) } } else { $absent += $r.Replace($script:Data, 'DATA') } }
  if ($absent.Count -gt 0) { Info "$Label : key scan: paths that do not exist (nothing to scan there)" ($absent -join ', ') }
  Close-FindScan $Label 'key'
  Check "$Label : the recovery key (dashed or not, any case) is in no log, state, conf, secret, work, tmp, evidence, result or posctl output file" 0 $hits.Count
}

# The admin PIN and the GoTrue password derived from it (with every pepper this scenario used) must be in no file a backup, restore or drill could have written. The row's actual
# is a count, never the value. backups\repo is excluded: it is encrypted and large.
$script:ExtraPeppers = @()
function Assert-NoPin([string]$Label) {
  if (-not $script:AdminPin -or -not $script:AdminId) { Info "$Label : admin PIN scan not run" 'no admin PIN in memory (see the setup capture check)'; return }
  $needles = @($script:AdminPin)
  foreach ($pp in (@(Get-Pepper) + @($script:ExtraPeppers))) { if ($pp) { $needles += (Get-DerivedPassword $script:AdminId $script:AdminPin ([string]$pp)) } }
  $roots = @('logs', 'state', 'conf', 'work', 'tmp') | ForEach-Object { Join-Path $script:Data $_ }
  $roots += @(Get-ChildItem (Join-Path $script:Data 'backups') -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'repo' } | ForEach-Object { $_.FullName })
  # product-written files only: posctl's captured output (evidence\posctl-*, evidence data copies, *.out/err.txt). The harness's own numeric dumps (checks.jsonl, result.json,
  # latency rows) are left out: a six-digit number in them is not the PIN.
  $ev = Join-Path $script:OutDir 'evidence'
  $roots += @(Get-ChildItem $ev -Force -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer -or $_.Name -match '^\d{3}-posctl-' } | ForEach-Object { $_.FullName })
  $roots += @(Get-ChildItem 'C:\out' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(out|err)\.txt$' } | ForEach-Object { $_.FullName })
  $names = @()
  Reset-FindScan
  $absentPin = @()   # digit-bounded for the PIN (Find-Text); file NAMES only, never the match
  foreach ($r in $roots) { if (Test-Path $r) { foreach ($needle in $needles) { $names += @(Find-Text $r $needle | ForEach-Object { Split-Path $_ -Leaf }) } } else { $absentPin += $r.Replace($script:Data, 'DATA') } }
  if ($absentPin.Count -gt 0) { Info "$Label : PIN scan: paths that do not exist (nothing to scan there)" ($absentPin -join ', ') }
  Close-FindScan $Label 'PIN'
  $names = @($names | Sort-Object -Unique)
  Add-Check "$Label : the admin PIN and its derived password are in no product-written file (logs, state, conf, work, tmp, backups except repo, posctl output)" 'no file' $(if ($names.Count -eq 0) { 'no file' } else { 'in: ' + ($names -join ', ') }) ($names.Count -eq 0)
}

# ---- a stdin the helper cannot send: exact bytes (BOM, CRLF, case, no dashes) -----------------------------------------------------------------------
function Invoke-PosctlStdinBytes([string[]]$PosctlArgs, [byte[]]$Bytes, [string]$Tag = 'stdin-bytes', [int]$TimeoutSec = 3600) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:Posctl; $psi.Arguments = ConvertTo-ArgLine $PosctlArgs
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  $p.StandardInput.BaseStream.Write($Bytes, 0, $Bytes.Length); $p.StandardInput.BaseStream.Flush(); $p.StandardInput.Close()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill(); throw "posctl timed out after $TimeoutSec s" }
  $p.WaitForExit()
  $raw = $so.Result.Trim(); $json = $null; try { $json = $raw | ConvertFrom-Json } catch { }
  Save-Evidence ("posctl-$Tag") ("args: $($PosctlArgs -join ' ')`nexit: $($p.ExitCode)`n--- stdout ---`n$raw`n--- stderr ---`n$($se.Result)")
  return [pscustomobject]@{ exit = $p.ExitCode; json = $json; raw = $raw; err = $se.Result; Stderr = $se.Result }
}

# ---- scheduled tasks ---------------------------------------------------------------------------------------------------------------------------------------------
function Get-TaskXml([string]$Name) { return ((schtasks.exe /Query /TN ("\SupermarketPOS\" + $Name) /XML 2>&1) | Out-String) }
# Starts the task through the scheduler (as its own principal) and waits until it has run and stopped.
function Invoke-TaskNow([string]$Name, [int]$TimeoutSec = 900) {
  $before = (Get-TaskInfo $Name).LastRun
  [void](schtasks.exe /Change /TN ("\SupermarketPOS\" + $Name) /ENABLE 2>&1)
  [void](schtasks.exe /Run /TN ("\SupermarketPOS\" + $Name) 2>&1)
  # State is Enabled/Disabled; the run state is the Status field. 267009 (0x41301) = the task is currently running.
  $ok = Wait-Until { $i = Get-TaskInfo $Name; ($i.LastRun -ne $before) -and ($i.Status -ne 'Running') -and ([string]$i.LastResult -ne '267009') -and ([string]$i.LastResult -ne '0x41301') } $TimeoutSec 2
  # always one row per call, id unique and stable (call order is deterministic), so the id set is the same in passing and failing runs
  $script:TaskNowSeq++; $i = Get-TaskInfo $Name
  Add-Check "task $Name run #$($script:TaskNowSeq) finished within $TimeoutSec s" 'Status not Running, LastResult not 267009' ("Status=$($i.Status) LastResult=$($i.LastResult) LastRun=$($i.LastRun)") $ok
  Start-Sleep -Seconds 2
  [void](schtasks.exe /Change /TN ("\SupermarketPOS\" + $Name) /DISABLE 2>&1)
  return $ok
}
function Get-BackupLogLines {   # every JSON line of logs\posctl\backup-<yyyyMMdd>.log, oldest first
  $d = Join-Path $script:Data 'logs\posctl'
  $out = @()
  foreach ($f in @(Get-ChildItem $d -Filter 'backup-2*.log' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
    foreach ($l in @(Get-Content -LiteralPath $f.FullName)) { if ($l) { try { $out += ($l | ConvertFrom-Json) } catch { } } }
  }
  return $out
}

# ---- the system clock (due-based tasks and 24 h / 72 h alerts) ---------------------------------------------------------------------------------------------
# The sandbox is disposable. Time travel is the only way to reach "a day later" / "a week later" inside the scenario timeout. Always paired with Restore-Clock.
$script:ClockShiftDays = 0.0
# Everything is computed in UTC and converted explicitly to local for Set-Date, so a time-zone offset or DST edge can never turn "+25 h" into "+24 h" or "+26 h" (Sandbox 41: the local clock
# read 21:42 -> 20:42 -> 21:42 while UTC stayed continuous). After each change the UTC clock is read back and must have moved by the intended amount; the row is always emitted (stable id per call).
$script:ClockBaseUtc = $null; $script:ClockWatch = $null; $script:ClockSeq = 0; $script:ClockSvcSaved = @(); $script:ClockSvcHeld = $false
# Set-Date alone was not enough evidence in the guest (WDAGUtilityAccount: UTC unmoved, no error seen). So: Set-Date -ErrorAction Stop with the error text kept; only if it throws, SetSystemTime by P/Invoke after
# enabling SeSystemtimePrivilege, with the Win32 return and error reported. Compiled only inside the Sandbox scripts (never run on the host).
$script:ClockSource = @'
using System;
using System.Runtime.InteropServices;
public static class PosClock {
  [StructLayout(LayoutKind.Sequential)] struct SYSTEMTIME { public ushort wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds; }
  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public uint Count; public LUID Luid; public uint Attr; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValueW(string sys, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr tok, bool disableAll, ref TOKEN_PRIVILEGES np, uint len, IntPtr prev, IntPtr retLen);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetSystemTime(ref SYSTEMTIME st);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  // "ok" or the reason (which Win32 call failed and its error number).
  public static string SetUtc(DateTime utc) {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out tok)) return "OpenProcessToken failed, error " + Marshal.GetLastWin32Error();   // TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY
    try {
      TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES(); tp.Count = 1; tp.Attr = 2;                                                            // SE_PRIVILEGE_ENABLED
      if (!LookupPrivilegeValueW(null, "SeSystemtimePrivilege", out tp.Luid)) return "LookupPrivilegeValue failed, error " + Marshal.GetLastWin32Error();
      AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
      int adj = Marshal.GetLastWin32Error();
      if (adj != 0) return "SeSystemtimePrivilege not enabled (AdjustTokenPrivileges error " + adj + "; 1300 = the token does not hold it)";
    } finally { CloseHandle(tok); }
    DateTime u = utc.ToUniversalTime();
    SYSTEMTIME st = new SYSTEMTIME();
    st.wYear = (ushort)u.Year; st.wMonth = (ushort)u.Month; st.wDay = (ushort)u.Day; st.wHour = (ushort)u.Hour; st.wMinute = (ushort)u.Minute; st.wSecond = (ushort)u.Second; st.wMilliseconds = (ushort)u.Millisecond;
    if (!SetSystemTime(ref st)) return "SetSystemTime returned false, error " + Marshal.GetLastWin32Error();
    return "ok";
  }
}
'@
function Get-ClockStamp { return ('utc=' + [DateTime]::UtcNow.ToString('o') + ' local=' + (Get-Date).ToString('o') + ' tz=' + (Get-TimeZone).Id) }
function Initialize-PosClock { if ('PosClock' -as [type]) { return }; Add-Type -TypeDefinition $script:ClockSource }
function Get-ClockDiag([string]$Label, $SinceUtc) {   # INFO rows only: privilege, services, w32tm, and (after a shift) the System events that explain a reset
  try { $pv = @(& whoami.exe /priv 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match 'SeSystemtimePrivilege' }); Info "$Label : whoami /priv SeSystemtimePrivilege" $(if ($pv.Count) { ($pv -join ' | ').Trim() } else { 'line absent (the token does not hold it)' }) } catch { Info "$Label : whoami /priv" $_.Exception.Message }
  foreach ($n in 'W32Time', 'vmictimesync') { $sv = Get-Service -Name $n -ErrorAction SilentlyContinue; Info "$Label : service $n" $(if ($sv) { "status=$($sv.Status) startType=$($sv.StartType)" } else { 'not present' }) }
  try { $w = @(& w32tm.exe /query /status 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match 'Source|Last Successful Sync|Leap|Stratum|error|0x8' } | Select-Object -First 6); Info "$Label : w32tm /query /status" ($w -join ' | ') } catch { Info "$Label : w32tm" $_.Exception.Message }
  if ($SinceUtc) {
    try {
      $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = ([DateTime]$SinceUtc).ToLocalTime().AddSeconds(-2); Id = 1, 35, 37, 158 } -ErrorAction Stop | Where-Object { $_.ProviderName -match 'Kernel-General|Time-Service|W32Time' } | Select-Object -First 8)
      $lines = @($ev | ForEach-Object { $m = ($_.Message -replace '\s+', ' '); "$($_.ProviderName)/$($_.Id)/$($_.TimeCreated.ToString('o'))/" + $m.Substring(0, [Math]::Min(120, $m.Length)) })
      Info "$Label : System events since the shift (Kernel-General 1, Time-Service 35/37/158)" $(if ($lines.Count) { $lines -join ' || ' } else { 'none' })
    } catch { Info "$Label : System events since the shift" ('none or unreadable: ' + $_.Exception.Message) }
  }
}
# Whatever re-syncs the guest clock (W32Time, the Hyper-V time-sync integration service) is stopped and disabled before the first shift; Restore-Clock puts both back.
function Stop-ClockSync {
  foreach ($n in 'W32Time', 'vmictimesync') {
    $svc = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($null -eq $svc) { continue }
    $script:ClockSvcSaved += [pscustomobject]@{ Name = $n; Status = [string]$svc.Status; StartType = [string]$svc.StartType }
    try { Set-Service -Name $n -StartupType Disabled -ErrorAction Stop } catch { Info "clock sync service $n : could not disable" $_.Exception.Message }
    try { Stop-Service -Name $n -Force -ErrorAction Stop } catch { Info "clock sync service $n : could not stop" $_.Exception.Message }
  }
  $script:ClockSvcHeld = $true
}
function Restore-ClockSync {
  foreach ($x in @($script:ClockSvcSaved)) {
    try {
      $st = [string]$x.StartType; if ($st -eq 'Automatic' -or $st -eq 'Manual' -or $st -eq 'Disabled') { Set-Service -Name $x.Name -StartupType $st -ErrorAction Stop }
      if ($x.Status -eq 'Running') { Start-Service -Name $x.Name -ErrorAction Stop }
    } catch { Info "clock sync service $($x.Name) : could not restore" $_.Exception.Message }
  }
  $script:ClockSvcSaved = @(); $script:ClockSvcHeld = $false
}
function Set-ClockUtc([DateTime]$TargetUtc, [string]$What) {
  $script:ClockSeq++
  Initialize-PosClock
  $beforeUtc = [DateTime]::UtcNow
  if ($script:ClockSeq -eq 1) { Get-ClockDiag "clock #1 $What : before the first shift" $null }
  Info "clock #$($script:ClockSeq) $What : before" (Get-ClockStamp)
  $local = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::SpecifyKind($TargetUtc, [DateTimeKind]::Utc), [TimeZoneInfo]::Local)   # Kind Local
  $setErr = ''
  try { Set-Date -Date $local -ErrorAction Stop | Out-Null } catch { $setErr = $_.Exception.Message }
  $fallback = ''
  if ($setErr) { $fallback = [PosClock]::SetUtc($TargetUtc) }
  $u0 = [DateTime]::UtcNow
  Start-Sleep -Seconds 5
  $u5 = [DateTime]::UtcNow
  $ok0 = [Math]::Abs(($u0 - $TargetUtc).TotalSeconds) -lt 15
  $ok5 = [Math]::Abs(($u5 - $TargetUtc).TotalSeconds) -lt 15
  $cause = 'ok'
  if (-not $ok5) {
    if ($setErr -and $fallback -ne 'ok') { $cause = "Set-Date error: $setErr; SetSystemTime fallback: $fallback" }
    elseif ($ok0) { $cause = 'moved then reset within 5 s (see events)' }
    elseif ($setErr) { $cause = "Set-Date error: $setErr; SetSystemTime fallback said ok but the clock did not move" }
    else { $cause = 'no change' }
  }
  Info "clock #$($script:ClockSeq) $What : after" (Get-ClockStamp)
  Get-ClockDiag "clock #$($script:ClockSeq) $What : after" $beforeUtc
  Add-Check "clock #$($script:ClockSeq) $What : UTC is at the intended time (checked at +0 s and +5 s)" 'UTC within 15 s of the target at +0 s and +5 s' ("cause=$cause; target=$($TargetUtc.ToString('o')) before=$($beforeUtc.ToString('o')) +0s=$($u0.ToString('o')) +5s=$($u5.ToString('o')); Set-Date error='$setErr'; SetSystemTime fallback='$fallback'") ($ok0 -and $ok5)
}
function Set-ClockForward([double]$Hours) {
  if ($null -eq $script:ClockBaseUtc) { $script:ClockBaseUtc = [DateTime]::UtcNow; $script:ClockWatch = [Diagnostics.Stopwatch]::StartNew() }
  if (-not $script:ClockSvcHeld) { Stop-ClockSync }
  $script:ClockShiftDays += ($Hours / 24.0)
  Set-ClockUtc ([DateTime]::UtcNow.AddHours($Hours)) ("forward $Hours h")
}
# Back to the saved UTC plus the real time that passed since the first shift (not a relative AddDays, which depends on the local offset).
function Restore-Clock {
  if ($script:ClockShiftDays -ne 0 -and $null -ne $script:ClockBaseUtc) {
    Set-ClockUtc ($script:ClockBaseUtc.AddTicks($script:ClockWatch.Elapsed.Ticks)) 'restore'
    $script:ClockShiftDays = 0.0; $script:ClockBaseUtc = $null; $script:ClockWatch = $null
    Restore-ClockSync
  }
}

# ---- till responsiveness: what a till feels while a backup job hammers the disk ------------------------------------------------------------------------------
# Two LAN requests per round: the health route and a PostgREST read (the gateway fronts both). Latency in ms, failures counted.
function Get-TillSample {
  $anon = (Get-StoreKeys).anon
  $sw = [Diagnostics.Stopwatch]::StartNew(); $h = Invoke-LanCurl 'GET' '/_store/health' '127.0.0.1' 10; $a = $sw.Elapsed.TotalMilliseconds
  $sw.Restart(); $d = Invoke-LanCurl 'GET' '/rest/v1/store_schema_version?select=max_version' '127.0.0.1' 10 $anon; $b = $sw.Elapsed.TotalMilliseconds
  # availability, not authorization: the gateway answered the health route with 200 and PostgREST answered at all (any status below 500)
  return @{ HealthMs = $a; DbMs = $b; Ok = ($h.status -eq 200 -and $d.status -ge 200 -and $d.status -lt 500) }
}
function Measure-Till([int]$Count) { $r = @(); for ($i = 0; $i -lt $Count; $i++) { $r += , (Get-TillSample); Start-Sleep -Milliseconds 200 }; return $r }
function Format-Stats($Samples, [string]$Field) {
  $v = @($Samples | ForEach-Object { $_[$Field] } | Sort-Object)
  if ($v.Count -eq 0) { return @{ N = 0; Mean = 0; P95 = 0; Max = 0 } }
  $p = $v[[Math]::Min($v.Count - 1, [int][Math]::Ceiling($v.Count * 0.95) - 1)]
  return @{ N = $v.Count; Mean = [Math]::Round(($v | Measure-Object -Average).Average, 0); P95 = [Math]::Round($p, 0); Max = [Math]::Round($v[$v.Count - 1], 0) }
}
# Samples the till while the async posctl (Start-PosctlAsync) runs. Records the numbers as Info and passes on a threshold: no failed request, p95 under
# $P95Ms and worst case under $MaxMs for both routes. The Sandbox disk is a virtual SSD: the HDD figure belongs to the real-hardware plan (Info row).
function Measure-TillWhile($Handle, [string]$Label, [int]$P95Ms = 1500) {
  $s = @()
  while (-not $Handle.Process.HasExited) { $s += , (Get-TillSample); Start-Sleep -Milliseconds 200 }   # sampling starts at once: a short job must not end inside a warm-up
  $base = Measure-Till 12   # idle baseline, taken after the job
  $hb = Format-Stats $base 'HealthMs'; $db = Format-Stats $base 'DbMs'; $hs = Format-Stats $s 'HealthMs'; $ds = Format-Stats $s 'DbMs'
  $fail = @($s | Where-Object { -not $_.Ok }).Count
  Info "$Label : till idle baseline (after the job) health ms (n/mean/p95/max)" ("{0}/{1}/{2}/{3}" -f $hb.N, $hb.Mean, $hb.P95, $hb.Max)
  Info "$Label : till idle baseline (after the job) db read ms (n/mean/p95/max)" ("{0}/{1}/{2}/{3}" -f $db.N, $db.Mean, $db.P95, $db.Max)
  Info "$Label : till during the job, health ms (n/mean/p95/max)" ("{0}/{1}/{2}/{3}" -f $hs.N, $hs.Mean, $hs.P95, $hs.Max)
  Info "$Label : till during the job, db read ms (n/mean/p95/max)" ("{0}/{1}/{2}/{3}" -f $ds.N, $ds.Mean, $ds.P95, $ds.Max)
  Check "$Label : the job ran long enough to be measured (at least 3 rounds)" $true ($s.Count -ge 3)
  Check "$Label : no till request failed while the job ran" 0 $fail
  $budgetH = [Math]::Max($P95Ms, 5 * $hb.P95); $budgetD = [Math]::Max($P95Ms, 5 * $db.P95)
  Info "$Label : worst single till request ms (health / db read), recorded not judged" ("{0} / {1}" -f $hs.Max, $ds.Max)
  Add-Check "$Label : till p95 under max($P95Ms ms, 5x the idle p95) on both routes" "health p95<$budgetH db p95<$budgetD" ("health p95={0}; db p95={1}" -f $hs.P95, $ds.P95) ($s.Count -gt 0 -and $hs.P95 -lt $budgetH -and $ds.P95 -lt $budgetD)
}

# ---- restore kill matrix (scenarios 46 / 47) ------------------------------------------------------------------------------------------------------------------
# Same shape as lib-update's Invoke-KillMatrix, for `backup restore --snapshot latest --swap`. Per label: the store is put back to "backup taken, then damaged",
# the restore is killed (exit 137, the OS releases the lock) at the hook point, the journal is on disk and says so, a second restore is refused with 17,
# `update --recover` finishes or undoes it, and the data is the restored data or the damaged data - never a mixture. $Expect: {param($label) 'GOOD'|'DAMAGED'|'EITHER'}.
function Invoke-RestoreKillMatrix([string[]]$Labels, [string]$Tag, [scriptblock]$Expect, [string]$Good, [string]$Damaged, [switch]$SignIn) {
  $g = Split-Fingerprint $Good; $d = Split-Fingerprint $Damaged
  $pre = New-PreSnapshot
  $consistentPre = @{ StartTypes = $pre.StartTypes }
  $first = $true
  foreach ($label in $Labels) {
    if (-not $first) { Reset-Store }
    $first = $false
    $t = ($label -replace '[^A-Za-z0-9]', '_')
    [void](Psql 'postgres' 'DROP TABLE IF EXISTS zz_fixture.zz_probe')
    Get-ChildItem (Join-Path $script:Data 'photos\product-photos') -File -ErrorAction SilentlyContinue | Select-Object -First 5 | Remove-Item -Force
    $dmg = Get-Fingerprint
    Check "$label : the damage is real before the restore" $true ($dmg -ne $Good)
    $watch = $label -notmatch 'after:reopen_gateway|finalize'
    if ($watch) {
      $poll = Join-Path $script:OutDir ("poll-$Tag-$t.jsonl"); Remove-Item $poll -Force -ErrorAction SilentlyContinue
      $job = Start-FencePoller $poll
      Assert-PollerConnects "$label" $poll
    }
    $r = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') "$Tag-kill-$t" (Hooks @{ exit_at = $label })
    Check "$label : the restore process was killed (137)" 137 $r.exit
    $j = Get-JournalDoc
    if ($label -like 'journal:*') { Assert-JournalAt $label $label }
    if ($j -ne $null) {
      Check "$label : the journal is a restore journal" 'restore' ([string]$j.kind)
      $h = Invoke-Posctl @('health', '--write') -Tag "$Tag-health-$t"
      Check "$label : health exits 17 (RECOVERY_NEEDED) with the journal left behind" 17 $h.exit
      Check "$label : status.json state is recovery-needed" 'recovery-needed' ([string](Read-JsonFile (Join-Path $script:Data 'state\status.json')).state)
      $again = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') "$Tag-again-$t"
      Check "$label : a second restore while the journal is on disk is refused with 17" 17 $again.exit
      Check "$label : ... and leaves the journal alone" $true (Test-Path (Get-UpdateReadPath 'journal.json'))
    } else { Add-Check "$label : a restore journal is on disk after the kill (the journal, health and second-restore checks need it)" 'present' 'missing' $false }
    $rec = Invoke-Posctl @('update', '--recover') -Tag "$Tag-recover-$t"
    Assert-Exit "$label : update --recover" $rec 'OK'
    if ($watch) {
      Start-Sleep -Seconds 2; Stop-LanPoller $job; Assert-KilledFenceWindow $label $poll
      if ($label -notin @('journal:started:done', 'journal:fence:intent')) {
        $nf = Get-FenceRowCount $poll
        Check "$label : fenced - the poller saw data-path 503 STORE_UPDATING rows ($nf)" $true ($nf -gt 0)
      }
    }
    Assert-ConsistentStore $label $null $consistentPre
    Assert-NoPin "$label"
    $after = Get-Fingerprint; $a = Split-Fingerprint $after
    $want = & $Expect $label
    $dbOk = switch ($want) { 'GOOD' { $a.Db -eq $g.Db } 'DAMAGED' { $a.Db -eq $d.Db } default { $a.Db -eq $g.Db -or $a.Db -eq $d.Db } }
    Check "$label : the database is the $want state (never a mixture)" $true $dbOk
    if (-not $dbOk) { Info-FingerprintDiff "$label vs good" $Good $after }
    # photos are only ever ADDED (after the database proved itself), so before the swap they may already be back
    $phOk = if ($want -eq 'GOOD') { $a.Photos -eq $g.Photos } else { $a.Photos -eq $g.Photos -or $a.Photos -eq $d.Photos }
    Check "$label : the photo files are the restored set or the damaged set, never partial" $true $phOk
    [void](Assert-StatusState $label 'running')
    Check "$label : the postgres name is live and no pos_next remains" $true ((Get-DbNames) -contains 'postgres' -and -not ((Get-DbNames) -contains 'pos_next'))
    if ($SignIn) {
      $s = Invoke-AdminGrant
      Check "$label : the admin signs in to the recovered store through GoTrue (HTTP 200 + access_token)" $true ($s.Status -eq 200 -and $s.Body -match 'access_token')
    }
  }
  Assert-NoSecrets $Tag
}

# One kill-matrix scenario: a store with probe data and a backup, damaged the same way before every restore. $Select picks the labels (a Where-Object scriptblock over
# `dev hook-labels`), $Expect says per label what the data must be after `update --recover`, $Count is how many labels the slice must hold (a label list that
# silently shrank is a failure, not a pass).
function Invoke-RestoreKillScenario([string]$Id, [scriptblock]$Select, [scriptblock]$Expect, [int]$Count) {
  Install-BackupStore -Hashed
  Seed-Probe
  $b = Backup-Now 'manual' "$Id-backup"
  Check "$Id setup: the backup exits 0" 0 $b.exit
  $good = Get-Fingerprint
  Save-Pristine   # Reset-Store returns to "probe data, backup taken, tills open"
  [void](Psql 'postgres' 'DROP TABLE zz_fixture.zz_probe')
  Get-ChildItem (Join-Path $script:Data 'photos\product-photos') -File | Select-Object -First 5 | Remove-Item -Force
  $damaged = Get-Fingerprint
  Check "$Id setup: the damaged state differs from the good state" $true ($damaged -ne $good)
  Reset-Store
  $reset = Get-Fingerprint
  Check "$Id setup: Reset-Store returns the good state" $good $reset
  Info-FingerprintDiff "$Id setup" $good $reset
  $labels = @(Get-KillLabels | Where-Object $Select)
  Check "$Id the slice holds $Count kill labels" $Count $labels.Count
  Info "$Id kill labels" ($labels -join ', ')
  Invoke-RestoreKillMatrix $labels $Id $Expect $good $damaged -SignIn
  return @{ Results = (Get-Results); Reboot = $false }
}
