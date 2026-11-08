//! `posctl photos import-from-cloud`: copy the files of the hosted project's `storage.objects` rows into `photos\<bucket>\<row id>`.
//! The rows are already in the local database (Plan 09 moved them with their original `id` and `metadata`); this only fetches files.
//! Safe to run again: a file of the right size is left alone, a wrong-size file is replaced, and each file is written to
//! `photos\.tmp\`, synced and renamed into place, so a killed run leaves no half file at a final path.
//! The process is elevated and the Functions account can modify `photos\`: `photos\`, `.tmp` and every bucket folder are held
//! open (no delete/rename sharing) for the whole run, so none of them can be swapped for a junction after the check.
//! It must never write outside `photos\`, never touch the database, never follow a redirect, and never let the key leave
//! the one header of the one request to the project URL it was given.
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::creds::SourceCredentials;
use super::{bucket_is_valid, ObjectRow, RowSource, MAX_IDS};
use crate::envelope::{Code, Outcome, PosctlError};
use crate::paths::Roots;
use crate::util::{is_uuid_v4, Secret};

pub struct ImportArgs {
    pub database: String,
    pub buckets: Vec<String>,
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// Could not connect, timed out, or the connection broke.
    Transport(String),
    /// The server answered something other than 200 (a 3xx included: redirects are never followed).
    Status(u16),
}

/// The only HTTP-aware seam. A reader, so a large object is streamed to disk, not held in memory. `size` is the row's
/// `metadata.size` (it bounds the request's total time).
pub trait ObjectSource {
    fn get(&self, bucket: &str, name: &str, size: Option<u64>) -> Result<Box<dyn Read>, FetchError>;
}

const ATTEMPTS: usize = 3;
const BACKOFF: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];
/// The largest object the importer takes (the app's buckets allow 2 MiB). A bigger row is a failure, not a download.
const MAX_OBJECT: u64 = 64 * 1024 * 1024;
/// Free space kept after a download.
const FREE_RESERVE: u64 = 64 * 1024 * 1024;
/// The whole run stops here with what it has: Plan 09 gives the child 3600 s inside the frozen window.
pub const RUN_DEADLINE: Duration = Duration::from_secs(3000);

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A request may take at most 64 KiB/s of its size, never less than 120 s. `timeout_read` alone is per read: a server
/// that sends a byte a minute would hold one object for ever.
pub(crate) fn request_timeout(size: Option<u64>) -> Duration {
    Duration::from_secs((size.unwrap_or(MAX_OBJECT) / (64 * 1024)).max(120))
}

/// `GET {origin}/storage/v1/object/authenticated/{bucket}/{name}` with the key in `apikey` (and `Authorization: Bearer` when
/// the key is a JWT). No redirects: a 3xx is a final error, so the key can only ever go to the project URL it came with.
pub struct UreqSource {
    origin: String,
    key: Secret,
    agent: ureq::Agent,
}

impl UreqSource {
    pub fn new(creds: &SourceCredentials) -> Self {
        let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(60)).build();
        Self { origin: creds.project_url.clone(), key: creds.service_role_key.clone(), agent }
    }
}

/// Three non-empty base64url parts, the first starting `eyJ` (`{"`): what a legacy Supabase service key looks like.
fn jwt_shaped(key: &str) -> bool {
    let parts: Vec<&str> = key.split('.').collect();
    parts.len() == 3 && key.starts_with("eyJ") && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

/// Every path segment percent-encoded (everything but `A-Z a-z 0-9 - . _ ~`), slashes kept.
pub(crate) fn encode_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl ObjectSource for UreqSource {
    fn get(&self, bucket: &str, name: &str, size: Option<u64>) -> Result<Box<dyn Read>, FetchError> {
        let url = format!("{}/storage/v1/object/authenticated/{bucket}/{}", self.origin, encode_name(name));
        let key = self.key.expose();
        let mut req = self.agent.get(&url).timeout(request_timeout(size)).set("apikey", key);
        if jwt_shaped(key) {
            req = req.set("Authorization", &format!("Bearer {key}"));
        }
        match req.call() {
            Ok(r) if r.status() == 200 => Ok(Box::new(r.into_reader())),
            Ok(r) => Err(FetchError::Status(r.status())),
            Err(ureq::Error::Status(code, _)) => Err(FetchError::Status(code)),
            // the message is ours to log: it must not carry the key, whatever the library put in it
            Err(ureq::Error::Transport(t)) => Err(FetchError::Transport(t.to_string().replace(key, "***"))),
        }
    }
}

/// What to do after a failed attempt.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// Try again (transport, 5xx, 429, size mismatch).
    Retry,
    /// This object fails; the next one is tried.
    Final,
    /// The whole run stops: the project refused the key, or this PC cannot write (disk full, folder replaced).
    Stop,
}
type Fail = (Kind, String);

fn classify(e: &FetchError) -> Fail {
    match e {
        FetchError::Transport(m) => (Kind::Retry, format!("transport error: {m}")),
        FetchError::Status(s) if *s == 401 || *s == 403 => (Kind::Stop, format!("HTTP {s}: the project refused the key")),
        FetchError::Status(s) if *s == 429 || (500..600).contains(s) => (Kind::Retry, format!("HTTP {s}")),
        FetchError::Status(s) if (300..400).contains(s) => (Kind::Final, format!("HTTP {s}: a redirect is an error, it is not followed")),
        FetchError::Status(s) => (Kind::Final, format!("HTTP {s}")),
    }
}

/// Open `p` (created when missing) and keep it open: no delete/rename sharing, so nobody can rename the folder away and put a
/// junction in its place while the run lasts. The check "a folder, not a reparse point" is made on that open handle.
fn hold_dir(p: &Path) -> Result<Option<File>, String> {
    match std::fs::symlink_metadata(p) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir_all(p).map_err(|e| format!("cannot create {}: {e}", p.display()))?,
        Err(e) => return Err(format!("cannot inspect {}: {e}", p.display())),
    }
    open_held(p)
}

#[cfg(windows)]
fn open_held(p: &Path) -> Result<Option<File>, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2; // no FILE_SHARE_DELETE
    const BACKUP_SEMANTICS_AND_OPEN_REPARSE_POINT: u32 = 0x0200_0000 | 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let plain = || format!("{} is not a plain folder", p.display());
    let f = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE)
        .custom_flags(BACKUP_SEMANTICS_AND_OPEN_REPARSE_POINT)
        .open(p)
        .map_err(|e| format!("cannot open {}: {e}", p.display()))?;
    let m = f.metadata().map_err(|e| format!("cannot inspect {}: {e}", p.display()))?;
    if !m.is_dir() || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(plain());
    }
    Ok(Some(f))
}

