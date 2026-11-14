# 48 - a restore killed AFTER the swap: activation, the live verification (with a real GoTrue admin sign-in), the gateway reopen and the unfence (Plan 08 Task 13, slice 3 of 3).
# Labels: journal:swap:done, activate, verify_live, reopen (intent and done each), journal:finalize:intent, before/after:finish_unfence and after:reopen_gateway.
# The swap is visible, so recovery rolls FORWARD: the restored data is live, `update --recover` re-runs verify_live (the admin sign-in on the internal listener) and reopens the
# tills; every label ends on the RESTORED database and photos, the store is consistent, and the admin signs in through GoTrue.
# Estimated 45 minutes.
. C:\scenarios\lib-backup.ps1
function Invoke-Scenario([int]$Phase) {
  return (Invoke-RestoreKillScenario '48' { $_ -match '^journal:(swap:done|activate:|verify_live:|reopen:|finalize:)' -or $_ -match '^(before|after):(finish_unfence|reopen_gateway)$' } { param($l) 'GOOD' } 11)
}
