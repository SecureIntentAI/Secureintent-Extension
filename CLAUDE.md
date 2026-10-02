# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The browser-extension half of **SecureIntent.AI** — a DLP (data-loss-prevention) tool that warns
developers *before* they paste secrets into untrusted destinations. See [PROJECT.MD](PROJECT.MD) for
the full Statement of Work, scope, and timeline.

The end-to-end design:

- Content scripts capture **paste events** and render warnings in a **closed Shadow DOM overlay**
  for UI isolation. The host element remains in the page; the closed root is not an anti-tampering
  boundary.
- A **client-side pre-filter** does cheap detection on-device using a signed pattern bundle fetched
  from the Worker. The `killSwitch` field in the bundle can disable the guard remotely.
- Standard detection telemetry posts to the Worker for **ClickHouse** ingestion. Business Shadow AI
  metadata uses a bounded local retry queue. Pattern bundles are Ed25519-signed and refreshed on a
  background schedule (and on popup demand).
- **SecureIntent never sends raw paste or scanned file content to its servers.** Paste telemetry
  may include a salted SHA-256 fingerprint and limited metadata. If a user allows a paste or upload,
  the destination site receives that content. Keep this boundary explicit in code and copy.
- Cross-browser from one codebase: Chrome, Edge, Firefox, Opera. Chrome ships MV3, Firefox MV2.

### Sibling repos (each its own git remote, all part of one product)

- `../backend` — Cloudflare Worker (Hono) at `api.secureintent.ai`: signed config bundle
  (`/v1/config`), telemetry (`/v1/telemetry`), signed entitlement (`/v1/entitlement`), quota
  (`/v1/usage`), Clerk/Paddle/promo. Has its own `CLAUDE.md`.
- `../landing_page` — the static `secureintent.ai` site (marketing + `account.html`, the Clerk sign-in
  / Paddle checkout page the extension links to). Has its own `CLAUDE.md`.

Anything touching auth, entitlement, quota, or telemetry shape is a **two-repo change** — the Worker
contract in `../backend/src/routes/` must move with it.

## Stack

