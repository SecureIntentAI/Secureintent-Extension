# Draft.js browser regression fixture

This fixture runs the published Draft.js 0.11.7 editor with its supported React
17 dependencies. It reproduces the multiline paste/model mismatch seen in the X
recording without using a signed-in account, sending a post, or saving an X draft.
It is a framework compatibility fixture, not a copy of X's current application.

Install the isolated test dependencies from the repository root:

```sh
npm ci --prefix e2e/fixtures/draft-js --ignore-scripts
```

Build the extension with its existing E2E flags, then run:

```sh
HEADLESS=1 ./node_modules/.bin/playwright test e2e/draft-editor.spec.ts
```

Playwright fulfills the fixture HTML and UMD assets locally at `example.com`.
No CDN or network service is needed during the tests. These dependencies are
outside the extension build and never ship in its bundles.

The assertions compare Draft.js `ContentState.getPlainText()` with the expected
text, then save and reopen that model. Merely asserting visible DOM text would
miss the reported bug. Coverage includes multiline emoji text, subsequent typing
and deletion, replacing a selection after the warning takes focus, anonymized
content, and destination-policy blocking.
