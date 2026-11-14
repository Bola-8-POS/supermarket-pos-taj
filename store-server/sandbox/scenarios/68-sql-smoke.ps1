# 68 - SQL smoke (FR11). FIRST scenario of every run (stage-payload.ps1 run order): it runs the product's OWN SQL against a real Postgres.
# Why: the host tests use fakes, so a statement Postgres rejects (scenario 69 first failed on `name || text`: "Could not choose a best candidate
# operator") passes every one of them. This scenario provisions a fresh store with the base pack and runs `posctl dev sql-smoke`, a hidden command
# that exists only in the test-hooks build. The SQL is NOT copied here: the command executes the product's own strings and methods through the same
# PsqlAdmin the update uses and prints {name, ok, shape, error} per statement. Read-only statements run as they are; the ones that mutate
# (clone + attribute replay, swap, swap back, collation repair, role LOGIN/NOLOGIN, drop) run on throwaway pos_smoke_* databases and the pos_smoke_role
# role that the command creates and drops itself. This script then checks that nothing of them is left and that the store still runs.
# Estimated 6 minutes.
. C:\scenarios\lib-update.ps1
function Invoke-Scenario([int]$Phase) {
  [void](Ensure-VcRuntime)
  $p = Provision-Fresh 'C:\out\r68.json' '68-provision'
  Check '68 provision with the base pack exits 0' 0 $p.Result.Exit
  if ($p.Result.Exit -ne 0) { return @{ Results = (Get-Results); Reboot = $false } }

  $r = Invoke-Posctl @('dev', 'sql-smoke') -TimeoutSec 900 -Tag '68-sql-smoke'
  Check '68 posctl dev sql-smoke exits 0' 0 $r.exit
  $data = $null; if ($r.json) { $data = $r.json.data }
  $results = @(); if ($data -and $data.results) { $results = @($data.results) }
  Check '68 the smoke printed its JSON results' $true ($results.Count -ge 20)
  $names = @($results | ForEach-Object { [string]$_.name })
  foreach ($must in 'catalog-digest', 'cluster-digest', 'invariants', 'row-counts', 'idle', 'slot-gate', 'applied-migrations', 'level', 'auth-level',
                    'store-schema-version', 'lockout-hook', 'names', 'size', 'owner', 'collation', 'clone-replay-collation', 'swap-and-back', 'set-login') {
    Check "68 the smoke ran $must" $true ($names -contains $must)
  }
  foreach ($x in $results) {
    $err = ''; if ($x.error) { $err = [string]$x.error }
    Check ("68 " + $x.name + ' ok (no SQL error, output has the expected shape)') 'True|' ("$($x.ok)|$err")
  }
  Check '68 allOk' $true ([bool]$data.allOk)

  # the shapes that matter most, asserted here independently of the command's own verdict
  $cat = @($results | Where-Object { $_.name -eq 'catalog-digest' })[0]
  $catHex = ''; if ($cat -and $cat.shape) { $catHex = ([string]$cat.shape) -replace '^sha256 ', '' }
  Check '68 the catalog digest is 64 hex characters' $true ($catHex -match '^[0-9a-f]{64}$')
  Check '68 ... and equals what psql -f catalog-digest.sql returns (scenario 69 harvests it that way)' $catHex (Get-CatalogDigest 'postgres')
  $cl = @($results | Where-Object { $_.name -eq 'cluster-digest' })[0]
  Check '68 the cluster digest is five 64-hex sections' '5 sections, each 64 hex' ([string]$cl.shape)
  $rows = @($results | Where-Object { $_.name -eq 'row-counts' })[0]
  Check '68 the row counts list tables (non-empty)' $true ([bool]($rows -and ([string]$rows.shape) -match '^[1-9][0-9]* tables$'))

  # the throwaways are gone, the store is untouched
  Check '68 no pos_smoke_* database is left' '' ((Get-DbNames | Where-Object { $_ -like 'pos_smoke_*' }) -join ',')
  Check '68 no pos_smoke_role is left' '0' (Psql 'template1' "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pos_smoke%'")
  Check '68 the live database is still there' $true ((Get-DbNames) -contains 'postgres')
  Check '68 the service roles can still sign in' 'True' ((Get-RoleCanLogin 'authenticator') -eq 't')
  Check '68 all five services still run' $true (Test-AllRunning)
  Assert-NoSecrets '68' $false
  return @{ Results = (Get-Results); Reboot = $false }
}
