# Moving a cloud store to its own server (owner runbook)

Vendor-only: this file names the hosted deployment procedure and is excluded from customer exports.
The command is `posctl switch` (run as an administrator on the store server, which must have been provisioned with `--prepare-for-switch`).

## Before `switch run`
1. Every till is signed in, online and has sent its queue. The review queue is resolved and dead letters are cleared in the app. The store is still `active` in the cloud.
2. Run `posctl switch plan --source-db-stdin` first and read every finding. Blocks must be gone; warnings must be understood. The cloud credentials go in on stdin as one JSON object, never on the command line.
3. Waive a till (`--waive-terminal <install id> --waive-reason "<why>"`) only as a last resort: its unsent work is lost. The depth it had is written to the journal.
4. The cloud project is the archive and refuses writes for good after the move (the hosted free plan has no platform backups). Keep it for a retention period the owner sets before the first real switch (proposal: 90 days).
5. A write to `storage.objects` or `auth.*` during the freeze is not caught by the write guard. It is caught when the copy is verified: the run ends exit 41 (`CLONE_VERIFY_FAILED`, `FINGERPRINT_MISMATCH`) and the switch rolls back. Run in a quiet hour.
6. Real-project rehearsal: the owner runs read-only `posctl switch plan` against the real hosted project and returns the output (checkpoint D-T14). Never a `run`.

## Exit codes
| Exit | Name | Meaning and what to do |
|---|---|---|
| 0 | OK | Done (or recovered). |
| 2 | USAGE | Bad flags or stdin. |
| 10 | LOCK_HELD | Another posctl operation holds the lock (retryable). Distinct from ALREADY_SWITCHED. If it never ends, see "A hung run". |
| 17 | RECOVERY_NEEDED | LOUD. Reasons: `OPERATION_INCOMPLETE` (an interrupted operation: run `posctl update --recover`), `JOURNAL_UNREADABLE`, `CLOUD_MAY_BE_MOVED`, `CLOUD_STILL_MOVED`, `CLOUD_STATE_UNKNOWN` (a failed run whose cloud state is unknown). Run the `posctl switch rollback <op>` command the report prints, with the cloud credentials. |
| 40 | SWITCH_REFUSED | Nothing changed. `PLAN_BLOCKED` (see findings), `ALREADY_SWITCHED`, `ALREADY_COMMITTED`, `CLOUD_STATE_UNKNOWN` (run refuses while progress reads unknown, rollback when the row cannot be read), `CLOUD_HELD_BY_ANOTHER_OPERATION` (run `switch rollback <old op>`), `CLOUD_STILL_MOVED`, `OPEN_JOURNAL_CLOUD_MOVED`, `PAST_POINT_OF_NO_RETURN`, `STAGING_NOT_PRIVATE`, `SCRUB_SECRETS_UNREADABLE` (blocks `run` AND `rollback`: fix the local secrets first). |
| 41 | SWITCH_FAILED_ROLLED_BACK | The run failed after it started and the system is as before (for example `DRAIN_TIMEOUT`, `CLONE_VERIFY_FAILED`). The cloud was given back. |
| 60, 61 | photo importer | These are the exit codes of the photo importer (60 inconsistent, 61 import failed), not of `switch`. The switch itself exits 41 with reason `PHOTOS_INCONSISTENT` / `PHOTOS_IMPORT_FAILED`, rolls back, and the cloud is released. |

Photo copy proof: Sandbox scenarios 50 (files on disk per bucket, sizes, `photos verify` exit 0, photo rows) and 53 (importer exit 61 rolls back and releases the cloud, exit 41) use `store-server/sandbox/lib-cloud-storage-stub.ps1`, a loopback fake of the hosted Storage download route. They have not run yet: the switch is not signed off until both pass on the integrated 09+10 build.

