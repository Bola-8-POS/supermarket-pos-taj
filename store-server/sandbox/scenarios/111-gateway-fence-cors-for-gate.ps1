# 111 - while the store is fenced for an update, the gateway's 503 is still readable by the till's browser (Plan 07b Task 7; review K15).
# Without Access-Control-Allow-Origin on the maintenance 503 the browser reports a transport failure: the gate shows "unreachable" and the
# "store is updating" banner never appears. The update is held at after:fence (the maintenance Caddyfile is live), the checks run, then the
# holder is killed and `update --recover` reopens the store (as scenario 80 does).
#   a  GET schema view with apikey + Origin: 503, body code STORE_UPDATING, Access-Control-Allow-Origin == Origin, Retry-After present
#   b  GET /_store/health with Origin: 503 STORE_UPDATING with the CORS header
#   c  OPTIONS preflight (Access-Control-Request-Headers: apikey): 2xx with the header allowed (a preflight is answered during the fence)
#   d  after --recover the schema view answers 200 again with the CORS header
# Estimated 15 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $origin = 'http://tauri.localhost'
  $anon = [string](Get-StoreKeys).anon
  $viewPath = '/rest/v1/store_schema_version?select=max_version,applied'
  $a = Start-PausedUpdate 'after:fence' 90000 @() 'u111'
  try {
    $v = Invoke-LanCurlHeaders 'GET' $viewPath @("Origin: $origin", "apikey: $anon")
    Save-Evidence 'h111-view' "status=$($v.status) acao=$($v.h['access-control-allow-origin']) ra=$($v.h['retry-after']) body=$($v.body) err=$($v.err)"
    Check '111a fenced: the schema view answers 503' 503 $v.status
    $code = ''; try { $code = [string]([string]$v.body | ConvertFrom-Json).code } catch { }
    Check '111a fenced: the body code is STORE_UPDATING' 'STORE_UPDATING' $code
    Check '111a fenced: the 503 carries Access-Control-Allow-Origin equal to the till origin' $origin ([string]$v.h['access-control-allow-origin'])
    Check '111a fenced: the 503 has exactly one Access-Control-Allow-Origin line' 1 ([int]$v.n['access-control-allow-origin'])
    Check '111a fenced: Retry-After is present' $true (-not [string]::IsNullOrEmpty([string]$v.h['retry-after']))

    $h = Invoke-LanCurlHeaders 'GET' '/_store/health' @("Origin: $origin")
    Check '111b fenced: /_store/health answers 503' 503 $h.status
    Check '111b fenced: /_store/health 503 carries the CORS header' $origin ([string]$h.h['access-control-allow-origin'])

    $p = Invoke-LanCurlHeaders 'OPTIONS' $viewPath @("Origin: $origin", 'Access-Control-Request-Method: GET', 'Access-Control-Request-Headers: apikey')
    Check '111c fenced: the preflight is 2xx' $true ($p.status -ge 200 -and $p.status -lt 300)
    Check '111c fenced: the preflight allows apikey' $true ([string]$p.h['access-control-allow-headers'] -match '(?i)\bapikey\b')
    Check '111c fenced: the preflight carries Access-Control-Allow-Origin equal to the till origin' $origin ([string]$p.h['access-control-allow-origin'])
  } finally {
    try { $a.Process.Kill() } catch { }
    [void]$a.Process.WaitForExit(30000)
  }
  Assert-Exit '111 --recover' (Invoke-Posctl @('update', '--recover') (Hooks @{}) -Tag 'u111-recover') 'OK'
  $script:r111 = $null
  [void](Wait-Until { $script:r111 = Invoke-LanCurlHeaders 'GET' $viewPath @("Origin: $origin", "apikey: $anon"); $script:r111.status -eq 200 } 60 1)
  Check '111d after --recover the schema view answers 200' 200 $script:r111.status
  Check '111d after --recover the CORS header is still there' $origin ([string]$script:r111.h['access-control-allow-origin'])
  Assert-NoSecrets '111'
  return @{ Results = (Get-Results); Reboot = $false }
}
