# 110 - the real gateway answers what the till's schema gate asks, in a way a browser can read (Plan 07b Task 7; review K15).
# The till runs in WebView2 at http://tauri.localhost and reads GET /_store/health and GET /rest/v1/store_schema_version with an apikey header.
# If the gateway lacked the CORS header the browser would see a transport failure and the gate would treat a real answer as "unreachable".
#   a  GET /_store/health with Origin: 200, Access-Control-Allow-Origin == that Origin, packVersion present
#   b  GET /rest/v1/store_schema_version?select=max_version,applied with apikey + Origin: 200, one row with both fields, CORS header
#   c  OPTIONS preflight with Access-Control-Request-Headers: apikey: 2xx, apikey allowed, CORS header
#   d  a foreign Origin is not echoed (the policy is an allowlist, not a wildcard)
# R1 (release gate): the view equals the installed pack manifest before and after a real update to the full-migration pack (Check-R1).
# Estimated 25 minutes.
. C:\scenarios\lib-update.ps1
# R1 (release gate): the level the till compares against is the installed pack's own migration list. The live view must equal the installed pack's manifest
# (count and newest prefix). The client's bundled level is computed from the same folder by the same rule (expected.test.ts pins the rule on the host,
# scripts/check-pack-migrations-match.mjs pins the pack's migration FILES against the repo). Run twice: against the derived `old` pack (263) and, after a real
# update, against the `new` pack, which is the base pack's content (266, drop = 0 in New-TestPacks.ps1).
function Check-R1([string]$Tag) {
  $origin = 'http://tauri.localhost'
  $anon = [string](Get-StoreKeys).anon
  $h = Invoke-LanCurlHeaders 'GET' '/_store/health' @("Origin: $origin")
  $pv = $null; try { $pv = ([string]$h.body | ConvertFrom-Json).packVersion } catch { }
  $v = Invoke-LanCurlHeaders 'GET' '/rest/v1/store_schema_version?select=max_version,applied' @("Origin: $origin", "apikey: $anon")
  $rows = @(); try { $rows = @([string]$v.body | ConvertFrom-Json) } catch { }
  $mf = $null
  if ($pv) { $mp = Join-Path $script:Prog "packs\$pv\manifest.json"; if (Test-Path $mp) { $mf = Get-Content $mp -Raw | ConvertFrom-Json } }
  Save-Evidence "h110-r1-$Tag" "packVersion=$pv view=$($v.body) manifest=$(if ($mf) { "$($mf.migrations.count)/$($mf.migrations.max)" } else { 'none' })"
  Check "110R1 ($Tag) the installed pack manifest was found" $true ($null -ne $mf)
  if ($null -ne $mf -and $rows.Count -gt 0) {
    Check "110R1 ($Tag) view applied == pack manifest migrations.count" ([string]$mf.migrations.count) ([string]$rows[0].applied)
    Check "110R1 ($Tag) view max_version == pack manifest migrations.max" ([string]$mf.migrations.max) ([string]$rows[0].max_version)
  }
}
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  Check-R1 'old-variant'
  # The store runs the derived `old` pack (3 newest migrations dropped). Update to the `new` pack, which carries the base pack's full migration list.
  Assert-Exit '110 update to the full-migration pack' (Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u110-update') 'OK'
  Check-R1 'full-pack'
  $origin = 'http://tauri.localhost'
  $anon = [string](Get-StoreKeys).anon
  $viewPath = '/rest/v1/store_schema_version?select=max_version,applied'

  $h = Invoke-LanCurlHeaders 'GET' '/_store/health' @("Origin: $origin")
  Save-Evidence 'h110-health' "status=$($h.status) acao=$($h.h['access-control-allow-origin']) body=$($h.body) err=$($h.err)"
  Check '110a /_store/health answers 200 with an Origin' 200 $h.status
  Check '110a /_store/health carries Access-Control-Allow-Origin equal to the till origin' $origin ([string]$h.h['access-control-allow-origin'])
  Check '110a /_store/health has exactly one Access-Control-Allow-Origin line (a duplicate makes the browser refuse it)' 1 ([int]$h.n['access-control-allow-origin'])
  $pv = $null; try { $pv = ([string]$h.body | ConvertFrom-Json).packVersion } catch { }
  Check '110a /_store/health body has a packVersion' $true (-not [string]::IsNullOrEmpty([string]$pv))

  $v = Invoke-LanCurlHeaders 'GET' $viewPath @("Origin: $origin", "apikey: $anon")
  Save-Evidence 'h110-view' "status=$($v.status) acao=$($v.h['access-control-allow-origin']) body=$($v.body) err=$($v.err)"
  Check '110b the schema view answers 200 with apikey and Origin' 200 $v.status
  Check '110b the schema view carries Access-Control-Allow-Origin equal to the till origin' $origin ([string]$v.h['access-control-allow-origin'])
  Check '110b the schema view has exactly one Access-Control-Allow-Origin line' 1 ([int]$v.n['access-control-allow-origin'])
  $rows = @(); try { $rows = @([string]$v.body | ConvertFrom-Json) } catch { }
  Check '110b the body is exactly one row' 1 $rows.Count
  $names = ''; if ($rows.Count -gt 0) { $names = (@($rows[0].PSObject.Properties.Name) | Sort-Object) -join ',' }
  Check '110b the row has exactly the two fields the gate reads' 'applied,max_version' $names

  $p = Invoke-LanCurlHeaders 'OPTIONS' $viewPath @("Origin: $origin", 'Access-Control-Request-Method: GET', 'Access-Control-Request-Headers: apikey')
  Save-Evidence 'h110-preflight' "status=$($p.status) allow-headers=$($p.h['access-control-allow-headers']) acao=$($p.h['access-control-allow-origin']) err=$($p.err)"
  Check '110c the preflight is 2xx' $true ($p.status -ge 200 -and $p.status -lt 300)
  Check '110c the preflight allows the apikey header' $true ([string]$p.h['access-control-allow-headers'] -match '(?i)\bapikey\b')
  Check '110c the preflight carries Access-Control-Allow-Origin equal to the till origin' $origin ([string]$p.h['access-control-allow-origin'])

  $f = Invoke-LanCurlHeaders 'GET' '/_store/health' @('Origin: https://evil.example')
  Check '110d a foreign Origin is not echoed back' '' ([string]$f.h['access-control-allow-origin'])

  Assert-NoSecrets '110'
  return @{ Results = (Get-Results); Reboot = $false }
}
