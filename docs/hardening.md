# Hardening and verification

## Verified locally — 2026-09-24

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Unit/component tests | 643 passed across 63 files |
| Deterministic Chromium suite | 21 passed, no retries |
| 1,000 concurrent Chromium runtime sessions, full built-in catalog | 1,000 completed, zero failures; 462 ms total; 456.4 ms p95 completion time |
| Page heartbeat during load | 25 ticks; page event loop continued running |
| Production Chrome / Firefox builds | Both passed |
| Production signing-key inspection | Production key present and test key absent in both targets (237 JS assets each) |
| Biome check | No errors; three existing `!important` CSS warnings |
| Whitespace validation | `git diff --check` passed |

Load inputs were short text pastes containing a known-key-shaped value. Timings
are one local run, not a hardware-independent SLA or a maximum-size-log benchmark.
The worker transport was real Chromium; the 1,000 sessions were driven from one
extension page, not 1,000 third-party tabs. Unit tests separately exercise memory
overload, cancellation, timeouts, queue writes and cross-session result isolation.
Semgrep was unavailable locally. Firefox runtime and live authenticated business
backend/desktop interoperability were not verified in this run.

This work targets text-paste DLP. It does not claim to intercept manual typing,
uploads, images, arbitrary embedded editors, or browser-restricted pages.

## Resource behavior

- At most 1,000 admitted paste sessions and four active processing workers.
- FIFO operations; dialogs retain bounded input, not a reserved worker.
- 64 MiB conservative logical budget for retained scan/restoration inputs. This
  is not a cap on the entire browser's resident memory or JavaScript GC overhead.
- 2,000,000 characters per paste, 30 seconds maximum queue wait, five seconds
  maximum processing per operation, and 120 seconds idle-session expiry.
- Transformations re-scan the original input/rules in a fresh computation. This
  trades some CPU for isolation and releases worker capacity while a user decides.
- Overload/timeouts refuse the intercepted paste. They never fall back to an
  unchecked native insertion.

The unit stress test runs 1,000 sessions through the real detection computation
with simulated worker transport. The Chromium stress test opens 1,000 runtime
sessions against the actual extension worker host and records latency/heartbeat
metrics. Neither test is evidence of loading 1,000 full third-party websites.

## Identity, policy and vault

Entitlements are evaluated from the exact signed payload. Cached feature gates
check expiration on use. Policy changes invalidate pending decisions and update
open guards. Confirmed sign-out or organization mismatch removes old team policy.
An anonymous config refresh cannot erase an existing team's policy.

Vault access derives origin from the browser's message sender; a caller cannot
select another site's origin. Writes and expiry sweeps run through one background
queue. Restoration checks expiry again when confirmed. Session storage clears at
browser close; one-minute alarms remove old values when the browser schedules
them, while reads reject expired values immediately.

Session Lock is a walk-away deterrent, not a logout or an OS security boundary.
Enforced users without a PIN see a setup gate. Settings/policy changes apply to
existing console pages. Failed PIN attempts have a per-page cooldown, which does
not defend against someone controlling devtools or the extension installation.

## Shadow AI reporting

The metadata queue is serialized, capped at 5,000 events and expires after 24
hours. Each queue belongs to one signed user/organization pair. Old/unowned queues
are discarded instead of migrated into another account. Consent is rechecked at
upload. Credentials must contain `sub` and active organization `org_id` or `o.id`;
missing organization claims hold the queue for a later retry. Backend token
verification remains mandatory; local claim decoding is only a binding check.

Volume/outcome IDs correlate, and successful sanitization/bypass outcomes are
reported only after insertion. Cancellation after scanning is recorded once.
Navigation before a scan finishes cannot produce a sensitive-content outcome.

## Desktop bridge compatibility

Legacy plaintext-token pairing is intentionally unsupported. The companion app
must implement this protocol before the new extension can pair:

1. Client sends `{type:"hello_v2", nonce:<random UUID>}`.
2. Server sends `{type:"challenge_v2", nonce:<16–128 URL-safe characters>, proof}`.
3. `proof` is lowercase hex HMAC-SHA256 using the pairing token as the key and
   UTF-8 `secureintent-bridge-v2/server/<clientNonce>/<serverNonce>` as the message.
4. After verifying it, the client sends `{type:"authenticate_v2", proof}` using
   the same construction with `client` in place of `server`.
5. The server verifies that proof, sends `{type:"welcome_v2", ok:true}`, then accepts
   the existing origin/handled frames on that connection.

Use high-entropy pairing tokens, fresh nonces, short handshake deadlines and
single-use per-connection challenges. No fallback sends the token itself.
The desktop implementation is outside this repository and was not changed here.

## Release checks

Run `pnpm compile`, `pnpm test`, and the deterministic Chromium suite (`HEADLESS=1
pnpm e2e`). Build both production targets. Test artifacts live under `dist-e2e/`
and have a public test signing key with real Clerk authentication disabled;
never ship them. Production artifacts must contain the production verification
key and no test key or open-overlay flag.

Before publication, verify the deployed backend with an actual business seat,
complete desktop v2 interoperability testing, and smoke-test live supported
editors plus Firefox. Local mocks and a successful Firefox build do not substitute
for those checks. Versioning/store publication is a separate release action.
