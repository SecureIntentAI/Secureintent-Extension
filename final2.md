# SecureIntent extension v1.2.0 — final2 release candidate

Supersedes `final1` (built 4 October 2026, 04:01, before the Draft.js fix and
without the fixes below). `final1` artifacts are kept unchanged for rollback.

## What changed since final1

| Fix | Before (final1) | Now (final2) |
| --- | --- | --- |
| Multiline paste into rich editors (ProseMirror: ChatGPT/Claude; Quill: Gemini; Notion; Gmail) | Text was inserted, then a false "Paste could not be completed" dialog appeared | Inserted, no dialog. Verification compares the inserted characters and ignores how the editor lays out whitespace |
| Blocking error dialog | Back after `cadf076`, contrary to the earlier product decision (`b4aca32`) | Removed again: a failed paste is logged and released; raw text still stays blocked on every failure path |
| Paste into `input[type=email]` / number fields | Always failed (no selection API) | Inserted at the browser caret and confirmed |
| Anonymise on `postgres://user:password@host` | IP/email inside the URL outranked the connection string, so only the host was masked and the password leaked | Personal data inside a credential belongs to that credential; the whole string is masked |
| Draft.js multiline state (`255f4d2`) | Not included | Included |
| Manifest host permissions | `https://secureintent.ai/*` listed twice | De-duplicated |

Source: `fix/paste-bugs` @ `63d6b5e` (`f73e6d6` fixes + `63d6b5e` regression-test update),
based on `feat/v1.2.0-business-onboarding` @ `255f4d2`.

## Packages

| Browser | ZIP | Unpacked |
| --- | --- | --- |
| Chrome MV3 | `dist/final2.zip` | `dist/final2.mv3/` |
| Firefox MV2 | `dist/final2.firefox.zip` | `dist/final2.firefox/` |
| AMO source | `dist/final2-sources.zip` | — |

Checksums: `dist/final2-SHA256SUMS.txt`. Version `1.2.0` (bump to `1.2.1` if `1.2.0`
was ever uploaded to a store). Production API, Clerk `pk_live_…`, sync host
`clerk.secureintent.ai`, production policy key; no test key, no staging hosts.

## Verification (5 October 2026)

- Unit: 831 passed (822 + 9 new, including mutation-checked tests for the
  connection-string leak and email fields). Typecheck and lint clean.
- Extension browser regression suite (`HEADLESS=1 pnpm e2e`): 35/35.
- Real Chrome, `final2.mv3` against production: 12/12 (install, signed config
  v12, secret blocked, cancel, clean paste, multiline into a rich editor with no
  dialog, email field, connection string fully anonymised, popup).
- Real editors, multiline paste: ProseMirror (prosemirror.net) and Quill 2.0.3 —
  `final1` shows the false error dialog, `final2` does not.
- Firefox: `web-ext lint` 0 errors (64 warnings from bundled Clerk code), installs
  in Firefox 140 ESR; rebuilding from `final2-sources.zip` reproduces
  `final2.firefox` byte-for-byte.
- Backend real-browser integration (Chrome + Firefox, simulated Clerk, current
  backend): 3/3 — sign-in, Firefox renewal, policy enforcement, one admin save
  reaching both browsers.
- `dist/chrome-mv3` and `dist/firefox-mv2` rebuilt from the same commit are
  identical to the final2 folders.

## Still to prove with real accounts

Production Clerk sign-in inside both extensions, and organisation-attributed
events in ClickHouse and the dashboards (see the end-to-end runbook).
