# SecureIntent

A browser extension that warns you **before** you paste API keys, tokens, or other
secrets into AI tools and other untrusted destinations. Detection runs entirely
**on-device** — your pasted text never leaves the browser.

> Cross-browser (Chrome, Edge, Firefox, Opera) from a single codebase, built on
> [WXT](https://wxt.dev) + React + TypeScript.

## What it does

- **Pre-paste secret detection.** A capture-phase paste listener inspects clipboard
  content on supported sites and blocks the paste if it contains a secret, showing a
  warning overlay rendered in a **closed Shadow DOM** for UI isolation. The host
  element remains part of the page; this is not an anti-tampering boundary.
- **Three ways to resolve a warning:** paste anyway, cancel, or **paste anonymously**.
- **Dehydrate ⇄ Rehydrate round-trip.** "Paste anonymously" replaces each secret with
  a reversible placeholder token (e.g. `⟦SI:a1b2c3d4⟧`) before it reaches the AI. When
  you later paste known tokens on the same origin, Pro users can explicitly restore
  them into the input. Copying does not rewrite the OS clipboard. The mapping lives
  in `storage.session`, expires after one hour, and is cleared when the browser
  closes. Background access is origin-bound and writes are serialized; an expiry
  alarm removes expired values when the browser runs it.
- **Ghost Sanitizer.** For large log/terminal pastes, an aggressive ruleset (keys plus
  public/private IPv4 addresses and emails) strips findings to typed placeholders
  (`[#SECRET_1#]`, `[#IP_1#]`, `[#EMAIL_1#]`) in one click, with a compact summary instead of
  a per-finding list.
- **Remote-tunable, signed policy.** Detection patterns and per-site selectors are
  fetched as an **Ed25519-signed** config bundle and verified before use, with a remote
  kill-switch. The extension ships with an offline fallback bundle and works without
  network access.

## Privacy model

Raw pasted text is a hard privacy boundary: it never leaves the device. Telemetry, when
sent, contains only a **salted SHA-256 fingerprint** of a detected secret (never the
secret itself), plus its type and label. The salt is a per-install random value stored
locally and never transmitted. Metadata also includes the action, site, plan and,
for team seats, organization and actor pseudonym. Business organization seats can
report recognized AI-site visits, paste byte counts and sensitive-paste outcomes
after Terms acceptance. Install/uninstall attribution is also reported (Chrome
install reporting does not wait for Terms acceptance). This is local text
processing, not zero metadata collection.

An intercepted paste fails **closed** on errors, overload or timeout: text is not
inserted and the user can dismiss the status and retry. This is text-paste DLP,
not interception of typing, file uploads, screenshots or all network traffic.

## Capacity and verification

The shared processing host supports up to 1,000 concurrent paste sessions, with
four active workers, a 64 MiB logical retained-input budget, a 30-second queue
deadline and a five-second per-operation watchdog. Idle dialogs do not reserve
workers. Over-budget requests are refused; this does not promise instantaneous
scanning of 1,000 maximum-size pastes or 1,000 arbitrary full websites.

`pnpm e2e` builds an isolated test artifact in `dist-e2e/`. It uses a public test
signing key and disables real account authentication. **Never distribute that
artifact.** Production builds remain in `dist/` and use the production public key.
See [hardening notes](docs/hardening.md) for limits and companion-app requirements.

## Supported sites

ChatGPT, Claude, Gemini, Perplexity, Microsoft Copilot, GitHub Copilot, Grok, Mistral,
Meta AI, Poe, v0, Bolt, Lovable, Replit, DeepSeek, DuckDuckGo AI, Kimi, Qwen, and Reddit.
A catch-all guard also protects common inputs on any other site.

## Tech stack

[WXT](https://wxt.dev) (wraps Vite; handles the MV3 manifest, cross-browser builds, and
entrypoint wiring) + React 19 + TypeScript. There is no hand-written `manifest.json`.

## Development

This project uses **pnpm**.

```bash
pnpm install        # install dependencies
pnpm dev            # dev server, Chrome target, with HMR
pnpm dev:firefox    # dev server, Firefox target
pnpm build          # production build → dist/chrome-mv3/
pnpm zip            # packaged zip for store submission
pnpm compile        # type-check (tsc --noEmit)
pnpm test           # unit tests (Vitest)
pnpm coverage       # unit tests with coverage
pnpm e2e            # end-to-end suite (Playwright, real Chromium)
pnpm lint           # Biome lint; `pnpm check` also checks formatting
pnpm semgrep        # custom static-analysis rules in semgrep/
```

`pnpm semgrep` needs Semgrep itself, which is a Python tool rather than a
dependency of this project:

```bash
brew install semgrep     # or: pipx install semgrep
```

The first `pnpm e2e` run also needs the browser Playwright drives:

```bash
pnpm exec playwright install chromium
```

## Project layout

```
src/
  entrypoints/      # per-site content scripts, background service worker, popup
  content/          # createPasteGuard — paste capture, detect, overlay, rehydrate
  overlay/          # closed Shadow DOM warning overlay (React)
  lib/
    detection/      # regex catalog, overlap resolution, tokenize, sanitize (Ghost)
    config/         # signed bundle: fetch, verify, validate, store
    fingerprint/    # per-install salt + salted SHA-256 fingerprint
    vault/          # RAM-only token→secret store for rehydration
    telemetry/      # fingerprint-only event reporting
```

Per-site content scripts are thin; all testable logic lives in `src/lib/`.

## License

Copyright (c) 2026 SECUREINTENT.AI LTD. All Rights Reserved. This repository is provided
for **view-only, security-auditing** purposes. See [LICENSE](LICENSE).
