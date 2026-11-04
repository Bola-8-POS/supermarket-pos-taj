<#
.SYNOPSIS
  Black-box test of the gateway CONTRACT against whatever configs posctl currently renders
  (the bootstrap templates of Plan 05 today, Plan 06's hardened gateway later).
.DESCRIPTION
  PowerShell 7 (test host only). It asks posctl for the rendered configs and fixture values (`posctl dev render-gateway`:
  ports, anon key, service-role key), starts stub upstreams (a second loopback Caddy answering "<name> {uri} xff=<X-Forwarded-For>"
  on the gotrue/rest/functions ports, with a hostile `Access-Control-Allow-Origin: *`), runs the gateway under a real Caddy
  and asserts what a client sees. It never reads a template. Maintenance expectations are contract A (conventions 17) and
  must hold for every future gateway; live expectations are the shared rules (apikey, auth allow-list, CORS, proxying).
  Use -Scheme https when the live gateway terminates TLS (certificate errors are skipped: this tests routing, not trust).
  Use -AllowLanListener once the LAN listener may bind a non-loopback address (Plan 06); every other listener stays loopback.
  Ports 47980-47989 must be free (the test refuses to start otherwise). Exit 0 = every expectation held.
#>
param(
  [string]$Posctl = (Join-Path $PSScriptRoot '..\target\release\posctl.exe'),
  [string]$Caddy = (Join-Path $env:POS_PACK_DIR 'bin\caddy.exe'),
  [ValidateSet('http', 'https')][string]$Scheme = 'http',
  [ValidateSet('both', 'live', 'maintenance')][string]$Section = 'both',
  [switch]$AllowLanListener
)
$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]
$procs = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$script:count = 0
$work = Join-Path ([IO.Path]::GetTempPath()) ('posctl-gwc-' + [Guid]::NewGuid().ToString('N'))

function Get-Listeners { @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 47980 -and $_.LocalPort -le 47989 }) }

function Note-Headers([hashtable]$h, [string]$what) {
  if ($h.ContainsKey('access-control-allow-credentials')) { $failures.Add("$what : response carries Access-Control-Allow-Credentials") }
}
function Req([string]$Method, [string]$Url, [hashtable]$Headers = @{}, [string]$Body = $null, [string]$ContentType = 'application/json') {
  $r = Invoke-WebRequest -Uri $Url -Method $Method -Headers $Headers -Body $Body -ContentType $ContentType -SkipHttpErrorCheck -SkipCertificateCheck -SkipHeaderValidation -TimeoutSec 5
  $text = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
  $h = @{}; foreach ($k in $r.Headers.Keys) { $h[$k.ToLowerInvariant()] = ($r.Headers[$k] -join ',') }
  Note-Headers $h "$Method $Url"
  [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $text.Trim(); H = $h; RetryAfter = $h['retry-after']; Allow = $h['access-control-allow-origin'] }
}
# A raw HTTP/1.1 request over a TcpClient: nothing normalises the request line or the header list (duplicates, tabs, dot segments).
function Raw([int]$Port, [string]$RequestLine, [string[]]$Headers = @(), [string]$Body = '') {
  $c = [Net.Sockets.TcpClient]::new('127.0.0.1', $Port)
  try {
    $c.ReceiveTimeout = 5000; $c.SendTimeout = 5000
    $s = $c.GetStream()
    if ($Scheme -eq 'https') { $ssl = [Net.Security.SslStream]::new($s, $false, [Net.Security.RemoteCertificateValidationCallback] { $true }); $ssl.AuthenticateAsClient('127.0.0.1'); $s = $ssl }
    $lines = @($RequestLine, "Host: 127.0.0.1:$Port") + $Headers + @('Connection: close')
    if ($Body) { $lines += "Content-Length: $($Body.Length)" }
    $bytes = [Text.Encoding]::ASCII.GetBytes((($lines -join "`r`n") + "`r`n`r`n" + $Body))
    $s.Write($bytes, 0, $bytes.Length); $s.Flush()
    $text = [IO.StreamReader]::new($s, [Text.Encoding]::UTF8).ReadToEnd()
  } finally { $c.Dispose() }
  $head, $body = $text -split "`r`n`r`n", 2
  $hl = $head -split "`r`n"
  $h = @{}; foreach ($l in $hl[1..($hl.Count - 1)]) { $i = $l.IndexOf(':'); if ($i -gt 0) { $h[$l.Substring(0, $i).ToLowerInvariant()] = $l.Substring($i + 1).Trim() } }
  Note-Headers $h "raw $RequestLine"
  [pscustomobject]@{ Status = [int](($hl[0] -split ' ')[1]); Body = "$body".Trim(); H = $h; RetryAfter = $h['retry-after']; Allow = $h['access-control-allow-origin'] }
}
function Expect([string]$Name, $Actual, [int]$Status, [string]$BodyLike = '*') {
  $script:count++
  if ($Actual.Status -ne $Status -or $Actual.Body -notlike $BodyLike) { $failures.Add("$Name : expected $Status '$BodyLike', got $($Actual.Status) '$($Actual.Body)'") } else { Write-Host "ok   $Name" }
}
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $script:count++
  if ($Ok) { Write-Host "ok   $Name" } else { $failures.Add("$Name : $Detail") }
}

