# Firefox (AMO) Launch Kit

Everything needed to publish SecureIntent to addons.mozilla.org (AMO). Chrome is
unaffected — the Firefox-only manifest settings are scoped by `browser === 'firefox'`
in [`wxt.config.ts`](../wxt.config.ts).

---

## 0. Status — what's already done

| Item | State |
|------|-------|
| Firefox MV2 build (`pnpm build:firefox`) | ✅ builds clean, 0 errors |
| `browser_specific_settings.gecko.id` = `secureintent@secureintent.ai` | ✅ set (Firefox only) |
| `gecko.strict_min_version` = `115.0` | ✅ set (storage.session floor) |
| Chrome-only `key` stripped from Firefox manifest | ✅ (avoids AMO warning) |
| `web-ext lint` | ✅ **0 errors**, 67 warnings (all from bundled React/deps — see §7) |
| Extension zip + sources zip | ✅ generated (`pnpm zip:firefox`) |
| Clerk publishable key baked into bundle | ✅ present (`pk_live_…`, public by design) |

**Artifacts to upload** (in `dist/`):
- `secureintent-extension-1.0.7-firefox.zip` — the add-on package (upload this)
- `secureintent-extension-1.0.7-sources.zip` — source for reviewers (see §6; required)

Regenerate anytime with: `pnpm zip:firefox`

---

## 1. Clerk auth on Firefox — SOLVED (Pro works)

> **Status: implemented.** Pro works on Firefox via a cookie + server-side-verify path
> (Option B below). This section documents why the SDK path fails on Firefox and how the
> implemented path avoids it. No free-only gating — Firefox gets full Pro.

### What was implemented
- **Token (Firefox):** the background reads the web app's Clerk `__session` JWT straight
  from the cookie via the privileged `browser.cookies` API
  ([`src/services/cookieToken.ts`](../src/services/cookieToken.ts)) instead of minting one
  through the chrome-extension SDK. That token was issued to the **web app origin**
  (allowlisted), never the extension origin.
- **Verify (backend):** the Worker verifies it with `@clerk/backend verifyToken` (JWKS,
  no origin check) and, because the default cookie token lacks the templated
  `email`/`public_metadata` claims, hydrates them via `clerkClient.users.getUser`
  ([`backend/src/lib/clerkAuth.ts` `hydrateClaims`](../../backend/src/lib/clerkAuth.ts)).
- **Popup (Firefox):** no `ClerkProvider` (it would crash — see below). `AccountSection`
  renders a cookie/entitlement-driven bar; sign-in/manage opens the web account page.
- **Flags:** `isClerkSdkEnabled()` (Chrome only) vs `isAuthEnabled()` (both) in
  [`src/lib/clerkConfig.ts`](../src/lib/clerkConfig.ts).

**Flow:** user signs in on `account.html` (web Clerk works fine in Firefox) → the session
cookie is set → the extension reads it → Worker returns a **signed entitlement valid for
days** → Pro unlocks. The Clerk cookie can go stale between visits, but the signed
entitlement has its own TTL, so Pro persists; it refreshes whenever the user reopens the
app/popup. Fails safe (keeps last-known entitlement on any error).

> **Requires a backend deploy** (`wrangler deploy`) for the `hydrateClaims` change —
> without it, Firefox Pro via **Paddle** (keyed by user id) still resolves, but **lifetime
> + business-email** tiers (keyed by email) won't until deployed.

### Why the chrome-extension SDK itself can't run on Firefox (background)

Auth on Chrome uses **`@clerk/chrome-extension`** (popup `ClerkProvider`/`useUser` +
background `createClerkClient`).

**The SDK code itself IS cross-browser.** Verified against the installed package
(`@clerk/chrome-extension@3.1.42`): it imports `browser` from the bundled
**`webextension-polyfill`** and uses standard `browser.cookies.*` / `browser.storage.*`
— **no raw `chrome.*` calls, no Manifest V3 requirement**. It runs in our Firefox MV2
build. "Chrome Extension" is branding, not a technical limit.

**The actual blocker is Clerk's origin allowlist vs Firefox's random origins:**

