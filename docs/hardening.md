# Hardening and verification

## Chrome/Firefox and backend follow-up — 2026-10-04

Scope expanded to the backend after the extension-only pass below. Extension base
is `20f9690`; backend base is `3eed107`, both on the Business onboarding branch.
The extension hardening is recorded with the [final1 handoff](../final1.md).
Backend source `08424ad` was deployed
with explicit approval as version `7ba66839-3a2d-4c2b-b6b8-12fb9397ba70` (100% traffic).
Store publication is unchanged.

### Connection defects fixed

- Firefox renews expired Clerk JWTs using the verified HttpOnly client credential
  through the new backend session endpoint. The backend checks the live client,
  session, user, expiry and revocation state before issuing a 60-second token.
  Expired JWTs alone cannot renew. Provider outages remain retryable.
- Renewal requests are coalesced, bounded and cached only in background memory.
  Cookie changes cancel old-account work. Explicit sign-out clears cached access.
- Simultaneous Chrome/Firefox connections for the same member have independent,
  single-use policy tickets. Five-second per-organization revision caching and
  shared in-flight reads reduce duplicate D1 heartbeat queries.
- Firefox MV2 injects ordered protection scripts into already-open supported tabs.
  Both manifests now have the host permissions required for this operation.
- Policy notices bind to the account, organization and revision; delayed storage
  reads cannot replace a newer notice or retain another account's notice.
- The actual Worker runtime rejected the session broker's `redirect: 'error'`
  option before contacting Clerk. The backend now uses `manual` and rejects
  redirects without forwarding credentials. A real Worker/browser test reproduced
  the failure and passed after this fix.
- Duplicate Clerk profile reads now share one promise within each backend request.
  Every new request still reloads membership and profile state; no account or
  organization data is cached across requests by this helper.

Clerk still supplies identity, D1 supplies current Business membership and policy,
and ClickHouse receives metadata-only analytics. The four onboarding journeys,
150-seat workspace and member/admin access separation remain covered by tests.
The matching backend and renewal rate-limit bindings are now deployed.
See the backend's `docs/extension-session-hardening.md` for the reviewed rollout,
rate-limit bindings and rollback constraints.

### Final verification

| Check | Result |
| --- | --- |
| Extension unit/component suites | 809 passed, 70 files |
| Backend unit suites | 627 passed; 3 opt-in browser cases run separately |
| TypeScript, both repositories | Passed |
| Chromium regression suite | 29 passed, no retries; 44.7 seconds |
| Local runtime worker exercise | 1,000 completed, zero failures; 1,196.3 ms total; 1,177.6 ms p95 completion; 49 heartbeat ticks |
| Actual Firefox and Chromium backend integrations | 2 passed; 22.33 seconds |
| Simultaneous Firefox and Chromium with actual Worker/D1/PolicyHub | Passed; 21.39 seconds; publication precedes fetch and heartbeat |
| Production Chrome MV3 / Firefox MV2 builds | Both passed |
| Exact final Firefox package smoke test | Passed: background, HttpOnly cookie API, session storage and popup |
| Production Worker dry build | Passed; nothing uploaded |
| ZIP CRC, root manifest and byte comparison | Both passed; 270 files / 237 JS assets per target |
| Production API/security/signature/D1 probes | 10 passed after deployment |
| Production ClickHouse acknowledgement | One synthetic anonymous event accepted (202, accepted: 1) |

The opt-in browser tests use actual backend routes, SQLite and fresh signing keys,
with simulated Clerk and ClickHouse provider boundaries. Chrome uses an isolated
test SDK adapter. Each browser exercises admin revision 7→8, signed delivery,
notice dismissal/reappearance, native paste enforcement, policy receipts,
authenticated telemetry acknowledgement and account-switch cleanup. Firefox also
exercises expired-cookie renewal and authoritative session revocation. These two
tests use the normal refresh message/alarm.

A separate simultaneous-browser test runs the actual production Worker bundle in
workerd with all D1 migrations, SQLite Durable Objects and native rate limits.
Synthetic Clerk tokens pass the real RSA verifier; policies pass the extension's
real signature verifier. With policy polling disabled and no refresh or reconnect,
one admin save from revision 7 to 8 reaches both existing native WebSockets for the
same member. Both popup notices reappear, both distinct installation receipts
advance, and the already-open composer tabs enforce the new rule. An unrelated
organization's live socket receives no publication. Firefox also renews an expired
session through the actual Worker broker. Clerk's remote service and Chrome's SDK
remain isolated test providers; this is local runtime evidence, not a production
account check.

