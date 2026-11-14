#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Verifies a real, elevated Windows deployment of the store print broker
    (Phase 19: Store-Local Durable Printing Service).

.DESCRIPTION
    This is a scripted artifact, not a checkpoint: this repo's CLAUDE.md
    testing policy requires automating verification rather than asking a
    human to click through the app, and the executing agent's own shell has
    no admin rights on a real target machine to run these elevated checks
    itself (per .planning/spikes/CONVENTIONS.md's "Elevation boundary" note).
    Run this script elevated, on the real deployed store machine, after the
    NSIS installer's post-install hook (windows/hooks.nsh) has completed.

    Fails fast: exits non-zero with a specific message on the FIRST failing
    check, rather than continuing past a failure and producing a partial
    pass. Exits 0 with "All checks passed" only when all five checks hold.

    Checks, in order:
      1. Get-Service PrintBrokerService reports Status=Running and
         StartType=Automatic.
      2. Get-CimInstance Win32_Process -Filter "Name='broker.exe'" shows
         SessionId=0 - proves genuine SCM management (a service process
         always runs in Session 0), not a stray manually-started process
         (.planning/spikes/CONVENTIONS.md's SessionId/ParentProcessId
         pattern).
      3. Get-NetFirewallRule -DisplayName "Store Print Broker" exists, its
         associated port filter shows LocalPort=8973/Protocol=TCP, and its
         associated address filter shows RemoteAddress=LocalSubnet (scoped
         by remote IP range, not by network profile alone).
      4. $env:ProgramData\PrintBroker\client-secret.txt exists and is
         non-empty.
      5. An HTTP GET to http://127.0.0.1:8973/health returns {"ok":true}.
      6. (Phase 20, DEP-01) The build's self-signed cert thumbprint (-ExpectedThumbprint)
         is present in Cert:\LocalMachine\Root - proves windows/hooks.nsh's
         `certutil -f -addstore Root` line actually ran and succeeded during install.
      7. The data folder (%ProgramData%\PrintBroker\) grants BUILTIN\Users,
         Everyone and Authenticated Users no write-type right (only the
         service account and administrators can alter the config or
         secret) - proves windows/hooks.nsh's `icacls` step landed the
         intended ACL. This check runs elevated, so it cannot itself prove a
         standard user can read the file; it instead asserts the `icacls`
         ACE for `*S-1-5-32-545` (BUILTIN\Users, read/execute) is present,
         which is what actually grants that read.
      8. Exactly one certificate in Cert:\LocalMachine\Root matches the
         installed build's subject CN (read from cert\subject.txt next to
         broker.exe) - proves an upgrade did not accumulate a second root
         certificate for the same subject.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ExpectedThumbprint
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "FAILED: $Message" -ForegroundColor Red
    exit 1
}

# --- Check 1: service is running and set to auto-start ---------------------
try {
    $service = Get-Service -Name 'PrintBrokerService' -ErrorAction Stop
} catch {
    Fail "Get-Service PrintBrokerService failed: $($_.Exception.Message)"
}

if ($service.Status -ne 'Running') {
    Fail "PrintBrokerService Status is '$($service.Status)', expected 'Running'."
}
if ($service.StartType -ne 'Automatic') {
    Fail "PrintBrokerService StartType is '$($service.StartType)', expected 'Automatic'."
}
Write-Host "OK: PrintBrokerService is Running with StartType=Automatic." -ForegroundColor Green

# --- Check 2: broker.exe is a genuine SCM-managed process (Session 0) ------
$brokerProcesses = Get-CimInstance Win32_Process -Filter "Name='broker.exe'"
if (-not $brokerProcesses) {
    Fail "No broker.exe process found via Get-CimInstance Win32_Process."
}
$sessionZero = $brokerProcesses | Where-Object { $_.SessionId -eq 0 }
if (-not $sessionZero) {
    $foundSessions = ($brokerProcesses | Select-Object -ExpandProperty SessionId) -join ', '
    Fail "broker.exe is running but not in SessionId=0 (found SessionId(s): $foundSessions) - this looks like a stray manually-started process, not the real SCM-managed service."
}
Write-Host "OK: broker.exe is running under SessionId=0 (genuine SCM-managed service)." -ForegroundColor Green