- Clerk requires the extension origin in **`allowed_origins`**, and **every** Clerk API
  call — including the ~60-second **token refresh** — is validated against it. Sync Host
  does **not** remove this (confirmed in Clerk's sync-host docs).
- **Chrome:** one fixed `chrome-extension://<id>` (our pinned `key`) → allowlist once. ✅
- **Firefox:** the runtime origin is `moz-extension://<random-UUID>`, **different for
  every user's install**. `gecko.id` fixes the add-on *identity*, NOT the runtime origin
  UUID (per MDN). Clerk `allowed_origins` takes literal origins — **no wildcard**
  (`moz-extension://*` is not supported/documented).
- ⇒ You **cannot pre-allowlist** Firefox users. Sign-in appears to work, then the first
  token refresh hits the Frontend API from an un-allowlisted origin and **fails within
  ~1 minute**. This is why it will not "just work."

Two SDK-specific blockers (both avoided by the cookie path above):

1. **Popup crash — MV2 manifest.** `ClerkProvider` hard-requires an MV3-style
   `host_permissions` key. The Firefox build is MV2 (host perms fold into `permissions`),
   so it throws *"Missing host_permissions entry"* and blanks the popup. → We don't mount
   `ClerkProvider` on Firefox.
2. **Origin allowlist.** Clerk validates every FAPI call (incl. the ~60s token refresh)
   against `allowed_origins`. Chrome has one fixed `chrome-extension://<id>`; Firefox gives
   each install a random `moz-extension://<uuid>` that can't be allowlisted (no wildcard,
   and `gecko.id` fixes only the add-on identity, not the runtime origin — per MDN). → We
   never mint tokens from the extension origin; we read the web-app cookie instead.

### Verify in a real Firefox
1. `pnpm build:firefox` (and deploy the backend for lifetime/business tiers).
2. `about:debugging` → This Firefox → Load Temporary Add-on → pick `dist/firefox-mv2/manifest.json`.
3. Free-path smoke test: paste a fake key on chatgpt.com → overlay works (no auth needed).
4. Pro path: sign in on `account.html`, then open the extension popup → the account bar
   should show your Pro plan, and Pro features unlock. It should **persist** past a minute
   (the signed entitlement is cached), unlike the old SDK path.

---

## 2. One-time: AMO developer account

1. Create/sign in at <https://addons.mozilla.org/developers/>.
2. Accept the distribution agreement.
3. (For CLI/automated submits, §8) generate API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/> — JWT issuer + secret.

---

## 3. Submit (manual, via the Developer Hub)

1. **Developer Hub → Submit a New Add-on.**
2. Distribution: **On this site (listed)**.
3. Upload `dist/secureintent-extension-1.0.7-firefox.zip`. Wait for the automated validation (0 errors expected).
4. **Source code**: when asked "Do you need to upload source?" → **Yes** (the code is bundled/minified). Upload `dist/secureintent-extension-1.0.7-sources.zip`. Paste the reviewer notes from §6.
5. Answer the **data collection** questions using §5.
6. Fill the **listing** using §4.
7. Submit for review.

Firefox review is often same-day to a few days. Because the bundle triggers
`DANGEROUS_EVAL` (from React/Clerk, not our code) it will likely get **human review** —
the sources zip + §6 notes are what clear it.

---

## 4. Listing metadata

- **Name:** `SecureIntent`
- **Add-on URL slug:** `secureintent`
- **Summary (≤250 chars):**
  > Blocks secret pastes locally. Business teams receive limited AI-service security metadata—never prompts, pasted text, or secrets.
- **Category:** Privacy & Security
- **Description:** reuse the detailed description from [`docs/store-listing.md`](./store-listing.md) (plain text renders fine on AMO).
- **Screenshots:** `store-assets/banner-1280x800.png` (add 2–3 more of the real warning overlay if available).
- **Icon:** taken from the package (`icons/128.png`).
- **Homepage:** `https://secureintent.ai`
- **Support site:** `https://secureintent.ai`
- **Support email:** `info@secureintent.ai`
- **Privacy Policy URL (required — we collect telemetry):** `https://secureintent.ai/privacy.html`
- **License (source disclosure):** source-available / view-only — see repo `LICENSE`.

---

## 5. Data collection disclosure (in the MANIFEST — required by AMO)

AMO **rejects** new add-ons without the `data_collection_permissions` manifest key
(validation error: *"The data_collection_permissions property is missing"*). It is
declared in [`wxt.config.ts`](../wxt.config.ts) for the Firefox build; AMO reads it
automatically — there is no separate form to fill:

