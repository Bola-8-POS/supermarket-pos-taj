# LAN TLS for Offline-only stores: Caddy `tls internal`, root trusted at pairing

Status: accepted for v1 (2026-10-03, updated 2026-10-20 to what Plan 06 built). Evidence: Plan 06, spikes S2, S4B, S9, S10, R3A, and the per-task Application Security reviews. Reviewer: Application Security Engineer.

## Decision
The store gateway terminates TLS with Caddy's built-in local certificate authority (`tls internal`, one certificate per
configured site host; pinned Caddy 2.11.7, SHA-256 verified). Each till and the server PC trust the store's root
certificate after a pairing step. Nothing else is trusted: the app's CSP and the `store.env` allowlist accept only
shop-network addresses on port 47304.

Pairing (`posctl pair create` / `pair join`):
- The till always recomputes the full SHA-256 of the root it received and compares it to the offer, machine to machine.
  A person additionally types a 16-hex-character fingerprint (shown as `xxxx-xxxx-xxxx-xxxx`) read from the server
  screen; a wrong value, a tampered certificate or a missing confirmation exits 51 with no store call and no file written.
- Exactly one PEM certificate block is accepted; the file handed to `certutil` is rebuilt from the verified DER, never
  from the received text. The root goes only into LocalMachine\Root of an elevated session. A failed join removes
  only a root that run added, and keeps the previous `store.env` as `.prev` (atomic replace).
- A successful re-pair to a different store removes the root of the previous one, but only a root the till can prove
  it installed (`client\pkioot.crt` hashes to the `VITE_STORE_CA_SHA256` the old `store.env` recorded). `posctl pair
  leave` removes the paired root and `store.env` (`.prev` stays). A certificate-store read error is an error, never
  "not found" (`certutil` answers a missing certificate with NTE_NOT_FOUND or CRYPT_E_NOT_FOUND; anything else fails the
  operation before anything is deleted).
- `provision` refuses up front (USAGE) a production `--base-port` that does not give LAN port 47304 and a
  `--server-host` the till app would reject (one shared rule, `pairing::check_shop_host`).
- LAN offers expire (10 minutes, swept by health) and are fetched over HTTPS from the LAN; a USB file never carries an
  expiry and is the only form `--trust-file` accepts. The pairing code is masked in the gateway access log.
