import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { seedPro } from './signing';

test.beforeEach(async ({ context }) => { await seedPro(context); });

// Deterministic e2e for the Ghost Sanitizer. Runs against the catch-all fallback
// guard on an UNSUPPORTED origin (no login). REQUIRES the e2e build
// (WXT_E2E=1 pnpm build) which opens the overlay shadow root so we can click
// "Sanitize & paste".

const SECRET = `sk-${'a'.repeat(30)}`;
const SITE = 'https://example.com/';
const PAGE = `<!doctype html><meta charset="utf-8"><body><textarea id="ta"></textarea></body>`;

// A log dump well over the 2000-char Ghost threshold, carrying a key, internal
// IPs (one repeated) and an email amid filler.
const FILLER = 'application request handled in 12ms by worker pool node-a '.repeat(50);
const LOG = `${FILLER}
ERROR auth failed key=${SECRET}
GET / from 10.0.4.21 -> upstream 192.168.1.10
retry from 10.0.4.21 paged owner ops@corp.example
${FILLER}`;

async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('ControlOrMeta+V');
}

test('large log paste shows the Ghost summary and Sanitize & paste strips everything', async ({
  context,
}) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  const overlay = page.locator('secureintent-overlay');

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  expect(LOG.length).toBeGreaterThan(2000);

  await page.locator('#ta').click();
  await paste(page, LOG);

  // Summary overlay (not the per-finding list) — it names the categories found.
  await expect(overlay).toBeAttached({ timeout: 5_000 });
  await expect(overlay.getByText(/IP address/)).toBeVisible({ timeout: 5_000 });
  await expect(overlay.getByText(/Email address/)).toBeVisible();

  await overlay.getByText('Sanitize & paste', { exact: true }).click();
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('#ta')).toHaveValue(/\[#SECRET_1#\]/);

  const out = await page.locator('#ta').inputValue();
  // Every sensitive value is gone…
  expect(out).not.toContain(SECRET);
  expect(out).not.toContain('10.0.4.21');
  expect(out).not.toContain('192.168.1.10');
  expect(out).not.toContain('ops@corp.example');
  // …replaced by typed placeholders, with the repeated IP correlated to one token.
  expect(out).toContain('[#SECRET_1#]');
  expect(out).toContain('[#EMAIL_1#]');
  expect((out.match(/\[#IP_1#\]/g) ?? []).length).toBe(2); // 10.0.4.21 appeared twice
  expect(out).toContain('[#IP_2#]'); // 192.168.1.10

  await page.close();
});

test('a small paste still uses the normal per-finding overlay, not Ghost', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  const overlay = page.locator('secureintent-overlay');

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.locator('#ta').click();
  await paste(page, `here ${SECRET} end`);

  await expect(overlay).toBeAttached({ timeout: 5_000 });
  // Normal mode exposes the reversible "Paste anonymously"; Ghost mode does not.
  await expect(overlay.getByText('Paste anonymously', { exact: true })).toBeVisible();
  await expect(overlay.getByText('Sanitize & paste', { exact: true })).toHaveCount(0);

  await page.close();
});
