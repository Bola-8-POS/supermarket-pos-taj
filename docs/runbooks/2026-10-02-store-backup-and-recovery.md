# Store backup and recovery: owner and support runbook

DRAFT (Plan 08 Task 14 Step 4). Written from the as-built code at HEAD e0975f45. Items marked **[PENDING]** wait on a decision or a
Sandbox result and must be filled in before this is released.

Applies to a store that runs its own server PC ("Offline only"). The server keeps one backup copy on its own disk. That copy protects
you against a bad update or a damaged database. It also copies every backup to a **second device**, a USB drive or a second internal
drive. Only a second device protects you if this PC dies.

Network folders (`\\host\share`) and mapped network drives are **not supported yet**. The command refuses them with "network shares
are not supported; use a USB drive or R2". A cloud (R2) destination arrives with Plan 12 and is not covered here.

Status screen (Plan 11, not yet built): when it exists it is meant to be the normal way to do the first two sections, running these
commands for you. Until then the commands below are the only way. Run every command in a PowerShell window opened **as Administrator** on the server
PC. The one exception is `posctl backup dest candidates`, which works without Administrator rights.

## 1. Set up (once, about 10 minutes)

1. Plug in an empty USB drive (NTFS or exFAT; at least 2 times the size of your database; 64 GB is plenty for one store).
2. Show the drives, then add the one you plugged in:
   - `posctl backup dest candidates`
   - `posctl backup dest add --kind device --path E:\ --allow-fixed`

   Use `--allow-fixed` only if Windows lists the drive as an internal disk. The system drive (usually C:) is always refused, and so is
   any folder inside the store's own program or data folders. A backup drive whose folder has been replaced by a link (junction, symbolic link or mount point, on the folder or any folder above or below it), or that turns out to be the system drive, is treated as a different drive: backups write nothing to it and read nothing from it, and the status shows it as foreign or not reachable (`BACKUP_DEST_FOREIGN` or `BACKUP_DEST_DOWN`). The backups go into a folder named `SupermarketPOS-Backup` on that
   drive, created for you. Add `--name usb-e` if you want your own label (1 to 32 lowercase letters, digits or dashes). Without
   `--name` the label is `usb-` plus the drive letter.
