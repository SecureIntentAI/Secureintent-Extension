# Universal detector development branch

Branch: `feat/v1.2.0-universal-detector`, based on `shadow-ai-features` at tag `v1.1.1` (`b49b8bd`). The package version is now `1.2.0` for local release-candidate packaging. Candidate zips exist in `dist/` but are not approved for submission while the manual gates below remain open. Do not submit `dist-e2e` to a browser store.

## Branch history

- `main` is at `f6a81fa` (`v1.0.14`) and is an ancestor of `v1.1.1`.
- `v1.1.0` (`a3b1176`) introduced the Business Shadow AI domain catalog, local visit tracking, privacy-limited service telemetry, and policy refresh/enforcement work.
- `v1.1.1` (`b49b8bd`) clarified Business metadata disclosures. The release line is 15 commits and 104 changed files beyond `main`.
- The current `feat/v1.2.0-universal-detector` branch still points to `b49b8bd`; the universal detector/file guard work has not been committed yet and exists in the worktree.

## Business Pro policy baseline

`main` (`f6a81fa`) is an ancestor of `v1.1.1`. The latest source and local v1.1.1 ZIP contain the team policy client paths. The admin controls live on `secureintent.ai/team.html`; the extension links admins there and consumes a signed `/v1/config` bundle. Existing policy checks cover custom patterns, blocked sites, blocking instead of warning, required Session Lock, and AI-service paste rules. Local extension policy tests and backend config/team route tests pass. This does not verify a real Business Pro admin/member account against the installed Web Store package. That live-account parity check is still required before release.

## Current local changes

- The detector now checks JSON string values and `.env` assignments using field context and entropy. It keeps offsets so sanitization can replace the value without removing the JSON field name.
- Aggressive mode recognizes long random-looking tokens with dots, hyphens, or underscores, including standalone tokens without provider-specific prefixes. It skips URL-like contexts. This is a possible-secret finding, not provider identification.
- A versioned synthetic detector corpus now covers 10 positive and 12 negative cases in `src/lib/detection/corpus/v1_2_0.ts`. It also exposed and fixed placeholder false positives from the generic credential-assignment and JSON patterns.
- Text file selection and drag-and-drop are checked locally before the page's `input`, `change`, or `drop` handler receives the file. Supported formats include JSON, JSONL, text, logs, `.env`, YAML, CSV, Markdown, XML, and configuration files. Files over 4 MB, selections over 8 MB total, text over 2 million characters, and selections over 10 files are refused. Existing team custom patterns and `blockInsteadOfWarn` apply to these scans.
- The file guard requires current consent before scanning or passing supported files to the page. Dismissing that gate cancels the pending selection/drop.
- The file warning is an accessible modal dialog with labelled content, keyboard focus trapping, Escape-to-cancel, and focus restoration after dismissal.
- The browser tests use a localhost API build and do not deploy anything.

## Run locally

```bash
pnpm test
pnpm compile
WXT_E2E=1 WXT_API_BASE=http://localhost:18788 WXT_WEB_APP_URL=http://localhost:18789 ./node_modules/.bin/wxt build
HEADLESS=1 ./node_modules/.bin/playwright test e2e/file-guard.spec.ts e2e/paste-safety.spec.ts
```

The localhost API does not need to be running for these browser tests; tests route config/telemetry and validate local scanning. Do not load a normal `pnpm build` test extension when testing with private files: its default API points to production.

Current extension verification on 2026-09-26:

- `vitest run`: 678 passing tests across 66 files.
- TypeScript compile: passed (`tsc --noEmit`).
- Biome check: passed for the updated detector and corpus files.
- `pnpm e2e`: passed all 27 Chromium tests after the file-dialog accessibility change, including consent, picker, drop, policy-block, keyboard cancellation, and worker-load coverage. The test build was written to `dist-e2e`.
- The versioned synthetic corpus matched all expected outcomes: 10/10 positives detected and 12/12 negatives left clean. This is regression evidence, not a measured production false-positive rate.

Isolated production builds of both Chrome MV3 and Firefox MV2 completed from the current worktree and produced local v1.2.0 packages. The Chrome and Firefox packages use manifest versions 3 and 2 respectively, report extension version `1.2.0`, pass ZIP integrity checks, and have checksums recorded in `dist/secureintent-extension-1.2.0-SHA256SUMS.txt`. The Firefox data-collection declaration is present. A source archive was also generated with `.env`, dependency, and local test artifacts excluded. Existing v1.1.0/v1.1.1 ZIPs were preserved. The large-chunk warning is also present in the local v1.1.1 Chrome bundle: its background and popup chunks are about 2.68 MB and 1.06 MB, versus 2.68 MB and 1.06 MB in the current test build. Clerk's `import.meta`/IIFE warning still needs a release review. Firefox runtime testing remains outstanding; system Firefox is installed, but the Playwright Firefox binary, `geckodriver`, and `web-ext` are not available here. The earlier 84 backend config/team test result is from the prior local note, not a run performed against this extension worktree.

## Release gates still open

- Verify an actual Business Pro admin saves a rule, a member receives a signed updated policy, and the installed extension enforces it. Include sign-out, seat removal, and stale-policy cases.
- Test supported file uploads against real target sites. A site can upload through programmatic `fetch`, a custom network path, or an editor that bypasses file input and drop events; this branch does not claim to intercept those paths. Binary files are not scanned.
- File-scan disclosure is now in extension consent and store copy; file scans run locally and emit no file-specific telemetry. Update and review the linked website Privacy Policy in its own repository before release. That repository already has other uncommitted changes, so coordinate rather than overwriting its work.
- Expand the synthetic corpus with reviewed, sanitized representative samples and investigate its false-positive/miss results. Review custom regex safety, performance on adversarial input, file replay compatibility, accessibility, and browser permissions.
- Complete review of the local `1.2.0` candidate: accept or resolve the Clerk warning, run Firefox runtime checks, inspect both manifests and package contents, rerun checksums if artifacts change, and document rollback. No merge or store submission before these gates pass.

## Rollback plan

- The current candidate has not been submitted. If any pre-release gate fails, keep v1.1.1 published and replace or discard the local candidate packages.
- This extension change does not include a backend schema or database migration. File contents remain local and file scans do not emit telemetry.
- If v1.2.0 is published and causes a Chrome regression, use the Chrome Web Store rollback action to republish the previous package under a new version number, then verify the dashboard and listing. See [Chrome Web Store rollback](https://developer.chrome.com/docs/webstore/rollback).
- For Firefox, select the previous published version in AMO's rollback flow and assign a version higher than all previously submitted versions; AMO generates and signs the rollback package. See [AMO version rollback](https://extensionworkshop.com/documentation/publish/version-rollback/).
- Consent storage remains compatible with v1.1.1: v1.2.0 writes terms version 3, while v1.1.1 accepts any stored version `>= 2`.
- The remote kill switch disables all paste and file scanning; there is no file-only remote switch. Use it only for emergency containment because it also disables paste protection.

## Five-day release cadence

1. Align the live Privacy Policy with the extension disclosures and book Business Pro and target-site test access.
2. Complete the detector corpus/false-positive review and test supported file uploads on the agreed target sites.
3. Run Firefox runtime checks and the live Business Pro policy/member scenarios.
4. Refresh the local `1.2.0` candidate if earlier checks require changes, review warnings and both manifests, and confirm package checksums and rollback steps.
5. Make the go/no-go decision from the evidence, then submit only the approved candidate.
