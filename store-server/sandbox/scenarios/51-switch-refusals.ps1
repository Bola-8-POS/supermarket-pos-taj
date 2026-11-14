# 51 - switch plan/run refusals that need no data move (Plan 09 Task 13).
# STAGE 1: runs on a build WITHOUT Plan 10's importer, but NEEDS a base pack that carries the storage tables (storage.buckets, storage.objects):
#   plan reads them on both sides (copy list, closure, column signature), so without them every answer is a bare refusal. Install-SwitchStore stops with a clear message.
# Needs: lib-update.ps1, lib-switch.ps1, test-hooks posctl, the 'new' test pack (268 migrations incl. the fence). No digest pass 2 needed.
# Each case: the fixture is broken, `switch plan` and `switch run` both answer exit 40 PLAN_BLOCKED naming the finding, the cloud row is
# byte-for-byte unchanged (no begin_draining ran) and the local server is untouched. Reset-Store between cases (cloud and local reset together).
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
function Assert-Refused([string]$Id, [string[]]$Code, $Pre, [string]$Level = 'block') {
  $fp = Get-CloudFingerprint
  $p = Invoke-Switch 'plan' -Tag "$Id-plan"
  Assert-PlanAnswered "$Id plan" $p
  $codes = Get-Codes $p $Level
  $want = Join-CodeSet $Code   # sorted exact set; a single code behaves as before
  foreach ($c in @($Code)) { Check "$Id plan: $c is a $Level finding" $true ($codes -contains $c) }
  # exactly the expected block set: an unexpected extra block must not hide behind the 'contains' check above
  if ($Level -eq 'block') { Check "$Id plan: the block findings are exactly {$want}" $want (Join-CodeSet $codes) }
  if ($Level -eq 'block') {
    Assert-Exit "$Id plan" $p 'SWITCH_REFUSED' 'PLAN_BLOCKED'
    $r = Invoke-Switch 'run' @('--wait-minutes', '1') -Tag "$Id-run"
    Assert-Exit "$Id run" $r 'SWITCH_REFUSED' 'PLAN_BLOCKED'
    foreach ($c in @($Code)) { Check "$Id run: $c is named" $true ((Get-Codes $r) -contains $c) }
    Check "$Id run: the block findings are exactly {$want}" $want (Join-CodeSet (Get-Codes $r))
  }
  Check "${Id}: the cloud row is untouched by plan and run (no hold taken)" $fp (Get-CloudFingerprint)
  Check "${Id}: the cloud reads active" 'active' (Get-CloudStateWord)
  Assert-LocalIntact $Id $Pre
}
# A run answered on the console with the given lines: refused with $Reason before the fence. Not fenced = the cloud row is byte-for-byte unchanged and reads active, and the local
# store is intact (no fence marker, no staging folder, own pepper still installed, services as before: Assert-LocalIntact).
function Assert-ConsoleRefused([string]$Id, [string]$Reason, [string[]]$Answers, $Pre) {
  $fp = Get-CloudFingerprint
  $r = Invoke-Switch 'run' @('--wait-minutes', '1') -Answers $Answers -Tag "$($Id -replace '[^A-Za-z0-9]', '_')-run"
  Assert-Exit "$Id run" $r 'SWITCH_REFUSED' $Reason
  Check "${Id}: the cloud row is untouched (no hold taken, not fenced)" $fp (Get-CloudFingerprint)
  Check "${Id}: the cloud reads active" 'active' (Get-CloudStateWord)
  Check "${Id}: no journal was opened" $false (Test-Path (Get-UpdateReadPath 'journal.json'))
  Assert-LocalIntact $Id $Pre
}
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  $pre = Get-SwitchSnapshot
  [void](Assert-LabelTable '51')
  Assert-NoUnexpectedPublicTables '51 fresh store'

  # 11H console proof (Q1): the run asks for the pepper and ONE admin PIN BEFORE the fence. Every refusal here must leave the store unfenced and the cloud untouched.
  Assert-ConsoleRefused '51 PEPPER_MISMATCH' 'PEPPER_MISMATCH' @((New-CloudPepper), $script:CloudAdminPin) $pre   # right PIN, a well-formed pepper that is not the cloud's
  $bad = New-Digits6; while ($bad -eq $script:CloudAdminPin) { $bad = New-Digits6 }
  Assert-ConsoleRefused '51 ADMIN_PIN_WRONG' 'ADMIN_PIN_WRONG' @($script:CloudPepper, $bad, $bad, $bad) $pre   # right pepper, three wrong PINs
  Assert-ConsoleRefused '51 PIN_PROMPT_REQUIRED' 'PIN_PROMPT_REQUIRED' @() $pre   # nobody at the console (an empty answers file)
  Assert-ConsoleRefused '51 PIN_PROMPT_REQUIRED (pepper given, no PIN)' 'PIN_PROMPT_REQUIRED' @($script:CloudPepper) $pre
  Assert-ConsoleRefused '51 PEPPER_UNUSABLE' 'PEPPER_UNUSABLE' @('not-a-pepper', $script:CloudAdminPin) $pre   # not 64 lower-case hex: refused before any PIN is asked

  # a pre-11H cloud (plaintext PINs, bcrypt check dropped): plan and run both block on schema shape, check violations and no valid admin
  # (the run's own CLOUD_PINS_NOT_HASHED check sits behind that gate and cannot be reached with a gate-passing fixture)
  [void](Cq 'ALTER TABLE public.profiles DROP CONSTRAINT profiles_pin_is_bcrypt; ALTER TABLE public.profiles DISABLE TRIGGER profiles_hash_pin')
  [void](Cq "UPDATE public.profiles SET pin = '$($script:CloudAdminPin)' WHERE id = '$($script:CloudAdminId)'")
  Check '51 setup: the cloud admin PIN is now 6 plain digits' 't' (Cq "SELECT pin ~ '^[0-9]{6}`$' FROM public.profiles WHERE id = '$($script:CloudAdminId)'")
  Assert-Refused '51 plaintext cloud PINs' @('CHECK_VIOLATIONS', 'NO_VALID_ADMIN', 'SCHEMA_SHAPE_MISMATCH') $pre
  Reset-Store

  # FENCE_NOT_INSTALLED: one fence object (the guard function) is missing on the cloud. Renaming a TABLE would also change the cloud's column
  # signature (SCHEMA_SHAPE_MISMATCH, facts.rs SQL_COLUMNS), and functions are not part of the shape; the triggers keep their oid, so nothing else fires.
  [void](Cq 'ALTER FUNCTION public.store_fence_guard() RENAME TO store_fence_guard_x')
  Assert-Refused '51 FENCE_NOT_INSTALLED' 'FENCE_NOT_INSTALLED' $pre
  Reset-Store

  # TILL_QUEUED seeded BEFORE run (a fresh queue): refused at the pre-check, before any hold (the T11 rule)
  Set-CloudTill $script:TillA 'till-a' 3
  Assert-Refused '51 TILL_QUEUED' 'TILL_QUEUED' $pre
  Reset-Store

  # a queue older than a day is only a warning and blocks nothing by itself
  Set-CloudTill $script:TillA 'till-a' 3 0 'active' 172800
  $p = Invoke-Switch 'plan' -Tag '51-stale-plan'
  Assert-PlanAnswered '51 stale queue' $p
  Check '51 TILL_QUEUED_STALE is a warning' $true ((Get-Codes $p 'warn') -contains 'TILL_QUEUED_STALE')
  Check '51 a stale queue is not a TILL_QUEUED block' $false ((Get-Codes $p) -contains 'TILL_QUEUED')
  Check '51 a stale queue: no block findings at all' '' (Join-CodeSet (Get-Codes $p))
  Reset-Store

  Set-CloudTill $script:TillA 'till-a' 0 2
  Assert-Refused '51 TILL_DEAD_LETTERS' 'TILL_DEAD_LETTERS' $pre
  Reset-Store

  [void](Cq "DELETE FROM supabase_migrations.schema_migrations WHERE version = (SELECT min(version) FROM supabase_migrations.schema_migrations)")
  Assert-Refused '51 SCHEMA_LEVEL_BEHIND' 'SCHEMA_LEVEL_BEHIND' $pre
  Reset-Store

  [void](Cq 'ALTER TABLE public.profiles ADD COLUMN zz_extra text')
  Assert-Refused '51 SCHEMA_SHAPE_MISMATCH' 'SCHEMA_SHAPE_MISMATCH' $pre
  Reset-Store

  # a NOT VALID check on THIS server that the cloud rows violate (COPY enforces it)
  # the SAME constraint on the cloud, so the shape signature (sig.rs SQL_CHECKS, NOT VALID stripped) matches and only CHECK_VIOLATIONS fires
  [void](Cq "ALTER TABLE public.profiles ADD CONSTRAINT zz_nv CHECK (name <> 'Switch Admin') NOT VALID")
  [void](Psql 'postgres' "ALTER TABLE public.profiles ADD CONSTRAINT zz_nv CHECK (name <> 'Switch Admin') NOT VALID")
  Assert-Refused '51 CHECK_VIOLATIONS' 'CHECK_VIOLATIONS' $pre

  Assert-NoSecrets '51'
  Assert-NoCloudSecrets '51' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
