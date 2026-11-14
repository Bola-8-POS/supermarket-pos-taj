# lib-pin.ps1 - shared helpers of Sandbox 94a / 94b (Plan 11H Task 16): staff with a generated PIN, sign-in through GoTrue, the unprovision + fresh provision +
# restore-from-the-drive round trip. PINs and peppers live in memory only; every Check carries booleans or counts, never a value.
. C:\scenarios\lib-backup.ps1

function Invoke-AuthAdmin([string]$Method, [string]$Path, $Body) {   # GoTrue admin API on the internal listener (a raw auth.users insert is forbidden)
  $k = Get-StoreKeys
  $h = @{ apikey = $k.service_role; Authorization = "Bearer $($k.service_role)" }
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Base + 5)/auth/v1/admin/users$Path" -Method $Method -Headers $h -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress) -SkipHttpErrorCheck -TimeoutSec 30
  return [pscustomobject]@{ Status = [int]$r.StatusCode; Content = [string]$r.Content }
}
# A cashier with a generated PIN: the account through GoTrue (its password derived from id + PIN + pepper, as create-staff does), then the profile row.
function Add-PinStaff([string]$Name, [string]$Pepper) {
  $pin = New-Digits6
  $c = Invoke-AuthAdmin 'Post' '' @{ email = ([guid]::NewGuid().ToString() + '@barpos.local'); password = ('tmp-' + (New-RandomToken 24)); email_confirm = $true }
  $id = ''; try { $id = [string]($c.Content | ConvertFrom-Json).id } catch { }
  Check "setup: GoTrue created the account of $Name (HTTP 200, a uuid)" $true ($c.Status -eq 200 -and $id -match '^[0-9a-fA-F-]{36}$')
  $u = Invoke-AuthAdmin 'Put' "/$id" @{ email = "$id@barpos.local"; password = (Get-DerivedPassword $id $pin $Pepper) }
  Check "setup: the account of $Name carries the derived password (HTTP 200)" 200 $u.Status
  [void](Psql 'postgres' "INSERT INTO public.profiles (id, name, role, pin) VALUES ('$id', '$Name', 'cashier', '$pin')")
  return @{ Id = $id; Pin = $pin }
}
function Get-StaffGrant([string]$Id, [string]$Pin, [string]$Pepper) { return (Invoke-Grant "$Id@barpos.local" (Get-DerivedPassword $Id $Pin $Pepper)) }
function Get-PlainPinCount { return [int](([string](Psql 'postgres' 'SELECT count(*) FROM public.profiles WHERE pin ~ ''^[0-9]{6}$''')).Trim()) }
function Get-HashedPinCount { return [int](([string](Psql 'postgres' 'SELECT count(*) FROM public.profiles WHERE pin ~ ''^\$2[aby]\$''')).Trim()) }
function Get-Sha256Hex([string]$Text) { return (([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Text.Trim())) | ForEach-Object { $_.ToString('x2') }) -join '') }
# verify_staff_pin runs as the caller: the admin's access token, PostgREST on the internal listener (the listener serving /rest/v1 is a guess; one rerun).
function Invoke-VerifyPin([string]$Token, [string]$Pin, [string]$StaffId) {
  $h = @{ apikey = (Get-StoreKeys).anon; Authorization = "Bearer $Token" }
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Base + 5)/rest/v1/rpc/verify_staff_pin" -Method Post -Headers $h -ContentType 'application/json' -Body (@{ p_pin = $Pin; p_staff_id = $StaffId } | ConvertTo-Json -Compress) -SkipHttpErrorCheck -TimeoutSec 30
  $ok = $false; try { $ok = [bool](($r.Content | ConvertFrom-Json).ok) } catch { }
  return [pscustomobject]@{ Status = [int]$r.StatusCode; Ok = $ok }
}
function Assert-VerifyStaffPin([string]$Label, $Staff, [string]$Pepper) {
  $g = Invoke-AdminGrant $Pepper
  Check "$Label the admin signs in (200) to call verify_staff_pin" 200 $g.Status
  $tok = ''; try { $tok = [string]($g.Body | ConvertFrom-Json).access_token } catch { }
  $wrong = New-Digits6; while ($wrong -eq $Staff.Pin) { $wrong = New-Digits6 }
  $ok = Invoke-VerifyPin $tok $Staff.Pin $Staff.Id
  $bad = Invoke-VerifyPin $tok $wrong $Staff.Id
  Check "$Label verify_staff_pin with the right PIN: ok" $true ($ok.Status -eq 200 -and $ok.Ok)
  Check "$Label verify_staff_pin with a wrong PIN: not ok" $true ($bad.Status -eq 200 -and -not $bad.Ok)
}
function Assert-NoStaffPin([string]$Label, $Staff) {   # Assert-NoPin scans for the admin pair: point it at the staff pair for one call
  $a = $script:AdminId; $p = $script:AdminPin
  $script:AdminId = $Staff.Id; $script:AdminPin = $Staff.Pin
  try { Assert-NoPin $Label } finally { $script:AdminId = $a; $script:AdminPin = $p }
}
# The drive and the recovery key: the only things that survive the wipe (41's "replacement PC").
function Initialize-PinDrive([string]$Id) {
  New-TestUsb 'E'
  [void](Add-Usb)
  $k = Export-RecoveryKey -Label "$Id key-export"
  return $k.Key
}
# restic ls of the newest snapshot: is the pepper record in it (a name, never a content)? Runs with this machine's key, before the wipe.
function Test-SnapshotHasPepperRecord {
  $restic = Get-Restic
  $env:RESTIC_PASSWORD = (Get-Content -Raw (Join-Path $script:Data 'secrets\restic-password.txt')).Trim()
  $out = (& $restic --no-cache --repo $script:UsbRepo ls latest 2>&1 | Out-String)
  Remove-Item Env:\RESTIC_PASSWORD -ErrorAction SilentlyContinue
  return ($out -match 'staff-password-pepper\.txt')
}
# unprovision --delete-data, then a fresh provision from the highest installed pack (a new pepper, a new admin PIN, a new machine key). Sets $script:Fresh*.
function Reset-ToFreshStore([string]$Id) {
  $tok = ((Get-StoreId) -replace '-', '').Substring(0, 8)
  $u = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', $tok) -Tag "$Id-unprovision"
  Check "$Id unprovision --delete-data exits 0 and every service is gone" $true ($u.exit -eq 0 -and (Test-AllAbsent))
  $pin = New-Digits6
  $p = Invoke-Posctl @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', "C:\out\$Id-fresh.json") $pin -Tag "$Id-fresh-provision" -TimeoutSec 1800
  Check "$Id fresh provision exits 0" 0 $p.exit
  Invoke-ParkBackupTasks
  $script:FreshPin = $pin
  $script:FreshAdminId = ([string](Psql 'postgres' 'SELECT id FROM public.profiles WHERE role::text = ''admin'' LIMIT 1')).Trim()
  $script:FreshPepper = Get-Pepper
  Check "$Id the fresh store has an admin profile and its own pepper" $true ($script:FreshAdminId -match '^[0-9a-fA-F-]{36}$' -and [bool]$script:FreshPepper)
}
function Invoke-DriveRestore([string]$Key, $Env, [string]$Tag) {
  return (Bk @('backup', 'restore', '--snapshot', 'latest', '--swap', '--repo', $script:UsbRepo, '--key-stdin') $Tag $Env $Key)
}
# After a refused/rolled-back restore the fresh store must be exactly what it was: its own admin signs in with its own pepper, the services run, no half-built database.
function Assert-FreshStoreIntact([string]$Label, [string]$Staff) {
  Check "$Label the fresh admin still signs in with the fresh pepper and PIN (200)" 200 (Invoke-Grant "$($script:FreshAdminId)@barpos.local" (Get-DerivedPassword $script:FreshAdminId $script:FreshPin $script:FreshPepper)).Status
  Check "$Label the fresh pepper is still the installed one" $true ((Get-Pepper) -eq $script:FreshPepper)
  Check "$Label the restored staff member is not in the store" '0' (([string](Psql 'postgres' "SELECT count(*) FROM public.profiles WHERE id = '$Staff'")).Trim())
  Check "$Label no pos_next database remains and the journal is gone" $true (-not ((Get-DbNames) -contains 'pos_next') -and -not (Test-Path (Get-UpdateReadPath 'journal.json')))
  Check "$Label the services are up and the gateway answers" $true ((Test-AllRunning) -and (Get-Health).status -eq 200)
}
