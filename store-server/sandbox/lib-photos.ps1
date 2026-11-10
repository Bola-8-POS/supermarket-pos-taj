# store-server/sandbox/lib-photos.ps1 - helpers for the photo scenarios 60-62 (Plan 10 Task 8). Dot-sourced AFTER lib-update.ps1 (and lib-cloud-storage-stub.ps1 for 61).
# Windows PowerShell 5.1 syntax only. Runs inside the Sandbox. No process is stopped by image name; services are restarted through the Service Control Manager.
if (-not (Get-Command Check -ErrorAction SilentlyContinue)) { throw 'lib-photos.ps1 needs lib-update.ps1 loaded first' }

function Get-PhotosRoot { return (Join-Path $script:Data 'photos') }
# The internal (loopback, plain http) listener is base+5; the shop-network TLS listener is base+4 (read from conf\posctl.json, never hard-coded).
function Get-InternalBase { return ('http://127.0.0.1:' + ((Get-Cfg).ports.base + 5)) }

function ConvertTo-B64Url([byte[]]$Bytes) { return ([Convert]::ToBase64String($Bytes).TrimEnd('=') -replace '\+', '-' -replace '/', '_') }
# A token the stack accepts: HS256 over the store's own jwt secret (the secret is read here, never printed or saved to evidence).
function New-TestJwt([string]$Sub) {
  $h = ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
  $now = [int][double]::Parse((Get-Date -UFormat %s))
  $c = '{"role":"authenticated","aud":"authenticated","sub":"' + $Sub + '","iat":' + $now + ',"exp":' + ($now + 3600) + '}'
  $p = ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes($c))
  $mac = New-Object Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes((Get-SecretText 'jwt-secret.txt')))
  return ("$h.$p." + (ConvertTo-B64Url ($mac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$h.$p")))))
}
# A profile with a role (the storage policies read it through get_user_role()); returns the user id.
function Add-TestStaff([string]$Role, [string]$Name) {
  $id = [Guid]::NewGuid().ToString()
  [void](Psql 'postgres' "INSERT INTO auth.users (id, email, encrypted_password, aud, role) VALUES ('$id', '$id@barpos.local', 'sandbox-not-a-hash', 'authenticated', 'authenticated'); INSERT INTO public.profiles (id, name, role, pin) VALUES ('$id', '$Name', '$Role', '$(New-Digits6)')")
  return $id
}

# One plain-http request with curl.exe. Form = a file sent as multipart field `file`; Json = a request body; headers come back lower-cased in .h.
function Invoke-PhotoCurl([string]$Method, [string]$Url, [string[]]$Headers = @(), [string]$FormFile = '', [string]$Json = '', [string]$OutFile = '') {
  $tmp = Join-Path $script:OutDir ('pcurl-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $hf = "$tmp.h"; $bf = if ($OutFile) { $OutFile } else { "$tmp.b" }
  $a = @('-sS', '--max-time', '60', '-D', $hf, '-o', $bf, '-w', '%{http_code}', '-X', $Method)
  foreach ($x in $Headers) { $a += @('-H', $x) }
  if ($FormFile) { $a += @('-F', ('file=@' + $FormFile + ';type=image/webp;filename=p.webp')) }
  if ($Json) { Set-Content "$tmp.j" $Json -Encoding ASCII -NoNewline; $a += @('-H', 'Content-Type: application/json', '--data-binary', "@$tmp.j") }
  $a += $Url
  $code = & "$env:windir\System32\curl.exe" @a 2>&1
  $h = @{}
  if (Test-Path $hf) { foreach ($l in (Get-Content $hf)) { if ($l -match '^([^:]+):\s*(.*)$') { $h[$Matches[1].ToLower()] = $Matches[2].Trim() } } }
  $text = ''; if (Test-Path $bf) { $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($bf)); if ($text.Length -gt 400) { $text = $text.Substring(0, 400) } }
  $st = 0; [void][int]::TryParse((("$code" -split '\s+')[-1]), [ref]$st)
  Remove-Item "$tmp.h", "$tmp.j" -Force -ErrorAction SilentlyContinue; if (-not $OutFile) { Remove-Item $bf -Force -ErrorAction SilentlyContinue }
  return @{ status = $st; h = $h; text = $text }
}
function New-PhotoFile([string]$Name, [int]$Size = 3000, [int]$Seed = 1) {
  $f = Join-Path $script:OutDir $Name
  $b = New-Object byte[] $Size; for ($k = 0; $k -lt $Size; $k++) { $b[$k] = [byte](($k * 31 + $Seed * 17) % 253) }
  [IO.File]::WriteAllBytes($f, $b); return $f
}
function Get-FileSha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

# A file written by the Functions service (or the importer) inherits the photos\ folder's grant: the Functions SID holds Modify, the ACE is inherited.
function Assert-InheritedFunctionsModify([string]$Id, [string]$Path) {
  $sid = Get-ServiceSid $script:Svc.Functions
  $ok = $false; $seen = ''
  if (Test-Path -LiteralPath $Path) {
    $acl = Get-Acl -LiteralPath $Path
    $seen = (($acl.Access | ForEach-Object { "$($_.IdentityReference)|$($_.FileSystemRights)|inh=$($_.IsInherited)" }) -join ' ; ')
    $mine = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and $_.IsInherited -and (([int]$_.FileSystemRights -band 0x1301BF) -eq 0x1301BF) })
    $ok = ($mine.Count -ge 1)
  } else { $seen = "missing: $Path" }
  Add-Check $Id 'Functions SID has an inherited Modify ACE' $seen $ok
}
function Restart-FunctionsService([string]$Label) {
  Restart-Service -Name $script:Svc.Functions -Force
  Check "$Label all five services Running again" $true (Wait-Until { Test-AllRunning } 120 1)
}
