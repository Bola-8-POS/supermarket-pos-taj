<#
.SYNOPSIS
    Self-check for scripts/purge-customer-repo-refs.ps1's pure filter and
    keep-tags handling (the wave 4a history-purge tool).

.DESCRIPTION
    Mirrors test-customer-manifest-filter.ps1: dot-sources the script (which
    only defines functions when dot-sourced — see its own trailing guard) and
    exercises three things, never touching a real repository:
    (a) Get-RefsToDelete: a keep list of one tag deletes every other tag,
        every heads/* except main, and every remotes/*.
    (b) ConvertTo-KeepTagsArray: a single comma-joined string (as arrives
        under `-File` from a non-PowerShell caller, which never tokenizes an
        unquoted comma into an array) is split on commas and trimmed.
    (c) Invoke-PurgeCustomerRepoRefs's pre-delete check: fails, before any
        `gh api -X DELETE` call, when the current release tag is absent from
        the resolved -KeepTags list. Runs in a child pwsh process (the
        function's own Fail helper calls `exit`) with `gh` stubbed by a
        function, so nothing real is ever called.

    Exits 0 with an "OK:" line only when all three behave correctly.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "FAILED: $Message" -ForegroundColor Red
    exit 1
}

$scriptPath = Join-Path $PSScriptRoot 'purge-customer-repo-refs.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Fail "scripts/purge-customer-repo-refs.ps1 does not exist (expected RED-phase failure if it hasn't been created yet)."
}

# Dot-source with a dummy -Repo: the script's own top-level param block is
# Mandatory on -Repo, but dot-sourcing must still only define functions,
# never call Invoke-PurgeCustomerRepoRefs (its trailing guard checks
# $MyInvocation.InvocationName, not whether parameters were supplied).
. $scriptPath -Repo 'dot-source-only/unused'

foreach ($fn in 'Get-RefsToDelete', 'ConvertTo-KeepTagsArray', 'Invoke-PurgeCustomerRepoRefs') {
    if (-not (Get-Command $fn -ErrorAction SilentlyContinue)) {
        Fail "$fn function not found after dot-sourcing '$scriptPath' (dot-sourcing must define functions only)."
    }
}

# --- (a) Get-RefsToDelete: a keep list of one tag ---------------------------

$fixtureRefs = @(
    'heads/main',
    'heads/worktree-agent-abc123',
    'tags/v1.2.3',
    'tags/v1.3.0',
    'tags/v1.4.0',
    'remotes/origin/main',
    'remotes/origin/feat/some-branch',
    'remotes/pull/3/merge'
)

$result = @(Get-RefsToDelete -Refs $fixtureRefs -KeepTags @('v1.4.0'))

$expected = @(
    'heads/worktree-agent-abc123',
    'tags/v1.2.3',
    'tags/v1.3.0',
    'remotes/origin/main',
    'remotes/origin/feat/some-branch',
    'remotes/pull/3/merge'
)

if (@(Compare-Object -ReferenceObject $expected -DifferenceObject $result).Count -ne 0) {
    Fail "deletion set mismatch. Expected: [$($expected -join ', ')]. Got: [$($result -join ', ')]."
}
if ($result -contains 'heads/main') {
    Fail "heads/main must never be in the deletion set."
}
if ($result -contains 'tags/v1.4.0') {
    Fail "a kept tag (tags/v1.4.0) must never be in the deletion set."
}

Write-Host "OK (a): Get-RefsToDelete kept heads/main and the listed tag, deleted the other $($result.Count) ref(s)." -ForegroundColor Green

# --- (b) ConvertTo-KeepTagsArray: comma-joined single string ----------------

$splitResult = @(ConvertTo-KeepTagsArray -KeepTags @('v1.9.0,v1.8.0'))
$splitExpected = @('v1.9.0', 'v1.8.0')
if (@(Compare-Object -ReferenceObject $splitExpected -DifferenceObject $splitResult).Count -ne 0) {
    Fail "ConvertTo-KeepTagsArray did not split a comma-joined string. Expected: [$($splitExpected -join ', ')]. Got: [$($splitResult -join ', ')]."
}

# A proper multi-element array (e.g. from an in-session PowerShell caller,
# where the parser itself tokenizes the comma) must pass through unchanged.
$passthroughResult = @(ConvertTo-KeepTagsArray -KeepTags @('v1.9.0', ' v1.8.0 '))
$passthroughExpected = @('v1.9.0', 'v1.8.0')
if (@(Compare-Object -ReferenceObject $passthroughExpected -DifferenceObject $passthroughResult).Count -ne 0) {
    Fail "ConvertTo-KeepTagsArray mishandled a real array. Expected: [$($passthroughExpected -join ', ')]. Got: [$($passthroughResult -join ', ')]."
}

if (@(ConvertTo-KeepTagsArray -KeepTags $null).Count -ne 0) {
    Fail "ConvertTo-KeepTagsArray must return an empty array for `$null."
}

Write-Host "OK (b): ConvertTo-KeepTagsArray splits a comma-joined string and passes a real array through unchanged." -ForegroundColor Green

# --- (c) pre-delete check: current release tag absent from -KeepTags -------
# Runs in a child process because Invoke-PurgeCustomerRepoRefs's Fail helper
# calls `exit`, and because `gh` must be stubbed to prove nothing real is
# ever called before the check fires.

$childScriptTemplate = @'
$ErrorActionPreference = 'Stop'
. '__SCRIPTPATH__' -Repo 'dot-source-only/unused'

$script:ghCallCount = 0
function gh {
    $script:ghCallCount++
    $joined = $args -join ' '
    if ($joined -like '*release view*') {
        return '{"tagName":"v9.9.9"}'
    }
    throw "unexpected gh call in pre-delete-check test: $joined"
}

Invoke-PurgeCustomerRepoRefs -Repo 'owner/repo' -KeepTags @('v1.0.0') -WhatIf
'@
$childScript = $childScriptTemplate.Replace('__SCRIPTPATH__', ($scriptPath -replace "'", "''"))

$childOutput = & pwsh -NoProfile -NonInteractive -Command $childScript 2>&1
$childExitCode = $LASTEXITCODE

if ($childExitCode -ne 1) {
    Fail "pre-delete check did not fail as expected (child exit code $childExitCode). Output: $($childOutput -join ' | ')"
}
if (($childOutput -join "`n") -notmatch 'FAILED:.*v9\.9\.9') {
    Fail "pre-delete check failure message did not name the current release tag. Output: $($childOutput -join ' | ')"
}
if (($childOutput -join "`n") -match 'matching-refs') {
    Fail "pre-delete check must fail before ever listing refs (gh api matching-refs was called). Output: $($childOutput -join ' | ')"
}

Write-Host "OK (c): Invoke-PurgeCustomerRepoRefs refuses to proceed when the current release tag (v9.9.9) is absent from -KeepTags, before listing or deleting any ref." -ForegroundColor Green

Write-Host "OK: purge-customer-repo-refs.ps1 self-check passed (a, b, c)." -ForegroundColor Green
