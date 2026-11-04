# 27 - the live dev-instance test (Task 5 CARRY): `a_real_instance_provisions_starts_seeds_and_stops` runs as a NON-elevated standard
# user (Postgres refuses to run with an administrator token). It spawns Postgres, GoTrue, PostgREST, Functions and Caddy on
# 127.0.0.1:47490-47499 under temp folders, seeds a first admin and tears everything down. It must not touch a real service.
function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  $meta = Get-PayloadMeta
  $test = $null
  foreach ($t in $meta.testExes) {
    $exe = Join-Path $script:Payload "tests\$t"
    $l = & $exe --ignored --list 2>&1 | Out-String
    if ($l -match '(?m)^(\S*a_real_instance_provisions_starts_seeds_and_stops): test') { $test = [pscustomobject]@{ Exe = $exe; Name = $Matches[1] }; break }
  }
  Check-True '27 the live dev-instance test is among the ignored tests' ($null -ne $test) 'not found in any staged test executable'
  if (-not $test) { return @{ Results = (Get-Results); Reboot = $false } }

  $pw = 'Aa1!' + (New-RandomToken 18)
  New-StdUser 'devrunner' $pw
  $cred = New-Object Management.Automation.PSCredential('devrunner', (ConvertTo-SecureString $pw -AsPlainText -Force))
  $work = 'C:\Users\Public\d27'; New-Item -ItemType Directory -Force $work | Out-Null
  & icacls.exe $work /grant 'Users:(OI)(CI)M' | Out-Null
  $copy = "C:\packcopy\$($meta.packVersion)"
  & robocopy "C:\payload\pack\$($meta.packVersion)" $copy /E /NFL /NDL /NJH /NJS /NP | Out-Null
  $exeCopy = Join-Path $work ([IO.Path]::GetFileName($test.Exe)); Copy-Item $test.Exe $exeCopy -Force
  Set-Content (Join-Path $work 'run.cmd') "@echo off`r`nset POS_DEV_PACK_DIR=$copy`r`nset TEMP=$work\tmp`r`nset TMP=$work\tmp`r`nmkdir $work\tmp 2>nul`r`n`"$exeCopy`" --ignored --test-threads=1 --exact $($test.Name) > `"$work\out.txt`" 2>&1`r`necho exit=%ERRORLEVEL% >> `"$work\out.txt`"`r`n"
  $pr = Start-Process cmd.exe -ArgumentList '/c', "$work\run.cmd" -Credential $cred -LoadUserProfile -WorkingDirectory $work -Wait -PassThru -WindowStyle Hidden
  $out = Get-Content "$work\out.txt" -Raw -ErrorAction SilentlyContinue
  Save-Evidence '27-test-output' "$out"
  $ok = $out -match ("(?m)^test " + [regex]::Escape($test.Name) + " \.\.\. ok")
  Add-Check "27 (standard user, not elevated) $($test.Name)" 'ok' $(if ($ok) { 'ok' } else { (@($out -split "`r?`n" | Where-Object { $_ -match 'panicked|FAILED|failed|never|exit=|Error' } | Select-Object -First 5) -join ' | ') }) $ok
  Check-True '27 the dev test touched no real service (none registered)' (Test-AllAbsent) (Get-AllServiceStates)
  Check-Equal '27 nothing is left listening in the dev port block 47490-47499' 0 @(Get-Listeners | Where-Object { $_.Port -ge 47490 -and $_.Port -le 47499 }).Count
  $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in 'postgres', 'auth', 'postgrest', 'caddy', 'functions' } | ForEach-Object { "$($_.ProcessName):$($_.Id)" })
  Check-True '27 no backend process is left running after the test' ($left.Count -eq 0) ($left -join ',')
  & net.exe user devrunner /delete | Out-Null
  return @{ Results = (Get-Results); Reboot = $false }
}
