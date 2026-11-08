//! Every path posctl touches, derived from two roots (conventions section 2):
//! `data` = `%ProgramData%\SupermarketPOS` and `program` = `%ProgramFiles%\SupermarketPOS`.
//! Production roots refuse a `%ProgramData%` that is not `C:\ProgramData`, because the compiled
//! functions program has the photo path baked in (S4B REVIEW Minor 6). Any other root is a
//! dev/test root and requires `--dev` (it can never register services).

use std::path::{Path, PathBuf};

use crate::envelope::PosctlError;

pub const PRODUCT: &str = "SupermarketPOS";

/// Pure so it can be tested on any machine: the production `%ProgramData%` must be `C:\ProgramData`.
pub fn check_program_data(value: Option<&str>) -> Result<(), String> {
    match value {
        Some(v) if v.trim_end_matches(['\\', '/']).eq_ignore_ascii_case("C:\\ProgramData") => Ok(()),
        Some(v) => Err(format!(
            "%ProgramData% is '{v}', not C:\\ProgramData: the functions program has C:\\ProgramData\\{PRODUCT}\\photos compiled in"
        )),
        None => Err("%ProgramData% is not set".to_string()),
    }
}

/// A production posctl must run from inside the program root: its directory is trusted for
/// `pack-feed-url.txt` and a bundled pack, so a copy run from anywhere else is refused.
pub fn check_posctl_dir(exe: &Path, program: &Path) -> Result<PathBuf, String> {
    let dir = exe.parent().ok_or_else(|| format!("{} has no parent directory", exe.display()))?;
    let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
    if dir.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !lower(dir).starts_with(lower(program)) {
        return Err(format!("posctl must run from under {}, not {}", program.display(), dir.display()));
    }
    if !dir.is_dir() {
        return Err(format!("{} does not exist", dir.display()));
    }
    Ok(dir.to_path_buf())
}

#[derive(Debug, Clone)]
pub struct Roots {
    pub data: PathBuf,
    pub program: PathBuf,
    /// Directory that holds `posctl.exe` (`$INSTDIR\posctl`): where `pack-feed-url.txt` and an
    /// optional bundled pack live.
    pub posctl_dir: PathBuf,
    pub dev: bool,
    /// Dev instances run a pack that lives outside `packs\` (`dev new --pack-dir`).
    pub pack_override: Option<PathBuf>,
}

impl Roots {
    pub fn production() -> Result<Self, PosctlError> {
        // review fix (elevated-path hardening): both folders come from `sys::known_folder` (SHGetKnownFolderPath),
        // never from `%ProgramData%` / `%ProgramFiles%`, which a UAC-consented process inherits from the invoking
        // user's environment (HKCU\Environment overrides system variables) and which would defeat
        // `resolve_pack`'s "only under packs\" rule. Non-Windows stubs return the conventional paths.
        use crate::sys::{known_folder, KnownFolder};
        let pd = known_folder(KnownFolder::ProgramData).map_err(PosctlError::precondition)?.display().to_string();
        check_program_data(Some(pd.as_str())).map_err(PosctlError::precondition)?;
        let program = known_folder(KnownFolder::ProgramFiles).map_err(PosctlError::precondition)?.join(PRODUCT);
        let exe = std::env::current_exe().map_err(|e| PosctlError::error(format!("cannot locate posctl.exe: {e}")))?;
        let posctl_dir = check_posctl_dir(&exe, &program).map_err(PosctlError::precondition)?;
        Ok(Roots {
            data: PathBuf::from("C:\\ProgramData").join(PRODUCT),
            program,
            posctl_dir,
            dev: false,
            pack_override: None,
        })
    }