- `join` requires port 47304, normalises hosts, refuses a host the app would reject, and refuses (PRECONDITION) when
  `%ProgramData%\SupermarketPOS` or `client\` exists with an untrusted owner.

Till configuration (`store.env`):
- Read only from `%ProgramData%\SupermarketPOS\client`, found through the Windows known-folder API, not the
  `%ProgramData%` variable a user can set. The drive must be local and fixed, and no folder in the `SupermarketPOS\` to
  `client\` to `store.env` chain may be a junction or symlink (else `STORE_ENV_UNTRUSTED_PATH`). The owner of the file and
  of its parent folders must be Administrators or SYSTEM, else it is ignored (`STORE_ENV_UNTRUSTED_OWNER`) on a cloud till.
- A cloud till never takes a URL or key from `store.env`. `.env` cannot set the mode.
- Any other defect in a trusted file (unknown mode, unreadable, rejected URL, wrong port) makes the app refuse with
  `STORE_CONFIG_INVALID` and no cloud fallback until repaired; the runtime config loads before the first client exists.

Gateway behaviour that is part of the control:
- The INTERNAL listener is loopback-only, has no CORS and no `/functions/v1`. The LAN listener allow-lists routes; GoTrue
  admin, signup, recover and password-grant paths and service-role bearers are refused. Request secrets (apikey, tokens,
  pair code) are filtered from the access log. HTTP/3 is off, TLS is 1.2 or newer, plain HTTP on the TLS port is refused.
- Upstream outage maps to 503 with `Retry-After`: a PostgREST 400 only when `Proxy-Status` is exactly `PostgREST; error=`
  (never by status alone), PostgREST 502/503/504 bodies replaced (no database host:port leaks), and sale/payment functions
  answer 503 (outcome unknown) rather than 500 when the backend dies in flight.
- `pki reissue --server-host <name>` is the explicit recovery when `state\gateway.json` is missing or damaged: it
  rebuilds TLS internal on the private LAN address from validated inputs. `pack activate` refuses (never silently falls
  back to plain loopback) when TLS evidence exists but `gateway.json` does not. `pki status` reports host drift.

## Options considered
1. Caddy `tls internal` (chosen). No code of ours issues certificates; names, renewal and the handshake are Caddy's.
2. A CA issued and managed by `posctl`, with a name constraint limiting it to the shop's names. Stronger containment,
   but it makes us the maintainer of certificate issuance and renewal, and Caddy's local CA has no name-constraint
   option in the pinned version (re-check at each Caddy upgrade).
3. Per-till pinned leaf certificates. No CA to protect, but every address change needs a re-pairing of every till.
4. Plain HTTP on the LAN. Rejected by D11: PINs and tokens would cross the shop network in clear.

## What this protects
PINs, tokens and sales data between a till and the server against anyone who can sniff or intercept the shop LAN,
provided the pairing fingerprint was compared on both screens (or the file came by hand).

## Residual risks (accepted or deferred, with the control that limits each)
- No name constraints (deferred): a till that trusts the store root trusts it for any host name, and LocalMachine\Root
  trust for an unconstrained CA is a large grant. Limit: the root key lives only in `DATA\pki\caddy` (SYSTEM,
  Administrators, the Gateway service account); the root is published only in the pairing file; `pair join` installs it
  only from an elevated session; `unprovision` removes it again from the SERVER PC only. A till keeps trusting it until
  its next re-pair to a different store or `posctl pair leave`; a server PC that is replaced or sold keeps the CA key on
  its disk, so the owner must run `pair leave` on each till (and wipe the old disk) before disposing of it.
- A till that was never re-paired or left keeps trusting a disposed server PC's unconstrained CA, and whoever holds that
  disk's `DATA\pki\caddy` can mint a certificate for any host name that the till then accepts (cloud Supabase, licence
  server, banking sites). Accepted for v1 with the `pair leave` / re-pair removal above; a name-constrained CA is the fix.
- SEC M1: `storeCaSha256` is written to `store.env` and exposed to the app but never checked against the connection;
  TLS trust is whatever LocalMachine\Root holds. Deferred (needs a Rust-side check of the presented chain).
- SEC M2: the typed fingerprint authenticates the root only. An attacker who keeps the genuine root can still change
  `serverHost`, `altHosts` and `anonKey` in a LAN offer. Impact today is denial of service (the till needs a store-issued
  leaf for that name, which only the server's Caddy holds). Deferred.
- SEC M3: a planted `store.env` (`STORE_ENV_UNTRUSTED_OWNER`) also blanks the `.env` cloud override, so a standard user
  can make a till fall back to the build-time URL (denial of service or a misroute to the vendor cloud). Deferred: keep
  the `.env` result and set only the code.
- The Gateway account can read the root key. Limit: per-service virtual account with no login; loopback exposure per D7/D8.
- The typed fingerprint is 64 bits; the machine-to-machine check is the full SHA-256. Limit: the human check matters only
  during the 10-minute LAN offer window; the USB path has no window. `FINGERPRINT_LEN` is one constant.
- Firewall service filter on the LAN listener is deferred to Plan 12 (CARRY): the rule is scoped by port, Private/Domain
  profile and LocalSubnet, but not to the Gateway process, and the Sandbox has no network to prove a filter would not cut
  every till. Until then any process on a local-subnet machine can reach the listener (which is route-allow-listed).
- Losing all gateway evidence (`gateway.json`, Caddyfile(s), root) is a silent downgrade to plain loopback; it fails
  closed for confidentiality but cuts tills off, and `pki status` does not flag it (BACKLOG, review-task-9 M1).
  `GATEWAY_STATE_*` are message prefixes, not envelope codes (M2, deferred); `teardown_trust` does nothing when the root
  file is unreadable (M3); provision on a PC with no private IPv4 yields no IP names (M4).
- Certificates are issued per name and renewed while the Gateway runs. A changed address needs `posctl pki reissue`;
  `pki status` reports drift (health does not run PowerShell, so drift shows only there). Root expiry warns under 90
  days and is critical under 7.
- The pairing code is a 10-minute bearer secret, masked in the access log. An expired offer is dropped by the health
  sweep (`health --write`, not under `--dev`), not at the moment it expires.
- Gateway edge hardening deferred (review-task-2 minors): `/_store/health` has no body cap or read-body timeout;
  site-name validation accepts a public domain name on some paths; hosts are not de-duplicated at render.
- The app CSP allows `https://*:47304` (wildcard host) in `img-src` and `connect-src`; single-label host names are
  accepted (Task 10 minors, deferred). Limit: the port is fixed and `store.env` is owner-checked.
- Seven SECURITY DEFINER RPCs (reopen_tab, edit_paid_tab, process_refund and four more) lack an active-caller check, so a
  deactivated user's token stays valid for up to one hour (BACKLOG, Medium; needs one later migration, outside Plan 06).
- Shared edge code (`_shared/errors.ts`, `caller.ts`, `upstream.ts`) changed: a hosted redeploy is owed at release.
  `fail()` forcing 503 relabels a function's own 503, including the agent proxy relaying a 503 from its provider (deferred).
- Storage routes are not served by the native gateway yet (Plan 10). The sandbox payload default pack and plan docs
  still name Caddy 2.11.6 and need the next pack refresh (Plan 13).
- `tls internal` trusts nothing about the till's own identity; sign-in is still the PIN through `staff-sign-in`.

## Revisit when
Caddy offers name constraints for the local CA; a customer requires a certificate chain from their own CA; a second
store site shares one root; Plan 12 adds the firewall service filter; or a review finds the pairing step skipped in practice.
