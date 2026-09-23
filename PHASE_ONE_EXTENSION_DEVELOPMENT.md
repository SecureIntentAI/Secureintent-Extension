# Phase One Extension Development — Shadow AI Discovery V1

- **Status:** Discovery now runs in the production extension on `shadow-ai-features` for a real Business organisation. The local harness and synthetic seat described later in this record have been removed.
- **Recorded:** 10 September 2026
- **Last updated:** 23 September 2026
- **Integration branch:** `shadow-ai-features`
- **Production status:** Not merged into `main` and not submitted to a browser store. The API route is in `secureintent-backend-v2` and still needs a deploy.

## 1. Purpose

Phase One delivers a non-production implementation of Shadow AI Discovery using
the existing SecureIntent extension, secret-detection engine, worker-based paste
processing, team-policy concepts, backend pipeline, and Business dashboard
design language.

The implementation demonstrates the complete V1 flow locally without using
customer accounts, customer telemetry, production ClickHouse, the live Business
dashboard, or production extension configuration.

### Current checkpoint

- The extension, local backend, and local Business dashboard are integrated on
  `demo/shadow-ai-v1` in their respective repositories.
- All Shadow feature branches and all three demo branches have been published to
  the organisation GitHub repositories.
- The backend and extension were started locally, and the complete local demo
  flow was manually confirmed working on 10 September 2026.
- Automated unit, contract, build, browser, privacy, and API validation has been
  completed as recorded in Section 16.
- No `main` branch, production service, production database, customer account,
  or browser-store package was changed.

## 2. Confirmed V1 scope

Phase One contains these seven feature groups:

1. Versioned AI service catalog and hostname recognition.
2. Recognised AI-domain visit telemetry.
3. Text-paste attempt and UTF-8 byte-volume telemetry, including clean pastes.
4. Sensitive-event metadata with a detection reason and final outcome.
5. Organisation-scoped backend ingestion, storage, aggregation, and reporting.
6. Business dashboard cards, trends, discovered-tools table, and DLP ledger.
7. Organisation-specific sanctioned/review classifications and paste-prevention
   policy actions.

## 3. AI service catalog

The catalog contains 18 services and is designed to be expanded through its
versioned JSON source.

| Category | Service | Recognised hostname(s) | Recognition rule |
| --- | --- | --- | --- |
| General | ChatGPT | `chatgpt.com`, `chat.openai.com` | Exact hostname |
| General | Claude | `claude.ai` | Exact hostname |
| General | Gemini | `gemini.google.com` | Exact hostname |
| General | Microsoft Copilot | `copilot.microsoft.com` | Exact hostname |
| General | Perplexity | `perplexity.ai`, `www.perplexity.ai` | Exact hostname |
| General | Grok | `grok.com` | Exact hostname |
| General | Mistral Le Chat | `chat.mistral.ai` | Exact hostname |
| General | Meta AI | `meta.ai`, `www.meta.ai` | Exact hostname |
| General | Poe | `poe.com` | Exact hostname |
| General | Character.AI | `character.ai` | Exact hostname |
| General | DeepSeek | `chat.deepseek.com` | Exact hostname |
| Developer | Google AI Studio | `aistudio.google.com` | Exact hostname |
| Developer | GitHub Copilot | `github.com` | Only `/copilot` and `/copilot/*` |
| Developer | Cursor | `cursor.com`, `www.cursor.com` | Exact hostname |
| Developer | Replit | `replit.com` | Exact hostname |
| Developer | Lovable | `lovable.dev` | Exact hostname |
| Developer | Bolt | `bolt.new` | Exact hostname |
| Developer | v0 | `v0.dev`, `v0.app` | Exact hostname |

The catalog deliberately avoids wildcard subdomains and `<all_urls>`. Ordinary
GitHub activity is not counted as GitHub Copilot usage. The GitHub path is
inspected transiently on-device and is never stored or transmitted.

