# 70 - the update that works, observed from every side (Plan 07 Task 11; obligations 1.4-1.6, 4, 8, 9.1; delta rows for 70).
#  old-auth (GoTrue one migration behind) -> new-auth. Four real updates, each held at a different hook label while the fenced store is inspected:
#   run 1  after:fence             LAN 503 STORE_UPDATING on GET+POST x rest/auth/functions, Retry-After 30, /_store/status 200|401, ports refused, logins refused,
#                                  fence state (demand, no failure actions, depend= empty, maintenance Caddyfile), status.json "updating", no secret in journal/logs.
#                                  The whole update is polled: no 2xx on a data path between the first and the last 503; the pack changes; status "running" after.
#   run 2  journal:work:done       auth-migrate touched the CLONE only: live auth.schema_migrations unchanged, the clone is at the pack's GoTrue level (PGPASSFILE honoured).
#   run 3  journal:swap:done       live == the pack's level, pos_prev_* == the pre-update snapshot; replayed ACL rows and settings equal (catalog state, not substrings).
#   run 4  after:activate_pack     SCM fence re-applied after conf::activate (demand, depend= empty, no failure actions, flag off); a service set to manual beforehand stays manual.
# Estimated 25-30 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new-auth' -OldPack 'old-auth' -LowerAuth
  Check '70 old pack carries the older GoTrue level' $script:AuthOldMax (Get-PackAuthMax $script:OldV)
  Check '70 new pack carries the newer GoTrue level' $script:AuthNewMax (Get-PackAuthMax $script:NewV)
  $pre = New-PreSnapshot
  $live0 = $pre.AuthLevel
  $n = 0; if ($live0 -match '^(\d+)\|') { $n = [int]$Matches[1] }
  $liveNew = "$($n + 1)|$($script:AuthNewMax)"
  $consistentPre = @{ StartTypes = $pre.StartTypes; Rows = $pre.Rows; AuthLevel = $live0; AuthLevelNew = $liveNew }
  Check '70 before: status.json state is running' 'running' ([string](Get-StatusDoc).state)

  # ---- dry run: a pure read ---------------------------------------------------------------------------------------------
  $dbs0 = (Get-DbNames) -join ','
  # backup = 'ok' like every other update here: without it the precondition refuses (exit 12 BACKUP_UNAVAILABLE) before the dry run says anything (run 3)
  $dry = Invoke-Posctl @('update', '--pack', $script:NewV, '--dry-run') (Hooks @{ backup = 'ok' }) -Tag 'dry'
  Assert-Exit '70 dry run' $dry 'OK'
  Check '70 dry run says it would update' $true $dry.json.data.wouldUpdate
  Check '70 dry run changed no database' $dbs0 ((Get-DbNames) -join ',')
  Check '70 dry run left no journal and no fence' $false ((Test-Path (Get-UpdateReadPath 'journal.json')) -or (Test-Path (Join-Path $script:Data 'conf\Caddyfile.live')))
  Check '70 dry run left the GoTrue level alone' $live0 (Get-AuthLevel)

  # ---- run 0 (FR14 A): the clone's catalog digest, read the way the product reads it, must be the digest the pack declares ------------------
  # Held at journal:work:done: the work is finished on pos_next, verify_clone has not run. A mismatch here names WHAT differs (line dump) instead of just exit 14.
  $declared = ''; try { $declared = [string](Read-JsonFile (Join-Path $script:Prog "packs\$($script:NewV)\manifest.json")).catalog.digest } catch { }
  $h = Start-PausedUpdate 'journal:work:done' 40000 @() 'u70z'
  $sqlErr = ''; try { Assert-PackSqlCurrent '70 C0' } catch { $sqlErr = $_.Exception.Message }   # FR15b: both digests must come from the same catalog-digest.sql
  Check '70 C0 pre: the packs were built from the catalog-digest.sql this run digests with' '' $sqlErr
  $cloneDigest = Get-CatalogDigest 'pos_next'
  Check '70 C0: the clone''s catalog digest equals the digest the pack declares' $declared $cloneDigest
  if ($declared -ne $cloneDigest) { Save-CatalogLines 'pos_next' 'catalog-lines-clone.txt'; Save-CatalogLines 'postgres' 'catalog-lines-live.txt' }
  [void](Wait-PosctlAsync $h 900)   # the update itself finishes (or rolls back); either way the store is reset below
  Reset-Store

  # ---- run 1: the fence, from the tills' side --------------------------------------------------------------------------------
  $poll = Join-Path $script:OutDir 'poll70.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '70' $poll   # FR14 (C): the poller has to connect while the store is still live, or the fence checks below prove nothing
  $tStart = [DateTime]::UtcNow   # FR16: the canary run inside verify_live must stamp canary.json lastRunAt AFTER this
  $h = Start-PausedUpdate 'after:fence' 70000 @() 'u70a'
  $t0 = [DateTime]::UtcNow.AddSeconds(1); Start-Sleep -Seconds 7; $t1 = [DateTime]::UtcNow
  Assert-LanFenced '70 fenced' $poll $t0 $t1
  Assert-LanNeverServed '70 fenced' $poll $t0 $t1
  Assert-Fenced '70 fenced' $pre.LiveHash
  Assert-LoginRefused '70 fenced'
  Assert-LanPortsClosed '70 fenced'
  $s = Assert-StatusState '70 fenced' 'updating'
  Check '70 fenced: health still exits 0 (an operation is not an outage)' 0 (Invoke-Posctl @('health', '--write') -Tag 'health-fenced').exit
  Assert-NoSecrets '70 fenced (journal on disk)'
  $r = Wait-PosctlAsync $h 900
  Stop-LanPoller $job
  Assert-Exit '70 update' $r 'OK'
  Check '70 update reports updated' $true $r.json.data.updated
  Check '70 packFrom/packTo' "$($script:OldV)>$($script:NewV)" "$($r.json.data.packFrom)>$($r.json.data.packTo)"
  Check '70 the previous database is named in the report' $true ([bool]$r.json.data.prevDb)
  Assert-ConsistentStore '70 after run 1' $true $consistentPre
  Write-StartTypeTable '70 run 1' $pre.StartTypes (Get-StartTypes)
  Assert-UpdateResult '70 after run 1' 'updated' 'OK' $script:NewV
  Assert-GatewayPackVersion '70 reopened (success)' $script:NewV   # explicit: the NEW pack answers on the LAN path after reopen
  $cj = Read-JsonFile (Join-Path $script:Data 'state\canary.json')
  $ranAt = $null; if ($cj -and $cj.lastRunAt) { try { $ranAt = ConvertTo-UtcDateTime $cj.lastRunAt } catch { } }
  Check '70 verify_live ran the canary: state\canary.json lastRunAt is after the update started' $true ($ranAt -ne $null -and $ranAt -gt $tStart)
  Check '70 verify_live ran the canary: state\canary.json lastOk is true' $true ($cj -ne $null -and $cj.lastOk -eq $true)
  [void](Assert-StatusState '70 after run 1' 'running')
  $rows = @(Read-LanPoll $poll | Where-Object { $_.p -like '/rest/v1*' -or $_.p -like '/auth/v1*' -or $_.p -like '/functions/v1*' })
  # FR14 (D): ConvertFrom-Json gives Int64 and object[] has no LastIndexOf, so the old `.IndexOf(503)` / `.LastIndexOf(503)` found nothing and then threw, which ended the
  # scenario right here and lost every later check. Plain loops over [int] values; a failure of the analysis itself is a failed check, never an abort.
  try {
    $first = -1; $last = -1
    for ($i = 0; $i -lt $rows.Count; $i++) { if ([int]$rows[$i].s -eq 503) { if ($first -lt 0) { $first = $i }; $last = $i } }
    Check '70 tills saw 503s' $true ($first -ge 0)
    if ($first -ge 0) {
      Check '70 the first 503 says STORE_UPDATING' $true ([string]$rows[$first].b -match 'STORE_UPDATING')
      $between = @($rows[$first..$last] | Where-Object { [int]$_.s -ge 200 -and [int]$_.s -lt 300 })
      Check '70 no 2xx on a data path between the first and the last 503' 0 $between.Count
      $after = @(); if ($last + 1 -lt $rows.Count) { $after = @($rows[($last + 1)..($rows.Count - 1)] | Where-Object { [int]$_.s -ne 503 -and [int]$_.s -ne 0 }) }
      Check '70 after the last 503 the store answers (not 503)' $true ($after.Count -gt 0 -or $last -eq ($rows.Count - 1))
    }
  } catch { Add-Check '70 poll analysis' 'no exception' $_.Exception.Message $false }
  # catalog state of the replay: the new live database carries the old one's ACL rows and settings, exactly
  $prev = Get-PrevDbName
  Check '70 a pos_prev_update_* database is kept' $true ([bool]$prev)
  if ($prev) {
    Check '70 ACL rows of the new live == the previous (sorted aclexplode, owner excluded)' (Get-DbAclRows $prev) (Get-DbAclRows 'postgres')
    Check '70 setconfig of the new live == the previous (exact)' (Get-DbSettingRows $prev) (Get-DbSettingRows 'postgres')
    Check '70 the previous database holds the pre-update GoTrue level' $live0 (Get-AuthLevel $prev)
  }
  Assert-NoSecrets '70 after run 1'

  # ---- run 2: auth-migrate touches the clone only ---------------------------------------------------------------------------------
  Reset-Store
  $h = Start-PausedUpdate 'journal:work:done' 40000 @() 'u70b'
  $live = Get-AuthLevel 'postgres'; $clone = Get-AuthLevel 'pos_next'
  Check '70 C1: live auth.schema_migrations is unchanged while the clone is migrated' $live0 $live
  Check '70 C1: the clone is at the pack''s GoTrue level (auth migrate read PGPASSFILE)' $liveNew $clone
  Check '70 C1: the clone gained exactly the missing migration' ($n + 1) (($clone -split '\|')[0])
  Assert-Fenced '70 work done' $pre.LiveHash
  [void](Assert-StatusState '70 work done' 'updating')
  Assert-NoSecrets '70 work done (journal + auth migrate output)'
  Assert-Exit '70 run 2' (Wait-PosctlAsync $h 900) 'OK'
  Assert-ConsistentStore '70 after run 2' $true $consistentPre
  Write-StartTypeTable '70 run 2' $pre.StartTypes (Get-StartTypes)

  # ---- run 3: after the swap ----------------------------------------------------------------------------------------------------
  Reset-Store
  $h = Start-PausedUpdate 'journal:swap:done' 40000 @() 'u70c'
  Check '70 swap: the new live database is at the pack''s GoTrue level' $liveNew (Get-AuthLevel 'postgres')
  $prev = Get-PrevDbName
  Check '70 swap: pos_prev_update_* exists' $true ([bool]$prev)
  if ($prev) { Check '70 swap: pos_prev_update_* equals the pre-update snapshot' $live0 (Get-AuthLevel $prev) }
  Check '70 swap: still fenced, still NOLOGIN' 'f' (Get-RoleCanLogin 'authenticator')
  Assert-Exit '70 run 3' (Wait-PosctlAsync $h 900) 'OK'
  Assert-ConsistentStore '70 after run 3' $true $consistentPre
  Write-StartTypeTable '70 run 3' $pre.StartTypes (Get-StartTypes)

  # ---- run 4: the SCM fence survives conf::activate; a manual service stays manual ---------------------------------------------------
  Reset-Store
  sc.exe config SupermarketPOS-Rest start= demand | Out-Null
  $pre4 = New-PreSnapshot
  $cfg4 = Get-ServiceConfigSnapshot   # FR15 (b): start types + failure actions + failureflag per service, BEFORE the update
  $poll4 = Join-Path $script:OutDir 'poll70d.jsonl'; Remove-Item $poll4 -Force -ErrorAction SilentlyContinue
  $job4 = Start-FencePoller $poll4   # FR16 (e): evidence that the fence was ever applied in this run, for the rollback branch below
  Assert-PollerConnects '70 run 4' $poll4
  $h = Start-PausedUpdate 'after:activate_pack' 50000 @() 'u70d'
  if (Test-Path (Join-Path $script:OutDir 'u70d.flag')) {
    # paused at the label: the fenced-state checks (the update is still running)
    $t0d = [DateTime]::UtcNow.AddSeconds(1); Start-Sleep -Seconds 5; $t1d = [DateTime]::UtcNow   # the update is paused 50 s at the label: fenced for the whole span
    Assert-LanNeverServed '70 run 4 fenced' $poll4 $t0d $t1d
    Assert-Fenced '70 after activate' '' -InternalStackUp
    $j = Get-JournalDoc
    Check '70 after activate: the journal is at the activate step' 'activate' ([string]$j.step)
    $side = Read-JsonFile (Get-UpdateReadPath 'fence-start-types.json')
    Check '70 the sidecar holds the PRE-update start types (Rest manual)' 'demand' ([string]$side.types.Rest)
    Assert-Exit '70 run 4' (Wait-PosctlAsync $h 900) 'OK'
    Stop-LanPoller $job4
    Assert-ConsistentStore '70 after run 4' $true @{ StartTypes = $pre4.StartTypes; Rows = $pre4.Rows; AuthLevel = $live0; AuthLevelNew = $liveNew }
    Write-StartTypeTable '70 run 4' $pre4.StartTypes (Get-StartTypes) @{ Rest = 'Rest pre-set to demand by this scenario (:~126-127)' }
    Check '70 a service that was manual before the update is manual after it' 'demand' ((Get-StartTypes)['Rest'])
    Assert-ServiceConfigRestored '70 after run 4' $cfg4 'success'
    # FR19 item 4: status.json carries the last result's exit code and reason; a success writes no reason and leaves no rolled-back record
    $st70 = Get-StatusDoc
    Check '70 status update.lastCode is 0 after a success' 0 ([int]$st70.update.lastCode)
    Check '70 status update.lastReason is empty after a success' ([string](Get-UpdateResult).lastReason) ([string]$st70.update.lastReason)
    Check '70 status update.lastResult is updated' 'updated' ([string]$st70.update.lastResult)
    Check '70 no UPDATE_ROLLED_BACK alert after a success' 0 @($st70.alerts | Where-Object { $_.code -eq 'UPDATE_ROLLED_BACK' }).Count
  } else {
    # the update ended before the pause point, i.e. it rolled back (the 'reached' check above already failed): a rollback must leave the ORIGINAL configuration, not the fence
    $r4 = Wait-PosctlAsync $h 900
    Stop-LanPoller $job4
    # without proof that the fence was applied, 'the original configuration is back' also holds for an update that never fenced: the poller must have seen the maintenance 503s
    $fencedRows = @(Read-LanPoll $poll4 | Where-Object { [int]$_.s -eq 503 -and [string]$_.b -match 'STORE_UPDATING' })
    Check '70 run 4 rolled back: the fenced state WAS observed (the LAN poller saw 503 STORE_UPDATING)' $true ($fencedRows.Count -gt 0)
    Assert-GatewayPackVersion '70 run 4 rolled back' $script:OldV   # the OLD pack answers after a rollback
    Add-Check '70 run 4 : the update ended before after:activate_pack' 'exit 0 and paused' "exit $($r4.exit) $($r4.json.code)" $false
    Assert-ServiceConfigRestored '70 after run 4' $cfg4 'rolled back'
  }
  Assert-NoSecrets '70 end'
  return @{ Results = (Get-Results); Reboot = $false }
}
