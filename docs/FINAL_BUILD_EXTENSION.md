# SecureIntent Extension — Final Build Review Document

**Review date:** 25 September 2026  
**Product:** SecureIntent browser extension  
**Chrome Web Store item:** `ejdhcakapnkbmfihgoamdnajgimhemof`  
**Purpose:** Establish what has actually been built, what is published, how data moves through the system, and what must be agreed before the next extension redesign.

This document is an engineering review of the source tree, release artifacts, backend routes, migrations, tests, release notes, and the supplied Chrome Web Store publication screenshot. It is not a substitute for a production smoke test against the deployed services.

> **Baseline note:** This is a v1.1.1 snapshot dated 25 September 2026. The
> `feat/v1.2.0-universal-detector` worktree now has uncommitted structured secret
> detection and local text-file scanning, and local v1.2.0 Chrome/Firefox/source
> candidate ZIPs with checksums. Those packages are not approved for submission, and
> this document does not verify the new behavior or remaining release gates; see
> [`UNIVERSAL_DETECTOR_DEV.md`](./UNIVERSAL_DETECTOR_DEV.md).

## 1. Executive status

- The current source release is **v1.1.1** (`Secureintent-Extension/package.json`, `manifest.json`, tag `v1.1.1`, commit `b49b8bd`).
- The supplied Google email/screenshot confirms **v1.1.1 was successfully published with Public visibility**. A cached public listing and an older release note still showed v1.0.14/pending review; those are stale evidence and should not override the publication email.
- The previous public product line was **v1.0.14**. v1.1.0 was the first Shadow AI Business protection release; v1.1.1 added the Business Shadow AI data-handling disclosure/fix.
- There is **no product release v1.0.15** in the repository history, tags, manifests, package artifacts, or branches. The only exact `1.0.15` source match is the npm dependency `spawn-sync@1.0.15`. The supplied popup screenshot labelled `v1.0.15` is therefore an external/intermediate build and cannot be treated as a reproducible release.
- Standard DLP telemetry is designed to flow to **ClickHouse** through `/v1/telemetry`.
- The current Shadow AI backend source on `origin/demo/shadow-ai-v1` stores `/v1/shadow/events` in a **D1 `shadow_events` table**, not ClickHouse. An older Phase One document describes a future/experimental ClickHouse Shadow schema, but that path is not proven by the current route. This must be resolved before promising a Shadow AI ClickHouse dashboard.
- The extension popup contains a plan/status dashboard. The full organization dashboard is a separate web page (`secureintent.ai/team.html`); it is not embedded in the popup.

## 2. Evidence and artifact inventory

| Item | Observed state |
|---|---|
| Extension repository | `Secureintent-Extension`, branch `shadow-ai-features`, tag `v1.1.1`, commit `b49b8bd` |
| Previous public baseline | `origin/main`/commit `f6a81fa`, v1.0.14 |
| Current Chrome production bundle | `Secureintent-Extension/dist/chrome-mv3`, manifest version 1.1.1 |
| Firefox build target | Firefox manifest/build target exists; verify the exact submitted store version separately |
| ZIP artifacts | `dist/secureintent-extension-1.1.0-chrome.zip`, `dist/secureintent-extension-1.1.1-chrome.zip` |
| E2E bundle | `dist-e2e/chrome-mv3`, version 1.1.1; public test key/auth-disabled configuration—never distribute as production |
| Legacy bundles | `dist-shadow/*`, `testk/`, and `chrome-mv3-dev` contain 1.0.14-era artifacts |
| Publication evidence | Supplied Google Web Store email/screenshot: v1.1.1, Public, successfully published |
| Screenshot evidence | `Screenshot/WhatsApp Image 2026-09-24 at 9.53.31 PM.jpeg` shows a popup labelled v1.0.15; this is not reproducible in source history |
| Release note caveat | `kaushikupdate.md` was written before the publication confirmation and still describes v1.1.1 as pending |