Source files:

- `src/lib/shadow/catalog.json`
- `src/lib/shadow/catalog.ts`
- `src/lib/shadow/catalog.test.ts`

## 4. Organisation-specific classification

Classification belongs to the organisation, not permanently to the provider:

- **Tier 1 — Sanctioned:** approved by the organisation.
- **Tier 2 — Recognised AI:** known AI service that has not been sanctioned.
- **Tier 3 — Review / Higher Risk:** requires additional organisational review.

Every catalog service defaults to Tier 2 until an organisation-specific policy
changes it. The dashboard can mark a tool as sanctioned, return it to recognised,
or flag it for review.

## 5. Visit telemetry

One `ai_page_visit` event is created for each recognised top-level document load
after explicit local consent.

Focus events, paste events, same-document history changes, unrecognised domains,
lookalikes, incognito tabs, and child frames do not create visits. Reloading a
recognised page creates a new visit.

The event contains only:

- schema version;
- random event ID;
- event timestamp;
- normalised hostname;
- catalog service ID;
- catalog version.

It does not contain the URL, path, query, fragment, page title, page content,
prompt, user identity, Seat ID, or organisation ID.

## 6. Paste-volume telemetry

Every recognised text-paste attempt with text is measured before the local DLP
decision. This includes clean pastes where no sensitive information is detected.

An `ai_paste_volume` event contains:

- the standard hostname-only destination metadata;
- a random paste event ID;
- the number of UTF-8 bytes attempted.

The actual pasted text is never placed in the event, extension telemetry queue,
backend request, backend database, dashboard response, or log.

The dashboard wording consistently describes these figures as **paste attempts**
and **attempted volume**, not confirmed submission.

## 7. Sensitive-event reporting

When the local scanner identifies sensitive material, the extension can record
an `ai_sensitive_paste` metadata event containing:

- hostname and catalog service ID;
- pseudonymous paste/event correlation IDs;
- detection type;
- approved detection reason/label;
- finding count;
- final outcome.

Supported outcomes are:

- `blocked` — organisation policy prevented insertion;
- `cancelled` — the user cancelled the paste;
- `sanitised` — sensitive values were replaced before insertion;
- `warning_bypassed` — the user chose to paste the original text.

The warning supports Cancel, Sanitise & paste, and Paste anyway. Pressing Escape
cancels the paste. The secret values and pasted text remain on-device.

## 8. Paste processing and reliability

Phase One reuses the dedicated worker architecture from the large-paste
reliability work:

- Chrome uses an offscreen extension document to host workers.
- Firefox uses the background context.
- Scanning and sanitisation execute outside the page's main thread.
- Paste processing is cancellable and bounded.
- A scan failure after interception stops the paste safely.
- Oversized pastes are stopped rather than processed without limits.

Shadow-specific worker entry points:

- `src/testing/entrypoints/paste-worker.ts`
- `src/testing/entrypoints/paste-offscreen/index.html`
- `src/testing/entrypoints/paste-offscreen/main.ts`

## 9. Policy behavior

The dashboard actions are intentionally worded as:

- **Mark as sanctioned**;
- **Needs review**;
- **Prevent pasting**;
- **Allow pasting**.

“Prevent pasting” stops paste insertion through the extension policy mechanism.
It does not block navigation to or use of the entire website.

The policy API advertises `refreshAfterSeconds: 300`. The local background checks
the backend on a one-minute alarm, and active content scripts check the refreshed
extension cache every five seconds. Online, active local extensions therefore
normally receive updates sooner than the five-minute V1 target, without claiming
guaranteed real-time delivery.

## 10. Extension state, retry, and retention

The extension stores the local test state in `browser.storage.local` under
`si_shadow_test_state_v1`.

Behavior:

