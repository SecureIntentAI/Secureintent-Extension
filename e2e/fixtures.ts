import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, test as base } from '@playwright/test';

declare const chrome: {
  storage: {
    local: { remove(keys: string[]): Promise<void> };
    sync: {
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
    };
  };
};

const dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(dirname, process.env.SI_E2E_EXTENSION ?? '../dist-e2e/chrome-mv3');

type WorkerFixtures = {
  // The persistent browser context, launched ONCE per worker. Playwright's
  // built-in `context` fixture is test-scoped and cannot be redeclared at
  // worker scope under the same name, so we back it with `_workerContext`
  // and expose it through the test-scoped `context` override below.
  _workerContext: BrowserContext;
  userDataDir: string;
};
type TestFixtures = { context: BrowserContext; extensionId: string };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // '' → Playwright uses a fresh temp profile. live.spec overrides via test.use({ userDataDir })
  // to reuse the saved-login profile (./.auth/profile).
  userDataDir: ['', { scope: 'worker', option: true }],

  _workerContext: [
    async ({ userDataDir }, use) => {
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: Boolean(process.env.HEADLESS),
        args: [
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`,
          '--disable-blink-features=AutomationControlled',
        ],
      });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await context.route('**/v1/telemetry', (route) => route.abort());
      // Block remote config sync so tests run against the bundled DEFAULT_BUNDLE
      // (deterministic) rather than whatever bundle is currently deployed.
      await context.route('**/v1/config', (route) => route.abort());
      // Clear any persisted bundle (e.g. a stale sync in .auth/profile) so
      // getActiveBundle falls back to the bundled DEFAULT_BUNDLE under test.
      let [sw] = context.serviceWorkers();
      if (!sw) sw = await context.waitForEvent('serviceworker');
      await sw.evaluate(async () => {
        await chrome.storage.local.remove(['si_config', 'si_config_synced']);
        // Pre-accept Terms & Privacy so guard-behavior specs exercise the paste
        // warning, not the first-run consent gate. The consent spec clears this.
        await chrome.storage.sync.set({ si_terms_consent: { version: 1, acceptedAt: Date.now() } });
      });
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  // Override the built-in test-scoped `context` to hand back the single
  // worker-scoped persistent context (one browser launch per worker/file).
  context: async ({ _workerContext }, use) => {
    await use(_workerContext);
  },

  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;
