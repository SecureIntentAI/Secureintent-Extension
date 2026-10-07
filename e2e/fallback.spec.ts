import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Deterministic e2e for the catch-all fallback guard. No login or live site: we
// serve a fake page on an UNSUPPORTED origin (so no dedicated guard runs and the
// *://*/* fallback content script handles it) via route fulfillment, then drive
// common inputs. Asserts overlay attachment only (the host is in light DOM, so
// this works with the closed-shadow production build too).

const SECRET = `sk-${'a'.repeat(30)}`;
const SITE = 'https://example.com/'; // not in our supported list → fallback owns it
const PAGE = `<!doctype html><meta charset="utf-8"><body>
  <textarea id="ta"></textarea>
  <input id="inp" type="text" />
  <div id="ce" contenteditable="true">&#8203;</div>
</body>`;

async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('ControlOrMeta+V');
}

test('fallback guards common inputs on an unsupported site', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGE }),
  );
  const overlay = page.locator('secureintent-overlay');

  await test.step('benign paste passes through (no overlay)', async () => {
    await page.goto(SITE, { waitUntil: 'domcontentloaded' });
    await page.locator('#ta').click();
    await paste(page, 'just a normal message, nothing secret here');
    await page.waitForTimeout(500);
    await expect(overlay).toHaveCount(0);
  });

  // Each common text-entry element should trip the guard on a secret paste.
  // Reload per field so each runs against a fresh content-script instance.
  for (const selector of ['#ta', '#inp', '#ce']) {
    await test.step(`secret paste into ${selector} mounts the overlay`, async () => {
      await page.goto(SITE, { waitUntil: 'domcontentloaded' });
      await page.locator(selector).click();
      await paste(page, `here ${SECRET} end`);
      await expect(overlay).toBeAttached({ timeout: 5_000 });
    });
  }
});

// One payload per secret category, asserted end-to-end through the real engine.
const SHOULD_FLAG: { name: string; payload: string }[] = [
  { name: 'email in a short paste', payload: 'john.wright@secureintent.ai at 2026-06-08T14:20:00Z' },
  { name: 'IPv4 in a short paste', payload: 'server address 10.22.33.44' },
  { name: 'OpenAI API key', payload: `sk-${'a'.repeat(30)}` },
  { name: 'credit card (Luhn)', payload: 'card 4597 3579 1372 4576 here' },
  {
    name: 'AWS secret access key (labelled)',
    payload: 'Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  // pilot/aggressive: entropy patterns are on in the bundled DEFAULT_BUNDLE
  { name: 'high-entropy hex (pilot)', payload: 'd41d8cd98f00b204e9800998ecf8427e3bbce4dbca09a9e3aeb5c55a40a5a51a' },
];

// Still ignored even in pilot mode — separators / short runs / failed validation.
const SHOULD_PASS: { name: string; payload: string }[] = [
  { name: 'invalid-Luhn card', payload: 'card 4597 3579 1372 4577 here' },
  { name: 'normal sentence', payload: 'Please review the pull request and merge it when ready.' },
  { name: 'UUID', payload: 'request id 550e8400-e29b-41d4-a716-446655440000' },
  { name: 'timestamp', payload: 'Event at 2026-06-08T14:20:00Z' },
];

test('fallback flags each secret category', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  const overlay = page.locator('secureintent-overlay');

  for (const { name, payload } of SHOULD_FLAG) {
    await test.step(`flags ${name}`, async () => {
      await page.goto(SITE, { waitUntil: 'domcontentloaded' });
      await page.locator('#ta').click();
      await paste(page, payload);
      await expect(overlay).toBeAttached({ timeout: 5_000 });
    });
  }
});

test('fallback ignores non-secrets (no false positives)', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  const overlay = page.locator('secureintent-overlay');

  for (const { name, payload } of SHOULD_PASS) {
    await test.step(`ignores ${name}`, async () => {
      await page.goto(SITE, { waitUntil: 'domcontentloaded' });
      await page.locator('#ta').click();
      await paste(page, payload);
      await page.waitForTimeout(500);
      await expect(overlay).toHaveCount(0);
    });
  }
});