- maximum queue size: 500 metadata events;
- queue lifetime: 24 hours;
- backend upload batch size: 25 events;
- acknowledged uploads are removed by event ID;
- repeated events are idempotent;
- expired events are discarded and counted;
- temporary backend failures retain events for retry;
- disabling collection clears the pending extension state;
- an expired or unauthorised synthetic session disables collection.

No pasted content is stored in this queue.

Core files:

- `src/lib/shadow/visits.ts`
- `src/lib/shadow/test-api.ts`
- `src/testing/entrypoints/background.ts`
- `src/testing/entrypoints/shadow.content.ts`
- `src/testing/ShadowTestPopup.tsx`
- `wxt.shadow.config.ts`

## 11. Local backend implementation

Repository: `secureintent-backend`

The functional local backend is fixed to `http://127.0.0.1:8791` and uses an
isolated D1 database. It provides:

- expiring synthetic Business member and admin sessions;
- pseudonymous `Seat N` labels;
- strict event validation;
- visit, paste-volume, and sensitive-event ingestion;
- idempotent event storage;
- organisation-scoped aggregation;
- summary, trend, discovered-tool, and ledger responses;
- admin-only classification and paste-policy updates;
- tenant isolation;
- bounded synthetic-session storage for repeatable tests.

Important backend files:

- `testing/shadow/worker.ts`
- `testing/shadow/validation.ts`
- `testing/shadow/migrations/0001_visits.sql`
- `testing/shadow/migrations/0002_discovery_v1.sql`
- `scripts/check-shadow-reporting.mjs`

## 12. ClickHouse reporting contract

The required production ClickHouse contract is prepared and versioned, but it has
not been applied.

It includes:

- a tenant-first, deduplicating `shadow_ai_events` table;
- page-visit, paste-volume, and sensitive-event rows;
- opaque pseudonymous seat identifiers;
- fixed summary aggregation;
- daily trend aggregation;
- discovered-tool aggregation;
- paginated DLP ledger query;
- typed ClickHouse query parameters.

The schema contains no columns for pasted text, prompts, secret values, email
addresses, complete URLs, paths, or query strings. A production retention TTL is
deliberately omitted until the retention period is approved.

Files:

- `secureintent-backend/testing/shadow/clickhouse/0001_shadow_ai_v1.sql`
- `secureintent-backend/testing/shadow/clickhouse/dashboard_queries.sql`
- `secureintent-backend/testing/shadow/clickhouse/README.md`
- `secureintent-backend/scripts/check-shadow-clickhouse.mjs`

## 13. Business dashboard

Repository: `secureintent.ai`

The local dashboard is `shadow.html` on the `demo/shadow-ai-v1` branch. It reuses
the established Business console colors, cards, panels, typography, tables,
controls, responsive layout, and status language.

Implemented UI:

- discovered-tools card;
- recognised-visits card;
- unsanctioned-usage percentage based on recognised visits;
- paste-attempt count;
- attempted paste-volume card;
- sensitive-event and higher-risk count;
- daily visit/paste/sensitive-event trend;
- discovered-tools table;
- organisation-specific policy actions;
- paginated DLP event ledger;
- pseudonymous Seat IDs by default;
- explicit V1 metric and blocklist definitions;
- responsive mobile layout.

Dashboard files:

- `secureintent.ai/shadow.html`
- `secureintent.ai/test/shadow-dashboard.check.js`

## 14. Privacy guardrails

Phase One enforces the following rules:

- hostname-only destination reporting;
- no pasted text or prompt content transmitted;
- no secret values transmitted or stored;
- no URL paths, queries, or fragments transmitted;
- no email addresses in Shadow telemetry or dashboard responses;
- pseudonymous Seat IDs displayed by default;
- the backend derives organisation and seat context from the authenticated
  session rather than accepting it from event bodies;
- unsupported fields cause event rejection;
- dashboard and extension endpoints are restricted to the local test origin;
- incognito/private browsing telemetry is excluded.

Future email integration remains outside Phase One.

