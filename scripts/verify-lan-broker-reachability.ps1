<#
.SYNOPSIS
    Verifies the store print broker's LAN/VPN firewall rule (Plan 19-02)
    actually admits traffic from a SECOND real machine, not just loopback
    (Phase 19: Store-Local Durable Printing Service, PRN-01).

.DESCRIPTION
    THIS SCRIPT COULD NOT BE RUN DURING THIS PHASE'S PLANNING OR EXECUTION.
    Every prior verification in this phase (this script's own broker/
    cargo tests, scripts/verify-print-broker-install.ps1) ran against
    loopback (127.0.0.1) on the single sandboxed Windows host available to
    the executing agent — there was no second real machine or bridged VM
    reachable from that environment to exercise the cross-machine LAN/VPN
    path at all. Per this repo's CLAUDE.md no-silent-drop testing policy,
    that gap is recorded here explicitly rather than glossed over or
    falsely claimed as verified (19-08-PLAN.md's `verification: backstop`
    truth). Running this script once, for real, from a second machine on
    the store's LAN/VPN against the POS host's real IP is the closing step
    for PRN-01's cross-machine claim — it is a deployment-time task, not
    something this sandboxed environment can close.

    Run this FROM A SECOND MACHINE on the same LAN/VPN as the POS host (not
    on the POS host itself — that would only prove loopback again). Takes
    the POS host's IP as a parameter. Requires no authentication — the
    broker's /health route is intentionally unauthenticated (matches
    scripts/verify-print-broker-install.ps1's own Check 5, which proves the
    same route works over loopback).

    Fails fast: exits non-zero with a specific message on the first failing
    check. Exits 0 with a clear PASS message only when the health check
    succeeds within the timeout.

.PARAMETER PosHostIp
    The store POS host's LAN/VPN-reachable IPv4 address (e.g. 192.168.1.50).
    Never use "localhost"/"127.0.0.1" here — that would test loopback on
    the machine running this script, not the POS host over the network.

.PARAMETER TimeoutSec
    HTTP request timeout in seconds. Defaults to 5.

.EXAMPLE
    .\verify-lan-broker-reachability.ps1 -PosHostIp 192.168.1.50
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$')]
    [string]$PosHostIp,

    [int]$TimeoutSec = 5
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "FAIL: $Message" -ForegroundColor Red
    Write-Host "Either the firewall rule is missing/misconfigured, or the broker is not listening on a LAN-reachable interface — re-check Plan 19-02's netsh rule (windows/hooks.nsh, profile=private, TCP/8973) and the broker's bind address." -ForegroundColor Yellow
    exit 1
}

if ($PosHostIp -in @('127.0.0.1', 'localhost', '::1')) {
    Fail "PosHostIp '$PosHostIp' is a loopback address — this script must be run FROM A SECOND MACHINE against the POS host's real LAN/VPN IP, or it proves nothing beyond what scripts/verify-print-broker-install.ps1 already proves over loopback."
}

$healthUrl = "http://${PosHostIp}:8973/health"
Write-Host "Checking $healthUrl from this machine ($(hostname))..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec $TimeoutSec
} catch {
    Fail "GET $healthUrl failed: $($_.Exception.Message)"
}

if ($response.ok -ne $true) {
    Fail "GET $healthUrl did not return { ""ok"": true } (got: $($response | ConvertTo-Json -Compress))."
}

Write-Host "PASS: $healthUrl responded { ""ok"": true } from a second machine — the firewall rule correctly admits LAN/VPN traffic." -ForegroundColor Green
exit 0
