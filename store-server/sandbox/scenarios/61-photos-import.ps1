# 61 - `posctl photos import-from-cloud` against a provisioned store (Plan 10 Task 8).
# A loopback listener inside the Sandbox plays the hosted project (lib-cloud-storage-stub.ps1, the same stub scenarios 50 and 53 use; the importer accepts an
# http://127.0.0.1:<port> source, so no certificate is needed). The local database already holds the rows with the cloud's ids (what Plan 09 does before the photo step).
# Proves: N files written with the cloud's size (61.1); a second run reports alreadyPresent N and downloads nothing (61.2); a source that fails on one object gives exit 61
#   and a re-run once it is back completes (61.3); an imported file inherits the photos\ ACL (61.4); a stdin document with "v":2 gives exit 2 and writes nothing (61.5).
# Needs the integrated 09+10 build (storage tables in the base pack, `photos import-from-cloud` in posctl). Estimated 15 minutes.
. C:\scenarios\lib-update.ps1
. C:\scenarios\lib-switch.ps1
. C:\scenarios\lib-cloud-storage-stub.ps1
. C:\scenarios\lib-photos.ps1
function Get-PhotoStdin([int]$V = 1) { return ('{"v":' + $V + ',"projectUrl":"' + $script:StubUrl + '","serviceRoleKey":"' + $script:StorageKey + '"}') }
function Invoke-Import([string]$Tag, [string]$Stdin) { return (Invoke-Posctl @('photos', 'import-from-cloud', '--source-credentials-stdin') $Stdin -Tag $Tag -TimeoutSec 900) }
function Invoke-Scenario([int]$Phase) {
  Install-SwitchStore
  Check '61 prerequisite: the importer is in this build' $true (Test-PhotoImporter)
  [void](Start-CloudStorageStub)
  $objs = @(Add-StubCloudPhotos 2)
  $n = $objs.Count
  Check '61 setup: the fixture has 2 objects in each of 2 buckets' 4 $n
  # the local rows, with the cloud's ids (no files yet)
  foreach ($b in @('product-photos', 'store-branding')) { [void](Psql 'postgres' "INSERT INTO storage.buckets (id, name) VALUES ('$b', '$b') ON CONFLICT DO NOTHING") }
  foreach ($o in $objs) { [void](Psql 'postgres' "INSERT INTO storage.objects (id, bucket_id, name, metadata) VALUES ('$($o.Id)', '$($o.Bucket)', '$($o.Name)', '{`"size`": $($o.Size), `"mimetype`": `"image/webp`"}'::jsonb)") }
  $photos = Get-PhotosRoot
  $v0 = Invoke-Posctl @('photos', 'verify') -Tag '61-verify-before'
  Check '61 setup: before the import every row is dangling (exit 60)' 60 $v0.exit

  # 61.1 first run
  $r1 = Invoke-Import '61-import-1' (Get-PhotoStdin)
  Check '61.1 import exits 0' 0 $r1.exit
  Check '61.1 it downloaded N files and found none present' "$n/0" ("$($r1.json.data.downloaded)/$($r1.json.data.alreadyPresent)")
  foreach ($o in $objs) {
    $f = Join-Path $photos "$($o.Bucket)\$($o.Id)"
    Check "61.1 $($o.Bucket)/$($o.Id) is on disk with the cloud's size" $o.Size $(if (Test-Path -LiteralPath $f) { (Get-Item -LiteralPath $f).Length } else { -1 })
  }
  $vv = Invoke-Posctl @('photos', 'verify') -Tag '61-verify-after'
  Check '61.1 photos verify now exits 0' 0 $vv.exit

  # 61.2 second run
  $r2 = Invoke-Import '61-import-2' (Get-PhotoStdin)
  Check '61.2 a second run exits 0' 0 $r2.exit
  Check '61.2 ... reports alreadyPresent N and downloaded 0' "$n/0" ("$($r2.json.data.alreadyPresent)/$($r2.json.data.downloaded)")

  # 61.4 ACL of an imported file
  Assert-InheritedFunctionsModify '61.4 an imported file inherits the Functions Modify grant' (Join-Path $photos "$($objs[0].Bucket)\$($objs[0].Id)")

  # 61.3 a source that fails on one object, then comes back
  $victim = $objs[1]
  Remove-Item -LiteralPath (Join-Path $photos "$($victim.Bucket)\$($victim.Id)") -Force
  Remove-Item -LiteralPath (Join-Path $script:StubDir 'requests.log') -Force -ErrorAction SilentlyContinue
  Set-StubFailing @($victim.Key)
  $r3 = Invoke-Import '61-import-failing' (Get-PhotoStdin)
  Check '61.3 a failing source gives exit 61 (PHOTOS_IMPORT_FAILED)' '61/PHOTOS_IMPORT_FAILED' ("$($r3.exit)/$($r3.json.code)")
  Check '61.3 exactly the failing object is reported' 1 ([int]$r3.json.data.failedCount)
  Check '61.3 the envelope is marked retryable' $true ([bool]$r3.json.retryable)
  Set-StubFailing @()
  $r4 = Invoke-Import '61-import-rerun' (Get-PhotoStdin)
  Check '61.3 the re-run completes (exit 0)' 0 $r4.exit
  Check '61.3 ... downloaded the one missing file, the rest were present' ("1/" + ($n - 1)) ("$($r4.json.data.downloaded)/$($r4.json.data.alreadyPresent)")
  Check '61.3 ... and the victim is back with the cloud size' $victim.Size $(if (Test-Path -LiteralPath (Join-Path $photos "$($victim.Bucket)\$($victim.Id)")) { (Get-Item -LiteralPath (Join-Path $photos "$($victim.Bucket)\$($victim.Id)")).Length } else { -1 })

  # 61.5 a stdin document of the wrong version writes nothing and is a usage error
  $count0 = @(Get-ChildItem -LiteralPath $photos -Recurse -File -Force).Count
  $r5 = Invoke-Import '61-import-v2' (Get-PhotoStdin 2)
  Check '61.5 stdin with "v":2 exits 2 (USAGE)' '2/USAGE' ("$($r5.exit)/$($r5.json.code)")
  Check '61.5 ... and wrote nothing' $count0 @(Get-ChildItem -LiteralPath $photos -Recurse -File -Force).Count

  Stop-CloudStorageStub
  Assert-NoSecrets '61' $false
  Assert-NoCloudSecrets '61' (Get-AllSecretValues)
  return @{ Results = (Get-Results); Reboot = $false }
}
