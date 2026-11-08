# 76 - the maintenance window, the idle test, and two updaters (Plan 07 Task 11). posctl.json maintenance.window is set around the Sandbox clock.
#   outside the window: exit 12 PRECONDITION OUTSIDE_WINDOW, nothing changed.
#   inside, caja open: exit 0, skipped, reason OPEN_CAJA, the pending pack is remembered (update-result.json + status.json), still the OLD level.
#   caja closed: updater A is held at before:run_backup (it owns update.lock); updater B is refused LOCK_HELD (exit 10); A finishes and updates; pending is cleared.
# RECENT_SALE: a payment made just now defers the run with reason RECENT_SALE. Estimated 15 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  Install-OldStore -Variant 'new'
  $pre = New-PreSnapshot
  $now = Get-Date
  $o = @{ Start = $now.AddHours(3).ToString('HH:00'); End = $now.AddHours(5).ToString('HH:00') }
  Set-MaintenanceWindow $o.Start $o.End
  $x = Invoke-Posctl @('update', '--pack', $script:NewV, '--window-aware') (Hooks @{ backup = 'ok' }) -Tag 'u76-outside'
  Assert-Exit '76 outside the window' $x 'PRECONDITION' 'OUTSIDE_WINDOW'
  Check '76 outside the window: nothing changed' $script:OldV ([string](Get-Cfg).pack.current)
  Check '76 outside the window: no journal' $false (Test-Path (Get-UpdateReadPath 'journal.json'))

  Set-MaintenanceWindow $now.AddHours(-1).ToString('HH:00') $now.AddHours(2).ToString('HH:00')
  Save-Evidence '76-setup-caja-open' (Psql 'postgres' "INSERT INTO public.caja_sessions(opening_cash, opened_by, status) SELECT 0, id, 'open' FROM public.profiles LIMIT 1")   # fail-loud: a failed setup throws
  Check '76 setup: a caja is open' '1' (Psql 'postgres' "SELECT count(*) FROM public.caja_sessions WHERE status = 'open'")
  $d = Invoke-Posctl @('update', '--pack', $script:NewV, '--window-aware') (Hooks @{ backup = 'ok' }) -Tag 'u76-trading'
  Assert-Exit '76 trading' $d 'OK'
  Check '76 trading: skipped' $true $d.json.data.skipped
  Check '76 trading: for OPEN_CAJA' 'OPEN_CAJA' ([string]$d.json.data.reason)
  Check '76 trading: nothing changed' $script:OldV ([string](Get-Cfg).pack.current)
  $u = Get-UpdateResult
  Check '76 trading: the pending update is remembered' $script:NewV ([string]$u.pending.packVersion)
  Check '76 trading: ... with the reason' 'OPEN_CAJA' ([string]$u.pending.reason + [string]$u.pending.deferredReason)
  Check '76 trading: status.json shows the pending pack' $script:NewV ([string](Get-StatusDoc).update.pending.packVersion)
  [void](Assert-StatusState '76 trading' 'running')

  # trg_caja_sessions_version needs version = old + 1
  Save-Evidence '76-setup-caja-close' (Psql 'postgres' "UPDATE public.caja_sessions SET status = 'closed', closed_at = now(), closed_by = opened_by, version = version + 1 WHERE status = 'open'")
  # RECENT_SALE (idle.rs: the newest public.payments.created_at is under 30 minutes old): a paid sale made just now, inserted as supabase_admin
  $sale = "WITH s AS (INSERT INTO public.shifts(staff_id) SELECT id FROM public.profiles LIMIT 1 RETURNING id, staff_id), " +
    "t AS (INSERT INTO public.tabs(customer_name, staff_id, shift_id, status, closed_at) SELECT 's7-recent-sale', staff_id, id, 'paid', now() FROM s RETURNING id, staff_id) " +
    "INSERT INTO public.payments(tab_id, amount, method, processed_by, created_at, idempotency_key) SELECT id, 5, 'cash', staff_id, now(), 's7-recent-sale-' || id::text FROM t"
  $ins = Invoke-PsqlAs 'supabase_admin' 'postgres' $sale   # throws on failure (payments.idempotency_key is NOT NULL, unique, no default)
  Save-Evidence '76-setup-recent-sale' "exit $($ins.exit)`n$($ins.out)"
  Check '76 setup: a payment made just now exists' '1' (Psql 'postgres' "SELECT count(*) FROM public.payments WHERE created_at > now() - interval '5 minutes'")
  $rowsBefore = Get-RowCounts; $dbsBefore = (Get-DbNames) -join ','; $penBefore = [string](Get-UpdateResult).pending.packVersion
  $rs = Invoke-Posctl @('update', '--pack', $script:NewV, '--window-aware') (Hooks @{ backup = 'ok' }) -Tag 'u76-recent'
  Assert-Exit '76 recent sale' $rs 'OK'
  Check '76 recent sale: skipped' $true $rs.json.data.skipped
  Check '76 recent sale: for RECENT_SALE' 'RECENT_SALE' ([string]$rs.json.data.reason)
  Check '76 recent sale: the pending pack is remembered' $script:NewV ([string](Get-UpdateResult).pending.packVersion)
  Check '76 recent sale: the deferral reason is RECENT_SALE' 'RECENT_SALE' ([string](Get-UpdateResult).pending.deferredReason)
  Check '76 recent sale: nothing was mutated (pack, databases, rows, journal, fence)' "$($script:OldV)|$dbsBefore|$rowsBefore|False|False" ("$((Get-Cfg).pack.current)|$((Get-DbNames) -join ',')|$(Get-RowCounts)|$(Test-Path (Get-UpdateReadPath 'journal.json'))|$(Test-Path (Join-Path $script:Data 'conf\Caddyfile.live'))")
  Save-Evidence '76-setup-age-payments' (Psql 'postgres' "UPDATE public.payments SET created_at = now() - interval '2 hours'")
  $poll = Join-Path $script:OutDir 'poll76.jsonl'; Remove-Item $poll -Force -ErrorAction SilentlyContinue
  $job = Start-FencePoller $poll
  Assert-PollerConnects '76' $poll
  $a = Start-PausedUpdate 'before:run_backup' 45000 @() 'u76-A'
  $info = Read-JsonFile (Get-UpdateFilePath 'update.lock.info')
  Check '76 A holds update.lock: the holder file names update and A''s pid' "update/$($a.Pid)" "$($info.kind)/$($info.pid)"
  $b = Invoke-Posctl @('update', '--pack', $script:NewV) (Hooks @{ backup = 'ok' }) -Tag 'u76-B'
  Assert-LockHeld '76 B' $b
  Assert-Exit '76 B' $b 'LOCK_HELD'
  Check '76 B is told it may retry' $true $b.json.retryable
  [void](Assert-StatusState '76 while A runs' 'updating')
  $ra = Wait-PosctlAsync $a 900
  Assert-Exit '76 A finished' $ra 'OK'
  Start-Sleep -Seconds 3; Stop-LanPoller $job
  Assert-RollbackFenceWindow '76 fence window' $poll   # A is a full successful update: one fence, one reopen
  Check '76 A updated' $true $ra.json.data.updated
  Assert-ConsistentStore '76 after two updaters' $true @{ StartTypes = $pre.StartTypes }
  Check '76 the pending marker is cleared by the successful update' $true ((Get-UpdateResult).pending -eq $null)
  Assert-NoSecrets '76'
  return @{ Results = (Get-Results); Reboot = $false }
}