The production ZIP, production manifest, source commit, and store item must be pinned to the same version before every future submission. Old local ZIPs and test folders should be archived clearly to avoid accidental upload.

## 3. Release history and feature progression

| Release | Evidence | Main changes |
|---|---|---|
| Initial public line (v1.0.3) | commit `a194d34` | Initial paste DLP, supported AI destinations, warning flow |
| v1.0.4 | commit `eeddaf8` | Session lock, anonymise round-trip, fallback guard, additional sites |
| v1.0.6 | tag `301a4ad` | Clerk authentication, plan-gated Pro, production switching, usage carryover |
| v1.0.6 follow-up | commit `3a5e5c7` | Popup redesign, plan checklist/tooltips, consent flow, Ghost title, Grok selector fix |
| v1.0.11 | commits around `2ca085f` | Team-policy sync, rule badges, Firefox support, consent gate, install/uninstall reporting, popup fixes |
| v1.0.12 | commit `29f1f6e` | Desktop bridge and complimentary teams |
| v1.0.13 | commit `e111529` | High-entropy secret type |
| v1.0.14 | tag/commit `f6a81fa` | Paste path no longer freezes the tab; reliability hardening followed in `fix/large-paste-freeze` |
| v1.1.0 | tag `a3b1176` | Business Shadow AI catalog, visits, paste-volume and sensitive-paste events |
| v1.1.1 | tag/commit `b49b8bd` | Business Shadow AI data-handling disclosure and release polish |

### v1.0.14 baseline

v1.0.14 is the last pre-Shadow public baseline. It already had the core DLP, anonymisation, Pro toolkit, Session Lock, team policy plumbing, signed configuration, and paste reliability work. It did not include the current Shadow AI metadata flow.

### v1.1.0/v1.1.1 additions

The v1.1 line adds Business-only Shadow AI metadata collection with an explicit consent/disclosure flow, recognized AI-service catalog, page-visit telemetry, paste-volume metadata, and sensitive-paste metadata. v1.1.1 clarifies the data handling in the popup/release flow; it does not turn raw prompt or secret collection into a feature.

## 4. Current v1.1.1 functionality

### 4.1 Core DLP flow

1. A paste event is intercepted during the capture phase on supported AI and developer sites. A fallback listener handles common text inputs on unlisted sites.
2. The extension sends the pasted string to a dedicated worker/offscreen scanner. The page thread does not run the expensive scan.
3. The detector returns findings. The extension resolves overlaps and applies the signed global/team policy.
4. The user sees the warning UI and can cancel, paste anyway (unless policy blocks it), or anonymise and paste.
5. A privacy-preserving telemetry event is queued/sent. The raw paste, prompt, secret value, complete URL, query string, and file contents are not sent.

### 4.2 Detection catalog

The checked-in catalog (`src/lib/detection/patterns.ts`) covers, among others:

- PEM private keys;
- Anthropic, OpenAI, AWS access-key IDs and secret access keys;
- GitHub tokens/PATs, GitLab, npm, Google, Stripe, Slack and Slack webhooks;
- JWTs, Hugging Face, Perplexity, OpenRouter, Groq, xAI, SendGrid and Twilio;
- Discord, Dropbox, Notion, Firebase, Google OAuth refresh tokens and Azure connection strings;
- credential-assignment context;
- Luhn-validated credit-card numbers;
- high-entropy hexadecimal/base64 values.

Team policy can add signed custom patterns. The catalog is primarily regex/context driven, with entropy and checksum logic. It is not a universal semantic secret detector; a previously unknown token format can still evade it. That limitation is the main reason for the proposed vNext detector redesign.

### 4.3 Supported destinations

The documented first-class destinations include ChatGPT, Claude, Gemini, Perplexity, Microsoft Copilot, GitHub Copilot, Grok, Mistral, Meta AI, Poe, v0, Bolt, Lovable, Replit, DeepSeek, DuckDuckGo AI, Kimi, Qwen and Reddit. A generic input fallback provides some coverage elsewhere, but it is not equivalent to a site-specific adapter.

