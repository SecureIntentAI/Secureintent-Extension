# Firefox (AMO) Launch Kit

Packaging commands and reviewer notes for addons.mozilla.org (AMO). A v1.2.0
candidate package is prepared, but Firefox runtime checks and the other release gates
in [`UNIVERSAL_DETECTOR_DEV.md`](./UNIVERSAL_DETECTOR_DEV.md) remain open. Chrome is
unaffected — the Firefox-only manifest settings are scoped by `browser === 'firefox'`
in [`wxt.config.ts`](../wxt.config.ts).

---

## 0. Status — what's already done

| Item | State |
|------|-------|
| Firefox MV2 v1.2.0 build | ✅ generated from current worktree |
| `browser_specific_settings.gecko.id` = `secureintent@secureintent.ai` | ✅ confirmed in candidate manifest |
| `gecko.strict_min_version` = `115.0` | ✅ confirmed in candidate manifest |
| Chrome-only `key` stripped from Firefox manifest | ✅ confirmed in candidate manifest |
| `web-ext lint` | ⏳ not run against the v1.2.0 candidate |
| Extension zip + sources zip | ✅ generated; `.env` and local test artifacts excluded from sources |
| Firefox runtime smoke test | Passed in system Firefox ESR with local integration fixtures; live provider checks pending |

**Artifacts to upload** (in `dist/`):
- `secureintent-extension-1.2.0-firefox.zip` — local candidate package; submit only after release approval
- `secureintent-extension-1.2.0-sources.zip` — source for reviewers (see §6; required)
- `secureintent-extension-1.2.0-SHA256SUMS.txt` — checksums for the Chrome, Firefox, and source ZIPs

Regenerate the package with: `pnpm zip:firefox`. Regenerate the source archive from the
current release worktree while excluding `.env`, dependencies, generated bundles, and
local test artifacts.

---

## 1. Clerk authentication on Firefox

The Firefox MV2 build uses the same Clerk identity and backend account/organization
resolution as Chrome. Its background reads the configured web-app and Clerk FAPI
cookies with the privileged cookies API.

- A fresh session JWT is sent to the existing API. An expired JWT is renewed through
  `POST /v1/auth/session/refresh` using the HttpOnly FAPI `__client` credential.
- The backend verifies the client with Clerk, checks its active session belongs to
  that client and user, and checks session status, expiration and abandonment.
  It issues a fixed 60-second token and verifies the result. An expired JWT alone
  never authorizes renewal.
- Renewal requests are coalesced and cached in background memory. Tokens and client
  proofs are not placed in extension storage, telemetry, URLs or logs.
- Cookie changes invalidate pending requests and refresh account/policy state.
  Explicit sign-out or rejected session proof clears cached entitlement. Provider
  outages use bounded retries and preserve the same user's last signed policy.
- Instance-specific cookie suffixes are derived from the configured publishable key.
  An expired web cookie cannot mask a fresh copy for the same session on FAPI.
- The backend requires the new IP and client rate-limit bindings. Missing bindings
  or provider failures return retryable errors; rollout requires the matching backend.

The backend verifies token signatures and configured authorized parties, then
hydrates missing default-token email claims and resolves current D1 Business
membership. A valid sign-in alone does not activate a Business workspace.

Chrome continues using `@clerk/chrome-extension`. Firefox does not mount that SDK's
ClerkProvider: the installed SDK requires an MV3 `host_permissions` manifest field,
and a random `moz-extension://` origin cannot use Chrome's pinned origin allowlist.
The popup opens the ordinary website account page for sign-in and account management.

### Verification

A real Firefox ESR browser has exercised the new renewal flow against local backend
routes with a simulated Clerk provider: signed entitlement and policy, managed-member
notice, trusted paste enforcement, account switching and revoked-session rejection.
A separate simultaneous Chrome/Firefox test uses the actual Worker runtime, D1,
SQLite PolicyHub and native WebSockets. One admin save reaches both browsers without
polling or reconnecting, updates their notices and receipts, and changes enforcement
in already-open tabs. Another organization's connection receives no publication.
This does not establish real production Clerk renewal or AMO approval.

Run the opt-in integration from `secureintent-backend-v2`:

```sh
SI_BROWSER_INTEGRATION=1 pnpm exec vitest run --no-file-parallelism test/extension-browser.integration.test.ts test/extension-policy-live.integration.test.ts
```

Keep these files sequential: their temporary browser builds share WXT's generated
type directory. The test builds do not replace the production packages.

Build the production target with `pnpm build:firefox`. The requested package names
are `dist/final1.firefox.zip` and `dist/final1.firefox/`. Load its manifest through
`about:debugging` for a temporary installation. See [hardening.md](./hardening.md)
for the current evidence and remaining live release checks.

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
3. Upload `dist/secureintent-extension-1.2.0-firefox.zip` only after the release gates pass. Wait for the automated validation (0 errors expected).
4. **Source code**: when asked "Do you need to upload source?" → **Yes** (the code is bundled/minified). Upload `dist/secureintent-extension-1.2.0-sources.zip`. Paste the reviewer notes from §6.
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
  > Blocks secret pastes and scans supported text files locally. Business teams receive limited AI-service security metadata.
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
- **Optional — `websiteActivity`** — recognised AI-service hostnames and the **domain**
  where a text paste was intercepted (e.g. `chatgpt.com`). **No page content or file
  contents.** Local file checks do not emit telemetry.

Notes:
- `websiteContent` is intentionally NOT declared — SecureIntent does not transmit raw
  pasted text or selected file contents to its servers. A destination site receives the
  content only when the user allows the paste or upload.
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
- SecureIntent never sends raw pasted text or selected file contents to its servers.
  Paste reporting uses a salted one-way hash + metadata after in-product consent;
  local file scans do not generate telemetry. The destination site receives content
  only when the paste or upload proceeds.
```

---

## 7. `web-ext lint` result (informational)

The 0-error/67-warning/0-notice result below is historical and was not run against
v1.2.0. Its recorded warning classes were `UNSAFE_VAR_ASSIGNMENT` (React DOM, ×64)
and `DANGEROUS_EVAL` (bundled dependencies, ×2). The current local environment does
not have `web-ext`; run it against v1.2.0 before AMO submission and record the actual
candidate-specific result here.

Do not treat the historical result as evidence for the v1.2.0 candidate. Run:
`npx web-ext lint --source-dir dist/firefox-mv2`.

---

## 8. Optional: automated submit (CI or CLI)

WXT can submit straight to AMO with API keys:

```bash
# store the AMO issuer/secret as env or in .env.submit (never commit)
npx wxt submit \
  --firefox-zip dist/secureintent-extension-1.2.0-firefox.zip \
  --firefox-sources-zip dist/secureintent-extension-1.2.0-sources.zip
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
