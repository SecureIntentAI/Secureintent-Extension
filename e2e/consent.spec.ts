import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Verifies the blocking Terms & Privacy consent gate end-to-end in a real
// browser: the first paste that would warn is intercepted by the consent gate,
// and only after agreeing does the actual secret warning show. Needs the open
// e2e shadow build (WXT_E2E=1) so we can click the button inside the overlay.

declare const chrome: {
  storage: {
    sync: {
      set(i: Record<string, unknown>): Promise<void>;
      remove(k: string[]): Promise<void>;
      get(k: string[]): Promise<Record<string, unknown>>;
    };
  };
};

const SECRET = `sk-${'a'.repeat(30)}`;
const SITE = 'https://example.com/'; // unsupported origin → the fallback guard owns it
const PAGE = `<!doctype html><meta charset="utf-8"><body><textarea id="ta"></textarea></body>`;

async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('ControlOrMeta+V');
}

test('consent gate blocks the first paste and unblocks after agreeing', async ({ context }) => {
  // Ensure Terms are NOT accepted for this test (fixture pre-accepts by default).
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.sync.remove(['si_terms_consent']));

  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));

  const consent = page.locator('secureintent-consent');
  const overlay = page.locator('secureintent-overlay');

  await test.step('first secret paste shows the consent gate, not the warning', async () => {
    await page.goto(SITE, { waitUntil: 'domcontentloaded' });
    await page.locator('#ta').click();
    await paste(page, `here ${SECRET} end`);
    await expect(consent).toBeAttached({ timeout: 5_000 });
    await expect(overlay).toHaveCount(0);
  });

  await test.step('agreeing closes the gate and shows the real warning', async () => {
    await consent.getByText('I Agree & Enable Protection').click();
    await expect(overlay).toBeAttached({ timeout: 5_000 });
    await expect(consent).toHaveCount(0);
  });

  await test.step('consent persists: a later secret paste goes straight to the warning', async () => {
    await page.goto(SITE, { waitUntil: 'domcontentloaded' });
    await page.locator('#ta').click();
    await paste(page, `again ${SECRET} end`);
    await expect(page.locator('secureintent-overlay')).toBeAttached({ timeout: 5_000 });
    await expect(page.locator('secureintent-consent')).toHaveCount(0);
  });

  // Restore the pre-accepted state for any later specs in this worker.
  await sw.evaluate(() =>
    chrome.storage.sync.set({ si_terms_consent: { version: 2, acceptedAt: Date.now() } }),
  );
});

test('welcome page: agree is gated on the checkbox and records consent', async ({
  context,
  extensionId,
}) => {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.sync.remove(['si_terms_consent']));

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/welcome.html`, {
    waitUntil: 'domcontentloaded',
  });

  const agree = page.getByRole('button', { name: /Activate protection/i });
  await expect(agree).toBeDisabled(); // can't accept until the box is ticked
  // Native checkbox is visually hidden; click its visible checkbox affordance,
  // rather than the label centre (which can fall on the policy link).
  await page.locator('label.w-consent .w-consent-box').click();
  await expect(page.getByRole('checkbox')).toBeChecked();
  await expect(agree).toBeEnabled();
  await agree.click();

  await expect(page.getByText(/You're protected/i)).toBeVisible();
  const stored = await sw.evaluate(() => chrome.storage.sync.get(['si_terms_consent']));
  expect(stored.si_terms_consent).toBeTruthy();

  await sw.evaluate(() =>
    chrome.storage.sync.set({ si_terms_consent: { version: 2, acceptedAt: Date.now() } }),
  );
});