    /// A dev/test root (`--dev`, `dev new`): never registers services, ACLs or firewall rules.
    pub fn custom(data: PathBuf, program: PathBuf) -> Self {
        let posctl_dir = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf))
            .unwrap_or_default();
        Roots { data, program, posctl_dir, dev: true, pack_override: None }
    }

    pub fn conf(&self) -> PathBuf { self.data.join("conf") }
    pub fn pgdata(&self) -> PathBuf { self.data.join("pgdata") }
    pub fn secrets(&self) -> PathBuf { self.data.join("secrets") }
    pub fn photos(&self) -> PathBuf { self.data.join("photos") }
    pub fn logs(&self) -> PathBuf { self.data.join("logs") }
    pub fn logs_for(&self, service: &str) -> PathBuf { self.logs().join(service) }
    pub fn posctl_logs(&self) -> PathBuf { self.logs().join("posctl") }
    pub fn tmp(&self) -> PathBuf { self.data.join("tmp") }
    pub fn tmp_for(&self, service: &str) -> PathBuf { self.tmp().join(service) }
    pub fn backups(&self) -> PathBuf { self.data.join("backups") }
    pub fn state(&self) -> PathBuf { self.data.join("state") }
    pub fn pki(&self) -> PathBuf { self.data.join("pki") }
    pub fn pki_caddy(&self) -> PathBuf { self.pki().join("caddy") }
    pub fn caddy_xdg(&self) -> PathBuf { self.pki_caddy().join("xdg") }
    pub fn client(&self) -> PathBuf { self.data.join("client") }
    pub fn client_run(&self) -> PathBuf { self.client().join("run") }
    /// Pairing offers Caddy serves (Plan 06); only the Gateway account may read them.
    pub fn pairing_offers(&self) -> PathBuf { self.client().join("pairing").join("offers") }
    pub fn packs_cache(&self) -> PathBuf { self.data.join("packs-cache") }
    pub fn work(&self) -> PathBuf { self.data.join("work") }
    pub fn work_migrations(&self) -> PathBuf { self.work().join("supabase").join("migrations") }

    pub fn posctl_json(&self) -> PathBuf { self.conf().join("posctl.json") }
    pub fn caddyfile(&self) -> PathBuf { self.conf().join("Caddyfile") }
    pub fn store_env(&self) -> PathBuf { self.client().join("store.env") }
    /// The OPERATION journal of update, switch and restore (Plan 07). Its presence means an operation is
    /// in flight or interrupted; `start`/`stop`/`restart`/`provision --resume` refuse while it exists.
    pub fn journal(&self) -> PathBuf { self.update_dir().join("journal.json") }
    /// Provisioning keeps its own journal so the `Recover` task (`update --recover`) never mistakes it for an update.
    pub fn provision_journal(&self) -> PathBuf { self.state().join("provision-journal.json") }
    pub fn provisioned_json(&self) -> PathBuf { self.state().join("provisioned.json") }
    pub fn unprovisioned_json(&self) -> PathBuf { self.state().join("unprovisioned.json") }
    pub fn status_json(&self) -> PathBuf { self.state().join("status.json") }
    /// The version the last update rolled back from (`update::result_file::RolledBack`).
    pub fn rolled_back_record(&self) -> PathBuf { self.update_dir().join("update-rolled-back.json") }
    pub fn update_lock(&self) -> PathBuf { self.update_dir().join("update.lock") }
    /// `state\update\`: the updater's control files (FR19). Protected SYSTEM + Administrators only; `state\` itself carries a
    /// Gateway RX ACE (for `status.json`) that a lower-privileged reader must not get on these files.
    pub fn update_dir(&self) -> PathBuf { self.state().join("update") }
    pub fn update_result(&self) -> PathBuf { self.update_dir().join("update-result.json") }
    pub fn fence_start_types(&self) -> PathBuf { self.update_dir().join("fence-start-types.json") }
    /// Where `p` (one of the control files above) lived before FR19: directly in `state\`.
    pub fn legacy_of(&self, p: &Path) -> PathBuf { self.state().join(p.file_name().unwrap_or_default()) }
    /// The file to READ: `p`, or its pre-FR19 location while `p` is absent. A probe error means `p` (the read then fails closed).
    pub fn read_path(&self, p: &Path) -> PathBuf {
        if p.try_exists().unwrap_or(true) { return p.to_path_buf(); }
        let old = self.legacy_of(p);
        if old.try_exists().unwrap_or(false) { old } else { p.to_path_buf() }
    }
    pub fn canary_json(&self) -> PathBuf { self.state().join("canary.json") }
    pub fn collation_json(&self) -> PathBuf { self.state().join("collation.json") }
    pub fn gotrue_env(&self) -> PathBuf { self.secrets().join("gotrue.env") }
    pub fn postgrest_conf(&self) -> PathBuf { self.secrets().join("postgrest.conf") }
    pub fn pgpass(&self) -> PathBuf { self.secrets().join("pgpass.conf") }

    pub fn packs(&self) -> PathBuf { self.program.join("packs") }
    /// The folder of an installed pack. A version string is joined onto `packs\` only when it is a
    /// real pack version (`pack::parse_pack_version`), so separators and `..` never reach the path.
    pub fn pack_dir(&self, pack_version: &str) -> Result<PathBuf, String> {
        if let Some(p) = &self.pack_override {
            return Ok(p.clone());
        }
        crate::pack::parse_pack_version(pack_version).ok_or_else(|| format!("'{pack_version}' is not a pack version"))?;
        Ok(self.packs().join(pack_version))
    }
}

