//! The machine's trusted-root store, behind a trait so `pair join` and `pki verify-trust` can be tested without touching it.
//! The real store runs `certutil.exe` by absolute path with a cleared environment (`exec::Cmd`); nothing in a test ever builds it.

use std::fs;
use std::path::Path;
use std::time::Duration;

use super::{certutil_add_root_args, certutil_delete_root_args, hex, pem_to_der, sha256_hex};
use crate::exec::{Cmd, ToolOutput};

pub trait RootStore {
    /// Adds the certificate in `file` (DER or PEM) to the machine's trusted roots.
    fn add_root(&self, file: &Path) -> Result<(), String>;
    /// True when a certificate with this SHA-256 is in the trusted roots.
    fn contains(&self, der: &[u8], sha256: &str) -> Result<bool, String>;
    fn remove(&self, der: &[u8]) -> Result<(), String>;
}

/// The real store: `certutil.exe`, the same tool `windows/hooks.nsh` uses for the print broker certificate.
pub struct CertutilStore;

fn sha1_hex(der: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    hex(&Sha1::digest(der))
}

fn run_certutil(args: &[String]) -> Result<ToolOutput, String> {
    let exe = crate::sys::system_dir()?.join("certutil.exe");
    Cmd::new(exe).args(args).timeout(Duration::from_secs(60)).run().map_err(|e| format!("certutil.exe could not run: {e}"))
}

/// `certutil -store Root <hash>` answers "no such certificate" with NTE_NOT_FOUND (observed in Windows Sandbox, scenario 30) or
/// CRYPT_E_NOT_FOUND; every other failure is an error, never absence.
const NTE_NOT_FOUND: i32 = 0x8009_0011_u32 as i32;
const CRYPT_E_NOT_FOUND: i32 = 0x8009_2004_u32 as i32;

#[derive(Debug, PartialEq, Eq)]
enum Lookup {
    Found,
    NotFound,
    Failed,
}

fn lookup_verdict(code: i32) -> Lookup {
    match code {
        0 => Lookup::Found,
        NTE_NOT_FOUND | CRYPT_E_NOT_FOUND => Lookup::NotFound,
        _ => Lookup::Failed,
    }
}

impl RootStore for CertutilStore {
    fn add_root(&self, file: &Path) -> Result<(), String> {
        let out = run_certutil(&certutil_add_root_args(file))?;
        if out.success() {
            Ok(())
        } else {
            Err(format!("certutil -addstore failed with exit code {} (run as Administrator)", out.code))
        }
    }

    fn contains(&self, der: &[u8], sha256: &str) -> Result<bool, String> {
        // certutil refuses to overwrite: an unguessable name in the caller's temp folder (never a fixed, plantable one)
        let tmp = std::env::temp_dir().join(format!("posctl-root-{}.cer", crate::util::random_hex(8)?));
        let args = vec!["-store".to_string(), "Root".to_string(), sha1_hex(der), tmp.to_string_lossy().into_owned()];
        let out = run_certutil(&args)?;
        match lookup_verdict(out.code) {
            Lookup::Found => {}
            Lookup::NotFound => return Ok(false),
            Lookup::Failed => return Err(format!("certutil -store failed with exit code {} (the trusted roots could not be read)", out.code)),
        }
        let bytes = fs::read(&tmp).map_err(|e| format!("exported certificate unreadable: {e}"));
        let _ = fs::remove_file(&tmp);
        let bytes = bytes?;
        let exported = if bytes.starts_with(b"-----BEGIN") { pem_to_der(&String::from_utf8_lossy(&bytes))? } else { bytes };
        Ok(sha256_hex(&exported) == sha256)
    }

    fn remove(&self, der: &[u8]) -> Result<(), String> {
        let out = run_certutil(&certutil_delete_root_args(&sha1_hex(der)))?;
        if out.success() {
            Ok(())
        } else {
            Err(format!("certutil -delstore failed with exit code {}", out.code))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_crypt_e_not_found_means_absent_any_other_failure_is_an_error() {
        assert_eq!(lookup_verdict(0), Lookup::Found);
        assert_eq!(lookup_verdict(0x8009_2004_u32 as i32), Lookup::NotFound);
        assert_eq!(lookup_verdict(-2146893807), Lookup::NotFound, "the code certutil really returns for a missing root");
        for code in [1, 5, -1, 0x8007_0005_u32 as i32, 0x8009_0000_u32 as i32, 0x8009_0010_u32 as i32] {
            assert_eq!(lookup_verdict(code), Lookup::Failed, "{code}");
        }
    }
}