## 15. Published branch record

The branch heads below identify the completed feature checkpoints. Integration
branches can receive later documentation-only commits, so developers should
always fetch and use the latest `origin/demo/shadow-ai-v1` tip.

### Extension repository

| Branch | Head | Responsibility |
| --- | --- | --- |
| `feat/shadow-catalog` | `6f3f205` | Catalog and recognition |
| `feat/shadow-visits` | `3097ee7` | Visit telemetry |
| `feat/shadow-paste-volume` | `7059634` | Paste volume and telemetry foundation |
| `feat/shadow-sensitive-events` | `730b4b5` | Sensitive outcomes and privacy E2E |
| `feat/shadow-policy-actions` | `9e6acfd` | Refresh and paste-policy enforcement |
| `demo/shadow-ai-v1` | `4bb0c66`* | Integrated extension demo and handoff |

### Backend repository

| Branch | Head | Responsibility |
| --- | --- | --- |
| `feat/shadow-catalog` | `4550a40` | Backend catalog snapshot |
| `feat/shadow-visits` | `59f0737` | Local visit ingestion |
| `feat/shadow-paste-volume` | `413b920` | Paste/DLP ingestion foundation |
| `feat/shadow-sensitive-events` | `9c8fffa` | Sensitive-event outcome validation |
| `feat/shadow-backend-reporting` | `278f303` | Reporting API and ClickHouse contract |
| `feat/shadow-policy-actions` | `b3975a1` | Organisation policy validation/integration |
| `demo/shadow-ai-v1` | `1141d77` | Integrated backend demo at completion time |

### Dashboard repository

| Branch | Head | Responsibility |
| --- | --- | --- |
| `feat/shadow-dashboard` | `7120a05` | Dashboard and browser checks |
| `feat/shadow-policy-actions` | `7db06fe` | Explicit policy actions |
| `demo/shadow-ai-v1` | `7db06fe` | Integrated dashboard demo |

\* Extension demo checkpoint before this documentation update.

Published repositories:

- Extension: <https://github.com/Secureintent-Admin/Secureintent-Extension>
- Backend: <https://github.com/SecureIntentAI/secureintent-backend>
- Dashboard: <https://github.com/SecureIntentAI/secureintent.ai>

All branches in the tables are now available from `origin`. At the publication
checkpoint, the remote `main` references remained unchanged:

- Extension: `f6a81fa`
- Backend: `9b0a7f0`
- Dashboard: `3612483`

The backend remote `main` had advanced independently beyond the developer's
local `main`. Any production integration must therefore fetch the latest remote
state first and must not assume the local `main` is current.

## 16. Validation results

Validation completed during Phase One:

- Extension Vitest: **56 files, 599 tests passed**.
- Backend Vitest: **36 files, 433 tests passed**.
- Extension TypeScript compilation: passed.
- Backend production TypeScript compilation: passed.
- Backend local Shadow TypeScript compilation: passed.
- Chrome MV3 Shadow build: passed.
- Firefox MV2 Shadow build: passed.
- Shadow Chromium E2E: **6 of 6 scenarios passed**.
- Backend live local reporting/API check: passed.
- Catalog parity check: passed.
- ClickHouse contract check: passed.
- Dashboard browser interaction and responsive-layout check: passed.
- Manual local startup and integrated demo smoke test: confirmed working.

The six extension E2E scenarios cover:

1. consent, catalog, hostname-only visits, and navigation deduplication;
2. all catalog hostnames and lookalike rejection;
3. clean and sensitive paste attempts without pasted-text transmission;
4. organisation paste policy without website-access blocking;
5. offline retry, backend replay deduplication, and pending-state clearing;
6. privacy-field rejection, Business-plan gating, and tenant isolation.

Known validation notes:

- The extension lint check has three pre-existing `!important` warnings in the
  production popup stylesheet and no new Shadow formatting errors.
