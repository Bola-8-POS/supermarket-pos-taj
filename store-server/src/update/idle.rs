//! How posctl knows the store is not trading: the database says so.
use crate::ops::outcome::OpError;
use crate::ops::world::R;
use serde::Deserialize;

pub const IDLE_MINUTES: u64 = 30; // ponytail: constant; make it a config key if a store ever needs another value
pub const IDLE_SQL: &str = "SELECT json_build_object(\
 'openCaja', (SELECT count(*) FROM public.caja_sessions WHERE status = 'open'),\
 'lastPaymentAgeSeconds', (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(created_at)))::bigint, 2147483647) FROM public.payments))::text";

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Idle { pub open_caja: u32, pub last_payment_age_s: u64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw { open_caja: u32, last_payment_age_seconds: u64 }

pub fn parse_idle(s: &str) -> R<Idle> {
    let r: Raw = serde_json::from_str(s.trim()).map_err(|e| OpError::err("IDLE_UNREADABLE", e.to_string()))?;
    Ok(Idle { open_caja: r.open_caja, last_payment_age_s: r.last_payment_age_seconds })
}
pub fn verdict(i: &Idle) -> Option<&'static str> {
    if i.open_caja > 0 { Some("OPEN_CAJA") }
    else if i.last_payment_age_s < IDLE_MINUTES * 60 { Some("RECENT_SALE") }
    else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_and_verdict() {
        let idle = parse_idle(r#"{"openCaja":0,"lastPaymentAgeSeconds":7200}"#).unwrap();
        assert_eq!(verdict(&idle), None);
        assert_eq!(verdict(&parse_idle(r#"{"openCaja":1,"lastPaymentAgeSeconds":86400}"#).unwrap()), Some("OPEN_CAJA"));
        assert_eq!(verdict(&parse_idle(r#"{"openCaja":0,"lastPaymentAgeSeconds":120}"#).unwrap()), Some("RECENT_SALE"));
        // a store that never sold has no payments: the query returns the 2147483647 sentinel
        assert_eq!(verdict(&parse_idle(r#"{"openCaja":0,"lastPaymentAgeSeconds":2147483647}"#).unwrap()), None);
    }
    #[test]
    fn garbage_is_an_error_not_idle() { assert!(parse_idle("not json").is_err()); }
}
