//! HS256 JWTs for the store's `anon` and `service_role` keys (what the kit's `New-Jwt` did),
//! plus a verifier so `posctl health` can prove `keys.json` still matches `jwt-secret.txt`.
//! It must never log or return the secret, and a token that fails verification yields nothing.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;

fn mac(secret: &str) -> Hmac<Sha256> {
    <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length")
}

pub fn sign_hs256(secret: &str, claims: &Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes());
    let signing_input = format!("{header}.{payload}");
    let mut m = mac(secret);
    m.update(signing_input.as_bytes());
    format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(m.finalize().into_bytes()))
}

/// The claims of a token whose signature verifies under `secret` and whose header is HS256.
/// Signature only: `iss`, `exp` and `role` are NOT checked here, so this must never be used for
/// authorization decisions.
pub fn verify_hs256(secret: &str, token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let (h, p, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(h).ok()?).ok()?;
    if header.get("alg")?.as_str()? != "HS256" {
        return None;
    }
    let sig = URL_SAFE_NO_PAD.decode(s).ok()?;
    let mut m = mac(secret);
    m.update(format!("{h}.{p}").as_bytes());
    m.verify_slice(&sig).ok()?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "unit-test-secret-not-a-real-one-0123456789";

    #[test]
    fn sign_then_verify_round_trips_the_claims() {
        let claims = json!({"iss": "supabase-offline-store", "role": "anon", "iat": 1, "exp": 2});
        let t = sign_hs256(SECRET, &claims);
        assert_eq!(t.split('.').count(), 3);
        assert_eq!(verify_hs256(SECRET, &t), Some(claims));
    }

    #[test]
    fn a_different_secret_or_a_tampered_payload_is_refused() {
        let t = sign_hs256(SECRET, &json!({"role": "anon"}));
        assert_eq!(verify_hs256("another-secret-another-secret-0000", &t), None);
        let mut parts: Vec<&str> = t.split('.').collect();
        let forged = URL_SAFE_NO_PAD.encode(br#"{"role":"service_role"}"#);
        parts[1] = &forged;
        assert_eq!(verify_hs256(SECRET, &parts.join(".")), None);
    }

    #[test]
    fn alg_none_and_garbage_are_refused() {
        let none_header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"role":"service_role"}"#);
        assert_eq!(verify_hs256(SECRET, &format!("{none_header}.{payload}.")), None);
        assert_eq!(verify_hs256(SECRET, "not-a-token"), None);
        assert_eq!(verify_hs256(SECRET, "a.b.c.d"), None);
    }
}