# --- Check 3: firewall rule exists, scoped to TCP/8973 ----------------------
try {
    $rule = Get-NetFirewallRule -DisplayName 'Store Print Broker' -ErrorAction Stop
} catch {
    Fail "Get-NetFirewallRule 'Store Print Broker' failed: $($_.Exception.Message)"
}

$portFilter = $rule | Get-NetFirewallPortFilter
if (-not $portFilter) {
    Fail "'Store Print Broker' firewall rule has no associated port filter."
}
if ($portFilter.Protocol -ne 'TCP') {
    Fail "'Store Print Broker' firewall rule Protocol is '$($portFilter.Protocol)', expected 'TCP'."
}
if ($portFilter.LocalPort -ne '8973') {
    Fail "'Store Print Broker' firewall rule LocalPort is '$($portFilter.LocalPort)', expected '8973'."
}

$addressFilter = $rule | Get-NetFirewallAddressFilter
if (-not $addressFilter) {
    Fail "'Store Print Broker' firewall rule has no associated address filter."
}
if ($addressFilter.RemoteAddress -ne 'LocalSubnet') {
    Fail "'Store Print Broker' firewall rule RemoteAddress is '$($addressFilter.RemoteAddress)', expected 'LocalSubnet' - the rule is scoped by network profile only, not by remote IP range, which is broader than PRN-01 requires."
}
Write-Host "OK: 'Store Print Broker' firewall rule exists (TCP/8973, RemoteAddress=LocalSubnet)." -ForegroundColor Green

# --- Check 4: per-store secret file exists and is non-empty -----------------
$secretPath = Join-Path $env:ProgramData 'PrintBroker\client-secret.txt'
if (-not (Test-Path -LiteralPath $secretPath)) {
    Fail "client-secret.txt not found at '$secretPath'."
}
$secretContent = Get-Content -LiteralPath $secretPath -Raw -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace($secretContent)) {
    Fail "client-secret.txt at '$secretPath' exists but is empty."
}
Write-Host "OK: client-secret.txt exists and is non-empty." -ForegroundColor Green

# --- Check 5: broker HTTP health check ---------------------------------------
# The broker's auth check runs before every route, including /health (no
# exemption) - the request must carry the same bearer token every other
# route needs, taken as the first non-blank line of client-secret.txt (the
# same rule the broker and app-side resolvers use).
$secretToken = ($secretContent -split "`r`n|`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($secretToken)) {
    Fail "client-secret.txt at '$secretPath' has no non-blank line to use as the bearer token."
}
try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8973/health' -Method Get -TimeoutSec 5 -Headers @{ Authorization = "Bearer $secretToken" }
} catch {
    Fail "GET http://127.0.0.1:8973/health failed: $($_.Exception.Message)"
}
if ($response.ok -ne $true) {
    Fail "GET http://127.0.0.1:8973/health did not return { ""ok"": true } (got: $($response | ConvertTo-Json -Compress))."
}
Write-Host "OK: broker /health endpoint responded { ""ok"": true }." -ForegroundColor Green

# --- Check 6: build cert imported into Trusted Root (Phase 20, DEP-01) -----
try {
    $rootCert = Get-ChildItem Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $ExpectedThumbprint
} catch {
    Fail "Get-ChildItem Cert:\LocalMachine\Root failed: $($_.Exception.Message)"
}
if (-not $rootCert) {
    Fail "cert not found in Trusted Root after install"
}
Write-Host "OK: build cert (thumbprint $ExpectedThumbprint) present in Cert:\LocalMachine\Root." -ForegroundColor Green

