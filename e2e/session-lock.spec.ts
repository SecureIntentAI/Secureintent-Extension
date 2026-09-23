import { createHash } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { seedPro } from './signing';

// Deterministic e2e for Session Lock (the cloud-console PIN gate). Seeds a known PIN hash +
// a sub-second timeout, serves a fake AWS console, and drives the lock/unlock.
// REQUIRES the e2e build (WXT_E2E=1) so the shadow root is open. No login.

declare const chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };

const SALT = 'testsalt';
const PIN = '1234';
// Mirrors computeFingerprint: SHA-256 of (salt + secret), hex.
const PIN_HASH = createHash('sha256').update(SALT + PIN).digest('hex');

const SITE = 'https://console.aws.amazon.com/console/home';
const GLOB = 'https://console.aws.amazon.com/**';
const PAGE = `<!doctype html><meta charset="utf-8"><body><h1>AWS Console</h1></body>`;

async function seed(context: BrowserContext): Promise<void> {
  await seedPro(context);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await sw.evaluate(
    ([salt, hash]) =>
      chrome.storage.local.set({
        si_fingerprint_salt: salt,
        si_lock_enabled: true,
        si_lock_pin: hash,
        si_lock_timeout_ms: 5000, // 5s inactivity for testing
      }),
    [SALT, PIN_HASH],
  );
}

test('locks the AWS console after inactivity and unlocks with the PIN', async ({ context }) => {
  await seed(context);
  const page = await context.newPage();
  await page.route(GLOB, (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  const lock = page.locator('secureintent-session-lock');

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });

  // Inactivity timer fires → lock appears.
  await expect(lock).toBeAttached({ timeout: 9_000 });

  // Wrong PIN auto-submits and is rejected (boxes clear, focus returns to box 1).
  await lock.getByLabel('PIN digit 1').click();
  await page.keyboard.type('0000');
  await expect(lock.getByText(/incorrect/i)).toBeVisible();

  // Correct PIN auto-submits and unlocks.
  await lock.getByLabel('PIN digit 1').click();
  await page.keyboard.type(PIN);
  await expect(lock).toHaveCount(0);

  await page.close();
});

test('stays locked across a reload', async ({ context }) => {
  await seed(context);
  const page = await context.newPage();
  await page.route(GLOB, (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  const lock = page.locator('secureintent-session-lock');

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await expect(lock).toBeAttached({ timeout: 9_000 });

  // A refresh must not bypass the lock — it re-locks immediately from the flag.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(lock).toBeAttached({ timeout: 9_000 });

  await page.close();
});
