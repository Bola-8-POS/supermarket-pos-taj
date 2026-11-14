//! DPAPI machine-scope wrap for secret files only posctl reads (two-mode Plan 11, T17).
//! Must never: print or log plaintext, or fall back to plaintext when wrapping fails.

use crate::util::Secret;

/// First line of a wrapped secret file; the DPAPI blob follows the newline.
pub const MAGIC: &[u8] = b"POSDPAPI1
";

/// Fixed entropy: binds a blob to posctl's use of it (not a secret; machine scope is the protection).
#[cfg(windows)]
const ENTROPY: &[u8] = b"SupermarketPOS posctl secret file v1";

#[cfg(windows)]
fn blob_of(bytes: &[u8]) -> windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
    windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

/// Copy a DPAPI-allocated output blob and release it.
#[cfg(windows)]
fn take(out: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    // SAFETY: `out` was filled by a successful CryptProtectData/CryptUnprotectData call, which allocates
    // `cbData` readable bytes at `pbData` with LocalAlloc; we copy them and free that allocation once.
    unsafe {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        v
    }
}

/// Machine-scope DPAPI (`CRYPTPROTECT_LOCAL_MACHINE`): any local process can unwrap, so this protects copied
/// files and backups, not against a local administrator.
#[cfg(windows)]
pub fn protect(plain: &[u8]) -> std::io::Result<Vec<u8>> {
    use windows::core::w;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let (input, entropy) = (blob_of(plain), blob_of(ENTROPY));
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: both input blobs point at live slices for the call; `out` is a valid out-parameter.
    unsafe {
        CryptProtectData(
            &input,
            w!("posctl"),
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .map_err(|e| std::io::Error::other(format!("DPAPI protect failed: {e}")))?;
    Ok(take(out))
}

/// A blob that does not unwrap (damaged, wrong machine) is `InvalidData`, never an empty secret.
#[cfg(windows)]
pub fn unprotect(blob: &[u8]) -> std::io::Result<Secret> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let (input, entropy) = (blob_of(blob), blob_of(ENTROPY));
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`; no description string is requested.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the DPAPI blob could not be unwrapped",
        )
    })?;
    let bytes = take(out);
    String::from_utf8(bytes).map(Secret).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the unwrapped secret is not UTF-8",
        )
    })
}

/// DPAPI exists only on Windows; posctl's secret files are a Windows-store feature.
#[cfg(not(windows))]
pub fn protect(_plain: &[u8]) -> std::io::Result<Vec<u8>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "DPAPI is only available on Windows",
    ))
}

#[cfg(not(windows))]
pub fn unprotect(_blob: &[u8]) -> std::io::Result<Secret> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "DPAPI is only available on Windows",
    ))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn protect_unprotect_round_trip() {
        let blob = protect(b"fake-secret-value").unwrap();
        assert!(
            !blob.windows(11).any(|w| w == b"fake-secret"),
            "the blob must not contain the plaintext"
        );
        assert_eq!(unprotect(&blob).unwrap().expose(), "fake-secret-value");
    }
}