```jsonc
"data_collection_permissions": {
  "required": ["none"],
  "optional": ["technicalAndInteraction", "websiteActivity"]
}
```

- **Required: none** — detection + warnings run 100% on-device and send nothing.
- **Optional — `technicalAndInteraction`** — anonymous detection fingerprints (a
  salted, one-way SHA-256 hash of a detected secret — never the secret itself),
  detection type/label, action chosen, plan tier, random install id. Opt-in via the
  in-product consent gate.
- **Optional — `websiteActivity`** — only the **domain** where a paste was intercepted
  (e.g. `chatgpt.com`). **No page content.**

Notes:
- `websiteContent` is intentionally NOT declared — raw pasted text never leaves the device.
- `technicalAndInteraction` is valid only in `optional`, never in `required` (putting it
  in `required` fails validation).
- The key is read by **FF 140+**; older Firefox ignores it, so `strict_min_version`
  stays `115.0` for reach. AMO flags the version note as a **warning**, not an error.
- `businessDomain` (a Business user's work-email *domain*, org-level) rides under
  technical/interaction; mention it in the privacy policy for completeness.

---

## 6. Reviewer notes (paste into the "source code" step)

```
Build tooling: WXT (wraps Vite) + React 19 + TypeScript. Package manager: pnpm.
Tested with Node v22 and pnpm 11.

Reproduce the uploaded dist/firefox-mv2/ build:

  1. corepack enable            # or: npm i -g pnpm
  2. pnpm install
  3. Create a .env file with these PUBLIC (non-secret) values:
       WXT_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuc2VjdXJlaW50ZW50LmFpJA
       WXT_CLERK_SYNC_HOST=https://clerk.secureintent.ai
       WXT_WEB_APP_URL=https://secureintent.ai
  4. pnpm build:firefox
  5. Output is dist/firefox-mv2/ (matches the uploaded package).

Notes:
- The Clerk publishable key above is a public client key (pk_live), safe to embed.
  No private/secret keys are used at build time.
- eval/innerHTML flagged by the validator come from the bundled React DOM and Clerk
  SDK, not from our source. Our code never calls eval; overlays render into a CLOSED
  shadow root.
- Raw pasted text never leaves the device; only a salted one-way hash + metadata is
  sent, and only after in-product consent.
```

---

## 7. `web-ext lint` result (informational)

`npx web-ext lint --source-dir dist/firefox-mv2` → **0 errors**, 67 warnings, 0 notices.

- `UNSAFE_VAR_ASSIGNMENT` (innerHTML) ×64 — React DOM. Standard, non-blocking.
- `DANGEROUS_EVAL` ×2 — bundled dep. Triggers human review; cleared by §6 source + notes.

None block submission. Re-run anytime: `npx web-ext lint --source-dir dist/firefox-mv2`.

---

## 8. Optional: automated submit (CI or CLI)

WXT can submit straight to AMO with API keys:

```bash
# store the AMO issuer/secret as env or in .env.submit (never commit)
npx wxt submit \
  --firefox-zip dist/secureintent-extension-1.0.7-firefox.zip \
  --firefox-sources-zip dist/secureintent-extension-1.0.7-sources.zip
```

Requires `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` (from §2). Same review applies.

For self-distribution (outside AMO) instead, use `web-ext sign` to get a signed `.xpi`.

---

## 9. Local testing checklist (do before submit)

- [ ] `pnpm build:firefox` clean
- [ ] Load `dist/firefox-mv2/` in `about:debugging` (temporary add-on)
- [ ] Paste a fake API key into chatgpt.com → warning overlay appears
- [ ] Cancel / Paste anyway / Paste anonymously all work
- [ ] Fallback guard fires on a non-dedicated site
- [ ] **Clerk sign-in + Pro sync works** (§1) — the one real risk
- [ ] Session lock triggers on a cloud console (if testing that feature)

---

## 10. After approval

- AMO signs and hosts the `.xpi`; auto-updates flow from AMO.
- Add the Firefox listing URL to the landing page install options.
- Keep `manifest.description` (in `wxt.config.ts`) in sync with the store summary.
- Future updates: bump `version`, `pnpm zip:firefox`, re-submit the new zip + sources.