### 4.4 Anonymise & Paste / Rehydrate

- The extension replaces detected values with reversible placeholders such as `⟦SI:a1b2c3d4⟧`.
- The original-to-placeholder mapping stays in `browser.storage.session`, is bound to the origin, expires after approximately one hour, and is cleared when the browser session closes.
- Pro users can rehydrate later on the same origin. Free users receive the configured monthly quota; Developer Pro is unlimited.
- The mapping is never uploaded as telemetry.

### 4.5 Ghost Log Sanitiser

- Intended for large logs (current threshold: 2,000 characters).
- Removes or replaces secrets, email addresses, and IPv4 addresses with irreversible placeholders such as `[#SECRET_1#]`, `[#EMAIL_1#]`, and `[#IP_1#]`.
- The action is exposed as “Sanitize & paste” and is Developer Pro/Business Pro functionality.
- It is intentionally irreversible; it is not the same as anonymise-and-rehydrate.

### 4.6 Session Lock

Session Lock can lock high-risk cloud consoles after inactivity or tab-away. Current adapters cover AWS, GCP/Firebase, Azure, Cloudflare, DigitalOcean, Heroku, Netlify, Render, Linode, Oracle, IBM and Supabase. The team policy can require Session Lock.

### 4.7 Popup and account surfaces

The extension popup shows:

- sign-in state and current plan;
- detection status and free quota/usage;
- Developer Pro toolkit status;
- Business Pro toolkit status;
- organization/seat state and active team rules;
- links to `https://secureintent.ai/account.html` and, for organization admins, `https://secureintent.ai/team.html`.

The popup is a compact status/control surface, not the complete team dashboard. The web team dashboard provides organization views for people, policy, billing, metrics and alert settings.

## 5. Plan, entitlement and business model

### Free / Developer

- Paste detection and warnings.
- Signed global policy and normal privacy-preserving telemetry.
- Monthly anonymise quota.
- Pro and Business rows are displayed as locked until entitled.

### Developer Pro

- Everything in Free.
- Unlimited anonymise-and-paste.
- Rehydrate Vault.
- Ghost Log Sanitiser.
- Session Lock.

### Business Pro

- Everything in Developer Pro.
- Organization seat and team policy sync.
- Security-Team Alerts.
- Shadow AI metadata collection, only after Business disclosure/consent.

The client receives a signed entitlement blob from `/v1/entitlement`. The backend verifies the Clerk token, hydrates organization claims, resolves Paddle/personal billing, lifetime grants and organization seats, and signs the result with Ed25519. Organization entitlements are cached for about four hours; personal entitlements for about 24 hours. The client verifies signature, expiry, and user binding; invalid data falls back to Free.

Known entitlement sources are `manual`, `lifetime`, `org_seat`, `paddle`, `business_email`, and `none`.

### Promotion issue requiring a decision

The checked-in promo configuration still has `PROMO_PLAN: developer_pro` and `PROMO_TEAM_SEATS: 150`. The older release note says a `?offer=business` flow was intended to issue lifetime Business Pro, but also records that the website did not send the expected offer and granted Developer Pro instead. This must be retested end-to-end before the next release; do not promise lifetime Business Pro from the current source without a verified production response.

## 6. Business/team operation

### Source of truth

Clerk organization membership is the source of truth for membership. Billing/seat state is resolved from Paddle plus D1 organization entitlement records. Complimentary/lifetime teams use a `comp` grant, are active without an expiry, and currently support a maximum of 150 seats (minimum one).

### Admin capabilities

An organization administrator can:

- invite, revoke, remove and view members;
- view seat usage and team status;
- start checkout, open the Paddle portal and reconcile billing;
- set team name and policy;
- configure alert routing and settings;
- view/export team metrics.

Regular members receive team coverage/status but not roster, billing or administrative metrics.