function Start-Caddy([string]$File, [int]$Probe) {
  $cfg = Join-Path $work $File
  $p = Start-Process -FilePath $Caddy -ArgumentList @('run', '--config', $cfg, '--adapter', 'caddyfile') -PassThru -WindowStyle Hidden -RedirectStandardError "$cfg.err" -RedirectStandardOutput "$cfg.out"
  $procs.Add($p)
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ($true) {
    if ($p.HasExited) { throw "caddy ($File) exited with $($p.ExitCode) before it was ready: $(Get-Content "$cfg.err" -Raw)" }
    $l = @(Get-NetTCPConnection -State Listen -LocalPort $Probe -ErrorAction SilentlyContinue)
    if ($l.Count) { break }
    if ([DateTime]::UtcNow -gt $deadline) { throw "caddy ($File) was not listening on $Probe after 20 s: $(Get-Content "$cfg.err" -Raw)" }
    Start-Sleep -Milliseconds 200
  }
  if ($p.HasExited) { throw "caddy ($File) died right after it was ready: $(Get-Content "$cfg.err" -Raw)" }
  # a stale Caddy on the port would answer with old configs and make this test pass for the wrong gateway
  if ($l[0].OwningProcess -ne $p.Id) { throw "port $Probe is owned by pid $($l[0].OwningProcess), not by the caddy this test started (pid $($p.Id))" }
  return $p
}
function Stop-Caddy($p) {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  [void]$p.WaitForExit(5000)
}
function Assert-Listeners($p, [int[]]$Ports, [string]$Label) {
  $ls = @(Get-NetTCPConnection -State Listen -OwningProcess $p.Id -ErrorAction SilentlyContinue)
  $got = ($ls | ForEach-Object { $_.LocalPort } | Sort-Object -Unique) -join ','
  Check "$Label listens on exactly $(($Ports | Sort-Object) -join ',')" ($got -eq (($Ports | Sort-Object) -join ',')) "got $got"
  $bad = @($ls | Where-Object { $_.LocalAddress -ne '127.0.0.1' -and -not ($AllowLanListener -and $_.LocalPort -eq $lanPort) })
  Check "$Label listeners are all 127.0.0.1" ($bad.Count -eq 0) ("non-loopback: " + (($bad | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ' '))
}

try {
  # C1: ports 47980-47989 must be ours alone
  $busy = Get-Listeners
  if ($busy.Count) { throw "refusing to start: something already listens on the contract ports: $((($busy | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid $($_.OwningProcess)" })) -join ', ')" }
  New-Item -ItemType Directory -Force $work | Out-Null
  $tlsArg = if ($Scheme -eq 'https') { 'internal' } else { 'off' }
  $rendered = & $Posctl dev render-gateway --out $work --tls $tlsArg | ConvertFrom-Json
  if (-not $rendered.ok) { throw "posctl dev render-gateway failed: $($rendered.message)" }
  Set-Content (Join-Path $work 'state\status.json') '{"state":"running"}' -Encoding ascii
  $d = $rendered.data
  $lanPort = $d.lanPort; $intPort = $d.internalPort; $modePort = $d.modePort
  $anon = $d.anonKey; $svc = $d.serviceRoleKey; $svcPayload = ($svc -split '\.')[1]
  $key = @{ Apikey = $anon }
  $lan = "${Scheme}://127.0.0.1:$lanPort"
  $tauri = 'http://tauri.localhost'

  # stub upstreams: gotrue / rest / functions, loopback only, hostile CORS and credentials headers the gateway must strip
  $stub = "{`n`tadmin off`n`tauto_https off`n`tpersist_config off`n`tstorage file_system $($work -replace '\\','/')/stubpki`n}`n"
  foreach ($u in @(@('gotrue', $d.gotruePort), @('rest', $d.restPort), @('functions', $d.functionsPort))) {
    $stub += "http://:$($u[1]) {`n`tbind 127.0.0.1`n`theader Access-Control-Allow-Origin *`n`theader Access-Control-Allow-Credentials true`n`trespond `"$($u[0]) {http.request.uri} xff={http.request.header.X-Forwarded-For}`" 200`n}`n"
  }
  Set-Content (Join-Path $work 'Caddyfile.stub') $stub -Encoding ascii
  $stubProc = Start-Caddy 'Caddyfile.stub' $d.gotruePort
  Assert-Listeners $stubProc @($d.gotruePort, $d.restPort, $d.functionsPort) 'stub upstreams'

  if ($Section -in 'both', 'live') {
    Write-Host "--- live ($Scheme)"
    $g = Start-Caddy 'Caddyfile.live' $intPort
    try {
      Assert-Listeners $g @($lanPort, $intPort) 'live gateway'

      # --- allowed traffic reaches the right upstream, rewritten
      $xff = @{ Apikey = $anon; 'X-Forwarded-For' = '1.2.3.4' }
      Expect 'rest GET reaches the rest upstream, client X-Forwarded-For overwritten' (Req GET "$lan/rest/v1/x" $xff) 200 'rest /x xff=127.0.0.1'
      Expect 'rest with an ordinary user bearer' (Req GET "$lan/rest/v1/x" @{ Apikey = $anon; Authorization = 'Bearer header.userpayload.sig' }) 200 'rest /x*'
      Expect 'functions GET reaches the functions upstream' (Req GET "$lan/functions/v1/x" $xff) 200 'functions /functions/v1/x xff=127.0.0.1'
      Expect 'auth refresh (charset JSON) reaches gotrue' (Req POST "$lan/auth/v1/token?grant_type=refresh_token" $xff '{}' 'application/json; charset=utf-8') 200 'gotrue /token?grant_type=refresh_token xff=127.0.0.1'
      Expect 'auth GET /user reaches gotrue' (Req GET "$lan/auth/v1/user" $xff) 200 'gotrue /user xff=127.0.0.1'
      Expect 'auth POST /logout reaches gotrue' (Req POST "$lan/auth/v1/logout" $key '{}') 200 'gotrue /logout*'
      Expect 'auth GET /health reaches gotrue' (Req GET "$lan/auth/v1/health" $key) 200 'gotrue /health*'
      $o = Req GET "$lan/rest/v1/x" @{ Apikey = $anon; Origin = $tauri }
      Check 'upstream Access-Control-Allow-Origin * is replaced by the gateway''s own' ($o.Allow -eq $tauri) "got '$($o.Allow)'"
      $n = Req GET "$lan/rest/v1/x" $key
      Check 'upstream Access-Control-Allow-Origin * is stripped without an Origin' ($null -eq $n.Allow) "got '$($n.Allow)'"
      $a = Req GET "$lan/auth/v1/user" @{ Apikey = $anon; Origin = 'http://evil.example' }
      Check 'a stranger origin gets no CORS grant on proxied auth' ($null -eq $a.Allow) "got '$($a.Allow)'"

      # --- own routes and keys
      Expect 'status without key' (Req GET "$lan/_store/status") 401
      Expect 'status with the anon key' (Req GET "$lan/_store/status" $key) 200 '*"running"*'
      Expect 'rest without key' (Req GET "$lan/rest/v1/x") 401 '*No API key*'
      Expect 'rest with a wrong key' (Req GET "$lan/rest/v1/x" @{ Apikey = 'nope' }) 401 '*Invalid API key*'
      Expect 'ANON key in upper case is a wrong key' (Req GET "$lan/rest/v1/x" @{ Apikey = $anon.ToUpperInvariant() }) 401 '*Invalid API key*'
      Expect 'service-role key as the Apikey header' (Req GET "$lan/rest/v1/x" @{ Apikey = $svc }) 401 '*Invalid API key*'
      Expect 'service-role key as ?apikey= alone' (Req GET "$lan/rest/v1/x?apikey=$svc") 401 '*No API key*'
      Expect 'anon key as ?apikey= alone is no key either' (Req GET "$lan/rest/v1/x?apikey=$anon") 401 '*No API key*'
      Expect 'duplicated Apikey header (anon, then bogus)' (Raw $lanPort 'GET /rest/v1/x HTTP/1.1' @("Apikey: $anon", 'Apikey: bogus')) 401 '*Invalid API key*'
      Expect 'duplicated Apikey header (bogus, then anon)' (Raw $lanPort 'GET /rest/v1/x HTTP/1.1' @('Apikey: bogus', "Apikey: $anon")) 401 '*Invalid API key*'
      Expect 'duplicated Apikey header on /_store/status' (Raw $lanPort 'GET /_store/status HTTP/1.1' @("Apikey: $anon", 'Apikey: bogus')) 401
      Expect 'duplicated identical Apikey header (anon, anon)' (Raw $lanPort 'GET /rest/v1/x HTTP/1.1' @("Apikey: $anon", "Apikey: $anon")) 401 '*Invalid API key*'

      # --- service-role bearers never pass, whatever the case, whitespace or path
      Expect "service-role bearer on /_store/health (a route before the apikey rule)" (Req GET "$lan/_store/health" @{ Authorization = "Bearer $svc" }) 401 '*Invalid API key*'
      foreach ($p in '/rest/v1/x', '/functions/v1/x', '/auth/v1/user') {
        Expect "service-role bearer 'bEaReR' on $p" (Req GET "$lan$p" @{ Apikey = $anon; Authorization = "bEaReR h.$svcPayload.s" }) 401 '*Invalid API key*'
        Expect "service-role bearer 'bearer' on $p" (Req GET "$lan$p" @{ Apikey = $anon; Authorization = "bearer $svc" }) 401 '*Invalid API key*'
        Expect "service-role bearer with a TAB on $p" (Raw $lanPort "GET $p HTTP/1.1" @("Apikey: $anon", "Authorization: Bearer`t$svc")) 401 '*Invalid API key*'
      }

      # --- /auth/v1 allow-list: everything else is 403
      $deny = '*not available on the store network*'
      Expect 'auth admin route denied' (Req GET "$lan/auth/v1/admin/users" $key) 403 $deny
      Expect 'auth password grant denied' (Req POST "$lan/auth/v1/token?grant_type=password" $key '{}') 403 $deny
      Expect 'auth PUT /user denied' (Req PUT "$lan/auth/v1/user" $key '{}') 403 $deny
      foreach ($pth in 'signup', 'recover', 'otp', 'verify', 'invite', 'factors') { Expect "auth POST /$pth denied" (Req POST "$lan/auth/v1/$pth" $key '{}') 403 $deny }
      Expect 'auth duplicated grant_type denied' (Req POST "$lan/auth/v1/token?grant_type=refresh_token&grant_type=password" $key '{}') 403 $deny
      Expect 'auth /token/ (trailing slash) denied' (Req POST "$lan/auth/v1/token/?grant_type=refresh_token" $key '{}') 403 $deny
      Expect 'auth upper-case path denied' (Req GET "$lan/AUTH/v1/admin/users" $key) 403 $deny
      Expect 'auth refresh grant without the query denied' (Req POST "$lan/auth/v1/token" $key '{}') 403 $deny

      # --- /token needs a JSON body
      $tok = '/auth/v1/token?grant_type=refresh_token'
      Expect 'auth token without a Content-Type' (Raw $lanPort "POST $tok HTTP/1.1" @("Apikey: $anon") '{}') 415 '*application/json*'
      Expect 'auth token as text/plain' (Req POST "$lan$tok" $key 'a=b' 'text/plain') 415 '*application/json*'
      Expect 'auth token as form-urlencoded' (Req POST "$lan$tok" $key 'a=b' 'application/x-www-form-urlencoded') 415 '*application/json*'
      Expect 'auth token as multipart' (Req POST "$lan$tok" $key 'a' 'multipart/form-data; boundary=x') 415 '*application/json*'
      Expect 'auth token as application/jsonx' (Req POST "$lan$tok" $key '{}' 'application/jsonx') 415 '*application/json*'

      # --- path tricks over a raw socket: none may reach gotrue's admin API (a token alias may only reach /token)
      foreach ($v in '//auth/v1/admin/users', '/auth/v1//admin/users', '/auth/v1/./admin/users', '/auth/v1/%2e%2e/admin/users', '/auth/v1/admin%2Fusers', '/auth/v1/%2e/admin/users',
                     '/rest/v1/../auth/v1/admin/users', '/rest/v1/%2e%2e/auth/v1/admin/users', '/rest/v1/%2e%2e%2fauth/v1/admin/users', '/functions/v1/../auth/v1/admin/users') {
        $r = Raw $lanPort "GET $v HTTP/1.1" @("Apikey: $anon")
        Check "path trick $v does not reach gotrue" ($r.Body -notlike 'gotrue*') "status $($r.Status) body '$($r.Body)'"
        Write-Host "     ($($r.Status) '$($r.Body)')"
      }
      foreach ($v in '/auth/v1//token', '/auth/v1/./token', '/auth/v1/%2e/token', '//auth/v1/token', '/auth/v1/token%2f', '/auth/v1/%74oken') {
        $r = Raw $lanPort "POST $v`?grant_type=refresh_token HTTP/1.1" @("Apikey: $anon", 'Content-Type: application/json') '{}'
        Check "token alias $v is refused or is exactly /token (percent-encoded letters decode to the same route)" ($r.Body -notlike 'gotrue*' -or $r.Body -like 'gotrue /token?grant_type=refresh_token*' -or $r.Body -like 'gotrue /%74oken?grant_type=refresh_token*') "status $($r.Status) body '$($r.Body)'"
        Write-Host "     ($($r.Status) '$($r.Body)')"
      }

      # --- CORS and the rest
      Expect 'preflight from the app origin' (Req OPTIONS "$lan/rest/v1/x" @{ Origin = $tauri }) 204
      Expect 'preflight from a stranger' (Req OPTIONS "$lan/rest/v1/x" @{ Origin = 'http://evil.example' }) 403
      Expect 'unknown path' (Req GET "$lan/zzz" $key) 404 '*not found*'
      Expect 'internal listener unknown path' (Req GET "http://127.0.0.1:$intPort/zzz") 404
      # I5: the live config must not listen on the mode-probe port at all (a refused connection, not just any error)
      $refused = $false
      try { [Net.Sockets.TcpClient]::new('127.0.0.1', $modePort).Dispose() } catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; $refused = ($e -is [Net.Sockets.SocketException] -and $e.SocketErrorCode -eq 'ConnectionRefused') }
      Check 'live config has no mode probe (connection refused)' $refused 'the mode-probe port accepted a connection or failed another way'
      Check 'the live gateway process is still running' (-not $g.HasExited) 'caddy exited during the live checks'
    } finally { Stop-Caddy $g }
  }

  if ($Section -in 'both', 'maintenance') {
    Write-Host '--- maintenance (contract A, http: the maintenance listener must answer even before TLS is decided)'
    $g = Start-Caddy 'Caddyfile.maintenance' $intPort
    try {
      Assert-Listeners $g @($lanPort, $intPort, $modePort) 'maintenance gateway'
      $r = Req GET "$lan/rest/v1/x" @{ Apikey = $anon; Origin = $tauri }
      Expect 'everything is 503 STORE_UPDATING' $r 503 '*STORE_UPDATING*'
      $j = $null; try { $j = $r.Body | ConvertFrom-Json } catch {}
      Check 'the 503 body is JSON with code STORE_UPDATING and a message' ($j -and $j.code -eq 'STORE_UPDATING' -and $j.message) "body '$($r.Body)'"
      Check '503 Content-Type is application/json' ($r.H['content-type'] -like 'application/json*') "got '$($r.H['content-type'])'"
      # every 503 carries Retry-After 30 and CORS
      $cases = @(
        @('GET with key', 'GET', "$lan/rest/v1/x", $key, $null), @('GET without key', 'GET', "$lan/rest/v1/x", @{}, $null),
        @('POST', 'POST', "$lan/functions/v1/process-direct-sale", $key, '{}'), @('refresh token', 'POST', "$lan/auth/v1/token?grant_type=refresh_token", $key, '{}'),
        @('storage', 'GET', "$lan/storage/v1/object/x", $key, $null), @('/_store/health', 'GET', "$lan/_store/health", $key, $null), @('unknown path', 'GET', "$lan/zzz", $key, $null),
        @('DELETE', 'DELETE', "$lan/rest/v1/x", $key, $null), @('PATCH', 'PATCH', "$lan/rest/v1/x", $key, '{}'), @('HEAD', 'HEAD', "$lan/rest/v1/x", $key, $null),
        @('POST to status', 'POST', "$lan/_store/status", $key, '{}'))
      foreach ($c in $cases) {
        $h = @{} + $c[3]; $h['Origin'] = $tauri
        $x = Req $c[1] $c[2] $h $c[4]
        Check "503 for $($c[0]) carries Retry-After 30 and CORS" ($x.Status -eq 503 -and $x.RetryAfter -eq '30' -and $x.Allow -eq $tauri) "status $($x.Status) retry-after '$($x.RetryAfter)' acao '$($x.Allow)'"
      }
      Expect 'status stays readable' (Req GET "$lan/_store/status" $key) 200 '*"running"*'
      Expect 'status without a key is 401' (Req GET "$lan/_store/status") 401
      Expect 'duplicated Apikey header on /_store/status' (Raw $lanPort 'GET /_store/status HTTP/1.1' @("Apikey: $anon", 'Apikey: bogus')) 401
      $pre = Req OPTIONS "$lan/rest/v1/x" @{ Origin = $tauri }
      Expect 'preflight answered' $pre 204
      Check 'preflight carries CORS' ($pre.Allow -eq $tauri) "got '$($pre.Allow)'"
      Expect 'mode probe says maintenance' (Req GET "http://127.0.0.1:$modePort/_mode") 200 'maintenance'
      Expect 'mode probe answers only /_mode' (Req GET "http://127.0.0.1:$modePort/other") 404
      Expect 'internal listener unchanged' (Req GET "http://127.0.0.1:$intPort/zzz") 404
      Check 'the maintenance gateway process is still running' (-not $g.HasExited) 'caddy exited during the maintenance checks'
    } finally { Stop-Caddy $g }
  }
} catch {
  $failures.Add("test aborted: $($_.Exception.Message)")
} finally {
  foreach ($p in $procs) { Stop-Caddy $p }
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failures.Count) { $failures | ForEach-Object { Write-Host "FAIL $_" -ForegroundColor Red }; exit 1 }
Write-Host "all $($script:count) gateway expectations held"
