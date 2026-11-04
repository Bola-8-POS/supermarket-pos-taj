#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Verifies a real, elevated Windows uninstall of the store print broker
    cleaned up everything the installer set up.

.DESCRIPTION
    This is a scripted artifact, not a checkpoint: this repo's CLAUDE.md
    testing policy requires automating verification rather than asking a
    human to click through the app. Run this script elevated, on the real
    target machine, after the NSIS uninstaller has completed (and NOT on the
    updater path - the updater never runs the old uninstaller, so nothing
    here applies to an in-place update).

    Fails fast: exits non-zero with a specific message on the first failing
    check. Exits 0 with "All checks passed" only when all three checks hold.
    Deliberately does not check %ProgramData%\PrintBroker\ - the ledger and
    the per-store secret are kept on purpose (broker/install/mod.rs's own
    uninstall() documents why: a reinstall must not silently mint a new
    secret and break every already-configured LAN client's credential).

    Checks, in order:
      1. Get-Service PrintBrokerService reports no such service.
      2. Get-NetFirewallRule -DisplayName "Store Print Broker" reports no such
         rule.
      3. Zero certificates in Cert:\LocalMachine\Root match the given subject
         CN (-SubjectCn) - the uninstaller's `certutil -delstore Root`
         removed it and nothing re-added it.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SubjectCn
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "FAILED: $Message" -ForegroundColor Red
    exit 1
}

# --- Check 1: service is gone -----------------------------------------------
$service = Get-Service -Name 'PrintBrokerService' -ErrorAction SilentlyContinue
if ($service) {
    Fail "PrintBrokerService still exists (Status=$($service.Status)) after uninstall."
}
Write-Host "OK: PrintBrokerService no longer exists." -ForegroundColor Green

# --- Check 2: firewall rule is gone -----------------------------------------
$rule = Get-NetFirewallRule -DisplayName 'Store Print Broker' -ErrorAction SilentlyContinue
if ($rule) {
    Fail "'Store Print Broker' firewall rule still exists after uninstall."
}
Write-Host "OK: 'Store Print Broker' firewall rule no longer exists." -ForegroundColor Green

# --- Check 3: root certificate is gone --------------------------------------
if ([string]::IsNullOrWhiteSpace($SubjectCn)) {
    Fail "-SubjectCn was empty."
}
$matchingRootCerts = @(Get-ChildItem Cert:\LocalMachine\Root -ErrorAction Stop | Where-Object { $_.Subject -like "CN=$SubjectCn*" })
if ($matchingRootCerts.Count -ne 0) {
    Fail "$($matchingRootCerts.Count) root certificate(s) with subject 'CN=$SubjectCn*' still present in Cert:\LocalMachine\Root after uninstall."
}
Write-Host "OK: no root certificate with subject 'CN=$SubjectCn*' remains." -ForegroundColor Green

Write-Host "All checks passed" -ForegroundColor Green
exit 0
