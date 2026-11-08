//! Third implementation of the staff Auth-password derivation (the Deno one in
//! `supabase/functions/_shared/staff-password.ts` and the Node one in
//! `scripts/lib/staff-password.ts` are the other two). The contract is byte-identical:
//!
//!   message = `barpos-staff-password|v1|<staff id lower-cased>|<pin>` (UTF-8)
//!   key     = the pepper's UTF-8 bytes (at least 32 characters)
//!   output  = `v1.` + unpadded base64url of HMAC-SHA256 (46 characters)
//!
//! The known-answer vectors in the tests below are the ones pinned by Plan 01 Task 1. If this
//! function ever disagrees with them, every staff member of every local store is locked out.
//! It must never differ by a byte from the Deno and Node derivations, and never accept a short pepper.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const STAFF_PASSWORD_VERSION: &str = "v1";
pub const MIN_PEPPER_LENGTH: usize = 32;
/// Entropy floor (orchestrator ruling): a long but near-constant pepper is refused.
pub const MIN_PEPPER_DISTINCT: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaffPasswordError {
    /// The pepper is missing, shorter than 32 characters, or has fewer than 8 distinct characters.
    Config,
    /// The staff id is not a UUID.
    BadStaffId,
    /// The PIN is not exactly six ASCII digits.
    BadPin,
}

impl std::fmt::Display for StaffPasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StaffPasswordError::Config => {
                write!(f, "the staff password pepper is missing, shorter than {MIN_PEPPER_LENGTH} characters or has fewer than {MIN_PEPPER_DISTINCT} distinct ones")
            }
            StaffPasswordError::BadStaffId => write!(f, "the staff id must be a UUID"),
            StaffPasswordError::BadPin => write!(f, "the PIN must be exactly six digits"),
        }
    }
}

impl std::error::Error for StaffPasswordError {}

pub(crate) fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

pub fn acceptable_pepper(p: &str) -> bool {
    let mut seen: Vec<char> = Vec::new();
    for c in p.chars() {
        if !seen.contains(&c) {
            seen.push(c);
        }
    }
    p.chars().count() >= MIN_PEPPER_LENGTH && seen.len() >= MIN_PEPPER_DISTINCT
}

pub fn derive_staff_password(staff_id: &str, pin: &str, pepper: &str) -> Result<String, StaffPasswordError> {
    if !acceptable_pepper(pepper) {
        return Err(StaffPasswordError::Config);
    }
    if !is_uuid(staff_id) {
        return Err(StaffPasswordError::BadStaffId);
    }
    if pin.len() != 6 || !pin.bytes().all(|c| c.is_ascii_digit()) {
        return Err(StaffPasswordError::BadPin);
    }
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(pepper.as_bytes()).map_err(|_| StaffPasswordError::Config)?;
    mac.update(format!("barpos-staff-password|{STAFF_PASSWORD_VERSION}|{}|{pin}", staff_id.to_lowercase()).as_bytes());
    let tag = mac.finalize().into_bytes();
    Ok(format!("{STAFF_PASSWORD_VERSION}.{}", URL_SAFE_NO_PAD.encode(tag)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test-only pepper and vectors: identical to Plan 01 Task 1 (Deno test and Node parity test).
    const PEPPER: &str = "test-pepper-not-secret-0123456789abcdef";
    const ID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn known_answers_match_plan_01() {
        assert_eq!(
            derive_staff_password(ID, "123456", PEPPER).unwrap(),
            "v1.b-KxtbzaJ3Kj4qtelqO7EIC7CiCPzzZmWEW4T7b0afg"
        );
        assert_eq!(
            derive_staff_password(ID, "654321", PEPPER).unwrap(),
            "v1.06cJj2ek2d7hSpbiXnLIVW1MJaULMx0nH8qlDnyY1mM"
        );
        assert_eq!(
            derive_staff_password("00000000-0000-4000-8000-000000000002", "123456", PEPPER).unwrap(),
            "v1.Ky3kYhaVTh0FuBRUP6kqZxqAzKdEWWPJ35k1wcI69Vc"
        );
    }

    #[test]
    fn staff_id_case_does_not_matter() {
        assert_eq!(
            derive_staff_password("ABCDEF00-0000-4000-8000-0000000000AB", "123456", PEPPER).unwrap(),
            "v1.Bt3Ec0OO3HlVZ1xK7K76_nzC7MsWf7e1zZt-2Fk_RP8"
        );
        assert_eq!(
            derive_staff_password("abcdef00-0000-4000-8000-0000000000ab", "123456", PEPPER).unwrap(),
            derive_staff_password("ABCDEF00-0000-4000-8000-0000000000AB", "123456", PEPPER).unwrap()
        );
    }

    #[test]
    fn output_fits_bcrypt() {
        assert_eq!(derive_staff_password(ID, "123456", PEPPER).unwrap().len(), 46);
    }

    #[test]
    fn refuses_a_missing_or_short_pepper() {
        assert_eq!(derive_staff_password(ID, "123456", ""), Err(StaffPasswordError::Config));
        assert_eq!(derive_staff_password(ID, "123456", "short"), Err(StaffPasswordError::Config));
        assert_eq!(
            derive_staff_password(ID, "123456", &"x".repeat(MIN_PEPPER_LENGTH - 1)),
            Err(StaffPasswordError::Config)
        );
        // review fix: a long but low-entropy pepper is refused too (ruling: floor 8 distinct characters)
        assert_eq!(derive_staff_password(ID, "123456", &"x".repeat(32)), Err(StaffPasswordError::Config));
        assert_eq!(derive_staff_password(ID, "123456", &"0".repeat(64)), Err(StaffPasswordError::Config));
        assert!(derive_staff_password(ID, "123456", &"0123456789abcdef".repeat(2)).is_ok());
    }

    #[test]
    fn acceptable_pepper_needs_length_and_eight_distinct_characters() {
        assert!(acceptable_pepper(PEPPER));
        assert!(!acceptable_pepper(&"x".repeat(64)));
        assert!(!acceptable_pepper("0123456"));
        assert!(acceptable_pepper(&"01234567".repeat(8)));
        assert!(!acceptable_pepper(&"0123456".repeat(9)));
    }

    #[test]
    fn refuses_a_malformed_staff_id_or_pin() {
        assert_eq!(derive_staff_password("not-a-uuid", "123456", PEPPER), Err(StaffPasswordError::BadStaffId));
        assert_eq!(
            derive_staff_password("00000000-0000-4000-8000-00000000000g", "123456", PEPPER),
            Err(StaffPasswordError::BadStaffId)
        );
        assert_eq!(derive_staff_password(ID, "12345", PEPPER), Err(StaffPasswordError::BadPin));
        assert_eq!(derive_staff_password(ID, "1234567", PEPPER), Err(StaffPasswordError::BadPin));
        assert_eq!(derive_staff_password(ID, "12345a", PEPPER), Err(StaffPasswordError::BadPin));
        assert_eq!(derive_staff_password(ID, "١٢٣٤٥٦", PEPPER), Err(StaffPasswordError::BadPin));
    }
}
