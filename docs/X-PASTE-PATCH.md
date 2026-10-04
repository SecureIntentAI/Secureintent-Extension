# X / Draft.js multiline paste patch

This patch applies to the v1.2.0 Business onboarding branch. The supplied
`gmailss/xbug.mp4` recording shows v1.1.1: a multiline paste leaves visible text
that does not agree with the composer state, and reopening the draft loses most
of the text.

The guard previously replayed checked text into Draft.js with
`document.execCommand('insertText')`. Draft uses a controlled content model and
has a separate paste handler for creating multiline blocks. Updating its DOM
through the generic insertion path can leave that model out of sync.

## Implementation

- Recognize the Draft.js contenteditable and replay only the approved
  `text/plain` payload through its paste handler, after the existing scan and
  policy decision.
- Restore the saved selection, allow the editor to synchronize it, and verify
  that the operation, content, and selection are still current before replay.
- Verify the result using Draft block boundaries, including empty lines, CRLF
  normalization, and its DOM-only trailing soft-newline sentinel. Allow a
  bounded wait for a controlled render.
- Keep cancellation active during asynchronous waits. If the editor rejects or
  cannot confirm the paste, show the existing failure UI without retrying via
  the DOM insertion path.
- Await insertion for clean, anonymized, sanitized, and restored text. Existing
  ordinary-input and Slate insertion behavior remains in place.

The implementation is in `src/content/draftEditorPaste.ts` and its integration
in `src/content/createPasteGuard.ts`. No new production dependencies or browser
permissions are introduced.

## Regression checks

`e2e/draft-editor.spec.ts` mounts the published Draft.js 0.11.7 with React 17 in an
isolated local fixture. It checks the editor's `ContentState` and saved/reopened
draft, not just visible DOM text. The fixture dependencies are pinned in their
own manifest and lockfile and are never bundled in the extension.

```sh
pnpm compile
pnpm test
HEADLESS=1 pnpm e2e:draft
HEADLESS=1 pnpm e2e
```

The browser commands install the isolated fixture with `npm ci --ignore-scripts`
and build a test-only extension. A matching Playwright Chromium installation is
required (`pnpm exec playwright install chromium`). The tests use routed local
assets and synthetic content; no signed-in X account is involved.

`src/content/draftEditorPaste.test.ts` separately covers failure, cancellation,
plain-text-only replay, delayed rendering, and selection accounting.

Verified for this patch:

- Untouched baseline `cadf076` fails the real Draft multiline regression and
  raises a React DOM `removeChild` error, unmounting the test editor. This is a
  controlled reproduction of the incompatible insertion path; it is not a
  claim that the recording and fixture fail identically.
- All 822 unit tests across 71 files pass, including 13 new helper cases.
- All 35 Chromium tests in the default browser suite pass with retries disabled,
  including six new Draft regressions, ordinary-input protections, anonymization,
  restoration, file guards, and session lock.
- The packaged production Chrome build separately passes the three clean Draft
  cases: multiline emoji/save/reopen/edit/delete, CRLF/blank lines, and soft
  newlines. It uses the production verification key rather than the test key.
- TypeScript and Biome checks on the changed application files pass. Chrome MV3
  and Firefox MV2 production builds pass. Existing Clerk `import.meta` and
  large-chunk build warnings remain.

## Local installation

Build production packages without `WXT_E2E` or localhost API overrides:

```sh
pnpm zip
pnpm zip:firefox
```

For Chrome, load `dist/chrome-mv3/` using **Load unpacked** on
`chrome://extensions`, then reload the X tab. If an unpacked copy already points
to that folder, use its **Reload** button. Avoid running another SecureIntent
copy alongside it. The package version remains 1.2.0.

Built packages:

| Browser | Package | SHA-256 |
| --- | --- | --- |
| Chrome | `dist/secureintent-extension-1.2.0-chrome.zip` | `aeb2507f0c14b8e5693164d5f9b3c01dbc2d1128df719a9174d90c7eea4dd0bd` |
| Firefox | `dist/secureintent-extension-1.2.0-firefox.zip` | `b308bc644509bd5d7d7c4b7c2303c524039a7effdb746a8a97b0f7e950a425c7` |

Both archives were checked against their unpacked output: version 1.2.0, patched
paste handling present, production policy key present, test key and localhost
test API absent, and no fixture dependencies included. Generated artifacts under
`dist/` remain local and ignored by Git.

The automated browser verification exercises real Draft.js, not X's complete
authenticated application. A signed-in X draft round trip and Firefox runtime
verification remain separate manual checks. This patch does not publish a store
update.
