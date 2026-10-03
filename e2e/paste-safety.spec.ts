import type { Page } from '@playwright/test';
import { DEFAULT_BUNDLE } from '../src/lib/config/default';
import { expect, test } from './fixtures';

declare const chrome: {
  storage: {
    local: {
      remove(keys: string[]): Promise<void>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

const SECRET = `sk-${'a'.repeat(30)}`;
const OTHER = `sk-${'b'.repeat(30)}`;
const SITE = 'https://example.com/';
const HTML = '<!doctype html><meta charset="utf-8"><textarea id="ta"></textarea>';

async function paste(page: Page, text: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('ControlOrMeta+V');
}

// Requires WXT_E2E=1 for the existing test-only open shadow root.
test.beforeEach(async ({ context }) => {
  await context.serviceWorkers()[0].evaluate(async () => {
    await chrome.storage.local.remove(['si_config', 'si_config_synced']);
  });
});

test('a queued second paste is checked after the first warning is resolved', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#ta').click();
  await paste(page, SECRET);
  const overlay = page.locator('secureintent-overlay');
  await expect(overlay.getByRole('button', { name: 'Paste anyway', exact: true })).toBeVisible();
  // The composer retains focus in the warning. Explicit focus also tests
  // guarding the input even if a page/editor programmatically restores focus.
  await page.locator('#ta').focus();
  await paste(page, OTHER);
  await expect(page.locator('#ta')).toHaveValue('');
  await expect(overlay).toHaveCount(1);
  await overlay.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(overlay).toHaveCount(1);
  await expect(page.locator('#ta')).toHaveValue('');
  await overlay.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(overlay).toHaveCount(0);
  await page.locator('#ta').click();
  await paste(page, OTHER);
  await expect(overlay).toHaveCount(1);
  await expect(page.locator('#ta')).toHaveValue('');
  await page.close();
});

test('oversized paste is explained and dismissal leaves the next paste protected', async ({
  context,
}) => {
  const page = await context.newPage();
  await page.route(SITE, (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#ta').click();
  await paste(page, 'x'.repeat(2_000_001));
  const status = page.locator('secureintent-paste-status');
  await expect(status.getByText('Paste is too large', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('paste-too-large.png') });
  await expect(page.locator('#ta')).toHaveValue('');
  await status.getByRole('button', { name: 'Dismiss' }).click();
  await expect(status).toHaveCount(0);
  await page.locator('#ta').click();
  await paste(page, SECRET);
  await expect(page.locator('secureintent-overlay')).toHaveCount(1);
  await page.close();
});

test('a large benign paste is inserted exactly once after scanning', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#ta').click();
  const text = 'ordinary safe text '.repeat(8000);
  await paste(page, text);
  await expect(page.locator('#ta')).toHaveValue(text);
  await expect(page.locator('secureintent-paste-status')).toHaveCount(0);
  await expect(page.locator('secureintent-overlay')).toHaveCount(0);
  await page.close();
});

test('a rule with only case-insensitive flags warns without an infinite scan', async ({
  context,
}) => {
  const bundle = {
    ...DEFAULT_BUNDLE,
    patterns: [
      { type: 'known-key', label: 'Test team token', regex: 'acme-secret-[0-9]+', flags: 'i' },
    ],
  };
  await context
    .serviceWorkers()[0]
    .evaluate((b) => chrome.storage.local.set({ si_config: b }), bundle);
  const page = await context.newPage();
  await page.route(SITE, (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#ta').click();
  await paste(page, 'ACME-SECRET-1234');
  await expect(
    page.locator('secureintent-overlay').getByText('Test team token', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('#ta')).toHaveValue('');
  await page.close();
});

// Never execute this intentionally pathological expression on the page thread.
// The extension's external watchdog must terminate the dedicated worker.
async function seedSlowRule(context: import('@playwright/test').BrowserContext) {
  await context.serviceWorkers()[0].evaluate(
    (bundle) =>
      chrome.storage.local.set({
        si_config: {
          ...bundle,
          patterns: [
            ...bundle.patterns,
            {
              type: 'known-key',
              label: 'Slow test rule',
              regex: '(a+)+$',
              flags: 'g',
              origin: 'team',
            },
          ],
        },
      }),
    DEFAULT_BUNDLE,
  );
}

test('a catastrophic regex cannot freeze the page or popup and times out closed', async ({
  context,
  extensionId,
}) => {
  await seedSlowRule(context);
  const page = await context.newPage();
  await page.route(SITE, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: HTML,
      headers: {
        'Content-Security-Policy':
          "default-src 'none'; script-src 'none'; worker-src 'none'; frame-src 'none'",
      },
    }),
  );
  await page.goto(SITE);
  await page.evaluate(() => {
    document.body.dataset.beats = '0';
    setInterval(() => {
      document.body.dataset.beats = String(Number(document.body.dataset.beats) + 1);
    }, 20);
  });
  await page.locator('#ta').click();
  await paste(page, `${'a'.repeat(40)}!`);
  const status = page.locator('secureintent-paste-status');
  await expect(status.getByText('Checking paste…', { exact: true })).toBeVisible();
  const before = await page.evaluate(() => Number(document.body.dataset.beats));
  await expect
    .poll(() => page.evaluate(() => Number(document.body.dataset.beats)), { timeout: 2000 })
    .toBeGreaterThan(before + 15);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('.si-wordmark')).toBeVisible({ timeout: 2000 });
  await popup.close();
  await expect(status.getByText('Paste could not be completed', { exact: true })).toBeVisible({ timeout: 8000 });
  await status.getByRole('button', { name: 'Dismiss' }).click();
  await expect(status).toHaveCount(0);
  await expect(page.locator('#ta')).toHaveValue('');
  await page.screenshot({ path: test.info().outputPath('worker-timeout.png') });
  await page.locator('#ta').click();
  await paste(page, SECRET);
  await expect(page.locator('secureintent-overlay')).toHaveCount(1);
  await expect(page.locator('#ta')).toHaveValue('');
  await page.close();
});

test('Escape cancels a running regex without waiting for the watchdog', async ({ context }) => {
  await seedSlowRule(context);
  const page = await context.newPage();
  await page.route(SITE, (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#ta').click();
  await paste(page, `${'a'.repeat(40)}!`);
  await expect(page.locator('secureintent-paste-status')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('secureintent-paste-status')).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator('#ta')).toHaveValue('');
  await page.locator('#ta').click();
  await paste(page, 'ordinary safe message');
  await expect(page.locator('#ta')).toHaveValue('ordinary safe message', { timeout: 2000 });
  await page.close();
});

test('checked clean text replaces the original selection exactly once', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#ta').fill('before OLD after');
  await page
    .locator('#ta')
    .evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(7, 10));
  await paste(page, 'NEW');
  await expect(page.locator('#ta')).toHaveValue('before NEW after');
  await page.close();
});