### Signed team policy

The policy fields include:

- `blockInsteadOfWarn`;
- `requireSessionLock`;
- `extraPatterns` and `replaceDefaultPatterns`;
- `blockedSites`;
- AI-service classifications (`sanctioned`, `recognized`, `review`) and `pasteBlocked`.

The backend validates and sanitizes up to 25 extra patterns, 50 blocked sites and 18 AI-service entries, then signs the merged configuration. The extension verifies the Ed25519 signature before applying it, caches it for offline operation, and falls back to the default/free bundle if the signature or expiry is invalid. A policy can remove “Paste anyway,” block a destination, and force Session Lock. The policy version is tracked separately from the global configuration version.

The configuration refresh scheduler checks active policy approximately every two hours. A kill switch and offline-safe default bundle are included in the signed configuration.

### Security-Team Alerts

Teams can configure Slack, Microsoft Teams or HTTPS webhook routing and thresholds by detection type. `/v1/telemetry` calls the alert handler asynchronously with throttling. Alert payloads must remain metadata-only; raw secrets must never be added to alert bodies.

## 7. Architecture and data flow

### Extension runtime

```text
Browser paste
   -> capture listener/site adapter
   -> worker/offscreen scanner
   -> overlap resolution + signed global/team policy
   -> warning / block / anonymise / sanitise
   -> local queue and privacy-preserving telemetry
```

The worker/offscreen protocol is defined in `src/lib/paste/protocol.ts`. Page code is responsible for insertion and user interaction; scanning, hashing and transformations are isolated from the page thread.

### Configuration flow

```text
Extension -> GET /v1/config -> verify Ed25519 signature -> cache bundle
                                   |
                                   +-- global detector catalog
                                   +-- supported sites
                                   +-- kill switch
                                   +-- organization policy
```

Invalid, expired or unverifiable configuration is not trusted. The client uses the safe default/free bundle instead.

### Reliability limits and fail-closed behavior

The current hardening implementation includes:

- maximum paste size: 2,000,000 characters;
- maximum preview findings: 100;
- worker operation watchdog: about five seconds;
- client deadline: about ten seconds;
- up to four workers, 1,000 retained sessions, 64 MiB retained budget;
- queue wait of about 30 seconds and idle expiry of about 120 seconds;
- 24-hour Shadow queue TTL and 5,000 queued Shadow events.

On timeout, overload or worker error, the paste remains blocked/dismissible and is not silently reinserted unchecked. This is safer but can feel like a freeze to the user. The current code still cannot guarantee perfect behavior on every arbitrary website; site-specific DOM insertion can stall independently of scanning.

Remote custom regexes are limited in length/count and basic nested-quantifier checks exist, but arbitrary JavaScript regular expressions remain a risk area. A vNext engine should use bounded execution or a safer pattern representation.

## 8. Telemetry: standard DLP path to ClickHouse

This is the verified design for ordinary DLP events.

### 8.1 Client event construction

`src/services/telemetryService.ts` creates an event with fields such as:

- event ID, timestamp and site;
- signed policy version;
- detection type/label and action;
- plan, source and signed-in state;
- business domain, organization ID and pseudonymous actor ID when applicable;
- browser/client metadata;
- salted SHA-256 fingerprint of the detected value.

The fingerprint is for deduplication/analytics. It is not the secret value and cannot be reversed into the original text by the service.

### 8.2 API route

The extension client posts to `POST /v1/telemetry`. The deployed backend route (`secureintent-backend-v2/src/routes/telemetry.ts`; the original `secureintent-backend` has the equivalent route) parses and validates the event, maps detections to rows, and returns HTTP 202. ClickHouse insertion and alert evaluation are scheduled through the Worker `waitUntil` mechanism so the request does not wait for the full analytics write.

### 8.3 ClickHouse table and transport

The standard event table is a MergeTree table named `events` in database `secureintent`, with columns equivalent to:

```text
ts, event_id, site, policy_version, fingerprint,
secret_type, label, action, plan, source, signed_in,
business_domain, client, browser, org_id, actor_id
```

Rows are ordered by `(org_id, ts, site)`. The Worker uses ClickHouse Cloud HTTP Basic authentication (`CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`) and JSONEachRow with asynchronous insert/wait-for-async-insert settings. The client retries up to three times with approximately 0/2/5-second backoff and can self-heal additive schema changes. Credentials are Worker secrets and must never be put in the extension bundle or this document.

### 8.4 Lifecycle telemetry

Install/uninstall attribution is separate from DLP events and is written to an `extension_lifecycle` ReplacingMergeTree keyed by event type and install ID. It contains version/browser/OS/campaign-style metadata, not pasted content.

### 8.5 Privacy boundary

The standard event path must not contain raw paste text, prompts, secret values, complete URLs, paths, query strings, file contents or incognito data. Reviewers should treat any new telemetry field as a privacy/security change requiring explicit sign-off.

## 9. Shadow AI telemetry: current implementation versus intended reporting

This distinction is the most important item in this review.

### 9.1 Client eligibility and event types

`src/lib/shadow/visits.ts` sends Shadow metadata only when all of the following are true:

- plan is Business Pro;
- a valid `org_...` organization is present;
- the user has accepted the disclosure/consent;
- the page is a recognized top-level HTTPS AI service;
- the page is not incognito, a frame, an extension port, or a user/password form.

The client creates:

- `ai_page_visit`: hostname, service ID, catalog version, timestamp and event ID;
- `ai_paste_volume`: the same metadata plus UTF-8 byte size;
- `ai_sensitive_paste`: paste event ID, detection type, reason, action (`blocked`, `cancelled`, `sanitised`, or `warning_bypassed`) and finding count.

The queue is local `browser.storage.local`, de-duplicates event IDs, is limited to 5,000 items/24 hours, uploads at most 25 events per batch, and retries through a one-minute alarm with an approximately eight-second request timeout. Sign-out, organization change or consent withdrawal clears the queue.

### 9.2 Current backend source

The current v2 route is `secureintent-backend-v2/src/routes/shadow.ts` with validation in `src/lib/shadowEvents.ts`. It:

1. verifies the Clerk Bearer token;
2. requires an organization and active paid/comp Business entitlement;
3. accepts batches of 1–25 events;
4. validates UUIDs, hostnames, catalog versions, timestamps, byte sizes, action/detection allowlists and finding limits;
5. stores bounded records through `insertShadowEvents` in the D1 `shadow_events` table (`migrations/0019_shadow_events.sql`);
6. returns the accepted event IDs with HTTP 202.

**Conclusion from source inspection:** the current route does **not** call ClickHouse. It writes to D1. The D1 binding/deployment target must also be verified because the current Worker configuration already uses D1 for waitlist data.

### 9.3 Historical/experimental ClickHouse contract

`PHASE_ONE_EXTENSION_DEVELOPMENT.md` and related backend test/design files describe a proposed `shadow_ai_events` ClickHouse schema and reporting queries for visits, trends, discovered tools and a DLP ledger. That is a design/phase artifact, not proof that production Shadow events currently reach ClickHouse. The release notes themselves identify the real Business event-to-ClickHouse test as pending.

### 9.4 Dashboard implication

The team metrics route (`/v1/team/metrics`) currently queries the standard ClickHouse `events` table for counts by day/type/site/action and distinct actors. It does not, from the checked source, query D1 `shadow_events` for Shadow page visits or paste-volume data. Therefore the current web dashboard can show standard DLP telemetry while Shadow-specific metrics remain absent or incomplete until a reporting path is deliberately implemented.

Before advertising a “Shadow AI dashboard,” choose and document one canonical design:

1. **D1 reporting path:** query/aggregate `shadow_events` with retention and access controls; or
2. **ClickHouse path:** add a validated Shadow ingestion table and route, then update metrics queries and retention/deletion procedures.

