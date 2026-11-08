# store-server/sandbox/lib-cloud-storage-stub.ps1 - a fake hosted Storage endpoint for the photo step of the switch (Plan 09 Task 13; scenarios 50, 53).
# Dot-sourced AFTER lib-switch.ps1. Windows PowerShell 5.1 syntax only. Runs inside the Sandbox; the job is stopped by its Job object, never by image name.
# Serves what `posctl photos import-from-cloud` reads: GET {projectUrl}/storage/v1/object/authenticated/{bucket}/{name} with the key in the `apikey`
#   header. The importer accepts `http://127.0.0.1:<port>` (loopback literal, same rule as switch/source.rs), so no certificate or hosts entry is needed.
# Files live in $script:StubDir\<bucket>\<name>; a name listed in $script:StubDir\fail.txt answers 500 (the importer retries 3 times, then fails: exit 61).
# Requests are logged as `GET <path> <status>` in requests.log; the key is compared in the job and never written anywhere.
$script:StubPort = 0; $script:StubUrl = ''; $script:StubDir = ''; $script:StubJob = $null; $script:StubObjects = @()

function Start-CloudStorageStub([int]$Port = 47391) {
  if ($script:StubJob) { return $script:StubUrl }
  $script:StubDir = Join-Path $script:OutDir 'stub-storage'
  New-Item -ItemType Directory -Force -Path $script:StubDir | Out-Null
  Remove-Item (Join-Path $script:StubDir 'fail.txt'), (Join-Path $script:StubDir 'requests.log') -Force -ErrorAction SilentlyContinue
  $script:StubPort = $Port; $script:StubUrl = "http://127.0.0.1:$Port"
  $script:StorageKey = (New-RandomToken 30)   # Get-CloudStdin reuses it while the stub runs
  $ready = Join-Path $script:StubDir 'ready.flag'; Remove-Item $ready -Force -ErrorAction SilentlyContinue
  $script:StubJob = Start-Job -ArgumentList $Port, $script:StubDir, $script:StorageKey, $ready -ScriptBlock {
    param($port, $dir, $key, $ready)
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://127.0.0.1:$port/"); $l.Start()
    Set-Content $ready 'up'
    $prefix = '/storage/v1/object/authenticated/'
    while ($l.IsListening) {
      $c = $l.GetContext(); $rq = $c.Request; $rs = $c.Response
      $path = [uri]::UnescapeDataString($rq.Url.AbsolutePath); $status = 404; $bytes = $null
      try {
        if ($rq.Headers['apikey'] -ne $key) { $status = 401 }
        elseif ($rq.HttpMethod -ne 'GET' -or -not $path.StartsWith($prefix) -or $path.Contains('..')) { $status = 404 }
        else {
          $rel = $path.Substring($prefix.Length)
          $failFile = Join-Path $dir 'fail.txt'
          $fails = @(); if (Test-Path $failFile) { $fails = @(Get-Content $failFile) }
          $file = Join-Path $dir ($rel -replace '/', '\')
          if ($fails -contains $rel) { $status = 500 }
          elseif (Test-Path $file -PathType Leaf) { $bytes = [System.IO.File]::ReadAllBytes($file); $status = 200 }
        }
      } catch { $status = 500 }
      Add-Content (Join-Path $dir 'requests.log') "GET $path $status"
      $rs.StatusCode = $status
      if ($bytes) { $rs.ContentType = 'application/octet-stream'; $rs.ContentLength64 = $bytes.Length; $rs.OutputStream.Write($bytes, 0, $bytes.Length) }
      $rs.Close()
    }
  }
  Check 'stub: the fake storage endpoint is listening' $true (Wait-Until { Test-Path $ready } 30 0.25)
  return $script:StubUrl
}
function Stop-CloudStorageStub {
  if ($script:StubJob) { try { Stop-Job $script:StubJob -ErrorAction SilentlyContinue; Remove-Job $script:StubJob -Force -ErrorAction SilentlyContinue } catch { } }
  $script:StubJob = $null; $script:StubUrl = ''
}

# Cloud rows + files: $PerBucket objects in each of product-photos and store-branding, explicit ids, metadata.size = the file's real size (the importer
# checks it). Content is deterministic and differs per object. Call AFTER Reset-Store (it resets the cloud database, not the stub folder).
function Add-StubCloudPhotos([int]$PerBucket = 2) {
  $objs = @()
  foreach ($b in @('product-photos', 'store-branding')) {
    [void](Cq "INSERT INTO storage.buckets (id, name) VALUES ('$b', '$b') ON CONFLICT DO NOTHING")
    New-Item -ItemType Directory -Force -Path (Join-Path $script:StubDir $b) | Out-Null
    for ($i = 1; $i -le $PerBucket; $i++) {
      $id = [guid]::NewGuid().ToString(); $name = "zz-test/$id.webp"; $size = 1500 + 337 * $i + $b.Length
      $buf = New-Object byte[] $size
      for ($k = 0; $k -lt $size; $k++) { $buf[$k] = [byte](($k * 7 + $i * 13 + $b.Length) % 251) }
      $dest = Join-Path $script:StubDir ("$b\" + ($name -replace '/', '\'))
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      [System.IO.File]::WriteAllBytes($dest, $buf)
      [void](Cq "INSERT INTO storage.objects (id, bucket_id, name, metadata) VALUES ('$id', '$b', '$name', '{`"size`": $size, `"mimetype`": `"image/webp`"}'::jsonb)")
      $objs += [pscustomobject]@{ Bucket = $b; Id = $id; Name = $name; Size = $size; Key = "$b/$name" }
    }
  }
  $script:StubObjects = $objs
  return $objs
}
function Set-StubFailing([string[]]$Keys) { Set-Content (Join-Path $script:StubDir 'fail.txt') $Keys }
function Get-StubRequests { $f = Join-Path $script:StubDir 'requests.log'; if (Test-Path $f) { return @(Get-Content $f) } else { return @() } }

# What a copy that really happened looks like: every file is on disk at DATA\photos\<bucket>\<row id> with the cloud's size, every bucket has one, the
# rows are in the live database, the stub saw a request per object, and `posctl photos verify` agrees (exit 0).
function Assert-StubPhotosCopied([string]$Label) {
  $objs = @($script:StubObjects)
  Check "$Label photos: the fixture has objects in both buckets" 'product-photos,store-branding' (($objs | ForEach-Object { $_.Bucket } | Sort-Object -Unique) -join ',')
  foreach ($o in $objs) {
    $f = Join-Path $script:Data "photos\$($o.Bucket)\$($o.Id)"
    $len = -1; if (Test-Path $f -PathType Leaf) { $len = (Get-Item $f).Length }
    Check "$Label photos: $($o.Bucket)/$($o.Id) is on disk with the cloud's size" $o.Size $len
  }
  $ids = ($objs | ForEach-Object { "'$($_.Id)'" }) -join ','
  Check "$Label photos: the object rows are in the live database" $objs.Count ([int](Psql 'postgres' "SELECT count(*) FROM storage.objects WHERE id IN ($ids)"))
  $req = Get-StubRequests
  foreach ($o in $objs) { Check "$Label photos: the cloud was asked for $($o.Key)" $true (@($req | Where-Object { $_ -eq "GET /storage/v1/object/authenticated/$($o.Key) 200" }).Count -ge 1) }
  $v = Invoke-Posctl @('photos', 'verify') -Tag ("$Label-photos-verify" -replace '[^A-Za-z0-9-]', '_')
  Assert-Exit "$Label photos: posctl photos verify" $v 'OK'
}
