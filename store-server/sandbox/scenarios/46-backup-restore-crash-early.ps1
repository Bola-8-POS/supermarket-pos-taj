# 46 - a restore killed at the EARLY journal points (Plan 08 Task 13, kill-and-recover at every ops::hooked point of a restore, slice 1 of 3).
# Labels: journal:started:done, fence, backup and repair_collation (intent and done each). The fenced tills, the half-finished restore and the damaged database are
# all still there when the process dies (exit 137, as a power cut): the journal says where, health and a second restore both answer RECOVERY_NEEDED (17), the tills
# stay fenced, and `update --recover` UNDOES the restore. After recovery the database is the damaged state it started from (never a mixture), the store is
# consistent (one level, no clone, no fence marker, start types and recovery policy restored) and the admin signs in through GoTrue.
# Estimated 35 minutes.
. C:\scenarios\lib-backup.ps1
function Invoke-Scenario([int]$Phase) {
  return (Invoke-RestoreKillScenario '46' { $_ -match '^journal:(started|fence|backup|repair_collation):' } { param($l) 'DAMAGED' } 7)
}