# --- Check 7: data folder ACL excludes standard-user write rights, icacls ACE present ---
$dataFolder = Join-Path $env:ProgramData 'PrintBroker'
try {
    $acl = Get-Acl -LiteralPath $dataFolder -ErrorAction Stop
} catch {
    Fail "Get-Acl '$dataFolder' failed: $($_.Exception.Message)"
}
# Only the write-TYPE rights - FullControl (and Modify/Write, which include
# it) also set the read bits and Synchronize, so ORing FullControl into this
# mask would flag the installer's own intended
# `*S-1-5-32-545:(OI)(CI)RX` (ReadAndExecute, Synchronize) grant as a
# violation on every correct install.
$writeRights = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
    [System.Security.AccessControl.FileSystemRights]::AppendData -bor
    [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
# Compared by SID, not by name (BUILTIN\Users, Everyone, NT AUTHORITY\
# Authenticated Users): those English names are localized on a non-English
# Windows, which would let this check pass vacuously there. An identity
# that cannot be translated to a SID (e.g. an orphaned/foreign SID) is
# treated as non-matching rather than failing the whole check.
function Get-IdentitySid([System.Security.Principal.IdentityReference]$Identity) {
    try {
        return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}
$standardUserSids = @('S-1-5-32-545', 'S-1-1-0', 'S-1-5-11')
$standardUserWriteAccess = $acl.Access | Where-Object {
    $standardUserSids -contains (Get-IdentitySid $_.IdentityReference) -and
    $_.AccessControlType -eq 'Allow' -and
    ($_.FileSystemRights -band $writeRights)
}
if ($standardUserWriteAccess) {
    Fail "'$dataFolder' grants a standard-user identity a write-type right ($($standardUserWriteAccess.IdentityReference.Value): $($standardUserWriteAccess.FileSystemRights)) - a standard user could corrupt the config or secret."
}
# This script runs elevated (#Requires -RunAsAdministrator), so it cannot
# itself prove a standard user can read the file - it asserts the ACE that
# grants that read is present instead (windows/hooks.nsh's
# `*S-1-5-32-545:(OI)(CI)RX` grant, BUILTIN\Users read/execute).
$readRights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
$usersReadAccess = $acl.Access | Where-Object {
    (Get-IdentitySid $_.IdentityReference) -eq 'S-1-5-32-545' -and
    $_.AccessControlType -eq 'Allow' -and
    ($_.FileSystemRights -band $readRights) -eq $readRights
}
if (-not $usersReadAccess) {
    Fail "'$dataFolder' has no BUILTIN\Users ReadAndExecute ACE - client-secret.txt may not be readable by a standard user."
}
Write-Host "OK: '$dataFolder' grants no standard-user identity a write-type right, and the BUILTIN\Users read ACE is present." -ForegroundColor Green

# --- Check 8: exactly one root certificate for the installed build's subject ---
$brokerExePath = ($brokerProcesses | Select-Object -First 1 -ExpandProperty ExecutablePath)
if (-not $brokerExePath) {
    Fail "Could not resolve broker.exe's ExecutablePath to locate the install directory."
}
$installDir = Split-Path (Split-Path $brokerExePath -Parent) -Parent
$subjectPath = Join-Path $installDir 'cert\subject.txt'
if (-not (Test-Path -LiteralPath $subjectPath)) {
    Fail "Subject CN resource not found at '$subjectPath'."
}
$subjectCn = (Get-Content -LiteralPath $subjectPath -Raw -ErrorAction Stop).Trim()
if ([string]::IsNullOrWhiteSpace($subjectCn)) {
    Fail "Subject CN resource at '$subjectPath' is empty."
}
$matchingRootCerts = @(Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "CN=$subjectCn*" })
if ($matchingRootCerts.Count -ne 1) {
    Fail "Expected exactly 1 root certificate with subject 'CN=$subjectCn*' in Cert:\LocalMachine\Root, found $($matchingRootCerts.Count)."
}
Write-Host "OK: exactly one root certificate present for subject 'CN=$subjectCn'." -ForegroundColor Green

Write-Host "All checks passed" -ForegroundColor Green
exit 0
