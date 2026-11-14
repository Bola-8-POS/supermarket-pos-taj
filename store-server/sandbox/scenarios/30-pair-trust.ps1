# 30 - `pair join` on a till (a PC that is NOT provisioned): the store root is installed into LocalMachine\Root only after every
# check passes, and nothing is installed, created or changed otherwise. Real ACLs, a real standard user, the real certificate store.
# Proves (Plan 06 Task 9 carries 4 and 5): tampered / foreign-block / wrong-fingerprint / 8-hex / expiring-trust-file / expired records
# change nothing; a valid join installs exactly the verified root (bytes == DER) and writes store.env atomically with .prev kept; client\
# and client\pki are Administrators-owned, Users read-only; a folder pre-created by a standard user makes join refuse PRECONDITION;
# a store.env planted by a standard user carries a non-administrator owner (the owner check src-tauri applies, Task 10 C1).
$script:CliPath = 'C:\Users\Public\p30'
function New-Utf8File([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false))) }
function ConvertTo-B64Url([string]$Text) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function Invoke-AsUser($Cred, [string]$Name, [string]$ScriptText) {
  New-Item -ItemType Directory -Force $script:CliPath | Out-Null
  & icacls.exe $script:CliPath /grant 'Users:(OI)(CI)M' | Out-Null
  $f = Join-Path $script:CliPath "$Name.ps1"
  Set-Content $f $ScriptText -Encoding ASCII
  $p = Start-Process -FilePath "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $f) -Credential $Cred -LoadUserProfile -WorkingDirectory $script:CliPath -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}
function Get-FileSha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() } else { 'absent' } }

