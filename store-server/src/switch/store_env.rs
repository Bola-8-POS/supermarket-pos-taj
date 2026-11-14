//! The server PC's own app configuration. `SwitchWork::on_commit` flips the `mode` of `conf\posctl.json` (conventions 5.2) and then
//! calls `paircmd::server_self_pair`, the ONLY writer of `client\store.env` (conventions v1.4); this module only checks, before
//! anything changes, that the pairing will succeed, and reads or sets the `mode` of a posctl.json value.
use crate::update::Env;

/// What `server_self_pair` needs, checked by running its read-only first half (`paircmd::build_record`: gateway.json, the host
/// name, the anon key, the root certificate; `dev` is the loopback allowance `on_commit` passes through `roots.dev`).
/// Every problem is returned as text; empty = ready. A failure after the
/// point of no return could only be fixed forward, so `plan` and `verify_clone` call this.
pub fn check_inputs(env: &Env, dev: bool) -> Vec<String> {
    match crate::paircmd::build_record(&env.roots, "1970-01-01T00:00:00Z", None, dev) {
        Ok(_) => vec![],
        Err(e) => vec![e.message],
    }
}

pub fn conf_mode(conf: &serde_json::Value) -> &str {
    conf["mode"].as_str().unwrap_or("")
}
pub fn set_conf_mode(conf: &mut serde_json::Value, mode: &str) {
    conf["mode"] = serde_json::Value::String(mode.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(d: &std::path::Path) -> Env {
        let (data, program) = (d.join("data"), d.join("prog"));
        let roots = crate::paths::Roots::custom(data.clone(), program.clone());
        Env {
            data,
            program,
            posctl_exe: d.join("posctl.exe"),
            ports: crate::ports::Ports::new(47300).unwrap(),
            roots,
            activate: std::rc::Rc::new(|_, _, _| Ok(())),
        }
    }

    #[test]
    fn the_mode_in_posctl_json_is_read_and_set_without_touching_other_keys() {
        let mut v: serde_json::Value =
            serde_json::json!({ "schema": 1, "mode": "cloud", "ports": { "base": 47300 } });
        assert_eq!(conf_mode(&v), "cloud");
        set_conf_mode(&mut v, "offline-only");
        assert_eq!(
            (conf_mode(&v), v["ports"]["base"].as_u64()),
            ("offline-only", Some(47300))
        );
        assert_eq!(conf_mode(&serde_json::json!({})), "");
    }

    #[test]
    fn a_server_that_cannot_describe_itself_to_its_own_app_is_named_before_anything_changes() {
        let d = tempfile::tempdir().unwrap();
        let missing = check_inputs(&env(d.path()), false);
        assert!(
            !missing.is_empty(),
            "an empty data folder cannot be paired with itself"
        );
        assert!(missing.iter().all(|m| !m.is_empty()));
    }
}
