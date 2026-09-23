# Firefox (AMO) Store Listing — copy-paste content

Ready-to-paste content for the addons.mozilla.org submission. For the submission
*process* (build, source upload, review), see [FIREFOX_LAUNCH.md](./FIREFOX_LAUNCH.md).

---

## Name
```
SecureIntent — Secret Paste Guard for AI
```
(AMO limit 50 chars. Shorter alternative: `SecureIntent`.)

## Add-on slug
```
secureintent
```

## Summary  (AMO limit ~250 chars)
```
Blocks secret pastes locally. Business teams receive limited AI-service security metadata—never prompts, pasted text, or secrets.
```

## Description  (paste as-is — plain text, keep the • bullets and blank lines)
```
SecureIntent warns you the moment you're about to paste an API key, token, password, or other secret into a website where it doesn't belong — like AI chat and coding assistants.

How it works
• Detection runs entirely on your device. Your pasted text is never sent anywhere.
• When a secret is detected, a warning appears with clear choices: Cancel, Paste anyway, or Paste anonymously — which redacts the secret and pastes the rest.
• Pasting a large log? It can strip out secrets, IP addresses, and emails in one step before the text goes in.
• Only an anonymous, one-way fingerprint of a detected secret is ever sent, and only for aggregate reporting — never the secret itself, and never your text.

What it detects
A wide range of credentials: API keys and access tokens from major cloud and developer platforms, private keys, high-entropy secrets, and common key = value credential patterns. Broad matches (such as card numbers) are confirmed by on-device validators to keep false positives low.

Where it works
Popular AI chat and coding assistants get dedicated support (ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok, Mistral, DeepSeek, and more), and a catch-all guard covers text fields on other sites. Protection happens wherever you paste.

Free & Pro
Core detection and warnings are free, including a monthly allowance of Anonymise & Paste. Pro unlocks unlimited Anonymise & Paste, large-log sanitizing, restoring anonymized values later in the same session, and a PIN lock for high-risk cloud consoles. Pro is entirely optional — the free protection works with no sign-up.

Privacy first
Raw pasted text, prompts, secrets, and URL paths never leave your device. The extension computes a salted, one-way hash on-device for anonymous reporting. For Business organisation members who accept the in-product disclosure, it also reports limited activity at recognised AI services: the service hostname, paste byte count, and secret-warning outcome. It never reports page content, URLs, prompts, or pasted text; free and Developer Pro installs do not send this Business metadata. We never sell your data.
```

## Category
```
Privacy & Security
```

## Tags
```
privacy, security, developer, ai, secrets, api-keys, dlp, clipboard
```

## URLs
| Field | Value |
|-------|-------|
| Homepage | `https://secureintent.ai` |
| Support site | `https://secureintent.ai` |
| Support email | `info@secureintent.ai` |
| Privacy policy (required) | `https://secureintent.ai/privacy.html` |

## License (source-disclosure step)
Source-available / view-only — see the repo `LICENSE`.

---

## Data collection disclosure — declared in the MANIFEST

AMO **requires** the `data_collection_permissions` key in the manifest for all new
add-ons, so it's declared in [`wxt.config.ts`](../wxt.config.ts) (Firefox build) and
AMO reads it automatically — you do **not** re-answer a separate form:

```jsonc
"data_collection_permissions": {
  "required": ["none"],                                  // core protection collects nothing
  "optional": ["technicalAndInteraction", "websiteActivity"] // opt-in telemetry
}
```

What this maps to for the listing/consent UI:
- **Required: none** — detection + warnings run 100% on-device and send nothing.
- **Optional — Technical and interaction data** — anonymous detection fingerprints
  (a salted one-way SHA-256 hash of a detected secret — never the secret itself),
  detection type, action chosen, plan tier, random install id. Opt-in via the
  in-product consent gate.
- **Optional — Website activity** — only the **domain** where a paste was
  intercepted (e.g. `chatgpt.com`), for coverage metrics. **No page content.**

> `websiteContent` is intentionally NOT declared — raw pasted text never leaves the
> device. `technicalAndInteraction` is valid only in `optional` (not `required`).
> The key is read by FF 140+; older Firefox ignores it, so the min version stays 115.

---

## Version notes / "What's new" (first Firefox release)
```
First Firefox release. On-device detection warns you before you paste secrets into AI tools and other sites. Free tier plus optional Pro (unlimited Anonymise & Paste, large-log sanitising, in-session restore, and a cloud-console PIN lock).
```

---

## Screenshots (upload 3–5; PNG/JPG)
Recommended shots:
1. The paste-warning overlay firing on a real AI site (secret masked in the shot).
2. The popup — "Protected" hero + plan checklist.
3. "Paste anonymously" result (tokens in place of a secret).
4. Ghost / large-log sanitiser summary.
5. Session Lock PIN screen on a cloud console.

Existing asset: `store-assets/banner-1280x800.png` (marketing banner — can be reused
as a promo tile; add real product screenshots for the gallery).

Social/preview image (for the site, not AMO): `landing_page/og-image.png` (1200×630).

---

## Reviewer notes (paste into the "source code" step — AMO requires source for bundled code)
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
- The Clerk key above is a public client (publishable) key, safe to embed. No
  private/secret keys are used at build time.
- eval/innerHTML flagged by the validator come from the bundled React DOM and Clerk
  SDK, not from our source. Our code never calls eval; overlays render into a CLOSED
  shadow root.
- Raw pasted text never leaves the device; only a salted one-way hash + metadata is
  sent, and only after in-product consent.
```