- The backend full lint command still reports one unrelated pre-existing
  implicit-`any` error in `test/usage.test.ts` and existing warnings.
- Chrome has automated runtime E2E coverage. Firefox compiles successfully, but
  final manual Firefox runtime acceptance is still required.

## 17. Running the Phase One demo

### Backend

```sh
cd secureintent-backend
pnpm db:shadow
pnpm dev:shadow
```

### Extension

```sh
cd Secureintent-Extension
pnpm build:shadow
```

Load `dist-shadow/chrome-mv3` as an unpacked Chrome extension in a dedicated test
profile.

For Firefox:

```sh
pnpm build:shadow:firefox
```

Load `dist-shadow/firefox-mv2/manifest.json` as a temporary Firefox add-on.

### Dashboard

```sh
cd secureintent.ai
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/shadow.html`.

See `docs/shadow-local-testing.md` for the detailed test and troubleshooting
instructions.

## 18. Not included in Phase One

- Full website blocking.
- Email-address display or email integration.
- Monitoring of Cursor or Replit desktop applications.
- Guaranteed real-time policy delivery.
- Browser-store review or publication.
- Production deployment.
- Production database changes.
- Automatic merging into `main`.
- Additional screens or integrations outside the approved V1 scope.

## 19. Work remaining before production promotion

The implementation work is complete for the isolated Phase One demo. Production
promotion still requires:

1. final Figma and product approval with Aleena;
2. staging and test-team credentials;
3. confirmation of the production ClickHouse database name and retention period;
4. application and review of the ClickHouse schema;
5. replacement of synthetic sessions with approved Clerk Business-team
   attribution;
6. integration into the production extension and Business dashboard entry
   points;
7. manual Firefox runtime acceptance;
8. security, privacy, permissions, and release review;
9. explicit approval before any merge, deployment, or browser-store submission.

## 20. Developer handoff and resume point

Do not rebuild Phase One from scratch. The complete local implementation is the
latest `origin/demo/shadow-ai-v1` branch in each repository.

For a new clone:

```sh
git clone https://github.com/Secureintent-Admin/Secureintent-Extension.git
cd Secureintent-Extension
git switch --track origin/demo/shadow-ai-v1
```

Repeat the same checkout in the backend and dashboard repositories using their
GitHub URLs from Section 15.

For an existing clone:

```sh
git fetch origin
git switch demo/shadow-ai-v1
git pull --ff-only
```

Before starting work, read these sources in order:

1. this Phase One record;
2. `docs/shadow-local-testing.md` for startup and verification;
3. `src/lib/shadow/catalog.json` for catalog truth;
4. `src/lib/shadow/visits.ts` for telemetry contracts;
5. `../secureintent-backend/testing/shadow/validation.ts` for backend validation;
6. the ClickHouse schema and queries listed in Section 12;
7. `../secureintent.ai/shadow.html` for the integrated dashboard behavior.

Use the existing feature branches when reviewing how an individual capability
was introduced. Use the demo branches when running or fixing the complete local
flow.

## 21. Ordered plan for the next phase

The next phase is production integration, not a rewrite of the local demo. Work
should proceed in this order.

### 21.1 Confirm decisions before coding

Obtain and record:

1. final Figma/component approval from Aleena;
2. confirmation that the 18-service catalog and exact host rules remain approved;
3. staging access and test Business-team access;
4. production ClickHouse database/cluster details;
5. approved event-retention period;
6. approved Clerk organisation, membership, and pseudonymous-seat mapping;
7. production API route names and extension configuration method;
8. owners and acceptance dates for Chrome and Firefox.

Do not invent production retention, identity attribution, or endpoint values when
these decisions are missing.

### 21.2 Prepare fresh non-main integration branches

Production work must start from the latest remote `main`, particularly in the
backend repository where remote `main` has moved since Phase One began.

```sh
git fetch origin
git switch -c feat/shadow-ai-production-integration origin/main
```

