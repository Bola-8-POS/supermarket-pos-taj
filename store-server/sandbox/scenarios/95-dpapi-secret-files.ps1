# 95 - DPAPI-wrapped secret files (Plan 11 slice 11S, Task 17/18). WRITTEN, NOT YET RUN: the first real run is the slice gate.
# Proves on a real store: after provision and a backup run, every posctl-only secret file starts with POSDPAPI1 and holds no 64-hex run; the files that other
# programs read (pgpass.conf, pgpass-backup.conf, restic-password.txt, gotrue.env, postgrest.conf) stay plaintext; then, with every wrapped file put back to
# the pre-11S plaintext form, an update and a backup run rewrap all of them (no plaintext leftover), the services start, a real GoTrue sign-in with the
# derived password works, and backup + restore --swap still pass. A damaged wrapped file stops the command and is neither replaced nor regenerated.
# Red once: the checker itself is shown to fail on a plaintext file (a plaintext file left behind fails the check).
# No secret value is printed or stored: files are read inside the Sandbox, only verdicts and file names reach the results. Estimated 30 minutes.
. C:\scenarios\lib-backup.ps1

$script:DpapiMagic = [Text.Encoding]::ASCII.GetBytes("POSDPAPI1`n")
$script:Latin1 = [Text.Encoding]::GetEncoding(28591)

function Get-WrappedFileNames {   # posctl-only: no other process reads these (store-server/src/dpapi.rs, Plan 11 section 3.6)
  $n = @('jwt-secret.txt', 'keys.json', 'staff-password-pepper.txt', 'pg-supabase_admin.pw', 'pg-postgres.pw', 'pg-authenticator.pw', 'pg-supabase_auth_admin.pw')
  if (Test-Path (Join-Path $script:Data 'secrets\pg-pos_backup.pw')) { $n += 'pg-pos_backup.pw' }
  return $n
}
# a non-posctl reader each; r2.env is hand-placed by the owner and sits beside restic-password.txt (plaintext), so wrapping it adds little and breaks hand edits
$script:PlainFileNames = @('pgpass.conf', 'pgpass-backup.conf', 'restic-password.txt', 'r2.env', 'gotrue.env', 'postgrest.conf')

function Test-DpapiWrapped([string]$Path) {   # true only when the file starts with the magic line AND holds no 64-hex run
  if (-not (Test-Path $Path)) { return $false }
  $b = [IO.File]::ReadAllBytes($Path)
  if ($b.Length -lt $script:DpapiMagic.Length) { return $false }
  for ($i = 0; $i -lt $script:DpapiMagic.Length; $i++) { if ($b[$i] -ne $script:DpapiMagic[$i]) { return $false } }
  return (-not [regex]::IsMatch($script:Latin1.GetString($b), '[0-9a-fA-F]{64}'))
}
function Get-NotWrapped([string[]]$Names) {
  return @($Names | Where-Object { -not (Test-DpapiWrapped (Join-Path $script:Data "secrets\$_")) })
}
function Get-OptionalFileNames { return @(Get-ChildItem (Join-Path $script:Data 'secrets') -Filter 'optional-*.txt' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }
function Assert-AllWrapped([string]$Label) {
  $names = @(Get-WrappedFileNames) + @(Get-OptionalFileNames)
  Check "$Label : every posctl-only secret file is wrapped and holds no 64-hex run (none listed = none left in plaintext)" '' ((Get-NotWrapped $names) -join ',')
  $stillPlain = @($script:PlainFileNames | Where-Object { (Test-Path (Join-Path $script:Data "secrets\$_")) -and (Test-DpapiWrapped (Join-Path $script:Data "secrets\$_")) })
  Check "$Label : the files other programs read stay plaintext (none wrapped)" '' ($stillPlain -join ',')
}
function Set-LegacyPlaintext([string[]]$Names) {   # the pre-11S form: the exact text, no BOM, written in place
  foreach ($n in $Names) {
    $p = Join-Path $script:Data "secrets\$n"
    $t = Read-SecretFileText $p
    [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))
  }
}
function Assert-StoreWorks([string]$Label) {
  Check "$Label : all five services are running" $true (Test-AllRunning)
  $g = Invoke-AdminGrant
  Check "$Label : a real GoTrue sign-in with the derived password works (the wrapped pepper was read)" $true ($g.Status -eq 200 -and $g.Body -match 'access_token')
}