function Invoke-Scenario([int]$Phase) {
  Install-Posctl -Release   # a till runs the shipped binary; join never loads a pack
  $pem = [IO.File]::ReadAllText('C:\payload\caddy-test-root.crt')
  $der = ConvertFrom-PemCert $pem
  $sha256 = Get-DerSha256 $der
  $sha1 = Get-DerSha1 $der
  $fp16 = $sha256.Substring(0, 16)
  $fpShown = ($fp16.ToUpper() -replace '(.{4})(?=.)', '$1-')
  $anon = (ConvertTo-B64Url '{"alg":"HS256","typ":"JWT"}') + '.' + (ConvertTo-B64Url '{"role":"anon"}') + '.' + (ConvertTo-B64Url 'signature-material')
  $now = (Get-Date).ToUniversalTime()
  function New-Record([string]$RootPem, [string]$Expires, [string]$Sha = $sha256) {
    $r = [ordered]@{ v = 1; mode = 'offline-only'; serverHost = 'storepc'; serverPort = 47304; altHosts = @('192.168.1.20'); anonKey = $anon; rootCertPem = $RootPem; rootSha256 = $Sha; issuedAt = $now.ToString('o') }
    if ($Expires) { $r['expiresAt'] = $Expires }
    return ($r | ConvertTo-Json -Depth 5)
  }
  $work = 'C:\work30'; New-Item -ItemType Directory -Force $work | Out-Null
  $soon = $now.AddMinutes(10).ToString('o')
  $files = @{
    good_usb   = New-Record $pem $null
    good_offer = New-Record $pem $soon
    tampered   = New-Record ($pem.Replace('MII', 'MIJ')) $soon
    foreign    = New-Record ("-----BEGIN X509 CRL-----`nAAAA`n-----END X509 CRL-----`n" + $pem) $soon
    expired    = New-Record $pem ($now.AddMinutes(-5).ToString('o'))
  }
  foreach ($k in $files.Keys) { New-Utf8File (Join-Path $work "$k.pospair") $files[$k] }
  $dataTop = 'C:\ProgramData\SupermarketPOS'
  $client = "$dataTop\client"
  $storeEnv = "$client\store.env"
  $rootFile = "$client\pki\root.crt"
  function Join-Pair([string]$Name, [string[]]$Extra) { Invoke-Posctl (@('pair', 'join', '--file', (Join-Path $work "$Name.pospair")) + $Extra) -Name "join-$Name" }
  function Check-NothingChanged([string]$Tag) {
    Check-Equal "30 ${Tag}: the root is not in LocalMachine\Root" 'False' (Test-RootTrusted $sha1)
    Check-Equal "30 ${Tag}: nothing was created under ProgramData\SupermarketPOS" 'False' (Test-Path $dataTop)
  }

  Check-Equal '30 precondition: the store root is not trusted yet' 'False' (Test-RootTrusted $sha1)
  Check-Equal '30 precondition: no ProgramData\SupermarketPOS folder' 'False' (Test-Path $dataTop)

  # ---- a standard user pre-creates client\ and plants a store.env (carry 4b/4c) -------------------------------------------------------
  $user = 'posuser30'
  $pw = 'Aa1!' + (New-RandomToken 18)
  New-StdUser $user $pw
  $cred = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $pw -AsPlainText -Force))
  $plant = "New-Item -ItemType Directory -Force -Path '$client' | Out-Null; Set-Content -Path '$storeEnv' -Value 'VITE_STORE_MODE=offline-only' -Encoding ASCII"
  $rc = Invoke-AsUser $cred 'plant' $plant
  Check-Equal '30 harness: the standard user created client\ and store.env' 0 $rc
  $userSid = (New-Object Security.Principal.NTAccount($user)).Translate([Security.Principal.SecurityIdentifier]).Value
  $ownTop = (Get-AclState $dataTop).Owner; $ownClient = (Get-AclState $client).Owner; $ownFile = (Get-AclState $storeEnv).Owner
  Add-Check '30 a store.env planted by a standard user has that user as its owner (not Administrators/SYSTEM): the app ignores it' "owner of SupermarketPOS\, client\ and store.env = $userSid" "$ownTop, $ownClient, $ownFile" (($ownTop -eq $userSid) -and ($ownClient -eq $userSid) -and ($ownFile -eq $userSid) -and (@('S-1-5-32-544', 'S-1-5-18') -notcontains $ownFile))
  $plantedHash = Get-FileSha $storeEnv
  $r = Join-Pair 'good_usb' @('--trust-file')
  Add-Check '30 join refuses PRECONDITION (exit 12) while the folder belongs to a standard user, and says how to fix it' 'exit 12, message names the owner / says delete' (Format-Envelope $r) ($r.Exit -eq 12 -and $r.Json.code -eq 'PRECONDITION' -and ($r.Json.message -match 'owned by' -and $r.Json.message -match 'delete'))
  Check-Equal '30 the refused join left the planted store.env as it was' $plantedHash (Get-FileSha $storeEnv)
  Check-Equal '30 the refused join created no client\pki and installed nothing' 'False' ((Test-Path "$client\pki") -or (Test-RootTrusted $sha1))
  Remove-Item $dataTop -Recurse -Force
  Check-NothingChanged '30 harness: planted folder removed'

  # ---- refusals that must change nothing --------------------------------------------------------------------------------------------------
  $r = Join-Pair 'tampered' @('--confirm-fingerprint', $fpShown)
  Add-Check '30 a record whose certificate was altered is refused (exit 51 or 50)' '51 or 50' (Format-Envelope $r) ($r.Exit -eq 51 -or $r.Exit -eq 50)
  Check-NothingChanged '30 altered certificate'
  $r = Join-Pair 'tampered' @('--trust-file')
  Add-Check '30 the same record is refused with --trust-file too (exit 51 or 50)' '51 or 50' (Format-Envelope $r) ($r.Exit -eq 51 -or $r.Exit -eq 50)
  Check-NothingChanged '30 altered certificate, trust-file'
  $r = Join-Pair 'foreign' @('--confirm-fingerprint', $fpShown)
  Add-Check '30 a foreign PEM block in front of the real certificate is refused (exit 50) even with the right fingerprint' '50' (Format-Envelope $r) ($r.Exit -eq 50)
  Check-NothingChanged '30 foreign block'
  $wrong = ($sha256.Substring(0, 15) + $(if ($sha256[15] -eq '0') { '1' } else { '0' }))
  $r = Join-Pair 'good_offer' @('--confirm-fingerprint', $wrong)
  Add-Check '30 a wrong typed fingerprint (16 characters) exits 51' '51' (Format-Envelope $r) ($r.Exit -eq 51)
  Check-NothingChanged '30 wrong fingerprint'
  $r = Join-Pair 'good_offer' @('--confirm-fingerprint', $sha256.Substring(0, 8))
  Add-Check '30 the right 8-character prefix is too short and is refused (exit 51 or 50)' '51 or 50' (Format-Envelope $r) ($r.Exit -eq 51 -or $r.Exit -eq 50)
  Check-NothingChanged '30 8-character prefix'
  $r = Join-Pair 'good_offer' @('--trust-file')
  Add-Check '30 an offer that carries an expiry cannot be trusted as a file (it came over the network): exit 50' '50' (Format-Envelope $r) ($r.Exit -eq 50)
  Check-NothingChanged '30 trust-file on an offer'
  $r = Join-Pair 'expired' @('--confirm-fingerprint', $fpShown)
  Add-Check '30 an expired offer is refused (exit 50 or 51)' '50 or 51' (Format-Envelope $r) ($r.Exit -eq 50 -or $r.Exit -eq 51)
  Check-NothingChanged '30 expired offer'
  $r = Invoke-Posctl @('pair', 'join', '--file', (Join-Path $work 'good_usb.pospair')) -Name 'join-no-confirmation'
  Add-Check '30 join with neither --confirm-fingerprint nor --trust-file is a usage error (exit 2)' '2' (Format-Envelope $r) ($r.Exit -eq 2)
  Check-NothingChanged '30 no confirmation'

  # ---- a valid join -----------------------------------------------------------------------------------------------------------------------------
  $r = Join-Pair 'good_offer' @('--confirm-fingerprint', $fpShown)
  Add-Check '30 the right fingerprint, typed in grouped capitals, exits 0' '0' (Format-Envelope $r) ($r.Exit -eq 0)
  if ($r.Exit -ne 0) { Save-DataEvidence 'join-failed'; Remove-TrustedRoot $sha1; return @{ Results = (Get-Results); Reboot = $false } }
  $inStore = @(Get-TrustedRootDer $sha1)
  Check-Equal '30 exactly one certificate with that thumbprint is in LocalMachine\Root' 1 $inStore.Count
  Check-Equal '30 the installed certificate bytes are exactly the verified DER' $sha256 $(if ($inStore.Count -eq 1) { Get-DerSha256 $inStore[0] } else { 'none' })
  $envText = if (Test-Path $storeEnv) { [IO.File]::ReadAllText($storeEnv) } else { '' }
  Check-True '30 store.env says offline-only' ($envText -match '(?m)^VITE_STORE_MODE=offline-only\r?$') $envText
  Check-True '30 store.env names the server on the store port over https' ($envText -match '(?m)^VITE_SUPABASE_URL=https://storepc:47304\r?$') $envText
  Check-True '30 store.env carries the CA hash and the alternative address' ($envText -match "(?m)^VITE_STORE_CA_SHA256=$sha256\r?$" -and $envText -match '(?m)^VITE_STORE_SERVER_ALT_HOSTS=192\.168\.1\.20\r?$') $envText
  Check-True '30 store.env holds the anon key and no service key' ($envText.Contains($anon) -and $envText -notmatch 'service_role|SERVICE') ''
  $rootText = if (Test-Path $rootFile) { [IO.File]::ReadAllText($rootFile) } else { '' }
  Check-Equal '30 client\pki\root.crt is the verified certificate (rebuilt from the DER)' $sha256 $(if ($rootText) { Get-DerSha256 (ConvertFrom-PemCert $rootText) } else { 'none' })
  $leftover = @(Get-ChildItem $client -Recurse -Force | Where-Object { $_.Name -match '\.tmp|\.new|~$' })
  Check-Equal '30 no temporary file is left behind (the writes were atomic renames)' 0 $leftover.Count
  Check-Equal '30 the first join has no store.env.prev (there was nothing before it)' 'False' (Test-Path "$storeEnv.prev")
  $v = Invoke-Posctl @('pki', 'verify-trust') -Name 'verify-trust'
  Check-True '30 pki verify-trust exits 0 and says trusted' ($v.Exit -eq 0 -and $v.Json.data.trusted -eq $true) (Format-Envelope $v)

  # ---- real ACLs ------------------------------------------------------------------------------------------------------------------------------------
  Check-Acl '30 ACL client\ (Administrators owner, protected, SYSTEM + Administrators full, Users read-only, inherited by children)' $client @((G $script:SidSystem 'F' 3), (G $script:SidAdmins 'F' 3), (G $script:SidUsers 'RX' 3))
  Check-Acl '30 ACL client\pki' "$client\pki" @((G $script:SidSystem 'F' 3), (G $script:SidAdmins 'F' 3), (G $script:SidUsers 'RX' 3))
  $owners = @($dataTop, $client, "$client\pki", $storeEnv, $rootFile | ForEach-Object { (Get-AclState $_).Owner } | Sort-Object -Unique)
  Check-Equal '30 SupermarketPOS\, client\, client\pki, store.env and root.crt are all owned by Administrators' 'S-1-5-32-544' ($owners -join ',')
  $allowed = @($script:SidSystem, $script:SidAdmins, $script:SidUsers)
  $strangers = @(@($client) + @(Get-ChildItem $client -Recurse -Force | ForEach-Object FullName) | ForEach-Object { $p = $_; Get-AceSids $p | Where-Object { $allowed -notcontains $_ } | ForEach-Object { "$p : $_" } })
  Check-Equal '30 only SYSTEM, Administrators and Users appear anywhere under client\' 0 $strangers.Count
  $probe = @"