Create equivalent non-main integration branches in the extension and dashboard
repositories. Port or cherry-pick only the reviewed production-relevant changes
from `origin/demo/shadow-ai-v1`. Do not merge the local-only demo wholesale into
production.

### 21.3 Integrate the backend first

1. Apply the approved ClickHouse schema with the approved retention policy.
2. Add production ingestion and reporting routes to the normal backend structure.
3. Replace synthetic sessions with Clerk Business-team authentication.
4. Derive organisation and pseudonymous seat identifiers server-side.
5. Preserve strict payload allowlists, tenant isolation, idempotency, and privacy
   rejection tests.
6. Store organisation classifications and paste policies in the approved
   production policy model.
7. Put the feature behind an organisation/staging feature flag.
8. Validate aggregation queries against realistic staged volumes.

### 21.4 Integrate the Business dashboard

1. Add the approved Shadow AI route to the existing Business navigation.
2. Use Aleena's final components and wording.
3. Connect summary, trends, tools, ledger, pagination, and policy actions to the
   production backend endpoints.
4. Preserve Seat IDs by default and all V1 metric definitions.
5. Add loading, empty, error, permission, and stale-policy states.

### 21.5 Integrate the production extension

1. Retain the tested catalog, visit semantics, paste measurement, DLP outcomes,
   queue bounds, retry, and worker processing.
2. Replace the fixed loopback test API with approved environment configuration.
3. Attach authenticated organisation/seat context without exposing emails or
   accepting tenant identity from page code.
4. Connect the production team-policy refresh while preserving the five-minute
   acceptance target.
5. Keep hostname permissions explicit and verify Chrome and Firefox manifests.
6. Keep collection gated by the approved consent and organisation feature flag.

### 21.6 Stage, validate, and release

1. Run all existing Phase One automated tests.
2. Add production-route, Clerk, ClickHouse, migration, and rollback tests.
3. Run end-to-end staging tests for both Business admin and member roles.
4. Manually accept Chrome and Firefox behavior on every catalog service.
5. Repeat the privacy inspection to prove that content, secrets, URLs, paths,
   queries, and emails never enter telemetry or logs.
6. Verify policy pickup within five minutes for online extensions.
7. Complete security, permissions, performance, and product reviews.
8. Open reviewed pull requests; merge or deploy only after explicit approval.

## 22. Decisions and behavior that must not be reimplemented

The following Phase One decisions are already implemented and tested:

- The catalog is versioned and exact-host based; ordinary GitHub traffic is not
  Copilot usage.
- A visit means one recognised top-level document load, not focus or paste.
- Paste volume means attempted UTF-8 text bytes, including clean pastes; it does
  not mean confirmed submission.
- The policy blocks paste insertion only; it does not block website access.
- Classification is organisation-specific and defaults to recognised/unsanctioned.
- Telemetry never contains pasted content, secret values, full URLs, paths,
  queries, emails, page content, or prompts.
- Seat identifiers are pseudonymous by default.
- The extension queue is bounded, expires, retries, and replays idempotently.
- Policy delivery targets five minutes without claiming real-time guarantees.

Reuse the catalog, event types, validation rules, tests, dashboard definitions,
and ClickHouse queries as the Phase Two baseline. Change them only through an
explicitly approved product or privacy decision.

## 23. Target completion criteria

The overall V1 target is complete for production only when:

1. both Chrome and Firefox pass staging acceptance;
2. real Business-team authentication and tenant attribution replace synthetic
   sessions;
3. ClickHouse storage, retention, reporting, and rollback are approved and live
   in staging;
4. the production Business dashboard matches the approved design and definitions;
5. policy actions are enforced by active extensions within the agreed target;
6. privacy tests prove that no content or secret value leaves the browser;
7. security, product, and release owners approve the change;
8. the reviewed branches are deliberately merged and deployed through the normal
   release process.