function Invoke-Scenario([int]$Phase) {
  Install-BackupStore
  Seed-Probe
  $b0 = Backup-Now 'manual' 'backup-95-first'   # creates the machine key, pgpass-backup.conf and pg-pos_backup.pw
  Check '95 the first backup exits 0' 0 $b0.exit

  # ---- after provision + backup: wrapped where posctl is the only reader --------------------------------------------------------------------------------------
  Check '95 the backup role password file exists (so it is covered below)' $true (Test-Path (Join-Path $script:Data 'secrets\pg-pos_backup.pw'))
  Assert-AllWrapped '95 after provision'
  Assert-StoreWorks '95 after provision'
  Assert-NoSecrets '95 after provision'

  # ---- red once: the checker fails on a plaintext file --------------------------------------------------------------------------------------------------------
  $decoy = Join-Path $script:Data 'secrets\zz-95-decoy.txt'
  $rb = New-RandomBytes 32
  [IO.File]::WriteAllText($decoy, ([BitConverter]::ToString($rb).Replace('-', '').ToLower()), (New-Object Text.UTF8Encoding($false)))
  Check '95 negative control: the checker rejects a plaintext 64-hex file' $false (Test-DpapiWrapped $decoy)
  Remove-Item $decoy -Force

  # ---- the pre-11S state: every wrapped file back to plaintext, then an update and a backup run must rewrap all of them ---------------------------------------------
  $names = @(Get-WrappedFileNames) + @(Get-OptionalFileNames)
  $daclBefore = @{}
  foreach ($n in $names) { $daclBefore[$n] = (Get-Acl (Join-Path $script:Data "secrets\$n")).GetSecurityDescriptorSddlForm('Access') }
  Set-LegacyPlaintext $names
  Check '95 setup: the legacy plaintext form is in place (every one of them now fails the checker)' $names.Count (@(Get-NotWrapped $names)).Count
  $u = Bk @('update', '--pack', $script:NewV) 'update-95' (Hooks @{ backup = 'ok' })
  Assert-Exit '95 the update from plaintext files succeeds' $u 'OK'
  $b1 = Backup-Now 'manual' 'backup-95-second'   # reads pg-pos_backup.pw: it is the one file only a backup run touches
  Check '95 the backup after the update exits 0' 0 $b1.exit
  Assert-AllWrapped '95 after the update and a backup (no plaintext leftover)'
  $daclMoved = @($names | Where-Object { (Get-Acl (Join-Path $script:Data "secrets\$_")).GetSecurityDescriptorSddlForm('Access') -ne $daclBefore[$_] })
  Check '95 the rewrap keeps every file DACL (none listed = none changed)' '' ($daclMoved -join ',')
  Assert-StoreWorks '95 after the update'
  Assert-NoSecrets '95 after the update'
  $left = @(Get-ChildItem (Join-Path $script:Data 'secrets') -Force -File | Where-Object { $_.Name -like '.*.tmp' })
  Check '95 no temp file of an atomic rewrap is left in secrets\' 0 $left.Count

  # ---- backup and restore still pass ---------------------------------------------------------------------------------------------------------------------------
  $good = Get-Fingerprint
  [void](Psql 'postgres' 'DROP TABLE zz_fixture.zz_probe')
  Check '95 the damage is real' $true ((Get-Fingerprint) -ne $good)
  $rs = Bk @('backup', 'restore', '--snapshot', 'latest', '--swap') 'restore-95'
  Check '95 restore --swap exits 0' 0 $rs.exit
  Check '95 the restored database equals the one that was backed up' (Split-Fingerprint $good).Db (Split-Fingerprint (Get-Fingerprint)).Db
  Assert-AllWrapped '95 after the restore'
  Assert-StoreWorks '95 after the restore'

  # ---- a damaged wrapped file is a hard error: the command stops, the file is neither replaced nor regenerated ------------------------------------------------
  $victim = Join-Path $script:Data 'secrets\pg-postgres.pw'
  $orig = [IO.File]::ReadAllBytes($victim)
  $junk = $script:Latin1.GetBytes("POSDPAPI1`nnot a real blob")
  [IO.File]::WriteAllBytes($victim, $junk)
  $r = Invoke-Posctl @('secret', 'set', 'RECEIPT_FROM_EMAIL', '--stdin') @{} 'receipts@example.invalid' -Tag 'damaged-95'   # loads every secret before it changes anything
  Check '95 a damaged wrapped file stops the command (non-zero exit)' $true ($r.exit -ne 0)
  $after = [IO.File]::ReadAllBytes($victim)
  Check '95 ... and the file is byte for byte what was there (never regenerated)' ([Convert]::ToBase64String($junk)) ([Convert]::ToBase64String($after))
  [IO.File]::WriteAllBytes($victim, $orig)   # put the real file back
  Assert-AllWrapped '95 after the damaged file was put back'
  Assert-StoreWorks '95 at the end'
  Assert-NoSecrets '95 at the end'
  return @{ Results = (Get-Results); Reboot = $false }
}