`$r = [ordered]@{}
`$c = '$client'
function Try-It([string]`$n, [scriptblock]`$a) { try { & `$a; `$r[`$n] = 'ALLOWED' } catch { `$r[`$n] = 'DENIED' } }
Try-It 'read store.env' { [void][IO.File]::ReadAllText("`$c\store.env") }
Try-It 'append store.env' { [IO.File]::AppendAllText("`$c\store.env", 'x') }
Try-It 'delete store.env' { Remove-Item "`$c\store.env" -Force -ErrorAction Stop }
Try-It 'rename store.env' { Rename-Item "`$c\store.env" 'moved.env' -ErrorAction Stop }
Try-It 'create a file in client' { Set-Content "`$c\planted.env" 'x' -ErrorAction Stop }
Try-It 'overwrite pki\root.crt' { [IO.File]::WriteAllText("`$c\pki\root.crt", 'x') }
Try-It 'replace pki\root.crt' { Remove-Item "`$c\pki\root.crt" -Force -ErrorAction Stop }
Try-It 'rename client' { Rename-Item `$c 'client-moved' -ErrorAction Stop }
`$r | ConvertTo-Json | Set-Content '$($script:CliPath)\acl.json' -Encoding ASCII
"@
  $rc = Invoke-AsUser $cred 'acl-probe' $probe
  Check-Equal '30 the ACL probe ran as the standard user' 0 $rc
  $res = $null; try { $res = Get-Content "$($script:CliPath)\acl.json" -Raw | ConvertFrom-Json } catch { }
  if ($res) {
    Save-Evidence '30-acl-probe' ($res | ConvertTo-Json)
    Check-Equal '30 a standard user can read store.env' 'ALLOWED' $res.'read store.env'
    foreach ($n in 'append store.env', 'delete store.env', 'rename store.env', 'create a file in client', 'overwrite pki\root.crt', 'replace pki\root.crt', 'rename client') { Check-Equal "30 a standard user cannot: $n" 'DENIED' $res.$n }
  } else { Add-Check '30 the ACL probe wrote its result' 'acl.json' 'missing' $false }
  Check-True '30 store.env and root.crt are unchanged after the probe' ((Test-Path $storeEnv) -and (Test-Path $rootFile) -and -not (Test-Path "$client\planted.env"))

  # ---- a failed join after a good one changes nothing --------------------------------------------------------------------------------------------
  $envHash = Get-FileSha $storeEnv
  $r = Join-Pair 'tampered' @('--confirm-fingerprint', $fpShown)
  Add-Check '30 a refused join after a good one exits 51 or 50' '51 or 50' (Format-Envelope $r) ($r.Exit -eq 51 -or $r.Exit -eq 50)
  Check-True '30 ... leaves the previously trusted root trusted and store.env byte-identical' ((Test-RootTrusted $sha1) -and ((Get-FileSha $storeEnv) -eq $envHash)) ''

  # ---- a second join keeps the previous store.env --------------------------------------------------------------------------------------------------
  $r = Join-Pair 'good_usb' @('--trust-file')
  Add-Check '30 a second join from the USB-style file (no expiry, --trust-file) exits 0' '0' (Format-Envelope $r) ($r.Exit -eq 0)
  Check-Equal '30 the previous store.env is kept as store.env.prev, byte for byte' $envHash (Get-FileSha "$storeEnv.prev")
  Check-Equal '30 still exactly one such certificate in LocalMachine\Root' 1 @(Get-TrustedRootDer $sha1).Count

  # ---- re-pair to a DIFFERENT store replaces the root; pair leave removes it (Final review CODE I4) -------------------------------------------
  # a second, self-made CA stands in for another store's Caddy root
  $rsa = [Security.Cryptography.RSA]::Create(2048)
  $req = New-Object Security.Cryptography.X509Certificates.CertificateRequest('CN=Second Test Store CA', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $req.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($true, $false, 0, $true)))
  $cert2 = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(30))
  $der2 = $cert2.RawData
  $sha2 = Get-DerSha256 $der2
  $sha1b = Get-DerSha1 $der2
  $pem2 = "-----BEGIN CERTIFICATE-----`n" + ([Convert]::ToBase64String($der2, 'InsertLineBreaks').Replace("`r", '')) + "`n-----END CERTIFICATE-----`n"
  New-Utf8File (Join-Path $work 'other_store.pospair') (New-Record $pem2 $null $sha2)
  $envBefore = Get-FileSha $storeEnv
  $r = Join-Pair 'other_store' @('--trust-file')
  Add-Check '30 re-pairing to a different store exits 0 and reports the old root as removed' 'exit 0, previousRoot removed' (Format-Envelope $r) ($r.Exit -eq 0 -and $r.Json.data.previousRoot -eq 'removed' -and $r.Json.data.previousRootSha256 -eq $sha256)
  Check-Equal '30 re-pair: the new store root is trusted' 'True' (Test-RootTrusted $sha1b)
  Check-Equal '30 re-pair: the previous store root is no longer trusted' 'False' (Test-RootTrusted $sha1)
  $envText2 = if (Test-Path $storeEnv) { [IO.File]::ReadAllText($storeEnv) } else { '' }
  Check-True '30 re-pair: store.env names the new root and store.env.prev the old one' ($envText2 -match "(?m)^VITE_STORE_CA_SHA256=$sha2?$" -and ([IO.File]::ReadAllText("$storeEnv.prev")) -match $sha256) $envText2
  $r = Invoke-Posctl @('pair', 'leave') -Name 'leave'
  Add-Check '30 pair leave exits 0 and reports the root removed' 'exit 0, root removed, wasPaired' (Format-Envelope $r) ($r.Exit -eq 0 -and $r.Json.data.wasPaired -eq $true -and $r.Json.data.root -eq 'removed')
  Check-Equal '30 leave: the paired root is no longer trusted' 'False' (Test-RootTrusted $sha1b)
  Check-Equal '30 leave: store.env and pkioot.crt are gone' 'False' ((Test-Path $storeEnv) -or (Test-Path $rootFile))
  Check-Equal '30 leave: store.env.prev is kept' 'True' (Test-Path "$storeEnv.prev")
  $r = Invoke-Posctl @('pair', 'leave') -Name 'leave-again'
  Add-Check '30 leaving again is a quiet no-op (exit 0, wasPaired false)' 'exit 0, wasPaired false' (Format-Envelope $r) ($r.Exit -eq 0 -and $r.Json.data.wasPaired -eq $false)
  Remove-TrustedRoot $sha1b
  Save-DataEvidence 'end'
  Remove-TrustedRoot $sha1
  Check-Equal '30 cleanup: the test root is removed again' 'False' (Test-RootTrusted $sha1)
  return @{ Results = (Get-Results); Reboot = $false }
}