Do not silently dual-write sensitive metadata until cost, retention, deletion and privacy reviews are complete.

## 10. Security and cryptography review

- Configuration and entitlement payloads are signed with Ed25519 and verified on the client.
- Entitlement responses are bound to the authenticated Clerk user and expire.
- Secret fingerprints use salted SHA-256; salt/key handling must remain backend-controlled.
- Rehydration mappings are origin-bound, session-local and time-limited.
- Raw values are intentionally absent from standard and Shadow telemetry.
- Team policy is server-validated and signed before it reaches the extension.
- Clerk authentication protects entitlement, team and Shadow routes; Business org entitlement is rechecked server-side.
- The extension must not ship ClickHouse credentials, Clerk secrets, policy signing keys or webhook secrets.

Recommended next hardening items are key rotation/runbooks, replay protection for signed bundles, strict regex execution limits, CSP/dependency review, webhook secret rotation, and an explicit retention/deletion policy for both D1 and ClickHouse.

## 11. Testing and verification status

The hardening notes report:

- 643 unit/integration tests and 21 deterministic E2E scenarios at the latest checkpoint;
- production Chrome/Firefox build checks;
- a local 1,000-concurrent-session stress run with zero reported failures, approximately 462 ms total and 456.4 ms p95 in that run;
- earlier paste-reliability documentation with 548 tests at an intermediate checkpoint.

These are valuable regression signals, not a production SLA. The following were not fully proven by the local audit:

- Firefox live authenticated Business backend flow;
- real deployed Business Shadow event through the final reporting store;
- interoperability with the desktop bridge in every supported release;
- every arbitrary website’s DOM insertion path;
- the corrected lifetime Business promo behavior;
- store propagation/cache state after the v1.1.1 publication email.

## 12. Known gaps and release blockers for a new build

1. **Shadow storage ambiguity:** decide D1 versus ClickHouse and implement/verify one canonical reporting path.
2. **Dashboard truthfulness:** align team metrics with the actual Shadow store before showing Shadow counts to administrators.
3. **Version hygiene:** remove or clearly quarantine v1.0.14/test artifacts and make the build pipeline produce one versioned ZIP.
4. **v1.0.15 confusion:** do not use the screenshot label as a release identifier; issue a reproducible tag if that build must be retained.
5. **Promo entitlement:** retest the `offer=business` flow against deployed backend and verify plan, seat count, expiry and source.
6. **Detector coverage:** regex-only recognition will miss unknown API-key formats and can be expensive for adversarial input.
7. **Custom regex safety:** replace unbounded JavaScript regex execution with a constrained engine/DSL or strict worker isolation and time budgets.
8. **Privacy operations:** define retention, deletion/export, tenant isolation and incident response for every telemetry store.
9. **Store release controls:** verify manifest permissions, host permissions, privacy disclosure, source-map handling and the exact ZIP before upload.

## 13. Recommended vNext detector methodology

The next extension should keep the current fail-closed worker architecture but make recognition layered:

1. **Cheap lexical prefilter:** identify candidate spans without scanning or hashing the entire page repeatedly.
2. **Bounded structural parsers:** parse known token families and credential assignment contexts with finite-state or bounded parsers.
3. **Entropy/checksum layer:** score unknown high-entropy strings and apply Luhn/format checks where appropriate.
4. **Context and destination signals:** use nearby words, code fences, environment-variable names and the target application to reduce false positives.
5. **Signed policy layer:** apply organization allow/block lists and custom detectors after the local candidate pipeline.
6. **Explainable finding:** return type, confidence, evidence category and safe redaction span—not the raw value—to the UI/telemetry.
7. **Resource controls:** cap bytes, findings, CPU time and memory per paste; cancel stale jobs; never reinsert an unchecked paste.
8. **Corpus/evaluation gate:** maintain a versioned positive/negative corpus, regression tests, adversarial regex tests and per-detector precision/recall thresholds.

