# SecureIntent extension v1.2.0 — final3 release candidate

Supersedes `final2`. `final1` and `final2` artifacts are kept unchanged for rollback.

**Needs the new backend first:** Worker from secureintent-backend PR #8 (accepts the
`sanitised` and `blocked` telemetry actions). The live backend before that answers 400 to
them and the extension drops those events.

## What changed since final2

| Fix | Before (final2) | Now (final3) |
| --- | --- | --- |
| Firefox popup "Couldn't check your plan just now" | Every Clerk cookie rotation (every 1 to 3 s while a secureintent.ai tab is open) counted as a session change, cancelled the plan check and showed the message | Only a change of account, session or sign-in state counts; a check cancelled by a real change answers with a fresh check |
| Ghost (large) pastes missing from the admin console | No telemetry for Ghost or capped pastes | Every warned paste reports; new outcomes `sanitised` and `blocked`, recorded only when the insert happened |
| "Use only these patterns" | Built-in email and IP checks still ran | Team-only mode runs only the team's patterns (paste and file guards) |
| Policy rollout flapping in the console | Sleeping, loading, frozen and store tabs held receipts at pending | Those tabs are skipped |
| Popup for Business admins | No Manage team link; org seat lost to a lifetime grant (backend) | Manage team and Shadow AI dashboard cards (org, seats), admin only |
| Built-in "Possible API key" rule (PR #8) | Not included | Included, matches config bundle v13 |
| Copy | Dashes in popup, overlay, welcome | Removed; team alerts marked coming soon |

Source: branch `fix/no-dashes` @ `d12d25d` (on `fix/paste-bugs` @ `47a7bc8` + PR #8 `571771f`).

## Packages

| Browser | ZIP | Unpacked |
| --- | --- | --- |
| Chrome MV3 | `dist/final3.zip` | `dist/final3.mv3/` |
| Firefox MV2 | `dist/final3.firefox.zip` | `dist/final3.firefox/` |
| AMO source | `dist/final3-sources.zip` | — |

Checksums: `dist/final3-SHA256SUMS.txt`. Version `1.2.0` (never uploaded to a store).
Production API, Clerk `pk_live_…`, sync host `clerk.secureintent.ai`.

`final3-sources.zip` is `git archive` of the source commit **without `.env`**. Add the
build-time `.env` (publishable values only) before uploading to AMO, as for final2.

## Verification (7 October 2026)

- Unit: 865 passed (including mutation-checked tests: the cookie-rotation and
  superseded-check tests fail on final2 code and pass now). Typecheck clean; Biome 12
  errors, all pre-existing (16 before).
- Extension browser regression suite (`HEADLESS=1 pnpm e2e`): 35/35.
- `dist/chrome-mv3` rebuilt by the e2e run is identical to `final3.mv3`.
- Firefox `web-ext lint`: 0 errors (66 warnings from bundled Clerk code).

## Still to prove with real accounts

Firefox popup with a secureintent.ai tab open (no false message, no `/v1/entitlement`
every few seconds); Ghost paste events and member names in the console; one-code member
join followed by the extension picking up the sign-in in Chrome and Firefox.