## After a crashed run: what is left on disk
A run that crashed leaves `backups\switch-*` (the data dump: it holds the store's data) and `state\update\cloud-pgpass-*` (the cloud password file). The next `switch run` and `switch rollback` purge them under the lock. `update --recover` does not purge them yet (product fix pending). If no further run is planned, delete them by hand as administrator.

Rows that need an explanation:
* **`moved` with no op record on this server.** The cloud says moved but this server has no journal or progress record: contact support before anything else (`CLOUD_STILL_MOVED`).
* **Cloud `moved`, this server not switched** (a crash between marking moved and the Reopen intent). Fixed by `posctl switch rollback <op id>` with the cloud credentials. The op id is in `state\update\switch-progress.json`, the journal and the report. `update --recover` ends exit 17 and prints the command.
* **`PAST_POINT_OF_NO_RETURN`.** From the Reopen intent on the run rolls FORWARD and the cloud stays moved. `update --recover` finishes the switch; `switch rollback` refuses. A rollback that began after that point is never undone by recovery (`UNRESOLVABLE`): contact support.
* **`ALREADY_SWITCHED` / `ALREADY_COMMITTED`.** The server already runs the store's own data. There is no way back in this version.
* **`CATALOG_MISMATCH` (from `update`, shown with the diagnostics lines `rel:` and `trg:`).** A database object exists that the pack does not know. Read the `rel:`/`trg:` lines. Move the data out of the object and drop the table, or send the object's name to support. NEVER edit the digest or the pack. The live data is untouched by the refusal.
* **A table added by a LATER migration.** Any public table created by a migration after the fence was installed blocks every switch (`FENCE_TABLES_UNGUARDED`, re-checked after the drain and before the freeze) until that migration installs the write guard on it. There is no event trigger that guards new tables, and a partitioned table needs its guard added by hand. Fix: ship the guard in the same migration as the table.
* **Tampered `backups\` (`STAGING_NOT_PRIVATE`).** The dump folder must be private (SYSTEM and Administrators only, owned by one of them). The message says "Nothing was written there" and prints the exact `icacls` commands: owner first, then no inheritance and only SYSTEM and Administrators. Run them as administrator, then run again.
* **Invalid-PIN count.** Staff counted under `rederive.scrambled` and `rederive.withoutValidPin` in the success report have no usable PIN on the new server (no PIN in the cloud, or an account without a profile). Reset each PIN after the switch. `plan` counts them in advance.
* **Public tables.** Service images (Auth, REST, Functions, Gateway) were not audited in code for the tables they might create. The Sandbox check "no public table that a packaged migration does not create" (scenarios 56 and 51) is the evidence; a failure names the table.

## A hung run (stop by PID, never by image name)
Signs: `posctl status` shows `OPERATION_HUNG` naming the process id (the holder has kept the lock longer than `RUN_CEILING_MS`, about 6 h 7 min), `switch rollback` and `update --recover` answer exit 10.
1. Confirm the PID is posctl.exe: `tasklist /FI "PID eq <pid>"`. An old info file or a reused PID is another program. Other posctl processes run on the machine: NEVER `taskkill /IM`.
2. Stop THAT PID (or restart the server).
3. Run `posctl update --recover`.
4. If it ends with exit 17, run the `posctl switch rollback <op>` it prints (needs the cloud credentials).
5. Past the Reopen intent, recovery rolls FORWARD and the cloud stays moved. A cloud that is already `moved` is not covered by the freeze dead-man: `status` raises `SWITCH_CLOUD_MAY_BE_MOVED` after a crash after the move.

## Time budget
The operation deadline is t0 plus the drain wait plus `WORK_BUDGET_SECS` (7200 s, PROVISIONAL), where t0 is read once the lock is held, the prechecks passed and the dump folder exists. Nothing starts after the deadline; every local statement and every child process of the data move (`pg_dump`, `pg_restore`, the photo importer) is capped to the time left; that is a rollback and no data is lost. The cloud-side reads of the verification are capped only by their own fixed 600 s server-side timeout and are checked against the deadline before each read, not during it. A rollback stops renewing the cloud freeze first; the cloud then frees itself 30 minutes (`FREEZE_MINUTES`) after the last renewal.

**FREEZE BOUND, UNVERIFIED until the Sandbox scenario 57 part A (execute-level run) passes:** the cloud is frozen at most deadline + 32 minutes (`SQL_OVERSHOOT_SECS`) + 30 minutes, that is at most wait + 2 h + about 1 h 2 min from t0; normally minutes after a failure. The drain window is the wait plus 5 minutes.

Worst case: wait up to 120 minutes (default 20) plus 2 h of work plus the overshoot. Per-phase seconds of a real run are in the success report (`data.elapsedSeconds`: fence, backup, clone, drain, copy = dump + load, rederive, work, verify_clone, swap, activate, verify_live) and in the journal (`extra.timingsMs`, `extra.switch.phaseMs`); scenario 50 records them. The real data size comes from the D-T14 read-only plan; the PM sets the final budget.

## Before you start: prerequisites learned from the Sandbox runs
* **The server must have been provisioned with `--prepare-for-switch`.** A prepared store serves LAN TLS (`tls=internal`) and trusts its own root, so `switch plan` can pair and the server PC can reach `https://<host>:<port>` (product commits e91c41b3, c000bf8c). `prepare` runs the same host and port checks as a plain provision (348b379e): a bad host name or a busy port is refused at prepare time, not at the switch.
* **VC++ runtime.** `posctl.exe` is built with the static CRT, so it runs on a clean Windows before the VC++ runtime is installed (67901ec9). The installer hooks always run the bundled VC++ runtime step (c6712a3b, dcbb1797). Install through the installer rather than copying files, so the runtime is there for the store services. Which store service needs it was not traced: unverified.
* **Cloud source URL `sslmode` and the CA.** A loopback source uses `sslmode=disable` (no TLS). A remote source defaults to `sslmode=verify-full`, checked against the Supabase Root 2021 CA bundled in posctl (`store-server/resources/supabase-root-2021-ca.crt`, CN=Supabase Root 2021 CA, SHA-256 `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`). To use another CA (custom domain, self-hosted) add `sslrootcert=<file>` to the source URL. An explicit `sslmode=require` is still accepted but does NOT verify the server certificate. A certificate failure stops with `SOURCE_CERT_VERIFY_FAILED` (check the computer's clock; never lower the mode). The bundled CA expires 2031-04-26: replace the file and ship a new binary before then. UNCONFIRMED: which certificate the Supabase pooler presents versus the direct host. BEFORE RELEASE a read-only connection test against OUR cloud project (direct and pooler hosts) is required; it needs the owner's go and the database password and has not been done.
* **Photos child process.** The photo importer child gets the `--data/--program` root arguments only under `--dev` (b9137b98). In production none are passed and the child uses the production roots. Nothing to do; it matters only when reading a dev log.
* **Backup phase is not proven against a real destination.** In the Sandbox runs `Backup` and `BackupVerify` were Disabled, so the switch's backup phase has not been shown to work against a configured backup destination (reported by the Sandbox runs, not re-checked here: unverified). Before the first real switch, run a manual backup to the configured destination and read the result.

## After the switch: re-pair every till (REQUIRED)
The server PC pairs with itself inside the switch (see "SELF_PAIR_FAILED"). Every till does NOT: it keeps pointing at the cloud, which now refuses it.
1. **What the till shows.** The app sits behind a blocking screen titled "This store moved to its own server" with "Ask an administrator to pair this till with the store server" (`StoreSwitchGate.tsx`, text in `locales/en-US/common.json`). Unsent sales are kept on the till and the screen says how many. The button "Try again" re-checks; "Still not paired" stays until the till is paired.
2. **Pair by hand with `posctl pair`** (administrator, on the till):
   * Server PC: `posctl pair create --lan` writes a short-lived offer the tills can fetch and prints the code and the 16-character fingerprint to compare. Without `--lan` it writes a pairing file (`client\pairing\pair-<unix time>.pospair`) to carry on a USB stick.
   * Till, from a LAN offer: `posctl pair fetch --host <server> --port <port> --code <code> --out <file>` (installs nothing), compare the fingerprint with the server screen, then `posctl pair join --file <file> --confirm-fingerprint <16 characters>`.
   * Till, from a USB file: `posctl pair join --file <file> --trust-file`.
   * Give exactly one of `--confirm-fingerprint` or `--trust-file`. `pair join` checks the record, installs the store root certificate, then writes the till's `client\store.env`.
   * **11a's `posctl pair join --prompt` console does not exist in this tree.** `cli.rs`/`paircmd.rs` have `--file`, `--confirm-fingerprint` and `--trust-file` only. If the prompt console ships on another branch, use it there: unverified.
3. **What the writer writes.** `pairing::join::join` replaces the till's `client\store.env` atomically (the old file is copied to `store.env.prev` first), and `pairing::store_env_text` is the only text of it: `VITE_STORE_MODE=offline-only`, `VITE_SUPABASE_URL=https://<server host>:<port>`, `VITE_SUPABASE_ANON_KEY` (the public anon key), `VITE_STORE_CA_SHA256` (the root fingerprint), optional `VITE_STORE_SERVER_ALT_HOSTS`, and `VITE_STORE_PAIRED_AT`. The server's own file comes from the same writer through `server_self_pair`.
4. **RESTART THE TILL APP AFTER PAIRING (REQUIRED).** The app reads its runtime configuration once at boot (`AppConfigProvider` runs `get_runtime_config` in one effect) and the Supabase client is created once (`initSupabaseClient` returns early when a client exists). A paired till keeps talking to the cloud until the app is closed and opened again. Do not just press "Try again".
5. **Queued sales.** Offline sales are kept in the till's localStorage (a persisted store) and replay to the new server after the restart, each with the idempotency key it was queued with, so a sale that already reached the cloud is not counted twice. A sale queued during the switch window is kept, not lost. How the new server treats a key first seen at the cloud was not traced: unverified.

## What the freeze covers: PUBLIC TABLES ONLY (read before relying on it)
* **Copied:** every `public` base table except `pin_attempts`, `store_switch_state` and `till_sync_report`, plus `auth.users`, `auth.identities`, `storage.buckets` and `storage.objects` (`tables.rs`: `SKIP_COPY`, `EXTRA_COPY`, `copy_tables`). `pin_attempts` is emptied locally, not copied.
* **Fenced (writes refused during the freeze):** the write guard is a statement-level `BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE` trigger created on each `public` table with `relkind = 'r'` (the fence migration). The plan blocks a switch with `FENCE_TABLES_UNGUARDED` when a public table lacks it.
* **Not fenced:** writes to `auth.*` and `storage.*` (so a user or file change during the freeze is not stopped), any other schema, and partitioned tables or partitions (only plain tables get the trigger). Those writes are caught only after the fact, when the copy is verified: the run ends exit 41 (`CLONE_VERIFY_FAILED`) and rolls back. A change made after verification passes cannot happen: the cloud is frozen. Run in a quiet hour and ask staff not to change passwords or upload photos.
* Whether any other schema of the hosted project holds store data was not audited: unverified.

## Interrupted after the swap: CLOUD_MAY_BE_MOVED
1. **What it means.** The run was interrupted at or after the database swap, but before the switch finished. The cloud may already be marked `moved` while this server is not switched. `status` raises `SWITCH_CLOUD_MAY_BE_MOVED`.
2. **What `update --recover` does.** It rolls the LOCAL side back: `swap_back` renames the live database to `pos_failed_<stamp>` and the previous database back to live. Nothing contacts the cloud. The report is exit 17 `RECOVERY_NEEDED` with reason `CLOUD_MAY_BE_MOVED` and the exact `posctl switch rollback <op>` command.
3. **What you do next.** The cloud stays moved (or frozen) until you run `posctl switch rollback <op>` with the cloud credentials on stdin. Until then the cloud refuses every till and the local server holds the old data. Run it, then check that the cloud reads `active` and the tills sell again.
4. **Retention.** The failed database is kept as `pos_failed_*` for 7 days, at most one of each of `pos_prev_*` and `pos_failed_*` (`prune_plan`). Keep it until the cause is understood: it holds the copy the run made.
5. **Past the point of no return** (the Reopen intent) the run rolls FORWARD instead; see `PAST_POINT_OF_NO_RETURN` above.

## SELF_PAIR_FAILED: the switch is committed, fix forward
1. After the point of no return `on_commit` flips `posctl.json` to `offline-only`, then calls `server_self_pair` (installs the store root, writes the server's `client\store.env`).
2. If that fails the run ends exit 17 `RECOVERY_NEEDED` with reason `SELF_PAIR_FAILED` and the text "the switch is committed but this server could not pair with itself ... run `posctl update --recover`". Do NOT run `switch rollback`: the switch is done and rollback is refused (`ALREADY_COMMITTED`).
3. Fix the cause named in the message (usually Caddy has not issued `root.crt` yet, or the shell is not elevated), then run `posctl update --recover` as administrator. The code comment says recovery lands in the same `on_commit`, which is idempotent, and so retries the pairing. That recovery path was not traced end to end: unverified. Confirm with `posctl status` and by checking that `client\store.env` carries `VITE_STORE_MODE=offline-only`.
4. The Sandbox scenarios now check that `client\store.env` exists on the server PC after a successful switch and after a roll-forward, with mode `offline-only` (the mode line only is read), and that the finishing result carries no `SELF_PAIR_FAILED`.

## After
The previous (empty) local database is kept as `pos_prev_*`. Pair every till with the server. Reset the PIN of every staff member counted under `rederive`. Keep the cloud project for the retention period.

## Sources / evidence (paths relative to the repo root, line numbers at branch `int/two-mode-09-10`)
* Till pairing commands: `store-server/src/paircmd.rs:28-70` (the `Create`, `Fetch`, `Join`, `Leave` definitions, the `--file`, `--confirm-fingerprint`, `--trust-file` flags), `:364-381` (`Join` handler, exactly one confirm flag). No `--prompt` anywhere in `store-server/src` (grep).
* Writer of `client\store.env`: `store-server/src/pairing/join.rs:195-200` (copy to `store.env.prev`, atomic write); the text: `store-server/src/pairing/mod.rs:166-179` (`store_env_text`). The server's own copy: `store-server/src/paircmd.rs:249-264` (`server_self_pair`, uses `join`); `store-server/src/paths.rs:94` (`client()` = `<data>\client`).
* Server pairs after the flip: `store-server/src/switch/work.rs:764-811` (`on_commit`, mode flip at `:787`, `self_pair` at `:796-806`, `SELF_PAIR_FAILED` at `:801`); product commit 812fcd8b.
* Till gate text: `src/app/StoreSwitchGate.tsx`, `src/shared/lib/i18n/locales/en-US/common.json:288-296`.
* Boot-once config: `src/app/AppConfigProvider.tsx:22-53`; init-once client: `src/shared/lib/supabase.ts:108-109`.
* Queued sales persisted with idempotency keys: `src/entities/offline-sale/model/store.ts:2,86` (zustand `persist`), `:163` (compared by `idempotencyKey`), `src/entities/offline-sale/model/recover.ts:12`.
* Copy list and fence scope: `store-server/src/switch/tables.rs:7-16` (`SKIP_COPY`, `KEEP_LOCAL`, `TRUNCATE_ONLY`, `EXTRA_COPY`), `:32-41` (`copy_tables`); `supabase/migrations/20261025000001_store_switch_fence.sql:95-99` (trigger on `public` tables with `relkind = 'r'`); `store-server/src/switch/facts.rs:296-305` (`FENCE_TABLES_UNGUARDED`).
* CLOUD_MAY_BE_MOVED: `store-server/src/switch/work.rs:183-190` (`LOUD_CLOUD_WARNINGS`), `:221-232` (`in_move_window`), `:432-451` (`mark_moved` then `CLOUD_MAY_BE_MOVED`); `store-server/src/ops/runner.rs:180-186` (rollback runs `swap_back`); `store-server/src/ops/swap.rs:31-33` (`swap_back_sql`: live to `failed`, `prev` to live), `:99-101` (`prune_plan`, 7 days).
* sslmode and the bundled CA: `store-server/src/switch/cloud.rs` (`libpq_env`, `write_pgpass`, `SUPABASE_ROOT_CA_PEM`) and `store-server/src/switch/source.rs` (`parse_pg_url`); `store-server/src/pg.rs:201` (loopback `sslmode=disable`). Channel binding of 7ce03780 was reverted.
* Prepared store: commits e91c41b3 (TLS), c000bf8c (trusts own root), 348b379e (host/port checks); `store-server/src/paircmd.rs:267-` (`trust_own_root`). Photos child `--dev` only: `store-server/src/switch/photos.rs:22-28`; b9137b98.
* VC++: commits 67901ec9, c6712a3b, dcbb1797.
* Unverified: `pair join --prompt`; which service needs the VC++ runtime; the retry path of `update --recover` after `SELF_PAIR_FAILED`; idempotency-key handling on the new server; backup phase against a real destination; other schemas holding store data.