/// Folders created by the layout step, parents before children (so a child's inherited ACL is
/// never looser than its parent's). Used by `layout::create_layout` and its test.
pub fn layout_dirs(roots: &Roots, service_names: &[&str]) -> Vec<PathBuf> {
    let mut v = vec![
        roots.data.clone(),
        roots.conf(),
        roots.pgdata(),
        roots.secrets(),
        roots.photos(),
        roots.logs(),
        roots.posctl_logs(),
        roots.tmp(),
        roots.backups(),
        roots.state(),
        roots.update_dir(),
        roots.pki(),
        roots.pki_caddy(),
        roots.caddy_xdg(),
        roots.client(),
        roots.client().join("pairing"),
        roots.pairing_offers(),
        roots.client().join("pki"),
        roots.client_run(),
        roots.packs_cache(),
        roots.work(),
        roots.work().join("supabase"),
        roots.work_migrations(),
    ];
    for s in service_names {
        v.push(roots.logs_for(s));
        v.push(roots.tmp_for(s));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_data_must_be_the_default_location() {
        assert!(check_program_data(Some("C:\\ProgramData")).is_ok());
        assert!(check_program_data(Some("c:\\programdata\\")).is_ok());
        assert!(check_program_data(Some("D:\\ProgramData")).is_err());
        assert!(check_program_data(Some("C:\\Users\\x\\ProgramData")).is_err());
        assert!(check_program_data(None).is_err());
    }

    #[test]
    fn derived_paths_follow_the_conventions() {
        let r = Roots::custom(PathBuf::from("X:\\d"), PathBuf::from("X:\\p"));
        assert_eq!(r.posctl_json(), PathBuf::from("X:\\d\\conf\\posctl.json"));
        assert_eq!(r.store_env(), PathBuf::from("X:\\d\\client\\store.env"));
        assert_eq!(r.status_json(), PathBuf::from("X:\\d\\state\\status.json"));
        assert_eq!(r.gotrue_env(), PathBuf::from("X:\\d\\secrets\\gotrue.env"));
        assert_eq!(r.logs_for("S"), PathBuf::from("X:\\d\\logs\\S"));
        assert_eq!(r.pack_dir("1.0.0-r1").unwrap(), PathBuf::from("X:\\p\\packs\\1.0.0-r1"));
        for bad in ["..", "..\\x", "1.0.0-r1\\..", "1.0.0-r1/x", "C:\\x", ""] {
            assert!(r.pack_dir(bad).is_err(), "{bad}");
        }
        assert!(r.dev);
    }

    // FR19: the updater's control files leave `state\` (Gateway RX) for the protected `state\update\`.
    #[test]
    fn the_updater_control_files_live_in_state_update_and_status_json_stays() {
        let r = Roots::custom(PathBuf::from("X:\\d"), PathBuf::from("X:\\p"));
        assert_eq!(r.update_dir(), PathBuf::from("X:\\d\\state\\update"));
        for (got, name) in [
            (r.journal(), "journal.json"), (r.update_result(), "update-result.json"), (r.fence_start_types(), "fence-start-types.json"),
            (r.rolled_back_record(), "update-rolled-back.json"), (r.update_lock(), "update.lock"),
        ] {
            assert_eq!(got, r.update_dir().join(name), "{name}");
        }
        assert_eq!(r.status_json(), PathBuf::from("X:\\d\\state\\status.json"));
        assert_eq!(r.provision_journal(), PathBuf::from("X:\\d\\state\\provision-journal.json"));
        assert_eq!(r.legacy_of(&r.journal()), PathBuf::from("X:\\d\\state\\journal.json"));
    }

    #[test]
    fn a_read_falls_back_to_the_old_location_only_while_the_new_file_is_absent() {
        let d = tempfile::tempdir().unwrap();
        let r = Roots::custom(d.path().join("data"), d.path().join("p"));
        std::fs::create_dir_all(r.update_dir()).unwrap();
        assert_eq!(r.read_path(&r.update_result()), r.update_result(), "neither exists: the new path");
        std::fs::write(r.legacy_of(&r.update_result()), "old").unwrap();
        assert_eq!(r.read_path(&r.update_result()), r.legacy_of(&r.update_result()));
        std::fs::write(r.update_result(), "new").unwrap();
        assert_eq!(r.read_path(&r.update_result()), r.update_result(), "the new file wins");
    }

    #[test]
    fn layout_lists_parents_before_children() {
        let r = Roots::custom(PathBuf::from("X:\\d"), PathBuf::from("X:\\p"));
        let dirs = layout_dirs(&r, &["A", "B"]);
        assert_eq!(dirs[0], r.data);
        for (i, d) in dirs.iter().enumerate() {
            if let Some(parent) = d.parent() {
                if parent.starts_with(&r.data) && parent != r.data.as_path() {
                    assert!(
                        dirs[..i].iter().any(|p| p == parent),
                        "{} is listed before its parent {}",
                        d.display(),
                        parent.display()
                    );
                }
            }
        }
        assert!(dirs.contains(&r.logs_for("A")) && dirs.contains(&r.tmp_for("B")) && dirs.contains(&r.update_dir()));
    }

    #[test]
    fn posctl_dir_must_exist_under_the_program_root() {
        let t = tempfile::tempdir().unwrap();
        let program = t.path().join("Prog");
        std::fs::create_dir_all(program.join("posctl")).unwrap();
        let exe = program.join("posctl").join("posctl.exe");
        assert_eq!(check_posctl_dir(&exe, &program).unwrap(), program.join("posctl"));
        let upper = PathBuf::from(program.to_string_lossy().to_uppercase());
        assert!(check_posctl_dir(&exe, &upper).is_ok());
        assert!(check_posctl_dir(&t.path().join("elsewhere").join("posctl.exe"), &program).is_err());
        assert!(check_posctl_dir(&program.join("posctl").join("..").join("..").join("x.exe"), &program).is_err());
        assert!(check_posctl_dir(&program.join("missing").join("posctl.exe"), &program).is_err());
    }
}