Production assets contain the production API and verification key, with no test
key or fixture API permission. Both requested packages come from the same source:

| Artifact | Unpacked folder | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `dist/final1.zip` | `dist/final1.mv3/` | 3635192 | `bccff449cd849b12e378d5c5721c1c133f990b07ee9c6efc2367eab76fcfa497` |
| `dist/final1.firefox.zip` | `dist/final1.firefox/` | 3570638 | `0e9d5f07bb54ea97b578ecce8ad6434c52acb062e60812f1c504201d9995ea69` |

Both retain version `1.2.0`. `dist/final1-build-info.json` records package metadata.
Real signed-in production Clerk renewal, two live Business seats, deployed WebSocket
delivery, organization-attributed ClickHouse ingestion, AMO/Web Store review and
production capacity testing remain release checks. The production anonymous
telemetry probe confirms one insert acknowledgement; it does not establish those
authenticated journeys. Neither one million downloads nor funding readiness is
established by local test counts or the single-machine worker exercise.

## Initial extension-only pass — 2026-10-04

Source: `feat/v1.2.0-business-onboarding`, local changes based on `20f9690`.
Scope: extension source, tests, documentation and local artifacts. The backend and
website were not changed or deployed. Existing Clerk, Business, quota, telemetry
and signed-policy endpoints remain the integration contract.

### Defects fixed

- YAML and XML redaction now replaces the actual value even when that value also
  occurs in a field name or opening tag. Both sanitize and reversible anonymise
  are covered by transformation regressions.
- File inputs inside open shadow roots are checked before native page handlers
  receive the selection. Replaced selections, drops, resets, consent withdrawal,
  account/policy changes and navigation invalidate pending uploads.
- Session Lock retains elapsed inactivity across routine entitlement renewal;
  changing the idle timeout also preserves time already spent idle.
- A confirmed account mismatch clears the previous organization's policy even
  when refresh fails. An ordinary outage for the same account retains cached rules.
- Paste failures have a visible, dismissible recovery message. Pending paste work
  is bounded and cannot replay after edits, identity/policy changes or navigation.
  AI-service policy is recalculated for each new paste after SPA navigation.
- Standard DLP telemetry now uses a persistent, identity-bound retry queue. Consent
  and fresh credential ownership are checked immediately before delivery. Expired
  or wrong-account events cannot be reassigned to another account.
- Policy connections have bounded token/connection waits and jittered reconnects.
  Sync status reflects the latest request. Persistent polling alarms survive MV3
  restarts and initial wakeups are spread; background refresh cycles are serialized.

### Resource and privacy boundaries

- Pending content-script pastes: eight entries, four million retained characters,
  two million characters per paste, and a 30-second replay age limit. Rejected text
  is discarded; a single text-free notice explains overload.
- Pending file checks: four jobs and 8 MB of supported text-file selections per page.
  Cancellation aborts file reads, worker requests and dialogs.
- Standard DLP queue: 512 events, 512 KiB logical serialized size, 24-hour retention,
  and at most 16 failed transport attempts. Retries use one-shot alarms, exponential
  backoff and jitter. Credential-change cancellation does not spend this attempt budget.
  Before persistence, pending admissions are separately capped at 64 events / 128 KiB,
  so a slow upload cannot retain an unbounded chain of incoming messages.
- Telemetry retains allowlisted metadata, salted fingerprints, canonical detection
  labels and the destination hostname. Raw clipboard/file content, custom labels,
  URL paths and tokens are not persisted in the telemetry queue. Internal owner IDs
  bind delivery locally; the backend derives the organization and actor from auth.
- Delivery accepts only the existing `202 { accepted: <detection count> }` response.
  Stable event IDs survive retries. This does not claim exactly-once backend delivery;
  duplicates remain possible after a lost acknowledgement, and events can expire or
  be evicted during prolonged outages or overload.

### Verification and release limits