3. **Create the recovery key and write it on paper:** `posctl backup key-export`. The key is shown once, on that screen, and the
   window waits for Enter so you can copy it. It is stored nowhere. Keep the paper away from the server PC. Without it a replacement
   PC cannot open the USB drive.
   - Every backup drive must be plugged in when you run this, because the key is added to each of them. If one is missing the command
     stops and names it.
   - The command also writes `escrow.age` onto every backup drive, **next to** the `SupermarketPOS-Backup` folder (for `E:\` that is
     `E:\escrow.age`). It holds the same key, locked so only the vendor can open it. If you lose the paper, the vendor can recover
     your backups with it. Nobody else can read it.
   - Running it a second time is refused ("a recovery key was already issued"). `posctl backup key-export --rotate` replaces the key;
     the old paper stops working, so write the new one down at once. A rotation also needs every drive plugged in.
   - **Once a recovery key exists, adding any further drive needs the key:** add `--key-stdin` to `dest add` and type the key from the
     paper when asked. The program reads it from the keyboard and never stores it.
4. The first copy starts within about five minutes. `posctl backup list` shows each backup and where it lives (it prints one JSON envelope, see below). `posctl backup dest
   check` tests the drives. `posctl backup run --reason manual` takes a backup right now.

**Recommended: turn on BitLocker (Windows device encryption) on the server PC's system drive.** While a backup or restore runs, the server
briefly holds a readable copy of the database in a private folder under `C:\ProgramData\SupermarketPOS`. Only administrators can open that
folder and leftovers are wiped, but on an SSD deleted data cannot be reliably erased. Disk encryption is what protects the data if the PC is
stolen or thrown away.

If a command fails, support can read the exit code (section 8).

## 2. What runs by itself

Two scheduled tasks do all of it. Both run as the SYSTEM account (section 10). Both catch up on their own if the PC
was off at the scheduled time.

**Backup** (every 5 minutes, decides what is due):
- one backup about every hour while a caja is open (a new one when the last is 55 minutes old);
- one right after every caja close;
- one every 12 hours when the store is closed, so the "no backup" alerts never trip overnight;
- one before every software update or version switch, and one before a restore (these are kept 30 days beyond the normal rules);
- every new backup is copied to each connected drive. A drive that fails is left alone for 30 minutes, then tried again (plugging it
  back in resets the wait).

**BackupVerify** (once a day, 5 minutes after the store's maintenance window ends; **05:05 with the default window**). It does two
things in order, and each only does work when it is due, so most days it finishes at once:
- *Check the copies:* each connected copy (this PC's own and each drive) is read end to end when it was last fully read 6 or more days
  ago. A drive that is not plugged in is skipped and shows its own alert. Old backups are cleaned up in the same pass.
- *Restore drill:* the newest backup (not a pre-restore safety snapshot) is restored into a scratch database, compared row by row, an administrator account is checked,
  and the scratch database is deleted. It runs when the last pass is 6 or more days old, and daily after a failure. It prefers the
  backup drive over the local copy, because that is the real disaster path.
- A PC that is off at that time runs it when it is next on. It is not tied to a weekday, so there is no "Sunday night" to remember;
  the only rule is that the server PC should normally be on overnight.

**Retention:** 24 hourly, 30 daily and 12 monthly backups are kept.

## 3. What the app tells you

Administrators see a bar at the top of every till screen. It says "the server PC" (in Spanish, "la PC del servidor"). Only these six
codes have their own wording; any other backup code shows the generic message "Backups need attention. Check the server status screen (Plan 11, not yet built)."
at the severity the server reports. Level words in the server's status are `warn` (yellow) and `critical` (red).

| Message (code) | Level | What it means | What to do |
|---|---|---|---|
| No backup outside the server PC for more than a day (`BACKUP_STALE_24H`) | warn | The drive is missing, full or was never added | Plug it in; `posctl backup dest check` |
| No backup drive is set up at all (`BACKUP_STALE_24H` or `BACKUP_STALE_72H` with reason `no-destination`) | warn, then critical | The server reports that no second device was ever added. The bar says "Connect a USB drive and set it up as a backup drive" (es-MX "Conecta una unidad USB y configúrala como unidad de respaldo") | Section 1: `posctl backup dest candidates`, then `dest add` |
| Same, more than 3 days (`BACKUP_STALE_72H`) | critical | Your data exists only on this PC | Do it today |
| Backup drive cannot be found (`BACKUP_DEST_DOWN`) | warn | The drive is unplugged or the folder is gone | Plug it back in. If you replaced it, `posctl backup dest remove --name <name>`, then `dest add` again (needs the key, see step 3) |
| Recovery key not saved (`BACKUP_KEY_NOT_EXPORTED`) | warn | A drive was added more than a day ago and no key was created | `posctl backup key-export` |
| Check failed (`BACKUP_VERIFY_FAILED`) | critical | A copy is damaged, or the drill could not restore (or took longer than the allowed time, 30 minutes by default) | Call support; do not delete anything |
| Not checked for more than 10 days (`BACKUP_VERIFY_OVERDUE`) | warn | The daily job has not completed a check | Leave the PC on; `posctl backup verify --read-data` |

Other backup codes you may see (generic bar, but support should know them):

| Code | Level | Meaning |
|---|---|---|
| `BACKUP_DEST_FOREIGN` | warn | A different drive now has the letter of a backup drive. Nothing is written to it. Plug the right drive back in |
| `BACKUP_DEST_FAILING` | warn | The drive is connected but copies keep failing for 6 hours or more (the status carries a short word such as `disk-full` or `access-denied`) |
| `BACKUP_DEST_NO_RECOVERY_KEY` | warn | A drive was added without the recovery key. Run `key-export --rotate` with every drive plugged in |
| `BACKUP_PHOTOS_UNREADABLE` | warn, then critical after 3 days (critical at once if the whole photo folder is unreadable) | The database is safe; some product photos could not be backed up |
| `BACKUP_RESTORE_WARNING` | warn | A restore finished with a warning; shown for 7 days |
| `BACKUP_STATE_UNKNOWN` | warn, critical after 1 day | The backup state file cannot be read. Run `posctl status` as Administrator |
| `UPDATE_BLOCKED` | warn | A newer version has waited 3 nights because the backup that must come first cannot be taken. Fix the backup and the update goes ahead |

If the internet is available, the same alerts are e-mailed (optional cloud feature).

## 4. Disaster: the server PC is gone

You need: the backup USB drive, the **recovery key on paper**, the installer of the same (or a newer) version, and any PC with a few
GB free.

1. Install the software and set the PC up as the store server (**Offline only**), exactly as on day one.
2. Plug in the USB drive. As Administrator:
   `posctl backup restore --snapshot latest --swap --repo E:\SupermarketPOS-Backup --key-stdin`
   and type the recovery key when asked (it is read from the keyboard, never written down by the program). The restore:
   - proves the data against the backup's own fingerprints;
   - brings the database up to the installed version if it is older;
   - gives every staff member a sign-in that is valid on **this** PC;
   - restores the product photos;
   - checks that an administrator can sign in to the restored store, then opens the store to the tills.

   It never restores into the live database directly. It builds the new database next to the old one under the name `pos_next` and
   swaps only after every check passes. If anything fails, nothing changes and the old database stays in use.
3. **Pair every till again.** The new server has a new certificate: `posctl pair create` on the server, then each till.
4. Re-add the drive for future backups (it already holds your history):
   `posctl backup dest add --kind device --path E:\SupermarketPOS-Backup --allow-fixed --key-stdin`
   (use `--allow-fixed` only if Windows lists the drive as an internal disk; type the key again). Then run `posctl backup key-export`
   to create a fresh key for this PC and write it on paper.
5. Re-create the optional cloud tunnel if you used it.

**If a restore fails or is rolled back, run the same command again.** `--snapshot latest` skips the safety snapshot that a restore takes just
before it starts (reason `pre-restore`), so a retry restores the last good backup, not the damaged state. Pre-update and pre-switch
snapshots are still eligible. Restore drills skip `pre-restore` snapshots too.

**Undo a restore:** to go back to the state just before a restore, run `posctl backup list` and restore the `pre-restore` snapshot by its id
(`--snapshot <id>`; ids of 8 or more hex characters work).

The old database (if any) is kept as `pos_prev_restore_<14 digits>` for rollback. Housekeeping drops it after at most 7 days (sooner if
a newer update or restore safety copy replaces it, because only one is kept). It still holds the old staff PINs, so it is closed to
the app. Do not copy it anywhere.

What the owner sees after a restore that ended with a warning:
- For 7 days the admin bar shows `BACKUP_RESTORE_WARNING`, but only as the generic "Backups need attention. Check the server status screen
  (Plan 11, not yet built)". The warning words (`PHOTOS_SOME_MISSING`, `POST_RESTORE_BACKUP_FAILED`, `PREV_COPY_REVOKE_FAILED`,
  `CANARY_AFTER_RESTORE`) are in the server's status (`posctl status`, and later the status screen), not on the bar.
- "Sign-in is blocked until the lockout protection works; call support" is the status alert `LOCKOUT_HOOK_INACTIVE` with cause
  `after-restore` (within 7 days of a restore whose canary check failed). The admin bar never shows it, because the bar shows only
  `BACKUP_*` codes; look for it in `posctl status`. While it is up, `CANARY_AFTER_RESTORE` is dropped from the restore warning so the same
  problem is not reported twice. It is the one to act on at once: call support.

## 5. Disaster: the database is damaged but the PC is fine

`posctl backup restore --snapshot latest --swap` (the copy on this PC is used, no key needed). If an attempt fails or is rolled back, run the same
command again: `latest` skips the `pre-restore` safety snapshot (pre-update and pre-switch ones are still eligible). To undo a restore, restore
the `pre-restore` snapshot by its id from `posctl backup list`.

To try a restore without replacing anything, leave out `--swap`. It restores into a scratch database named `pos_drill_<14 digits>`,
compares it, reports the result and deletes it. `--snapshot` is required in both forms; `latest` or a snapshot id from `posctl backup
list` works. If a backup or update is running, the restore waits up to 2 minutes, then stops with "lock held" (exit 10).

## 6. Never

- Never delete `secrets\restic-password.txt`, `backups\escrow.age` or the folder `backups\` (under `C:\ProgramData\SupermarketPOS`) by
  hand.
- Never copy the USB drive's folder to a shared location. It is encrypted, but the key on paper is the only thing standing between a
  thief and your staff list.
- Never stop the store's services by hand while an update or a backup is running.

## 6b. What `posctl backup list` prints (support)

Like every `posctl` command it prints one JSON envelope on stdout (`ok`, `command`, `code`, `message`, `data`). The message is "backups
listed". It is read-only: it takes no lock, never creates a repository or a key, and works while a backup runs. In `data`:
- `snapshots`: newest first, one row per backup with `id`, `time` (UTC), `reason` (hourly, caja-close, pre-update, pre-switch, pre-restore,
  manual), `schema`, `protected` (true for the pre-update, pre-switch and pre-restore ones) and `on` (the copies that hold it, for
  example `["local","usb-e"]`; a backup on the drive and on this PC is one row);
- `unreachable`: destinations that are not plugged in; `broken`: copies that could not be read (`repo` and `detail`); `absent`: no local
  repository exists yet;
- `photosUnreadable` (only when present): `total` and `paths`. File names appear here and in the backup log, never in the status
  every till can read.

## 7. Where things are (support)

Under the data folder `C:\ProgramData\SupermarketPOS` (administrators and SYSTEM only):
- `backups\repo` the local backup copy; `backups\escrow.age` the vendor-locked key copy; `backups\cache` the backup tool's cache; `backups\backup.lock` the
  lock that keeps two backup jobs from running together; `backups\tmp`, `backups\restore`, `backups\stage` scratch folders (cleaned
  automatically);
- `secrets\restic-password.txt` the machine key; `secrets\pgpass-backup.conf`, `secrets\pg-pos_backup.pw`, `secrets\r2.env`
  (cloud, Plan 12), `secrets\staff-password-pepper.txt`;
- `state\backup.json` the backup state; `posctl.json` holds the `backup` section (destinations, restore time budget).

## 8. Exit codes (support)

| Exit | Name | Typical meaning for `posctl backup ...` |
|---|---|---|
| 0 | OK | done |
| 1 | ERROR | an unexpected failure, for example a disk read or write error ("I/O error: ..."); read the message and the backup log, then call support |
| 2 | USAGE | bad arguments, unknown reason, invalid key, a recovery key already issued, a network path |
| 3 | NOT_ELEVATED | open PowerShell as Administrator (checked before the provisioned check, so a standard user gets 3, never 4; `dest candidates` is the one command open to a standard user) |
| 4 | NOT_PROVISIONED | this PC is not set up as a store server |
| 10 | LOCK_HELD | an update, backup or restore is running; try again later |
| 12 | PRECONDITION | refused before changing anything: drive missing, not enough space, key does not open the backup, no vendor key in this build, backup not ready for an update |
| 17 | RECOVERY_NEEDED | an interrupted update, switch or restore is still open. Two cases: a new `restore` is refused before touching anything, or a restore already under way could not roll back (it is recorded as failed). In both the tills stay fenced. Run `posctl update --recover` as Administrator, then retry. Among the `backup` commands only `restore` returns it |
| 30 | BACKUP_FAILED | the backup did not complete |
| 31 | RESTORE_FAILED | the restore or drill failed |

## 9. Vendor key ceremony (vendor, owner-run, once before the first release; never on a store PC)

1. On an offline, trusted machine generate the escrow key pair: `age-keygen -o vendor-escrow.key`. The file holds the **private** key;
   the line `# public key: age1...` is the public key.
2. Store the private key offline in two places (for example an encrypted USB in a safe and a paper copy in a second location). It
   must never be committed, e-mailed, put in CI secrets or copied to any store PC or developer laptop.
3. Give the release build only the **public** `age1...` key, one line. As built, the committed file
   `store-server/resources/escrow-pubkey.txt` stays `PLACEHOLDER-NO-VENDOR-KEY`. The release workflow writes the real key into it
   before building, from the repository variable `POS_ESCROW_PUBKEY` (or from `customers/<name>/escrow-pubkey.txt` for one customer,
   which wins over the variable), and then refuses the build if the file still says PLACEHOLDER, holds the development key, or is not
   an `age1` key. A build with the placeholder cannot run `key-export`, so a release cannot ship without it.
   **[PENDING: set the `POS_ESCROW_PUBKEY` variable after the ceremony; the release workflow has not been run.]**
   The key is also **pinned by a committed fingerprint**: `store-server/resources/escrow-pubkey.fingerprint` holds
   `PLACEHOLDER-NO-VENDOR-KEY-FINGERPRINT` until the ceremony, and the release writer step (`scripts/write-escrow-pubkey.mjs
   --fingerprint-file ...`) fails unless the resolved key hashes to it. The ceremony therefore includes a **reviewed commit** of that
   file. The fingerprint is the lowercase hex SHA-256 of the exact trimmed `age1...` recipient string (UTF-8, no newline). Compute it:
   `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1].trim()).digest('hex'))" age1...`
   or in PowerShell, with the key written to a temp file without a trailing newline:
   `Set-Content -NoNewline -Path $env:TEMP\k.txt -Value 'age1...'; (Get-FileHash $env:TEMP\k.txt -Algorithm SHA256).Hash.ToLower(); Remove-Item $env:TEMP\k.txt`.
   Changing the `POS_ESCROW_PUBKEY` variable alone fails the release (fingerprint mismatch); rotating the key needs the variable and a
   reviewed fingerprint commit together. A key supplied as `customers/<name>/escrow-pubkey.txt` is checked against
   `customers/<name>/escrow-pubkey.fingerprint` in the same folder (commit both); the variable is checked against the global file.
   Also, the release build uses `cargo build --release --locked` for posctl (committed `store-server/Cargo.lock`) and then fails if
   the built `posctl.exe` contains `POSCTL_TEST_` or the development escrow recipient.
4. Rehearse once with a scratch store: `posctl backup key-export`, then on the ceremony machine `age -d -i vendor-escrow.key escrow.age`
   must print exactly the key shown to the owner. **[PENDING: Plan 13 repeats this with a real restore.]** Rotate the escrow key
   pair only with a new release; old `escrow.age` files stay readable only with the old private key, so keep it.
5. Recovery with `escrow.age`: the vendor decrypts it on the ceremony machine, gives the key to the owner by phone or in person (after
   identity checks), and the owner restores with `posctl backup restore ... --key-stdin`.

## 10. Which account runs the backup tasks

Both tasks, `Backup` and `BackupVerify`, run as **SYSTEM** (decision Q7). A least-privilege account (`NT SERVICE\SupermarketPOS-Backup`)
was tried in Windows Sandbox scenario 44 and Task Scheduler refuses it (`schtasks` rejects the service-account logon type for that
name), so the tasks stay as SYSTEM. A narrower built-in account (LOCAL SERVICE) is a possible follow-up, not part of v1.

- What the owner sees: no change.
- Support check, in an Administrator PowerShell window:
  - `schtasks /Query /TN "\SupermarketPOS\Backup" /V /FO LIST` and the same for `\SupermarketPOS\BackupVerify`. The "Run As User"
    line reads `SYSTEM`.
  - For the exact registered definition: `schtasks /Query /TN "\SupermarketPOS\Backup" /XML` shows `<UserId>S-1-5-18</UserId>` and
    `<RunLevel>HighestAvailable</RunLevel>`. (These are the values `posctl` registers; the task folder is `\SupermarketPOS\`.)
  - If a task is missing or out of date, `posctl tasks install` registers it again, and `posctl status` raises `TASKS_MISSING` or
    `TASKS_STALE`.

## 11. Known gaps (as built)

- No network-folder (NAS/UNC) destination yet; it needs a task account that can reach a share. Follow-up.
- No cloud (R2) destination until Plan 12.
- If the folder `backups\tmp` was created by another account before provisioning, backups refuse to run (exit 12, PRECONDITION: "... is not
  private") until support resolves it. Automatic repair is a follow-up.
- Backup and restore briefly hold a readable copy of the database; on an SSD a deleted copy cannot be reliably erased. Disk encryption
  (BitLocker) on the server PC is recommended, not enforced (section 1).

## 12. Development and test notes

- Backups taken by a `posctl` build older than commit 804df704 use a different catalog fingerprint, because ACL items are now compared in sorted order.
- Restoring such a backup with a newer build reports "catalog differs" and rolls back.
- On development or Sandbox stores, take a fresh backup (`posctl backup run --reason manual`) before testing a restore.
- No migration is needed, because nothing has shipped.
