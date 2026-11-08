# 60 - the photo service on a fresh Offline-only store (Plan 10 Task 8). Windows-only checks the host tests cannot make.
# Proves: a manager uploads through the storage routes and the file lands at photos\<bucket>\<row uuid> (60.1); a cashier is refused 403 and nothing is written (60.2);
#   a signed GET returns the bytes with nosniff (60.3); delete removes the row and the file (60.4); the photos\ folder and a new file carry the Functions Modify grant by
#   inheritance (60.5); a service restart keeps the file serving (60.6); `posctl photos verify` exits 0 (60.7); a stale scratch file in photos\.tmp is purged at start-up
#   (60.8); the tx= strip: `Prefer: tx=rollback` from a LAN client still commits (60.9); the internal listener that keeps tx= is not reachable from the shop network (60.10);
#   the LAN refuses `Accept-Profile`/`Content-Profile: storage` and storage.objects is unchanged (60.11).
# 60.9 uses a throwaway table (public.zz_txprobe) instead of process_direct_sale_atomic: the same gateway strip decides both, and the RPC itself needs a staff/shift/caja
#   fixture that is not this scenario's subject (tests/gateway_live.rs covers the RPC path on the host).
# Needs a base pack that carries the storage tables and storage.ts (the integrated 09+10 build). Estimated 25 minutes.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-photos.ps1
function Invoke-Scenario([int]$Phase) {
  Install-Posctl; [void](Ensure-VcRuntime)
  $p = Provision-Fresh 'C:\out\r60.json' 'provision-60'
  Check '60 setup: provision exits 0' 0 $p.Result.exit
  if ($p.Result.exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }
  Invoke-ParkBackupTasks
  Check '60 setup: the pack carries the storage tables' 't' (Psql 'postgres' "SELECT to_regclass('storage.objects') IS NOT NULL AND to_regclass('storage.buckets') IS NOT NULL")
  [void](Psql 'postgres' "INSERT INTO storage.buckets (id, name) VALUES ('product-photos', 'product-photos') ON CONFLICT DO NOTHING")
  $anon = (Get-StoreKeys).anon
  $base = Get-InternalBase
  $photos = Get-PhotosRoot
  $mgr = New-TestJwt ([string]$p.Result.json.data.firstAdmin.id)
  $cashierId = Add-TestStaff 'cashier' 'zz cashier'
  $cash = New-TestJwt $cashierId
  $mh = @("apikey: $anon", "Authorization: Bearer $mgr"); $ch = @("apikey: $anon", "Authorization: Bearer $cash")
  $src = New-PhotoFile 'p60.webp' 3000 1
  $srcSha = Get-FileSha $src
  $name = 'zz-test/p60.webp'

  # 60.1 / 60.2 upload
  $up = Invoke-PhotoCurl 'POST' "$base/storage/v1/object/product-photos/$name" $mh $src
  Check '60.1 manager upload answers 200' 200 $up.status
  $id = ''; try { $id = [string](($up.text | ConvertFrom-Json).Id) } catch { }
  Check '60.1 the answer carries the new object id' $true ($id -match '^[0-9a-f-]{36}$')
  $file = Join-Path $photos "product-photos\$id"
  Check '60.1 the file exists at photos\product-photos\<uuid> with the uploaded bytes' $srcSha $(if (Test-Path -LiteralPath $file) { Get-FileSha $file } else { 'missing' })
  $before = @(Get-ChildItem -LiteralPath $photos -Recurse -File -Force | Where-Object { $_.FullName -notlike '*\.tmp\*' }).Count
  $cu = Invoke-PhotoCurl 'POST' "$base/storage/v1/object/product-photos/zz-test/cashier.webp" $ch $src
  Check '60.2 cashier upload answers 403' 403 $cu.status
  $after = @(Get-ChildItem -LiteralPath $photos -Recurse -File -Force | Where-Object { $_.FullName -notlike '*\.tmp\*' }).Count
  Check '60.2 no file was written and no row exists for the cashier name' "$before/0" ("$after/" + (Psql 'postgres' "SELECT count(*) FROM storage.objects WHERE name = 'zz-test/cashier.webp'"))

  # 60.3 signed GET
  $sg = Invoke-PhotoCurl 'POST' "$base/storage/v1/object/sign/product-photos/$name" $mh '' '{"expiresIn":120}'
  $rel = ''; try { $rel = [string](($sg.text | ConvertFrom-Json).signedURL) } catch { }
  Check '60.3 sign answers 200 with a signedURL' $true ($sg.status -eq 200 -and $rel -like '/object/sign/*')
  $got = Join-Path $script:OutDir 'p60.got'
  $gt = Invoke-PhotoCurl 'GET' ($base + '/storage/v1' + $rel) @() '' '' $got
  Check '60.3 signed GET answers 200 with the same bytes' "200/$srcSha" ("$($gt.status)/" + $(if (Test-Path $got) { Get-FileSha $got } else { 'missing' }))
  Check '60.3 the answer carries nosniff' 'nosniff' ([string]$gt.h['x-content-type-options'])

  # 60.5 ACL of the folder and the new file
  $plan = Get-DataAclPlan
  Check-Acl '60.5a photos\ folder carries the planned DACL (Functions Modify, inheritable)' $photos $plan[$photos.TrimEnd('\')]
  Assert-InheritedFunctionsModify '60.5b the new file inherits the Functions Modify grant' $file

  # 60.6 / 60.8 restart; a stale scratch file goes
  $tmpDir = Join-Path $photos '.tmp'; New-Item -ItemType Directory -Force $tmpDir | Out-Null
  $stale = Join-Path $tmpDir 'stale-60.part'; Set-Content $stale 'left over from a crash'
  (Get-Item $stale).LastWriteTime = (Get-Date).AddDays(-3)
  Restart-FunctionsService '60.6'
  $gt2 = Invoke-PhotoCurl 'GET' ($base + '/storage/v1' + $rel) @() '' '' $got
  Check '60.6 after the restart the file still serves (200, same bytes)' "200/$srcSha" ("$($gt2.status)/" + $(if (Test-Path $got) { Get-FileSha $got } else { 'missing' }))
  Check '60.8 the stale scratch file is gone after the restart (start-up purge)' $true (Wait-Until { -not (Test-Path -LiteralPath $stale) } 60 1)

  # 60.7 verify
  $v = Invoke-Posctl @('photos', 'verify') -Tag '60-verify'
  Check '60.7 posctl photos verify exits 0' 0 $v.exit
  Check '60.7 ... and sees one row, one file, none dangling' '1/1/0' ("$($v.json.data.rows)/$($v.json.data.files)/$($v.json.data.dangling)")

  # 60.4 delete
  $dl = Invoke-PhotoCurl 'DELETE' "$base/storage/v1/object/product-photos" $mh '' ('{"prefixes":["' + $name + '"]}')
  Check '60.4 delete answers 200' 200 $dl.status
  Check '60.4 the row is gone' '0' (Psql 'postgres' "SELECT count(*) FROM storage.objects WHERE id = '$id'")
  Check '60.4 the file is gone' $false (Test-Path -LiteralPath $file)

  # 60.9 tx=rollback from a LAN client is stripped: the write commits
  # a body needs curl -d, which Invoke-LanCurlHeaders does not send: curl.exe straight at the LAN listener, name resolved to loopback
  $cfg = Get-Cfg; $lanPort = $cfg.ports.base + 4; $lanName = Get-LanName
  $bodyFile = Join-Path $script:OutDir 'tx60.json'; Set-Content $bodyFile '{"id":1,"note":"tx-rollback-must-commit"}' -Encoding ASCII -NoNewline
  $r9 = $null
  # the probe table was never created (404 = PostgREST does not know it): create it in public, grant the API role the JWTs carry (authenticated), reload the schema cache
  [void](Psql 'postgres' "DROP TABLE IF EXISTS public.zz_txprobe; CREATE TABLE public.zz_txprobe (id int PRIMARY KEY, note text); GRANT SELECT, INSERT ON public.zz_txprobe TO authenticated; NOTIFY pgrst, 'reload schema'")
  try {
  [void](Wait-Until {
    $o = & "$env:windir\System32\curl.exe" -sS -o NUL -w '%{http_code}' --ssl-no-revoke --max-time 10 --resolve "${lanName}:${lanPort}:127.0.0.1" -X POST -H "apikey: $anon" -H "Authorization: Bearer $mgr" -H 'Content-Type: application/json' -H 'Prefer: tx=rollback,return=minimal' --data-binary "@$bodyFile" "https://${lanName}:${lanPort}/rest/v1/zz_txprobe" 2>&1
    $script:r9 = "$o"; if ($script:r9 -eq '404') { [void](Psql 'postgres' "NOTIFY pgrst, 'reload schema'" -AllowFailure) }; ($script:r9 -eq '201')
  } 60 3)
  Check '60.9 the LAN POST with Prefer: tx=rollback answers 201' '201' $script:r9
  Check '60.9 the row IS committed (the strip removed tx=rollback)' '1' (Psql 'postgres' "SELECT count(*) FROM public.zz_txprobe WHERE id = 1")
  Info '60.9 stand-in' 'public.zz_txprobe instead of process_direct_sale_atomic; the RPC path is covered by tests/gateway_live.rs'
  } finally {
    # cleanup must not mask a failure above
    try { [void](Psql 'postgres' 'DROP TABLE IF EXISTS public.zz_txprobe' -AllowFailure) } catch { }
  }

  # 60.10 the internal listener that keeps tx= is loopback only
  $ls = @(Get-StoreListeners | Where-Object { $_.Port -eq ($cfg.ports.base + 5) })
  Check '60.10 the internal listener (base+5) is bound to 127.0.0.1 only' '127.0.0.1' ((@($ls | ForEach-Object { $_.Addr } | Sort-Object -Unique)) -join ',')
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress })
  if ($ips.Count -eq 0) { Info '60.10 connect from a non-loopback address' 'the Sandbox has no network adapter with an address; the bind check above is the proof' }
  foreach ($ip in $ips) {
    $c = New-Object Net.Sockets.TcpClient; $ok = $false
    try { $ar = $c.BeginConnect($ip, $cfg.ports.base + 5, $null, $null); $ok = ($ar.AsyncWaitHandle.WaitOne(3000) -and $c.Connected) } catch { $ok = $false } finally { $c.Close() }
    Check "60.10 a connect to ${ip}:$($cfg.ports.base + 5) is refused" $false $ok
  }

  # 60.11 storage profile through the LAN gateway
  $cnt0 = Psql 'postgres' 'SELECT count(*) || chr(124) || COALESCE(string_agg(name, chr(44) ORDER BY name), chr(45)) FROM storage.objects'
  $spell = @(
    @('GET', 'Accept-Profile: storage'), @('GET', 'accept-profile: storage'), @('GET', 'Accept-Profile: STORAGE'), @('GET', 'Accept-Profile:  storage'),
    @('GET', 'Accept-Profile: public, storage'), @('POST', 'Content-Profile: storage'), @('POST', 'content-profile: Storage'), @('DELETE', 'Content-Profile: storage')
  )
  $i = 0
  foreach ($s in $spell) {
    $i++
    $r = Invoke-LanCurlHeaders $s[0] '/rest/v1/objects?select=id' @("apikey: $anon", "Authorization: Bearer $mgr", $s[1], 'Content-Type: application/json') 8
    Check "60.11 LAN $($s[0]) with '$($s[1])' is refused 403" 403 $r.status
  }
  Check '60.11 storage.objects is unchanged (row count and names)' $cnt0 (Psql 'postgres' 'SELECT count(*) || chr(124) || COALESCE(string_agg(name, chr(44) ORDER BY name), chr(45)) FROM storage.objects')
  $ir = Invoke-PhotoCurl 'GET' "$base/rest/v1/objects?select=id&limit=1" ($mh + @('Accept-Profile: storage'))
  Check '60.11 the same request on the internal listener is not refused 403' $true ($ir.status -ne 403 -and $ir.status -ne 0)

  Assert-NoSecrets '60' $false
  return @{ Results = (Get-Results); Reboot = $false }
}