This gives broader unknown-API coverage without making a remote model or unbounded regex the security boundary. Any ML/heuristic layer should be advisory to a deterministic, bounded enforcement layer until it is independently evaluated.

## 14. Sunday submission estimate

Assuming “Sunday” means the next Sunday, 27 September 2026:

### If only packaging the already-built v1.1.1

- Version/manifest/ZIP verification: 2–4 hours.
- Privacy/permissions/store listing check and smoke test: 2–4 hours.
- Submission: same day if all evidence is ready.

### If implementing the requested reliability redesign

- Minimum safe hardening with the existing detector architecture: about **3 engineering days**.
- Regression, adversarial tests, cross-browser checks, packaging and release review: about **2 additional working days**.
- A new universal detector methodology with corpus tuning and production telemetry review: realistically **1–2 weeks for a first production candidate**, followed by continued tuning. It should not be promised as fully reliable in three calendar days.

Therefore, a Sunday submission is realistic only for a frozen, already-tested change. If development starts now and includes the new detection engine, plan the five-working-day best-case engineering/QA window first, then submit. The earlier requested “three days development plus two days validation” is a reasonable best-case hardening estimate, not a guarantee for a new detector architecture.

### Google Web Store review time

After submission, Google controls the review queue. The project notes say most reviews complete within a few days, but some can take several weeks. For planning, reserve **1–7 days as a normal working estimate and several weeks as the contingency**, with no guaranteed approval date. Publication is automatic after approval if the release is configured for automatic publishing.

## 15. Review sign-off checklist

Before starting the next build, the owner/CTO/CEO should explicitly sign off on:

- [ ] v1.1.1 is the intended production baseline.
- [ ] The v1.0.15 screenshot is classified as an intermediate/untracked build.
- [ ] Shadow events will be stored/reported from D1, ClickHouse, or an explicitly approved dual path.
- [ ] The team dashboard’s Shadow metrics are truthful for the chosen store.
- [ ] Business Pro entitlement and the lifetime promo behavior are verified in production.
- [ ] Telemetry fields, retention, deletion and tenant isolation are approved.
- [ ] The new detector’s coverage, false-positive target and resource limits are agreed.
- [ ] Sunday submission means a package-only release or a full redesigned build.
- [ ] A reproducible tag, ZIP checksum and rollback version are recorded.

## 16. Useful source references

- Extension overview and supported sites: `README.md`
- Popup plan/toolkit: `src/entrypoints/popup/planFeatures.ts`, `src/entrypoints/popup/PlanCard.tsx`
- Entitlements: `src/lib/entitlement/`
- Detection catalog: `src/lib/detection/patterns.ts`
- Paste worker/protocol: `src/lib/paste/`, `src/entrypoints/`
- Shadow client: `src/lib/shadow/visits.ts`, `src/lib/shadow/api.ts`, `src/services/shadowBackground.ts`
- Reliability: `docs/PASTE-RELIABILITY.md`, `docs/hardening.md`
- Standard telemetry API: `secureintent-backend/src/routes/telemetry.ts`
- ClickHouse writer/schema: `secureintent-backend/src/lib/clickhouse.ts`
- Shadow API: `secureintent-backend-v2/src/routes/shadow.ts`, `src/lib/shadowEvents.ts`
- Shadow D1 migration: `secureintent-backend-v2/migrations/0019_shadow_events.sql`
- Team metrics: `secureintent-backend-v2/src/lib/teamMetrics.ts`
- Team policy/config: `secureintent-backend-v2/src/lib/orgPolicy.ts`, `src/lib/configBundle.ts`, `src/routes/config.ts`
- Release notes and deployment caveats: `kaushikupdate.md`

**Recommended decision:** approve this document as the baseline review, resolve the Shadow D1/ClickHouse decision and promo behavior first, then build the detector/reliability changes behind a reproducible v1.2.x or v2.0.0 tag with a separate migration and rollback plan.
