# 47 - a restore killed in the MIDDLE: the clone, the migration work, the clone verification and the intent to swap (Plan 08 Task 13, slice 2 of 3).
# Labels: journal:clone_db, work, verify_clone (intent and done each) and journal:swap:intent. A kill at or before verify_clone:done leaves the live database as it was:
# recovery undoes the restore and drops the clone (photos are only ever ADDED, so the photo folder is the restored set or the damaged set, never partial).
# journal:swap:intent is decided by pg_database and is accepted either way, but never a mixture.
# Estimated 35 minutes.
. C:\scenarios\lib-backup.ps1
function Invoke-Scenario([int]$Phase) {
  return (Invoke-RestoreKillScenario '47' { $_ -match '^journal:(clone_db|work|verify_clone):' -or $_ -eq 'journal:swap:intent' } { param($l) if ($l -eq 'journal:swap:intent') { 'EITHER' } else { 'DAMAGED' } } 7)
}