/// ponytail: without Windows handles the check is one-time (the product only runs on Windows; this keeps the crate building).
#[cfg(not(windows))]
fn open_held(p: &Path) -> Result<Option<File>, String> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_dir() => Ok(None),
        _ => Err(format!("{} is not a plain folder", p.display())),
    }
}

/// The name only ever goes into the request path, never into a local path; still, a name that climbs is refused.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("the row has no name".into());
    }
    if name.starts_with('/') || name.contains('\\') || name.chars().any(char::is_control) || name.split('/').any(|s| s == "." || s == "..") {
        return Err("the row's name is not a plain object name".into());
    }
    Ok(())
}

/// Exactly what this importer's temp files are called: `<uuid-v4>.import-<digits>-<digits>`.
fn is_import_leftover(name: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let Some((id, rest)) = name.split_once(".import-") else { return false };
    let mut parts = rest.split('-');
    is_uuid_v4(id) && matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None) if digits(a) && digits(b))
}

enum Existing {
    Ready,
    Fetch,
    Refused(String),
}

fn existing(dest: &Path, size: Option<u64>) -> Existing {
    match std::fs::symlink_metadata(dest) {
        Ok(m) if m.file_type().is_file() => {
            if size.is_none_or(|s| s == m.len()) {
                Existing::Ready
            } else {
                Existing::Fetch
            }
        }
        Ok(_) => Existing::Refused("the path exists and is not a regular file".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Existing::Fetch,
        Err(e) => Existing::Refused(format!("cannot inspect the path: {e}")),
    }
}

/// One attempt. The temp file is gone on every error. `expected_dir` is the canonical bucket folder: after the rename the
/// file must be found directly in it (a second, independent look in case a folder was swapped despite being held).
fn attempt(src: &dyn ObjectSource, row: &ObjectRow, dest: &Path, tmp_dir: &Path, expected_dir: &Path) -> Result<u64, Fail> {
    let reader = src.get(&row.bucket, &row.name, row.size).map_err(|e| classify(&e))?;
    let tmp = tmp_dir.join(format!("{}.import-{}-{}", row.id, std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let written = (|| -> Result<u64, Fail> {
        // writer-side failures (cannot create, disk full, cannot sync) are not the network's: no retry, the run stops
        let writer = |what: &str, e: std::io::Error| (Kind::Stop, format!("{what}: {e}"));
        // one byte more than allowed, so "too long" is seen as too long
        let cap = row.size.unwrap_or(MAX_OBJECT).saturating_add(1);
        let mut f = File::create_new(&tmp).map_err(|e| writer("cannot create the temp file", e))?;
        let mut limited = reader.take(cap);
        let mut buf = vec![0u8; 64 * 1024];
        let mut n = 0u64;
        loop {
            let k = limited.read(&mut buf).map_err(|e| (Kind::Retry, format!("transport error: the download broke: {e}")))?;
            if k == 0 {
                break;
            }
            f.write_all(&buf[..k]).map_err(|e| writer("cannot write the file (disk full?)", e))?;
            n += k as u64;
        }
        f.sync_all().map_err(|e| writer("cannot sync the temp file", e))?;
        match row.size {
            Some(s) if n != s => Err((Kind::Retry, format!("size mismatch: downloaded {n} bytes, the row says {s}"))),
            None if n > MAX_OBJECT => Err((Kind::Final, "the object is larger than 64 MiB and its row has no size".into())),
            _ => Ok(n),
        }
    })();
    let n = match written {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    // the handle is closed (the closure ended): a rename over an existing file works on Windows then
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err((Kind::Stop, format!("cannot move the file into place: {e}")));
    }
    let inside = std::fs::canonicalize(dest).ok().and_then(|c| c.parent().map(Path::to_path_buf)).is_some_and(|p| p == expected_dir);
    if !inside {
        let _ = std::fs::remove_file(dest);
        return Err((Kind::Stop, "the file landed outside its folder: the folder was replaced during the run".into()));
    }
    Ok(n)
}

/// Up to 3 attempts (back-off 1 s, 3 s) for transport errors, 5xx, 429 and a size mismatch; any other answer is final.
fn download(src: &dyn ObjectSource, row: &ObjectRow, dest: &Path, tmp_dir: &Path, expected_dir: &Path, deps: &Deps) -> Result<u64, Fail> {
    let mut last: Fail = (Kind::Final, String::new());
    for n in 0..ATTEMPTS {
        if n > 0 {
            if (deps.elapsed)() + BACKOFF[n - 1] >= deps.deadline {
                return Err((Kind::Stop, "the run time limit was reached".into()));
            }
            (deps.sleep)(BACKOFF[n - 1]);
        }
        match attempt(src, row, dest, tmp_dir, expected_dir) {
            Ok(bytes) => return Ok(bytes),
            Err(f) => {
                last = f;
                if last.0 != Kind::Retry {
                    break;
                }
            }
        }
    }
    Err(last)
}

#[derive(Default)]
struct Tally {
    downloaded: u64,
    already_present: u64,
    pending: u64,
    unverified: u64,
    bytes: u64,
    failed_count: u64,
    not_tried: u64,
    failed: Vec<Value>,
}

impl Tally {
    fn fail(&mut self, row: &ObjectRow, reason: String) {
        self.failed_count += 1;
        if self.failed.len() < MAX_IDS {
            self.failed.push(json!({"bucket": row.bucket, "id": row.id, "name": row.name, "reason": reason}));
        }
    }
}

/// The clocks and the disk, as the run sees them (tests inject their own).
pub(crate) struct Deps<'a> {
    pub sleep: &'a dyn Fn(Duration),
    /// Time since the run began.
    pub elapsed: &'a dyn Fn() -> Duration,
    pub deadline: Duration,
    /// Free bytes on the volume of this folder, when known.
    pub free: &'a dyn Fn(&Path) -> Option<u64>,
}

pub fn import_objects(roots: &Roots, args: &ImportArgs, rows: &dyn RowSource, src: &dyn ObjectSource) -> Outcome {
    let start = Instant::now();
    let elapsed = || start.elapsed();
    let free = |p: &Path| crate::sys::free_disk_bytes(p).ok();
    import_objects_with(roots, args, rows, src, &Deps { sleep: &std::thread::sleep, elapsed: &elapsed, deadline: RUN_DEADLINE, free: &free })
}

/// A second importer on the same folder (`photos\.import.lock`, advisory; `update.lock` is Plan 09's and is not taken here).
fn take_lock(photos: &Path) -> Result<File, PosctlError> {
    let f = File::options().create(true).truncate(false).write(true).open(photos.join(".import.lock")).map_err(|e| PosctlError::error(format!("cannot open the import lock: {e}")))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err(PosctlError::new(Code::LockHeld, "another photo import is running").retryable()),
        Err(std::fs::TryLockError::Error(e)) => Err(PosctlError::error(format!("cannot lock the import: {e}"))),
    }
}

pub(crate) fn import_objects_with(roots: &Roots, args: &ImportArgs, rows: &dyn RowSource, src: &dyn ObjectSource, deps: &Deps) -> Outcome {
    if args.buckets.is_empty() || args.buckets.iter().any(|b| !bucket_is_valid(b)) {
        return PosctlError::new(Code::Usage, "the buckets must be bucket names: lowercase letters, digits, dash and underscore").into();
    }
    let list = match rows.rows(&args.database, &args.buckets) {
        Ok(l) => l,
        Err(m) => return PosctlError::error(format!("could not read the photo rows: {m}")).into(),
    };
    let photos = roots.photos();
    let tmp_dir = photos.join(".tmp");
    // held open until this function returns
    let mut held: Vec<File> = Vec::new();
    let mut _lock: Option<File> = None;
    let mut canonical_root = photos.clone();
    if !args.dry_run {
        let prepared = (|| -> Result<(), PosctlError> {
            held.extend(hold_dir(&photos).map_err(PosctlError::error)?);
            held.extend(hold_dir(&tmp_dir).map_err(PosctlError::error)?);
            canonical_root = std::fs::canonicalize(&photos).map_err(|e| PosctlError::error(format!("cannot resolve the photos folder: {e}")))?;
            _lock = Some(take_lock(&photos)?);
            // what a killed earlier run left behind: only files named exactly like this importer's temp files
            if let Ok(rd) = std::fs::read_dir(&tmp_dir) {
                for e in rd.flatten() {
                    if is_import_leftover(&e.file_name().to_string_lossy()) && e.file_type().is_ok_and(|t| t.is_file()) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = prepared {
            return e.into();
        }
    }
    let mut t = Tally::default();
    let mut bucket_dirs: HashSet<String> = HashSet::new();
    let mut stop: Option<String> = None;
    for (i, row) in list.iter().enumerate() {
        let rest = (list.len() - i - 1) as u64;
        if (deps.elapsed)() >= deps.deadline {
            stop = Some("the run time limit was reached".into());
            t.not_tried = rest + 1;
            break;
        }
        if !args.buckets.contains(&row.bucket) {
            t.fail(row, "the row's bucket is not one of the requested buckets".into());
            continue;
        }
        if !is_uuid_v4(&row.id) {
            t.fail(row, "the row's id is not a UUID".into());
            continue;
        }
        if let Err(r) = check_name(&row.name) {
            t.fail(row, r);
            continue;
        }
        // before anything is read or written below this folder: it is a real folder, and it stays one
        if !args.dry_run && !bucket_dirs.contains(&row.bucket) {
            match hold_dir(&photos.join(&row.bucket)) {
                Ok(f) => {
                    held.extend(f);
                    bucket_dirs.insert(row.bucket.clone());
                }
                Err(m) => {
                    t.fail(row, m);
                    continue;
                }
            }
        }
        let dest = photos.join(&row.bucket).join(&row.id);
        match existing(&dest, row.size) {
            Existing::Ready => {
                t.already_present += 1;
                t.unverified += u64::from(row.size.is_none());
                continue;
            }
            Existing::Refused(r) => {
                t.fail(row, r);
                continue;
            }
            Existing::Fetch => {}
        }
        if row.size.is_some_and(|s| s > MAX_OBJECT) {
            t.fail(row, "the object is larger than the importer's 64 MiB limit".into());
            continue;
        }
        if args.dry_run {
            t.pending += 1;
            continue;
        }
        if (deps.free)(&photos).is_some_and(|free| free < row.size.unwrap_or(MAX_OBJECT).saturating_add(FREE_RESERVE)) {
            t.fail(row, "not enough free disk space".into());
            stop = Some("not enough free disk space".into());
            t.not_tried = rest;
            break;
        }
        match download(src, row, &dest, &tmp_dir, &canonical_root.join(&row.bucket), deps) {
            Ok(n) => {
                t.downloaded += 1;
                t.bytes += n;
                t.unverified += u64::from(row.size.is_none());
            }
            Err((kind, reason)) => {
                t.fail(row, reason.clone());
                if kind == Kind::Stop {
                    stop = Some(reason);
                    t.not_tried = rest;
                    break;
                }
            }
        }
    }
    // after a real run what is still missing is what failed or was never tried; after a dry run it is what a real run would fetch
    let pending = if args.dry_run { t.pending } else { t.failed_count + t.not_tried };
    let data = json!({
        "database": args.database, "buckets": args.buckets, "dryRun": args.dry_run, "total": list.len(),
        "downloaded": t.downloaded, "alreadyPresent": t.already_present, "pending": pending, "unverified": t.unverified,
        "bytes": t.bytes, "elapsedSeconds": (deps.elapsed)().as_secs(), "failedCount": t.failed_count, "notTried": t.not_tried, "stopped": stop, "failed": t.failed,
    });
    if t.failed_count == 0 && stop.is_none() {
        let msg = if args.dry_run {
            format!("dry run: {} of {} photos would be downloaded", t.pending, list.len())
        } else {
            format!("{} photos downloaded, {} already present", t.downloaded, t.already_present)
        };
        Outcome::ok(msg, data)
    } else {
        let why = stop.map(|s| format!(" ({s})")).unwrap_or_default();
        let mut o = Outcome::with_code(Code::PhotosImportFailed, format!("{} of {} photos could not be imported{why}; run the command again", t.failed_count + t.not_tried, list.len()), data);
        o.retryable = true;
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock;
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, VecDeque};
    use std::io::Cursor;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const C: &str = "33333333-3333-4333-8333-333333333333";
    const KEY: &str = "sb-test-key-0123456789";

    fn row(bucket: &str, id: &str, name: &str, size: Option<u64>) -> ObjectRow {
        ObjectRow { bucket: bucket.into(), id: id.into(), name: name.into(), size }
    }
    fn args(dry_run: bool) -> ImportArgs {
        ImportArgs { database: "postgres".into(), buckets: vec!["product-photos".into(), "store-branding".into()], dry_run }
    }
    fn roots(d: &tempfile::TempDir) -> Roots {
        Roots::custom(d.path().join("data"), d.path().join("prog"))
    }
    fn creds(url: String, key: &str) -> SourceCredentials {
        SourceCredentials { project_url: url, service_role_key: Secret(key.into()) }
    }

    /// No waiting, no elapsed time, plenty of disk.
    fn imp(r: &Roots, a: &ImportArgs, rows: &dyn RowSource, src: &dyn ObjectSource) -> Outcome {
        imp_t(r, a, rows, src, &|_| {}, &|| Duration::ZERO, RUN_DEADLINE, &|_| Some(u64::MAX / 2))
    }
    #[allow(clippy::too_many_arguments)]
    fn imp_t(r: &Roots, a: &ImportArgs, rows: &dyn RowSource, src: &dyn ObjectSource, sleep: &dyn Fn(Duration), elapsed: &dyn Fn() -> Duration, deadline: Duration, free: &dyn Fn(&Path) -> Option<u64>) -> Outcome {
        import_objects_with(r, a, rows, src, &Deps { sleep, elapsed, deadline, free })
    }

    struct FakeRows(Vec<ObjectRow>);
    impl RowSource for FakeRows {
        fn rows(&self, _db: &str, buckets: &[String]) -> Result<Vec<ObjectRow>, String> {
            Ok(self.0.iter().filter(|r| buckets.is_empty() || buckets.contains(&r.bucket)).cloned().collect())
        }
    }

    type Answers = VecDeque<Result<Vec<u8>, FetchError>>;

    /// Answers per object name, in order; the last answer repeats. `default` answers every other name.
    struct Script {
        by_name: RefCell<HashMap<String, Answers>>,
        default: Result<Vec<u8>, FetchError>,
        calls: RefCell<Vec<String>>,
    }
    impl Script {
        fn new(default: Result<Vec<u8>, FetchError>) -> Self {
            Self { by_name: RefCell::new(HashMap::new()), default, calls: RefCell::new(Vec::new()) }
        }
        fn on(self, name: &str, answers: Vec<Result<Vec<u8>, FetchError>>) -> Self {
            self.by_name.borrow_mut().insert(name.into(), answers.into());
            self
        }
        fn calls_for(&self, name: &str) -> usize {
            self.calls.borrow().iter().filter(|n| *n == name).count()
        }
    }
    impl ObjectSource for Script {
        fn get(&self, _bucket: &str, name: &str, _size: Option<u64>) -> Result<Box<dyn Read>, FetchError> {
            self.calls.borrow_mut().push(name.to_string());
            let mut m = self.by_name.borrow_mut();
            let answer = match m.get_mut(name) {
                Some(q) if q.len() > 1 => q.pop_front().unwrap(),
                Some(q) => q.front().cloned().unwrap_or_else(|| self.default.clone()),
                None => self.default.clone(),
            };
            answer.map(|b| Box::new(Cursor::new(b)) as Box<dyn Read>)
        }
    }

    fn read(roots: &Roots, bucket: &str, id: &str) -> Option<Vec<u8>> {
        std::fs::read(roots.photos().join(bucket).join(id)).ok()
    }
    fn tmp_is_empty(roots: &Roots) -> bool {
        std::fs::read_dir(roots.photos().join(".tmp")).map(|rd| rd.count() == 0).unwrap_or(true)
    }

    #[test]
    fn downloads_missing_files() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![row("product-photos", A, "p/a.jpg", Some(3)), row("store-branding", B, "logo.png", None)]);
        let src = Script::new(Err(FetchError::Status(404))).on("p/a.jpg", vec![Ok(b"abc".to_vec())]).on("logo.png", vec![Ok(b"LOGO!".to_vec())]);
        let o = imp(&r, &args(false), &rows, &src);
        assert_eq!((o.code, o.code.exit()), (Code::Ok, 0), "{} {}", o.message, o.data);
        assert_eq!(read(&r, "product-photos", A).as_deref(), Some(&b"abc"[..]));
        assert_eq!(read(&r, "store-branding", B).as_deref(), Some(&b"LOGO!"[..]));
        let v = &o.data;
        assert_eq!((v["total"].clone(), v["downloaded"].clone(), v["alreadyPresent"].clone(), v["pending"].clone(), v["bytes"].clone(), v["unverified"].clone(), v["failedCount"].clone()), (json!(2), json!(2), json!(0), json!(0), json!(8), json!(1), json!(0)));
        assert_eq!((v["database"].clone(), v["dryRun"].clone(), v["failed"].clone(), v["stopped"].clone()), (json!("postgres"), json!(false), json!([]), Value::Null));
        assert_eq!(v["elapsedSeconds"], 0);
        assert!(tmp_is_empty(&r), "no temp file is left");
    }

    #[test]
    fn already_present_is_skipped() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        std::fs::create_dir_all(r.photos().join("product-photos")).unwrap();
        std::fs::write(r.photos().join("product-photos").join(A), b"old").unwrap();
        std::fs::write(r.photos().join("product-photos").join(B), b"whatever size").unwrap();
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(3)), row("product-photos", B, "b.jpg", None)]);
        let src = Script::new(Ok(b"NEW".to_vec()));
        let o = imp(&r, &args(false), &rows, &src);
        assert_eq!(o.code, Code::Ok, "{}", o.message);
        assert!(src.calls.borrow().is_empty(), "nothing is fetched for a file that is there");
        assert_eq!(read(&r, "product-photos", A).as_deref(), Some(&b"old"[..]));
        assert_eq!((o.data["alreadyPresent"].clone(), o.data["downloaded"].clone(), o.data["unverified"].clone()), (json!(2), json!(0), json!(1)));
    }

    #[test]
    fn wrong_size_file_is_replaced() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        std::fs::create_dir_all(r.photos().join("product-photos")).unwrap();
        std::fs::write(r.photos().join("product-photos").join(A), b"xx").unwrap();
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(5))]);
        let src = Script::new(Ok(b"fresh".to_vec()));
        let o = imp(&r, &args(false), &rows, &src);
        assert_eq!(o.code, Code::Ok, "{}", o.message);
        assert_eq!(read(&r, "product-photos", A).as_deref(), Some(&b"fresh"[..]));
        assert_eq!((o.data["downloaded"].clone(), o.data["alreadyPresent"].clone()), (json!(1), json!(0)));
        assert!(tmp_is_empty(&r));
    }

    #[test]
    fn size_mismatch_retries_3_times_then_fails() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(5))]);
        let src = Script::new(Ok(b"four".to_vec()));
        let slept = RefCell::new(Vec::new());
        let sleep = |d: Duration| slept.borrow_mut().push(d);
        let o = imp_t(&r, &args(false), &rows, &src, &sleep, &|| Duration::ZERO, RUN_DEADLINE, &|_| None);
        assert_eq!(src.calls_for("a.jpg"), 3);
        assert_eq!(*slept.borrow(), vec![Duration::from_secs(1), Duration::from_secs(3)]);
        assert_eq!((o.code, o.code.exit(), o.retryable), (Code::PhotosImportFailed, 61, true));
        assert!(o.data["failed"][0]["reason"].as_str().unwrap().contains("size mismatch"), "{}", o.data);
        assert!(read(&r, "product-photos", A).is_none(), "a wrong-size download never reaches the final path");
        assert!(tmp_is_empty(&r));
    }

    #[test]
    fn a_too_long_body_is_a_mismatch_not_a_truncated_success() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(3))]);
        let o = imp(&r, &args(false), &rows, &Script::new(Ok(b"abcdef".to_vec())));
        assert_eq!(o.code, Code::PhotosImportFailed);
        assert!(o.data["failed"][0]["reason"].as_str().unwrap().contains("downloaded 4 bytes"), "one byte past the size is seen: {}", o.data);
        assert!(read(&r, "product-photos", A).is_none());
    }

    #[test]
    fn retry_429_and_5xx_other_4xx_final() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![
            row("product-photos", A, "n429", Some(1)),
            row("product-photos", B, "n404", Some(1)),
            row("product-photos", C, "n400", Some(1)),
            row("store-branding", "44444444-4444-4444-8444-444444444444", "nbreak", Some(1)),
            row("store-branding", "55555555-5555-4555-8555-555555555555", "n500", Some(1)),
        ]);
        let src = Script::new(Ok(b"x".to_vec()))
            .on("n429", vec![Err(FetchError::Status(429)), Err(FetchError::Status(503)), Ok(b"x".to_vec())])
            .on("n404", vec![Err(FetchError::Status(404))])
            .on("n400", vec![Err(FetchError::Status(400))])
            .on("nbreak", vec![Err(FetchError::Transport("connection reset".into())), Ok(b"x".to_vec())])
            .on("n500", vec![Err(FetchError::Status(500))]);
        let o = imp(&r, &args(false), &rows, &src);
        assert_eq!((src.calls_for("n429"), src.calls_for("n404"), src.calls_for("n400"), src.calls_for("nbreak"), src.calls_for("n500")), (3, 1, 1, 2, 3));
        assert_eq!((o.code, o.data["downloaded"].clone(), o.data["failedCount"].clone(), o.data["stopped"].clone()), (Code::PhotosImportFailed, json!(2), json!(3), Value::Null));
        let reasons: Vec<String> = o.data["failed"].as_array().unwrap().iter().map(|f| f["reason"].as_str().unwrap().to_string()).collect();
        assert_eq!(reasons, vec!["HTTP 404", "HTTP 400", "HTTP 500"]);
    }

    #[test]
    fn a_refused_key_stops_the_run_at_the_first_401_or_403() {
        for status in [401u16, 403] {
            let d = tempfile::tempdir().unwrap();
            let r = roots(&d);
            let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(1)), row("product-photos", B, "b.jpg", Some(1)), row("product-photos", C, "c.jpg", Some(1))]);
            let src = Script::new(Ok(b"x".to_vec())).on("a.jpg", vec![Err(FetchError::Status(status))]);
            let o = imp(&r, &args(false), &rows, &src);
            assert_eq!(src.calls.borrow().len(), 1, "no request per remaining row");
            assert_eq!((o.code.exit(), o.data["failedCount"].clone(), o.data["notTried"].clone(), o.data["pending"].clone()), (61, json!(1), json!(2), json!(3)));
            assert!(o.data["stopped"].as_str().unwrap().contains("refused the key"), "{}", o.data);
        }
    }

    #[test]
    fn the_run_deadline_stops_with_the_partial_tally() {
        struct Ticking<'a> {
            inner: &'a Script,
            clock: &'a Cell<Duration>,
        }
        impl ObjectSource for Ticking<'_> {
            fn get(&self, b: &str, n: &str, s: Option<u64>) -> Result<Box<dyn Read>, FetchError> {
                self.clock.set(self.clock.get() + Duration::from_secs(40));
                self.inner.get(b, n, s)
            }
        }
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows((0..5).map(|i| row("product-photos", &format!("{i:08x}-0000-4000-8000-000000000000"), &format!("n{i}.jpg"), Some(1))).collect());
        let inner = Script::new(Ok(b"x".to_vec()));
        let clock = Cell::new(Duration::ZERO);
        let o = imp_t(&r, &args(false), &rows, &Ticking { inner: &inner, clock: &clock }, &|_| {}, &|| clock.get(), Duration::from_secs(100), &|_| None);
        assert_eq!((o.code.exit(), o.data["downloaded"].clone(), o.data["notTried"].clone(), o.data["failedCount"].clone()), (61, json!(3), json!(2), json!(0)));
        assert!(o.data["stopped"].as_str().unwrap().contains("time limit"), "{}", o.data);
        assert!(o.retryable);
        // and the rerun (fresh clock) fetches only the two that were not tried
        let again = Script::new(Ok(b"x".to_vec()));
        let o = imp(&r, &args(false), &rows, &again);
        assert_eq!((o.code, again.calls.borrow().len(), o.data["alreadyPresent"].clone()), (Code::Ok, 2, json!(3)));
    }

    #[test]
    fn the_request_time_is_bounded_by_the_size() {
        assert_eq!(request_timeout(Some(0)), Duration::from_secs(120));
        assert_eq!(request_timeout(Some(1 << 20)), Duration::from_secs(120));
        assert_eq!(request_timeout(Some(64 << 20)), Duration::from_secs(1024));
        assert_eq!(request_timeout(None), Duration::from_secs(1024));
    }

    #[test]
    fn too_little_free_disk_space_stops_before_any_download_and_a_huge_row_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(10)), row("product-photos", B, "b.jpg", Some(10))]);
        let src = Script::new(Ok(vec![0; 10]));
        let o = imp_t(&r, &args(false), &rows, &src, &|_| {}, &|| Duration::ZERO, RUN_DEADLINE, &|_| Some(1000));
        assert!(src.calls.borrow().is_empty());
        assert_eq!((o.code.exit(), o.data["stopped"].clone(), o.data["notTried"].clone()), (61, json!("not enough free disk space"), json!(1)));
        // an object past the importer's limit fails alone; the next one is still tried
        let big = FakeRows(vec![row("product-photos", A, "big.jpg", Some(MAX_OBJECT + 1)), row("product-photos", B, "b.jpg", Some(1))]);
        let src = Script::new(Ok(b"x".to_vec()));
        let o = imp(&r, &args(false), &big, &src);
        assert_eq!((src.calls.borrow().len(), o.data["downloaded"].clone(), o.data["failedCount"].clone()), (1, json!(1), json!(1)));
        assert!(o.data["failed"][0]["reason"].as_str().unwrap().contains("64 MiB"));
    }

    #[test]
    fn redirect_is_an_error_and_key_not_forwarded() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let elsewhere = mock::start_bytes(|_| (200, b"stolen".to_vec()));
        let target = format!("{}/steal", elsewhere.url());
        let origin = mock::start_bytes(move |_| (302, target.clone().into_bytes()));
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(6))]);
        let o = imp(&r, &args(false), &rows, &UreqSource::new(&creds(origin.url(), KEY)));
        assert_eq!((o.code, o.code.exit()), (Code::PhotosImportFailed, 61));
        assert!(o.data["failed"][0]["reason"].as_str().unwrap().contains("redirect"), "{}", o.data);
        assert!(elsewhere.requests().is_empty(), "the redirect target was never contacted");
        assert_eq!(origin.requests().len(), 1, "a 3xx is final: no retry");
        assert_eq!(origin.requests()[0].headers.iter().find(|(k, _)| k == "apikey").map(|(_, v)| v.as_str()), Some(KEY), "the key went to the project URL");
        assert!(read(&r, "product-photos", A).is_none());
    }

    #[test]
    fn ureq_source_requests_the_authenticated_object_url_with_the_key_header() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let server = mock::start_bytes(|_| (200, b"bytes".to_vec()));
        let rows = FakeRows(vec![row("product-photos", A, "p/a b+c.jpg", Some(5))]);
        let o = imp(&r, &args(false), &rows, &UreqSource::new(&creds(server.url(), KEY)));
        assert_eq!(o.code, Code::Ok, "{} {}", o.message, o.data);
        assert_eq!(read(&r, "product-photos", A).as_deref(), Some(&b"bytes"[..]));
        let req = &server.requests()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("GET", "/storage/v1/object/authenticated/product-photos/p/a%20b%2Bc.jpg"));
        assert!(req.headers.iter().all(|(k, _)| k != "authorization"), "a key that is not a JWT adds no Authorization header");
    }

    #[test]
    fn a_jwt_shaped_key_adds_a_bearer_header_and_the_name_is_encoded_per_byte() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln";
        assert!(jwt_shaped(jwt));
        for no in [KEY, "eyJabc.def", "eyJa.b.c.d", "abc.def.ghi", "eyJa..c", "eyJa.b.c d"] {
            assert!(!jwt_shaped(no), "{no}");
        }
        assert_eq!(encode_name("a/b c/é.jpg"), "a/b%20c/%C3%A9.jpg");
        let d = tempfile::tempdir().unwrap();
        let server = mock::start_bytes(|_| (200, b"x".to_vec()));
        let o = imp(&roots(&d), &args(false), &FakeRows(vec![row("product-photos", A, "a.jpg", Some(1))]), &UreqSource::new(&creds(server.url(), jwt)));
        assert_eq!(o.code, Code::Ok);
        let h = &server.requests()[0].headers;
        assert_eq!(h.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.clone()), Some(format!("Bearer {jwt}")));
        assert_eq!(h.iter().find(|(k, _)| k == "apikey").map(|(_, v)| v.as_str()), Some(jwt));
    }

    #[test]
    fn partial_failure_then_rerun_fetches_only_missing() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(1)), row("product-photos", B, "b.jpg", Some(1)), row("product-photos", C, "c.jpg", Some(1))]);
        let broken = Script::new(Ok(b"x".to_vec())).on("b.jpg", vec![Err(FetchError::Status(500))]);
        let first = imp(&r, &args(false), &rows, &broken);
        assert_eq!((first.code.exit(), first.data["downloaded"].clone(), first.data["pending"].clone()), (61, json!(2), json!(1)));
        assert!(read(&r, "product-photos", B).is_none());
        let healed = Script::new(Ok(b"y".to_vec()));
        let second = imp(&r, &args(false), &rows, &healed);
        assert_eq!(second.code, Code::Ok, "{}", second.message);
        assert_eq!(*healed.calls.borrow(), vec!["b.jpg".to_string()], "only the missing object is fetched");
        assert_eq!((second.data["downloaded"].clone(), second.data["alreadyPresent"].clone()), (json!(1), json!(2)));
        assert_eq!(read(&r, "product-photos", A).as_deref(), Some(&b"x"[..]), "the first run's file is untouched");
        assert!(tmp_is_empty(&r));
    }

    /// A body that gives two bytes and then the connection dies: what a killed or cut-off download looks like to the writer.
    struct Dying(Option<Vec<u8>>);
    impl Read for Dying {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.0.take() {
                Some(b) => {
                    let n = b.len().min(buf.len());
                    buf[..n].copy_from_slice(&b[..n]);
                    Ok(n)
                }
                None => Err(std::io::Error::other("killed")),
            }
        }
    }
    struct Killed {
        dies_left: Cell<usize>,
    }
    impl ObjectSource for Killed {
        fn get(&self, _b: &str, _n: &str, _s: Option<u64>) -> Result<Box<dyn Read>, FetchError> {
            if self.dies_left.get() > 0 {
                self.dies_left.set(self.dies_left.get() - 1);
                Ok(Box::new(Dying(Some(vec![1, 2]))))
            } else {
                Ok(Box::new(Cursor::new(b"hello".to_vec())))
            }
        }
    }

    #[test]
    fn a_killed_import_leaves_no_partial_final_file_and_a_rerun_finishes_cleanly() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(5))]);
        // every attempt breaks half way
        let o = imp(&r, &args(false), &rows, &Killed { dies_left: Cell::new(3) });
        assert_eq!((o.code.exit(), o.retryable), (61, true));
        assert!(read(&r, "product-photos", A).is_none(), "no partial file at the final path");
        assert!(tmp_is_empty(&r), "the half files are removed");
        // a process that died without cleaning up leaves a temp file named like ours: the rerun removes it and finishes
        std::fs::write(r.photos().join(".tmp").join(format!("{A}.import-4242-7")), [1, 2]).unwrap();
        let o = imp(&r, &args(false), &rows, &Killed { dies_left: Cell::new(0) });
        assert_eq!(o.code, Code::Ok, "{}", o.message);
        assert_eq!(read(&r, "product-photos", A).as_deref(), Some(&b"hello"[..]));
        assert!(tmp_is_empty(&r));
    }

    #[test]
    fn only_temp_files_named_like_this_importers_are_removed() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let tmp = r.photos().join(".tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let ours = [format!("{A}.import-77-1")];
        let theirs = ["storage-service-file".to_string(), format!("{A}.import-x-1"), format!("{A}.import-77-1.bak"), format!("{A}.import-77"), "notauuid.import-1-2".to_string(), format!("{A}.import-1-2-3")];
        for n in ours.iter().chain(theirs.iter()) {
            std::fs::write(tmp.join(n), b"x").unwrap();
        }
        let o = imp(&r, &args(false), &FakeRows(vec![]), &Script::new(Err(FetchError::Status(404))));
        assert_eq!(o.code, Code::Ok);
        for n in &ours {
            assert!(!tmp.join(n).exists(), "{n}");
        }
        for n in &theirs {
            assert!(tmp.join(n).exists(), "{n} is not ours");
        }
    }

    #[test]
    fn a_second_importer_on_the_same_folder_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        std::fs::create_dir_all(r.photos()).unwrap();
        let other = File::options().create(true).truncate(false).write(true).open(r.photos().join(".import.lock")).unwrap();
        other.try_lock().unwrap();
        let o = imp(&r, &args(false), &FakeRows(vec![]), &Script::new(Ok(vec![])));
        assert_eq!((o.code, o.code.exit(), o.retryable), (Code::LockHeld, 10, true));
        drop(other);
        assert_eq!(imp(&r, &args(false), &FakeRows(vec![]), &Script::new(Ok(vec![]))).code, Code::Ok);
        // a dry run takes no lock and writes nothing
        let o = imp(&r, &args(true), &FakeRows(vec![]), &Script::new(Ok(vec![])));
        assert_eq!(o.code, Code::Ok);
    }

    #[test]
    fn dry_run_writes_nothing() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(3)), row("product-photos", B, "b.jpg", Some(3))]);
        let src = Script::new(Ok(b"abc".to_vec()));
        let o = imp(&r, &args(true), &rows, &src);
        assert_eq!(o.code, Code::Ok, "{}", o.message);
        assert_eq!((o.data["dryRun"].clone(), o.data["pending"].clone(), o.data["downloaded"].clone(), o.data["total"].clone()), (json!(true), json!(2), json!(0), json!(2)));
        assert!(src.calls.borrow().is_empty());
        assert!(!r.photos().exists(), "not even the folders are created");
        // with one file already in place, only the other is pending
        std::fs::create_dir_all(r.photos().join("product-photos")).unwrap();
        std::fs::write(r.photos().join("product-photos").join(A), b"abc").unwrap();
        let o = imp(&r, &args(true), &rows, &src);
        assert_eq!((o.data["pending"].clone(), o.data["alreadyPresent"].clone()), (json!(1), json!(1)));
        assert!(!r.photos().join("product-photos").join(B).exists() && !r.photos().join(".tmp").exists() && !r.photos().join(".import.lock").exists());
    }

    #[test]
    fn never_writes_outside_photos_dir() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = vec![
            row("product-photos", "../../evil", "a.jpg", Some(1)),
            row("product-photos", "not-a-uuid", "a.jpg", Some(1)),
            row("product-photos", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "a.jpg", Some(1)),
            row("product-photos", A, "../escape.jpg", Some(1)),
            row("product-photos", B, "/absolute.jpg", Some(1)),
            row("product-photos", C, "a/../../b.jpg", Some(1)),
            row("product-photos", "44444444-4444-4444-8444-444444444444", "a\\b.jpg", Some(1)),
            row("product-photos", "55555555-5555-4555-8555-555555555555", "", Some(1)),
            row("elsewhere", "66666666-6666-4666-8666-666666666666", "a.jpg", Some(1)),
        ];
        // a source of rows that ignores the bucket filter: a misbehaving source must not widen the import
        struct Wide(Vec<ObjectRow>);
        impl RowSource for Wide {
            fn rows(&self, _db: &str, _b: &[String]) -> Result<Vec<ObjectRow>, String> {
                Ok(self.0.clone())
            }
        }
        let src = Script::new(Ok(b"x".to_vec()));
        let o = imp(&r, &args(false), &Wide(rows), &src);
        assert_eq!((o.code.exit(), o.data["failedCount"].clone(), o.data["downloaded"].clone()), (61, json!(9), json!(0)));
        assert!(src.calls.borrow().is_empty(), "a refused row never reaches the network");
        let mut all = Vec::new();
        let mut stack = vec![d.path().to_path_buf()];
        while let Some(p) = stack.pop() {
            for e in std::fs::read_dir(&p).unwrap().flatten() {
                if e.path().is_dir() {
                    stack.push(e.path());
                } else if e.file_name() != ".import.lock" {
                    all.push(e.path());
                }
            }
        }
        assert!(all.is_empty(), "no file was written anywhere: {all:?}");
    }

    #[test]
    fn a_planted_bucket_link_is_refused() {
        // a plain file where the bucket folder should be stands in for a link/junction (the junction cases are Windows tests below)
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        std::fs::create_dir_all(r.photos()).unwrap();
        std::fs::write(r.photos().join("product-photos"), b"not a folder").unwrap();
        let src = Script::new(Ok(b"x".to_vec()));
        let o = imp(&r, &args(false), &FakeRows(vec![row("product-photos", A, "a.jpg", Some(1))]), &src);
        assert_eq!(o.code, Code::PhotosImportFailed);
        assert!(src.calls.borrow().is_empty());
    }

    #[test]
    fn failure_exits_61_retryable_and_lists_up_to_100() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let rows = FakeRows((0..120).map(|i| row("product-photos", &format!("{i:08x}-0000-4000-8000-000000000000"), &format!("n{i}.jpg"), Some(1))).collect());
        let src = Script::new(Err(FetchError::Status(404)));
        let o = imp(&r, &args(false), &rows, &src);
        assert_eq!((o.code, o.code.exit(), o.retryable), (Code::PhotosImportFailed, 61, true));
        assert_eq!((o.data["failedCount"].clone(), o.data["failed"].as_array().unwrap().len(), o.data["total"].clone(), o.data["pending"].clone()), (json!(120), 100, json!(120), json!(120)));
        let f = &o.data["failed"][0];
        assert_eq!((f["bucket"].clone(), f["id"].clone(), f["name"].clone(), f["reason"].clone()), (json!("product-photos"), json!("00000000-0000-4000-8000-000000000000"), json!("n0.jpg"), json!("HTTP 404")));
    }

    #[test]
    fn key_never_in_output_or_error() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        // a server that echoes the key back in every kind of answer: the importer must not repeat any of it
        let echo = mock::start_bytes(|req| {
            let key = req.headers.iter().find(|(k, _)| k == "apikey").map(|(_, v)| v.clone()).unwrap_or_default();
            (401, format!("{{\"message\":\"bad key {key}\"}}").into_bytes())
        });
        let c = creds(echo.url(), KEY);
        let rows = FakeRows(vec![row("product-photos", A, "a.jpg", Some(1))]);
        let o = imp(&r, &args(false), &rows, &UreqSource::new(&c));
        assert_eq!(o.code, Code::PhotosImportFailed);
        let shown = format!("{} {} {:?}", o.message, o.data, o);
        assert!(!shown.contains(KEY) && !shown.contains("bad key"), "{shown}");
        assert!(shown.contains("HTTP 401"));
        // a dead server: the transport error is ours to show, still without the key
        let dead = creds("http://127.0.0.1:1".into(), KEY);
        let o = imp(&r, &args(false), &rows, &UreqSource::new(&dead));
        assert_eq!(o.code, Code::PhotosImportFailed);
        assert!(!format!("{} {}", o.message, o.data).contains(KEY));
        assert!(!format!("{c:?}").contains(KEY));
    }

    #[test]
    fn a_database_failure_or_bad_buckets_are_not_an_import_failure() {
        struct Down;
        impl RowSource for Down {
            fn rows(&self, _: &str, _: &[String]) -> Result<Vec<ObjectRow>, String> {
                Err("psql failed: connection refused".into())
            }
        }
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let src = Script::new(Ok(vec![]));
        assert_eq!(imp(&r, &args(false), &Down, &src).code, Code::Error);
        let bad = ImportArgs { database: "postgres".into(), buckets: vec!["../x".into()], dry_run: false };
        assert_eq!(imp(&r, &bad, &FakeRows(vec![]), &src).code, Code::Usage);
        assert!(!r.photos().exists());
    }

    #[test]
    fn a_file_that_lands_outside_the_expected_folder_is_deleted_and_stops_the_run() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(&d);
        let (bucket, other, tmp) = (r.photos().join("product-photos"), r.photos().join("other-dir"), r.photos().join(".tmp"));
        for p in [&bucket, &other, &tmp] {
            std::fs::create_dir_all(p).unwrap();
        }
        let dest = bucket.join(A);
        let row = row("product-photos", A, "a.jpg", Some(3));
        let src = Script::new(Ok(b"abc".to_vec()));
        // the caller says the folder should be `other-dir`: the file is somewhere else, so it is removed and the run stops
        let e = attempt(&src, &row, &dest, &tmp, &std::fs::canonicalize(&other).unwrap()).unwrap_err();
        assert_eq!(e.0, Kind::Stop);
        assert!(e.1.contains("outside"), "{}", e.1);
        assert!(!dest.exists());
        // the right folder passes
        assert_eq!(attempt(&src, &row, &dest, &tmp, &std::fs::canonicalize(&bucket).unwrap()).unwrap(), 3);
        assert!(dest.exists());
    }

    /// Real junctions (`mklink /J`, no elevation needed): the Functions account can make these inside `photos\`.
    #[cfg(windows)]
    mod junctions {
        use super::*;

        fn junction(link: &Path, target: &Path) {
            std::fs::create_dir_all(target).unwrap();
            let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
            assert!(out.status.success(), "mklink: {} {}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        }
        fn entries(p: &Path) -> usize {
            std::fs::read_dir(p).map(|rd| rd.count()).unwrap_or(0)
        }

        #[test]
        fn a_junction_for_a_bucket_folder_is_refused_and_the_target_stays_empty() {
            let d = tempfile::tempdir().unwrap();
            let r = roots(&d);
            let outside = d.path().join("outside");
            std::fs::create_dir_all(r.photos()).unwrap();
            junction(&r.photos().join("product-photos"), &outside);
            let src = Script::new(Ok(b"x".to_vec()));
            let o = imp(&r, &args(false), &FakeRows(vec![row("product-photos", A, "a.jpg", Some(1))]), &src);
            assert_eq!((o.code, o.data["failedCount"].clone()), (Code::PhotosImportFailed, json!(1)));
            assert!(src.calls.borrow().is_empty());
            assert_eq!(entries(&outside), 0);
        }

        #[test]
        fn a_junction_for_the_temp_folder_is_refused_before_anything_is_deleted_or_created() {
            let d = tempfile::tempdir().unwrap();
            let r = roots(&d);
            let outside = d.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join(format!("{A}.import-1-2")), b"theirs").unwrap();
            std::fs::create_dir_all(r.photos()).unwrap();
            junction(&r.photos().join(".tmp"), &outside);
            let src = Script::new(Ok(b"x".to_vec()));
            let o = imp(&r, &args(false), &FakeRows(vec![row("product-photos", A, "a.jpg", Some(1))]), &src);
            assert_eq!(o.code, Code::Error, "{}", o.message);
            assert!(src.calls.borrow().is_empty());
            assert_eq!(entries(&outside), 1, "the leftover cleanup did not run through the junction");
        }

        #[test]
        fn a_junction_for_the_photos_folder_itself_is_refused() {
            let d = tempfile::tempdir().unwrap();
            let r = roots(&d);
            let outside = d.path().join("outside");
            std::fs::create_dir_all(r.data.clone()).unwrap();
            junction(&r.photos(), &outside);
            let o = imp(&r, &args(false), &FakeRows(vec![row("product-photos", A, "a.jpg", Some(1))]), &Script::new(Ok(b"x".to_vec())));
            assert_eq!(o.code, Code::Error);
            assert_eq!(entries(&outside), 0);
        }

        #[test]
        fn a_junction_in_place_of_the_destination_file_is_refused() {
            let d = tempfile::tempdir().unwrap();
            let r = roots(&d);
            let outside = d.path().join("outside");
            std::fs::create_dir_all(r.photos().join("product-photos")).unwrap();
            junction(&r.photos().join("product-photos").join(A), &outside);
            let src = Script::new(Ok(b"x".to_vec()));
            let o = imp(&r, &args(false), &FakeRows(vec![row("product-photos", A, "a.jpg", Some(1))]), &src);
            assert_eq!((o.code, o.data["failedCount"].clone()), (Code::PhotosImportFailed, json!(1)));
            assert!(src.calls.borrow().is_empty());
            assert_eq!(entries(&outside), 0);
        }

        #[test]
        fn the_held_folders_cannot_be_renamed_or_replaced_while_the_run_lasts() {
            struct Renamer {
                photos: std::path::PathBuf,
                refused: RefCell<Vec<(String, bool)>>,
            }
            impl ObjectSource for Renamer {
                fn get(&self, _b: &str, _n: &str, _s: Option<u64>) -> Result<Box<dyn Read>, FetchError> {
                    // what the Functions account would try between the check and the write
                    for (from, to) in [(self.photos.join("product-photos"), "product-photos-moved"), (self.photos.join(".tmp"), ".tmp-moved"), (self.photos.clone(), "photos-moved")] {
                        let target = from.with_file_name(to);
                        self.refused.borrow_mut().push((to.to_string(), std::fs::rename(&from, target).is_err()));
                    }
                    Ok(Box::new(Cursor::new(b"abc".to_vec())))
                }
            }
            let d = tempfile::tempdir().unwrap();
            let r = roots(&d);
            let src = Renamer { photos: r.photos(), refused: RefCell::new(Vec::new()) };
            let o = imp(&r, &args(false), &FakeRows(vec![row("product-photos", A, "a.jpg", Some(3))]), &src);
            assert_eq!(o.code, Code::Ok, "{} {}", o.message, o.data);
            assert_eq!(src.refused.borrow().len(), 3);
            assert!(src.refused.borrow().iter().all(|(_, refused)| *refused), "every rename was refused: {:?}", src.refused.borrow());
            assert_eq!(read(&r, "product-photos", A).as_deref(), Some(&b"abc"[..]));
            // and once the run is over the folders are free again
            assert!(std::fs::rename(r.photos().join("product-photos"), r.photos().join("moved")).is_ok());
        }
    }
}