| Check | Result |
| --- | --- |
| Final TypeScript check | Passed (`tsc --noEmit`) |
| Final unit/component suites | 789 passed across 69 files |
| Complete deterministic Chromium suite | 29 passed, no retries; 32.6 seconds |
| Final file-guard browser rerun after navigation fix | 8 passed, no retries |
| Local runtime worker exercise | 1,000 completed, zero failures; 561.1 ms total; 553.2 ms p95 completion; 31 heartbeat ticks |
| Chrome MV3 and Firefox MV2 production builds | Both passed |
| Production asset inspection | 237 JS assets per target; production verification key/API present; test key/API absent |
| Changed source/test Biome check | 29 files passed |
| Whitespace validation | `git diff --check` passed |
| Packaged ZIP integrity | Both passed; manifest at archive root |

The complete browser run preceded the final telemetry admission, file-navigation
and same-team account-switch additions. The final unit suite includes all those
changes; the eight file browser checks were rerun against the final rebuilt source.
The 1,000-session timings measure completion from a shared start, using short
known-key pastes on this machine. They are not a per-paste production latency SLA.

Reproduce the checks with `pnpm compile`, `pnpm test`, `HEADLESS=1 pnpm e2e`,
`pnpm build` and `pnpm build:firefox`.

### Local build artifacts

Requested package names, rebuilt from the same working-tree source:

- Chrome: `dist/final1.zip`, unpacked `dist/final1.mv3/` (Manifest V3).
- Firefox: `dist/final1.firefox.zip`, unpacked `dist/final1.firefox/` (Manifest V2).

Both are version 1.2.0 and use the same production API and verification key.
Archive contents were checked byte-for-byte against their unpacked folders.
At the end of this initial pass Firefox still read a session cookie without renewal,
account changes depended on polling, and already-open tabs needed reloading. Those
defects are addressed by the follow-up above. The shared update notice is inside
the extension popup; live production policy/notice delivery remains a release check.

Chrome unpacked: `dist/chrome-mv3/`. Firefox unpacked: `dist/firefox-mv2/`.
These packages contain the local working-tree fixes based on `20f9690`; no commit
or push was performed. Both retain extension version `1.2.0`. The earlier
`dist/final-mv3` folder/ZIP was not replaced.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `dist/secureintent-extension-1.2.0-hardened-chrome-mv3.zip` | 3634937 | `2f466fce33ac21fe6839392fb7a9121c32fe37fcdd485343b882d3ec516089f0` |
| `dist/secureintent-extension-1.2.0-hardened-firefox-mv2.zip` | 3569476 | `0c86293dbe642eae53aa0c3626ea5cb5d4cdade04db223bde5b64e5e37e43eec` |

The browser load check exercises 1,000 short runtime sessions in one Chromium
extension worker host. It does not establish capacity for one million installations,
concurrent cloud traffic, maximum-size documents or every live editor. Real Clerk
sign-in, all four live onboarding journeys, managed seat revocation, deployed D1 /
ClickHouse ingestion, Firefox runtime behavior and production load still require
integration verification. Backend changes were outside this initial pass; the
follow-up above expands that scope and records newer browser evidence.

The file guard covers supported text files through standard inputs and drops in
accessible content-script pages, including open shadow roots. Closed shadow roots,
binary formats, programmatic uploads and browser-restricted pages remain outside
that guarantee. Session Lock remains a walk-away deterrent.

No store submission, production deployment or funding-readiness certification is
implied by these local checks. Test artifacts under `dist-e2e/` are not distributable.

## Historical verification — 2026-09-24

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

This verification predates the local text-file upload guard and does not verify it.
The guard is scoped to supported text files selected through standard file inputs
or dropped onto pages where the content script runs. It does not cover binary files,
programmatic upload paths, arbitrary embedded editors, or browser-restricted pages.
File contents and file-scan results are processed locally and do not generate telemetry.
The v1.2.0 file-guard changes still require their own unit, browser, and Firefox checks.

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
upload. Credentials must contain `sub`; any `org_id` or `o.id` claim must match.
When the token has no organization claim, its user is bound to the signed current
seat and the backend validates the expected organization against D1 membership.
An explicit different organization is rejected. Backend token verification remains
mandatory; local claim decoding is only a binding check.

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
