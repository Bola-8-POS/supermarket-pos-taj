<#
.SYNOPSIS
    Generates or imports a code-signing certificate for a `npm run tauri build`
    run, and writes the subject-CN resource windows/hooks.nsh reads to remove
    a previous build's root certificate before adding the new one.

.DESCRIPTION
    Default mode (no -PfxPath): generates a brand-new self-signed certificate
    with its own thumbprint - a build-time artifact, not a reusable
    credential.

    -PfxPath mode: imports a long-lived, per-customer certificate from a PFX
    file (held as a CI environment secret) into Cert:\CurrentUser\My instead
    of generating one, non-exportable (-Exportable:$false) so the imported
    private key cannot be re-exported from the runner afterward.

    Either way, exports ONLY the public half (Export-Certificate, never
    Export-PfxCertificate) to src-tauri/cert/selfsigned.cer - the private key
    never leaves the CurrentUser\My store as a file this script writes - and
    writes the certificate's subject CN, and only the CN, to
    src-tauri/cert/subject.txt: a one-line resource with no trailing newline
    that windows/hooks.nsh reads at install/uninstall time to remove the
    previous build's root certificate before adding the new one. Written with
    [IO.File]::WriteAllText and ASCII encoding, because Windows PowerShell
    5.1's `>`/Out-File writes UTF-16LE with a BOM, which NSIS's byte-oriented
    FileRead would hand to certutil as a malformed name. For the same reason
    the resolved subject CN is rejected if it contains any non-ASCII
    character (the base config's placeholder publisher has an em dash; every
    real customer override is plain ASCII).

    Store is Cert:\CurrentUser\My - NOT Cert:\LocalMachine\My despite that
    being the more "production-sounding" choice. `signtool.exe sign /sha1
    <thumbprint>` (what tauri-action / tauri-bundler actually invokes, with no
    `/sm` flag) only searches the CurrentUser store by default; a cert placed
    in LocalMachine\My is invisible to it (confirmed by reproducing signtool's
    exact invocation directly against a real build output, 2026-09-01).
    CurrentUser\My also has no elevation dependency, which matters for a
    self-hosted runner running as a plain (non-admin) service account.

    Output contract: the ONLY thing written via the success-path
    pipeline/`Write-Output` is $cert.Thumbprint (a bare string) - this is what
    `$THUMBPRINT = powershell -File scripts/generate-build-cert.ps1` captures
    for the `npm run tauri build -- --config "..."` invocation. All
    progress/status messages go to `Write-Host` (console only, never captured
    by command substitution).
#>

[CmdletBinding()]
param(
    [string]$Subject = 'CN=Taj House of Spice Supermarket POS',
    [string]$PfxPath,
    # Plain string, not [SecureString]: this script is invoked as a child
    # `powershell -File ...` process from release.yml (Windows PowerShell
    # 5.1), and a SecureString cannot cross that process boundary. When
    # omitted, falls back to the CODE_SIGNING_PFX_PASSWORD environment
    # variable (release.yml sets it from the GitHub Environment secret) so
    # the password is never a command-line argument either.
    [string]$PfxPassword
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "FAILED: $Message" -ForegroundColor Red
    exit 1
}

function Get-SubjectCn([string]$distinguishedName) {
    if ($distinguishedName -match 'CN=([^,]+)') {
        return $Matches[1]
    }
    return $distinguishedName
}

function Assert-AsciiSubjectCn([string]$cn) {
    if ($cn -match '[^\x00-\x7F]') {
        Fail "Certificate subject CN '$cn' contains a non-ASCII character; use a plain-ASCII CN."
    }
}

# Fail fast on the requested self-signed subject before touching the
# certificate store; the imported-PFX certificate's actual subject is
# re-checked below once it is known (it may differ from -Subject).
if (-not $PfxPath) {
    Assert-AsciiSubjectCn (Get-SubjectCn ($Subject -replace '^CN=', ''))
}

$certDir = Join-Path $PSScriptRoot '..\src-tauri\cert'
$certPath = Join-Path $certDir 'selfsigned.cer'
$subjectPath = Join-Path $certDir 'subject.txt'
$certStoreLocation = 'Cert:\CurrentUser\My'

if ($PfxPath) {
    if (-not (Test-Path -LiteralPath $PfxPath)) {
        Fail "PFX file not found: $PfxPath"
    }
    try {
        $importArgs = @{
            FilePath          = $PfxPath
            CertStoreLocation = $certStoreLocation
            Exportable        = $false
        }
        $resolvedPassword = if ($PfxPassword) { $PfxPassword } else { $env:CODE_SIGNING_PFX_PASSWORD }
        if ($resolvedPassword) {
            $importArgs['Password'] = ConvertTo-SecureString -String $resolvedPassword -AsPlainText -Force
        }
        # A commercial code-signing PFX usually bundles its issuing chain
        # alongside the leaf certificate; Import-PfxCertificate imports every
        # certificate the file contains and returns all of them as an array.
        # Only the leaf (the one with a private key) is the certificate this
        # build signs with.
        $importedCerts = @(Import-PfxCertificate @importArgs)
    } catch {
        Fail "Import-PfxCertificate ($PfxPath) failed: $($_.Exception.Message)"
    }
    $cert = $importedCerts | Where-Object HasPrivateKey | Select-Object -First 1
    if (-not $cert) {
        Fail "Import-PfxCertificate ($PfxPath) imported no certificate with a private key."
    }
    # Any other certificate the PFX also imported (intermediates/roots) is
    # not needed after this and must not linger in the store.
    $otherImportedCerts = $importedCerts | Where-Object { $_.Thumbprint -ne $cert.Thumbprint }
    foreach ($otherCert in $otherImportedCerts) {
        Remove-Item -LiteralPath (Join-Path $certStoreLocation $otherCert.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
    Write-Host "OK: imported cert $($cert.Subject), store=$certStoreLocation, thumbprint=$($cert.Thumbprint)" -ForegroundColor Green
} else {
    try {
        $cert = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject $Subject `
            -CertStoreLocation $certStoreLocation `
            -NotAfter (Get-Date).AddYears(5) `
            -KeyUsage DigitalSignature `
            -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
    } catch {
        Fail "New-SelfSignedCertificate ($certStoreLocation) failed: $($_.Exception.Message)"
    }
    Write-Host "OK: generated cert $($cert.Subject), store=$certStoreLocation, thumbprint=$($cert.Thumbprint)" -ForegroundColor Green
}

if (-not $cert -or [string]::IsNullOrWhiteSpace($cert.Thumbprint)) {
    Fail "No usable certificate/thumbprint produced."
}

$subjectCn = Get-SubjectCn $cert.Subject
Assert-AsciiSubjectCn $subjectCn

if (-not (Test-Path -LiteralPath $certDir)) {
    New-Item -ItemType Directory -Force -Path $certDir | Out-Null
}

try {
    Export-Certificate -Cert $cert -FilePath $certPath | Out-Null
} catch {
    Fail "Export-Certificate to '$certPath' failed: $($_.Exception.Message)"
}
Write-Host "OK: exported public certificate to $certPath (private key stays in $certStoreLocation)" -ForegroundColor Green

try {
    [IO.File]::WriteAllText($subjectPath, $subjectCn, [Text.Encoding]::ASCII)
} catch {
    Fail "Writing subject CN to '$subjectPath' failed: $($_.Exception.Message)"
}
Write-Host "OK: wrote subject CN '$subjectCn' to $subjectPath" -ForegroundColor Green

# Machine-readable contract: ONLY the thumbprint goes to stdout/pipeline.
Write-Output $cert.Thumbprint
