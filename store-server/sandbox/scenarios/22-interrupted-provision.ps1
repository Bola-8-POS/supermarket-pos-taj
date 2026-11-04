# 22 - interrupted provision: kill the posctl process tree (by PID) while a chosen journal step runs, then resume.
# Two cut points on the same machine, one after the other: run_order (the database push) and initdb.
function Start-ProvisionAsync([string]$Digits, [string]$ResultFile, [switch]$Resume) {
  $a = @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', $ResultFile)
  if ($Resume) { $a += '--resume' }
  $p = [Diagnostics.Process]::Start((New-PosctlStartInfo $a))
  $p.StandardInput.WriteLine($Digits); $p.StandardInput.Close()
  [pscustomobject]@{ Proc = $p; Out = $p.StandardOutput.ReadToEndAsync(); Err = $p.StandardError.ReadToEndAsync() }
}

function Test-Interrupt([string]$Step, [string]$Tag, [bool]$ResumeRefused = $false) {
  $digits = New-Digits6
  $h = Start-ProvisionAsync $digits "C:\out\r22-$Tag-first.json"
  $hit = $false
  $end = (Get-Date).AddSeconds(900)
  while ((Get-Date) -lt $end -and -not $h.Proc.HasExited) {
    $s = @(Get-JournalSteps | Where-Object { $_.name -eq $Step -and $_.state -eq 'started' })
    if ($s.Count -gt 0) { $h.Proc.Kill($true); $hit = $true; break }
    Start-Sleep -Milliseconds 100
  }
  [void]$h.Proc.WaitForExit(30000)
  Save-Evidence "22-$Tag-killed-run" ("hit=$hit exited=$($h.Proc.HasExited) exit=$($h.Proc.ExitCode)`n$($h.Out.Result)`n$($h.Err.Result)")
  Check-True "22[$Tag] posctl was killed while step '$Step' was Started" $hit "the process ended before the step ran (exit $($h.Proc.ExitCode))"
  if (-not $hit) { return $null }
  Start-Sleep -Seconds 3
  $steps = @(Get-JournalSteps)
  $st = ($steps | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' '
  Check-True "22[$Tag] the provision journal survives and shows '$Step' not Done" ((Test-Path (Join-Path $script:DataRoot 'state\provision-journal.json')) -and (@($steps | Where-Object { $_.name -eq $Step -and $_.state -eq 'done' }).Count -eq 0)) $st
  $kids = @(Get-Process -Name initdb, postgres, psql, supabase -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) -join ','
  Add-Check "22[$Tag] what is still running after the kill (recorded)" 'recorded' ("$kids | " + (Get-AllServiceStates)) $true

  # a plain re-run must not blindly continue
  $plain = Invoke-Posctl @('provision', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin') $digits -Name "22-$Tag-plain-rerun"
  Add-Check "22[$Tag] provision without --resume is refused (RECOVERY_NEEDED, exit 17)" '17' (Format-Envelope $plain) ($plain.Exit -eq 17)

  $res = Invoke-Posctl @('provision', '--resume', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', "C:\out\r22-$Tag-resume.json") $digits -Name "22-$Tag-resume"
  if ($ResumeRefused) {
    # by design (journal: the SQL steps of run_order are not re-runnable): a clean refusal that names the way out
    Add-Check "22[$Tag] provision --resume is refused as unsafe (RECOVERY_NEEDED, exit 17, names unprovision --delete-data)" '17 RECOVERY_NEEDED' (Format-Envelope $res) ($res.Exit -eq 17 -and $res.Json.code -eq 'RECOVERY_NEEDED' -and $res.Json.message -match 'unprovision --delete-data')
    return [string](Get-StoreId)
  }
  Add-Check "22[$Tag] provision --resume exits 0" '0' (Format-Envelope $res) ($res.Exit -eq 0)
  Save-DataEvidence "22-$Tag-after-resume"
  if ($res.Exit -ne 0) { return $null }
  Invoke-ParkBackupTasks -Label " [$Tag]"   # provision registers the Backup tasks; park them before the lifecycle commands (tick race, run 20261025-000013-20)
  Check-True "22[$Tag] resume stdout is one JSON object, ok" ((@($res.Raw -split "`r?`n").Count -eq 1) -and $res.Json.ok -eq $true) $res.Raw
  Check-True "22[$Tag] journal: every step Done" (@(Get-JournalSteps | Where-Object { $_.state -ne 'done' }).Count -eq 0 -and @(Get-JournalSteps).Count -ge 11) ((Get-JournalSteps | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ')
  Check-StoreUp "22[$Tag] after resume:"
  $adminId = [string]$res.Json.data.firstAdmin.id
  $email = "$adminId@barpos.local"
  $raw = Invoke-Grant $email $digits
  $good = Invoke-Grant $email (Get-DerivedPassword $adminId $digits (Get-Pepper))
  Check-True "22[$Tag] first admin: raw PIN refused (400), derived password works (200)" ($raw.Status -eq 400 -and $good.Status -eq 200) "raw=$($raw.Status) derived=$($good.Status)"
  $hits = @(); foreach ($root in @((Join-Path $script:DataRoot 'logs'), (Join-Path $script:DataRoot 'state'), "C:\out\r22-$Tag-resume.json", "C:\out\r22-$Tag-first.json")) { $hits += @(Find-Text $root $digits) }
  Check-True "22[$Tag] PIN absent from logs, journal/state and result files" ($hits.Count -eq 0) ($hits -join ', ')
  $profiles = Invoke-Psql "SELECT count(*) FROM public.profiles WHERE role = 'admin'"
  Check-Equal "22[$Tag] exactly one admin profile after kill + resume" 1 $profiles.Out.Trim()
  return [string]$res.Json.data.storeId
}

# Third cut point (Task 10 CARRY: the real HTTP reset of the first admin). posctl is killed right after the admin PROFILE exists but
# before the step is journalled Done (the window is the sign-in verification, a few hundred ms), so the resume finds an admin
# and takes the AlreadyExists -> reset_first_admin_pin path over real HTTP. The check that the reset path ran: the resumed run
# reports the SAME admin id the killed run created, there is exactly one admin, and the new PIN works through the derived password.
$script:FastHttp = New-Object Net.Http.HttpClient
$script:FastHttp.Timeout = [TimeSpan]::FromSeconds(3)
function Get-AdminProfileIdFast {
  $kf = Join-Path $script:DataRoot 'secrets\keys.json'
  if (-not (Test-Path $kf)) { return $null }
  try {
    $key = (Get-Content $kf -Raw | ConvertFrom-Json).service_role
    $req = New-Object Net.Http.HttpRequestMessage ([Net.Http.HttpMethod]::Get), "http://127.0.0.1:$($script:Base + 5)/rest/v1/profiles?select=id&role=eq.admin&limit=1"
    $req.Headers.Add('apikey', $key); $req.Headers.Add('Authorization', "Bearer $key")
    $resp = $script:FastHttp.SendAsync($req).GetAwaiter().GetResult()
    $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ($resp.IsSuccessStatusCode -and $body -match '"id"\s*:\s*"([0-9a-fA-F-]{36})"') { return $Matches[1] }
  } catch { }
  return $null
}
function Test-FirstAdminResetCut {
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $digits = New-Digits6
    $h = Start-ProvisionAsync $digits "C:\out\r22-reset-first-$attempt.json"
    $killedId = $null
    $end = (Get-Date).AddSeconds(900)
    while ((Get-Date) -lt $end -and -not $h.Proc.HasExited) {
      $id = Get-AdminProfileIdFast
      if ($id) { $h.Proc.Kill($true); $killedId = $id; break }
      Start-Sleep -Milliseconds 10
    }
    [void]$h.Proc.WaitForExit(30000)
    $steps = @(Get-JournalSteps)
    $faDone = @($steps | Where-Object { $_.name -eq 'first_admin' -and $_.state -eq 'done' }).Count
    $st = ($steps | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' '
    if ($killedId -and $faDone -eq 0) {
      Check-True "22[reset] attempt ${attempt}: posctl killed after the admin profile existed and before first_admin was journalled Done" $true
      Start-Sleep -Seconds 3
      $res = Invoke-Posctl @('provision', '--resume', '--pack', 'auto', '--server-host', 'sandbox-pc', '--confirm-private-network', '--first-admin-pin-stdin', '--result-file', 'C:\out\r22-reset-resume.json') $digits -Name '22-reset-resume'
      Add-Check '22[reset] provision --resume exits 0' '0' (Format-Envelope $res) ($res.Exit -eq 0)
      if ($res.Exit -ne 0) { return [string](Get-StoreId) }
      Invoke-ParkBackupTasks -Label " [reset $attempt]"   # provision registers the Backup tasks; park them before the lifecycle commands (tick race, run 20261025-000013-20)
      $adminId = [string]$res.Json.data.firstAdmin.id
      Check-Equal '22[reset] the resumed run reports the SAME admin id as the killed run (it found the admin and reset its PIN)' $killedId $adminId
      Check-Equal '22[reset] exactly one admin profile' 1 (Invoke-Psql "SELECT count(*) FROM public.profiles WHERE role = 'admin'").Out.Trim()
      $email = "$adminId@barpos.local"
      $raw = Invoke-Grant $email $digits
      $good = Invoke-Grant $email (Get-DerivedPassword $adminId $digits (Get-Pepper))
      Check-True '22[reset] after the reset the raw PIN is refused (400) and the derived password works (200)' ($raw.Status -eq 400 -and $good.Status -eq 200) "raw=$($raw.Status) derived=$($good.Status)"
      Check-Equal '22[reset] profiles.pin equals the PIN of the resumed run' $digits (Invoke-Psql "SELECT pin FROM public.profiles WHERE id = '$adminId'").Out.Trim()
      $hits = @(); foreach ($root in @((Join-Path $script:DataRoot 'logs'), (Join-Path $script:DataRoot 'state'), 'C:\out\r22-reset-resume.json', "C:\out\r22-reset-first-$attempt.json")) { $hits += @(Find-Text $root $digits) }
      Check-True '22[reset] PIN absent from logs, journal/state and result files' ($hits.Count -eq 0) ($hits -join ', ')
      Check-StoreUp '22[reset] after resume:'
      return [string]$res.Json.data.storeId
    }
    # missed the window (or the run ended first): start over on clean data
    Add-Check "22[reset] attempt ${attempt}: window missed (recorded, retrying)" 'recorded' "killedId=$killedId faDone=$faDone steps=$st" $true
    $sid = Get-StoreId
    if ($sid) { [void](Invoke-Posctl @('unprovision', '--delete-data', '--confirm', (($sid -replace '-', '').Substring(0, 8))) -Name "22-reset-retry-cleanup-$attempt") }
    elseif (-not (Test-AllAbsent)) { break }
  }
  Add-Check '22[reset] the kill window was hit within 5 attempts' 'hit' 'never hit' $false
  return $null
}

function Invoke-Scenario([int]$Phase) {
  [void](Install-Posctl)
  [void](Ensure-VcRuntime)
  [void](Install-Pack)
  foreach ($v in @(@('run_order', 'dbpush'), @('initdb', 'initdb'))) {
    $storeId = Test-Interrupt $v[0] $v[1] ($v[0] -eq 'run_order')
    # start over for the next cut point: delete the data (and prove unprovision works after a resumed provision)
    $sid = if ($storeId) { $storeId } else { Get-StoreId }
    if ($sid) {
      $tok = ($sid -replace '-', '').Substring(0, 8)
      $u = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', $tok) -Name "22-$($v[1])-cleanup"
      Add-Check "22[$($v[1])] cleanup: unprovision --delete-data" '0 and all services gone' ((Format-Envelope $u) + ' ' + (Get-AllServiceStates)) ($u.Exit -eq 0 -and (Test-AllAbsent))
    } else {
      Add-Check "22[$($v[1])] cleanup: store id known" 'known' 'unknown' $false
      break
    }
  }
  if (Test-AllAbsent) {
    $sid3 = Test-FirstAdminResetCut
    if ($sid3) {
      $u3 = Invoke-Posctl @('unprovision', '--delete-data', '--confirm', (($sid3 -replace '-', '').Substring(0, 8))) -Name '22-reset-cleanup'
      Add-Check '22[reset] cleanup: unprovision --delete-data' '0 and all services gone' ((Format-Envelope $u3) + ' ' + (Get-AllServiceStates)) ($u3.Exit -eq 0 -and (Test-AllAbsent))
    }
  }
  return @{ Results = (Get-Results); Reboot = $false }
}