[WXT](https://wxt.dev) (extension framework, wraps Vite) + React 19 + TypeScript. WXT handles the
manifest, MV3 entrypoint wiring, cross-browser builds, and HMR — there is no hand-written
`manifest.json`. **Biome** is the linter/formatter (not ESLint/Prettier). **Semgrep** runs custom
rules in `semgrep/`. **Playwright** drives the live end-to-end suite in `e2e/`.

## Commands

**Use `pnpm` for everything** (the project is pinned to pnpm; do not use npm/yarn).

```bash
pnpm dev            # dev server, Chrome target, HMR
pnpm dev:firefox    # dev server, Firefox target
pnpm build          # production build → dist/chrome-mv3/ (outDir is dist, not .output)
pnpm build:firefox  # → dist/firefox-mv2/
pnpm zip            # packaged zip for store submission (Chrome)
pnpm zip:firefox    # AMO zip (also emits a -sources.zip)
pnpm compile        # tsc --noEmit — type-check
pnpm lint           # biome lint
pnpm check          # biome check (lint + format); check:fix to auto-fix
pnpm format         # biome format --write
pnpm semgrep        # run custom Semgrep rules (semgrep/), fail on findings
                    #   needs `brew install semgrep` — it is a Python tool, not a dependency
                    #   here, so a clean checkout has the script but not the binary. Same for
                    #   Playwright's browsers: `pnpm exec playwright install chromium`.
pnpm test           # vitest run (unit tests, colocated *.test.ts)
pnpm test:watch     # vitest watch
pnpm coverage       # vitest run --coverage
```

Run a single test file: `pnpm test <name>` (e.g. `pnpm test detection`) — vitest filters by path
substring.

Unit tests use Vitest with the `WxtVitest` plugin (`vitest.config.ts`), jsdom, and
`wxt/testing/fake-browser` for `browser.*`/storage. Test files live next to the code as
`*.test.ts(x)`. SOW target is ≥85% coverage on pure logic (`src/lib/`, `src/content/`,
`src/services/`); thin `createShadowRootUi` mount wrappers in `src/overlay/mount*.ts` are excluded and
verified via build + manual load.

**E2E** (Playwright, builds the extension then loads it in a real Chromium):

```bash
pnpm e2e               # canary + fallback specs (no live network)
pnpm e2e:live          # live LLM sites (needs e2e:login session first)
pnpm e2e:roundtrip     # anonymize → rehydrate vault roundtrip
pnpm e2e:ghost         # large-log sanitization
pnpm e2e:session-lock  # cloud-console PIN lock
pnpm e2e:consent       # first-run Terms & Privacy gate
pnpm e2e:install       # creator attribution on install (stub API on :8788, never prod)
pnpm e2e:login         # one-time: capture a logged-in browser session
```

`e2e:install` seeds the creator cookie into a profile, *then* loads the extension into
it, so `onInstalled` fires with the cookie already present — the real ordering (click
precedes install). Cookies seeded via `addCookies` need an explicit `expires`, or the
profile drops them as session cookies on close.

**Build-time env** (`.env`, WXT `WXT_`-prefixed, see `src/lib/clerkConfig.ts`):
`WXT_CLERK_PUBLISHABLE_KEY` (auth is disabled entirely when empty), `WXT_CLERK_SYNC_HOST`
(default `https://clerk.secureintent.ai`), `WXT_WEB_APP_URL` (default `https://secureintent.ai`).

## Code layout

All source lives under `src/` (WXT `srcDir: 'src'`). Per-site content scripts are **thin** — each just
passes `{ name, siteKey }` to `createPasteGuard`. All real logic lives in pure, testable modules under
`src/content/`, `src/lib/`, and `src/services/`.

**Adding a new site** requires a new `src/entrypoints/<site>.content/index.ts` that passes
`{ name, siteKey }` to `createPasteGuard`, a `matches` host list, and a selector entry in
`src/content/siteSelectors.ts` (plus a manifest change → store resubmit). Changing an existing site's
selector or patterns is done via a remote bundle update (no resubmit). Even with no dedicated
entrypoint a site is still covered by the **fallback** catch-all guard; dedicated entrypoints exist for
beating the page's own handlers and site-specific selectors. Keep the popup's supported-host list in
sync.

```
src/
  entrypoints/
    <site>.content/index.ts     # one thin guard per site: chatgpt, claude, gemini, perplexity,
                                #   copilot, githubcopilot, grok, mistral, meta, poe, v0, bolt,
                                #   lovable, replit, reddit, deepseek, duck, kimi, qwen
    fallback.content/index.ts   # catch-all guard on *://*/* — no-ops where a dedicated guard ran
                                #   (shared window flag) so sites are never double-guarded
    sessionlock.content/index.ts# cloud-console PIN lock (AWS/GCP/Azure/CF/DO/Heroku/… consoles)
    bridge.content/index.ts     # reports the focused tab's host/port to the desktop bridge
                                #   (only when a desktop app is there) — see "Desktop bridge" below
    background.ts               # service worker (MV3) / background page (MV2): config sync alarm,
                                #   badge bumps, vault opt-in, entitlement refresh + user-mismatch clear
    popup/                      # React popup: enable/pause, intercepted count, PIN setup, refresh,
                                #   AccountSection (plan + team + sign-in link), PlanCard (checklist,
                                #   team seat, error+retry), PopupConsent, planFeatures
    welcome/                    # first-run onboarding page + Terms & Privacy accept
  content/                      # paste-guard + session-lock logic (was src/lib/content/)
    createPasteGuard.ts         # paste capture → detect → fingerprint → overlay → insert/anon/cancel
    createSessionLock.ts        # inactivity/tab-away → PIN gate over high-risk consoles
    siteSelectors.ts            # per-siteKey input selectors (static fallback for the bundle)
    findComposer.ts             # walk the event path to the composer element
    fallbackSelector.ts         # generic text-entry selector for the catch-all guard
    types.ts                    # SiteConfig { name, siteKey }
  lib/
    detection/
      patterns.ts               # static offline regex catalog (TYPE_RANK, PATTERNS)
      validators.ts             # post-match validators (Luhn card check, entropy) cut false positives
      compile.ts / index.ts     # compilePatterns + detectSecrets (overlap-resolve by rank then length)
      redact.ts                 # fixed-width masking
      tokenize.ts               # tokenizeSecrets: secret → ⟦SI:xxxxxxxx⟧ token + VaultEntry list
      ghost.ts / sanitize.ts    # large-log "ghost" scrub: extra patterns for IPs/emails + summarize
      locate.ts                 # line# + masked windowed snippet (no raw secret)
    vault/index.ts              # RAM-only token→secret store in storage.session (rehydrate anon pastes)
    lock/index.ts               # PIN hashing/verify (reuses fingerprint salt + SHA-256)
    fingerprint/                # per-install salt + fingerprint(secret, salt): SHA-256, never leaves device
    config/                     # ConfigBundle shapes, store, validate, verify (Ed25519), default fallback
    api/client.ts               # getJson (no-store) + postJson (keepalive) + API_BASE
    telemetry/                  # TelemetryEvent types (build/send now live in services/)
    features/                   # internal feature-hook registry (registerFeature / notify*)
    entitlement/                # signed entitlement: types, store, evaluateBlob/evaluateStored, refresh
    quota/                      # Anonymise & Paste allowance: offline.ts (on-device) + backend routing
                                #   + reset.ts (when the UTC-month allowance comes back)
    consent/index.ts            # blocking Terms & Privacy gate (TERMS_VERSION, sync storage)
    clerkConfig.ts              # publishable key, JWT template, sync host, ACCOUNT_URL, IS_FIREFOX
    bridge/                     # desktop-agent bridge: pairing (token from the desktop over
                                #   native messaging), types (protocol), hash (SHA-256 digest +
                                #   token-keyed HMAC, matches the agent's dedup_mac), client
                                #   (connect-per-burst over ws://127.0.0.1, port scan 8137–8141)
    browserAction.ts            # browser.action (MV3) ?? browser.browserAction (MV2) shim
    badge.ts                    # per-tab intercepted-count toolbar badge
    debug/index.ts              # siDebug / siError / elapsedMs structured console output
  settings/index.ts             # enabled toggle, blocked count, session-lock config
  services/                     # I/O orchestration over pure lib modules
    configService.ts            # syncConfig: fetch /v1/config → validate → verify → persist if newer
    scheduler.ts                # SYNC_ALARM + handleRefreshMessage (popup-triggered sync)
    telemetryService.ts         # buildEvent (fresh UUID) + sendTelemetry (fire-and-forget POST)
    entitlementBackground.ts    # Clerk token minting + entitlement refresh from the background
    cookieToken.ts              # Firefox: read the Clerk `__session` cookie (SDK can't mint there)
    installAttribution.ts       # report every install (creator optional) + arm the uninstall URL
  overlay/                      # React dialogs + closed-shadow-DOM mounts
    Overlay.tsx                 # paste warning: detections, masked snippets, 3 actions
    SessionLock.tsx / LockWarning.tsx
    mount.ts / mountSessionLock.ts / mountLockWarning.ts   # createShadowRootUi wrappers (test-excluded)
  core.ts                       # internal API barrel (reusable guard/overlay/detection exports)
  components/Logo.tsx           # brand mark (inlined SVG, renders inside closed shadow DOM)
  public/ assets/               # static + bundled assets
```

## Key invariants

- **Raw content never goes to SecureIntent servers** — paste telemetry may contain a salted SHA-256
  fingerprint, never the original text or secret value. Supported file scans are local and generate
  no file telemetry. A destination receives content when the user allows the paste or upload. Never
  log or send raw content to SecureIntent. Vault token → secret pairs live only in `storage.session`.
- The overlay uses a **closed** shadow root for UI isolation. Paste and supported text-file checks
  fail closed on scanner errors, overload, or timeout; content is not passed to the page unchecked.
- The paste handler must call `preventDefault`/`stopImmediatePropagation` **synchronously**, before
  any `await`. The `enabled` flag and the vault snapshot are cached in local vars (refreshed via
  watchers) and read synchronously — don't turn those into `await`s inside the handler.
- Content scripts register at `runAt: 'document_start'` with a **capture-phase** listener so they beat
  the page's own paste handlers. Programmatic pastes (our own `execCommand('insertText')` re-inserts)
  are skipped via `e.isTrusted`.
- Detection is regex-then-validator; overlapping matches resolve by `TYPE_RANK` (private-key >
  known-key > env-credential), then longer match wins. Broad regexes (cards) are confirmed by a
  post-match validator (Luhn / entropy) to avoid false positives.
- The guard reads the active bundle at content-script boot, then resolves the input selector as
  `bundle.sites[siteKey]?.inputSelector ?? siteSelectors[siteKey]` (remote overrides static fallback).
- Remote config is **Ed25519-signed** and verified before use; the embedded public key must match the
  Worker's signing key. Bundles are accepted only if strictly newer (`version >` current).

## Overlay actions (paste-guard)

The warning dialog offers three outcomes, mapped to telemetry actions in `createPasteGuard`:

- **paste** → `paste_anyway` — insert the original text (for a large log, `sanitize()` scrubs it first).
- **redact** → `paste_anonymously` — `tokenizeSecrets` replaces each secret with a `⟦SI:…⟧` token,
  inserts the masked text, and stores the `token → secret` entries in the **vault** so the destination
  can be rehydrated later in the same session.
- **cancel** → `cancelled` — drop the paste entirely.

## Session lock

A separate, opt-in feature (`sessionlock.content` + `createSessionLock` + `lib/lock`). After
inactivity or tab-away it covers high-risk cloud consoles with a PIN gate. The PIN is hashed with the
same per-install salt + SHA-256 as the fingerprint module (never stored plaintext). A per-tab
`sessionStorage` flag survives a reload (a refresh can't bypass the lock) and clears on tab close.
Fails open on error.

## Free & paid tiers (single build)

There is **no open-core split**. One build ships both the free and the paid features; the extension is
a single product with free and paid tiers, not a public core plus a private pro repo. The repo is
still **source-available (view-only — see [LICENSE](LICENSE))**.

- Paid features (`rehydrate`, `ghost`, `session_lock`) ship in this build but are **gated at runtime**
  by a signed entitlement fetched from the Worker for the signed-in Clerk user — see `src/lib/entitlement/`
  and the Clerk/Paddle wiring in `src/services/entitlementBackground.ts`. The entitlement blob is
  Ed25519-signed (same verify path as the config bundle) and evaluated locally; it **fails safe to
  free** on any invalid/expired/missing state.
- Client-side gating is a UX gate, **not** the security boundary: the source is viewable and the checks
  are patchable. The valuable logic and license truth live server-side in `backend/` — treat the client
  gate as convenience, not enforcement.
- `src/lib/features/` — internal feature-hook registry (`registerFeature` + `notifyDetections`/
  `notifyAction`). Hooks get detection **metadata only** (counts/types/labels); raw clipboard text is
  never passed, same hard privacy boundary as everywhere.
- `src/core.ts` — internal API barrel that groups the reusable guard/overlay/detection exports. Retained
  as a convenience seam; it is **no longer an external publish target** (no `@secureintent/core` package,
  no `BUILD_TARGET=pro` build).

### Auth (Clerk) — two different paths per browser

There is no in-extension sign-in form; users sign in on the web app (`ACCOUNT_URL` →
`secureintent.ai/account.html`) and the extension mirrors that session.

- **Chrome/Edge/Opera (MV3):** `@clerk/chrome-extension` with `syncHost = https://clerk.secureintent.ai`
  mints a **templated** session token (JWT template `secureintent`, carries `email` +
  `public_metadata`). The manifest pins `key` so the `chrome-extension://` origin stays stable for
  Clerk's allowed origins and the Worker's `CLERK_AUTHORIZED_PARTIES`.
- **Firefox (MV2):** the SDK can't mint a token (its FAPI call comes from a random
  `moz-extension://` origin Clerk can't allowlist), so `services/cookieToken.ts` reads the Clerk
  `__session` cookie via `browser.cookies`. That default token has only `sub` — the Worker's
  `hydrateClaims` fills email/metadata from the Clerk backend API. Requires the `cookies` permission
  plus host permissions for both domains.
- The entitlement blob is bound to a Clerk user id: `evaluateBlob` rejects a blob whose `clerkUserId`
  doesn't match the live session, so a signed Pro blob can't be copied into another install. The
  background clears a mismatched cache; content scripts skip the check and rely on that.

### Anonymise & Paste quota (free tier)

Free users get `OFFLINE_LIMIT` (10) anonymised pastes per UTC month. When the allowance is spent the
overlay and the popup say so and name the reset date (`lib/quota/reset.ts`) rather than showing the
same "· Pro" badge as a user who never had the feature. Signed out, the count lives
on-device in `lib/quota/offline.ts` — deliberately obfuscated (XOR-folded token under an innocuous
storage key) so it doesn't read as a plain counter; a UX gate, not a security boundary. Signed in, it
routes to the Worker's `/v1/usage`, which reconciles the offline count forward with a MAX-only seed
(`X-SI-Offline-Used`), so signing in never grants a fresh allowance. Pro is unlimited. Backend
unreachable → fall back to the on-device count.

### Counting installs and uninstalls

`services/installAttribution.ts` reports **every** install to `POST /v1/install` — with the creator
slug when a link put one in our cookie, without it otherwise. Organic installs are the denominator;
dropping them leaves no way to tell a quiet week from a broken report. The payload is a random
install id, the build (browser + version) and the coarse platform from `getPlatformInfo()` — never
the arch, never anything about the person.

Uninstalls come from `runtime.setUninstallURL`. Nothing of ours runs at removal, so the address is
registered while the extension is alive — on install, at every startup, and again once the server's
token arrives — and the browser opens it on the way out. `syncUninstallUrl()` is the only thing that
sets it, and it *clears* it on Firefox until the Terms are accepted: that build promises AMO
`data_collection_permissions: { required: ['none'] }`, and an armed ping is a report.

### Consent gate

`lib/consent` stores a `{ version, acceptedAt }` record in **sync** storage. Until the current
`TERMS_VERSION` is accepted, the paste guard shows a consent gate on the first warning and the popup
shows a consent screen; the `welcome/` page is the normal first-run accept path. Bump `TERMS_VERSION`
to re-prompt everyone after a terms change. The gate is dismissable the same three ways as the
warning dialog (Escape / × / scrim) and says what that costs: the paste it interrupted is dropped.

### One upgrade destination

Every upgrade CTA — the popup's Upgrade button and the overlay's locked Pro action (which posts
`si-open-upgrade` to the background) — opens `ACCOUNT_URL`. The marketing `#tiers` section is for
people who don't have the extension yet, so it's never an in-product CTA target.

### Desktop bridge (automatic when the desktop app is installed)

The SecureIntent **desktop app** also watches the clipboard, so without coordination both
products warn about the same copy. The bridge is how they avoid that. There is **no switch in the
extension**: it pairs on its own with a desktop app on the same machine, and whether the two
coordinate is a setting in the desktop app, which is what holds the token. With no desktop app the
browser never opens a local port.

- **Pairing is native messaging** (`lib/bridge/pairing.ts`). The desktop registers itself as the
  host `ai.secureintent.desktop` for this extension's id only (Chromium: `allowed_origins` with the
  id pinned by the manifest `key`; Firefox: `allowed_extensions` with the gecko id), and hands over
  the token on `{type:"get_pairing"}`. Needs the `nativeMessaging` permission. The token is kept in
  **`storage.session` only** and re-asked each browser session; a refused token is re-asked once
  (desktop reinstalled). No host means no desktop app — the call rejects, which is normal, and a
  miss is not re-asked for a minute. `local:si_bridge_available` records only *that* a desktop app
  answered, so content scripts can skip reporting where there is nobody to report to.
- Older versions stored a pasted token and an on/off switch in `storage.local`;
  `forgetManualPairing()` removes both on update.

- `bridge.content` (all pages, `document_idle`) reports the **focused tab's host and port** to
  the background, debounced 250ms and only when they actually change — a content script reads its
  own address with no permission, whereas watching tabs from the background would need `tabs` and a
  listing that declares it reads browsing history.
- The background sends two messages over `ws://127.0.0.1:<port>`:
  `browser_url` (so the agent can recognise a local dev server) and `handled` (so it doesn't raise
  its own alert for a copy we already warned about).
- **Connect-per-burst, never held open.** An MV3 worker is killed after ~30s idle, so a held socket
  dies with it; keeping it alive would mean a keepalive forever and a permanently resident worker.
- WebSockets have no CORS, which is why the bridge itself needs **no host permission**.
- Discovery is authentication: the first port in **8137–8141** that answers the v2 handshake. A
  squatter can't fake that without the token.
- `pnpm e2e:desktop` (with `SI_DESKTOP_E2E=1` and a running desktop agent) drives the real
  extension in Chromium against it.

Two things that will bite anyone changing this:

- **`browser_url` must carry `url`.** The agent's `BrowserUrl` variant has a single `url` field and
  drops a frame it can't deserialise *in silence*. `url` is the **origin only** — a path or query
  would leak session tokens. `host`/`port`/`ts` ride along because the agent ignores unknown fields.
- **`handled` carries a keyed MAC, never a plain hash.** The paste worker computes the SHA-256 of the
  paste (`handledDigest`); the background keys it with the pairing token as
  HMAC-SHA256(token, `secureintent-bridge-v2/handled/<digest>`) and sends `{type, mac, ttl_ms}`.
  The old unsalted FNV-1a `hash` was cheap to test guesses against. Both repos pin one shared
  vector (`hash.test.ts` / the desktop's `engine/src/bridge.rs`).

### Firefox / MV2 gotchas

`browser.action` doesn't exist under MV2 — always go through `lib/browserAction.ts`. `wxt.config.ts`
branches on `browser === 'firefox'` for `browser_specific_settings` (stable add-on id, `strict_min_version`
115 for `storage.session`, and AMO's required `data_collection_permissions`) and drops the Chrome-only
`key`. Gate any Chrome-only path on `IS_FIREFOX` from `lib/clerkConfig.ts`.

## WXT conventions

- **Entrypoints are discovered by filename** in `src/entrypoints/`: `{name}.{ext}` or
  `{name}/index.{ext}` only — deeply nested files (e.g. `content/chatgpt.ts`) are NOT entrypoints. A
  file is a *content script* when its name is `content` or ends in `.content` (so the folder is
  `<site>.content/`). Note `src/content/` is a plain logic dir, **not** an entrypoint folder.
- `@/` resolves to `src/` (the srcDir), e.g. `@/lib/...`, `@/content/...`, `@/assets/...`.
- Import WXT APIs from the **`#imports`** virtual module
  (`import { defineContentScript, createShadowRootUi, ContentScriptContext, storage } from '#imports'`).
  These also work as auto-imported globals, but `#imports` is explicit and used throughout this repo.
- `defineBackground` and `browser` are likewise available via `#imports` / auto-import.
- Files under `public/` are served from the web-accessible root, referenced with a leading slash.
- WXT config is `wxt.config.ts`; the React integration is enabled via the `@wxt-dev/module-react`
  module there. `tsconfig.json` extends the generated `.wxt/tsconfig.json` — don't edit the generated
  one.
- The `postinstall` script runs `wxt prepare`, which regenerates `.wxt/`. If types or auto-imports go
  missing, run `wxt prepare`.
