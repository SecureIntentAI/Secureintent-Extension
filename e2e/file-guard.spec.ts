import { DEFAULT_BUNDLE } from '../src/lib/config/default';
import { expect, test } from './fixtures';

declare const chrome: {
  storage: {
    local: { set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> };
    sync: { set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> };
  };
};

const SITE = 'https://example.com/';
const HTML = `<!doctype html><meta charset="utf-8">
  <input id="upload" type="file" accept=".json,.txt">
  <div id="drop">Drop files here</div>
  <div id="received"></div>
  <script>
    document.querySelector('#upload').addEventListener('input', (event) => {
      document.querySelector('#received').dataset.inputSeen = event.target.files?.[0]?.name || '';
    });
    document.querySelector('#upload').addEventListener('change', (event) => {
      document.querySelector('#received').textContent = event.target.files?.[0]?.name || '';
    });
    document.querySelector('#drop').addEventListener('drop', (event) => {
      event.preventDefault();
      document.querySelector('#received').textContent = event.dataTransfer?.files?.[0]?.name || '';
    });
  </script>`;

test.beforeEach(async ({ context }) => {
  await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.remove(['si_config', 'si_config_synced']));
});

test('requires current consent before scanning or passing a selected file', async ({ context }) => {
  const [sw] = context.serviceWorkers();
  await sw.evaluate(() => chrome.storage.sync.remove(['si_terms_consent']));
  const page = await context.newPage();
  try {
    await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
    await page.goto(SITE);
    await page.locator('#upload').setInputFiles({
      name: 'secrets.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ apiKey: 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3' }),
      ),
    });
    const consent = page.locator('secureintent-consent');
    await expect(
      consent.getByRole('heading', { name: 'One quick step before we check this file' }),
    ).toBeVisible();
    await expect(page.locator('secureintent-file-check')).toHaveCount(0);
    await expect(page.locator('#received')).toBeEmpty();
    await consent.getByRole('button', { name: 'I Agree & Enable Protection' }).click();
    const warning = page.locator('secureintent-file-check');
    await expect(warning.getByText('SecureIntent found 1 possible secret')).toBeVisible();
    await expect(page.locator('#received')).toBeEmpty();
    await warning.getByRole('button', { name: 'Upload anyway' }).click();
    await expect(page.locator('#received')).toHaveText('secrets.json');
  } finally {
    await sw.evaluate(() =>
      chrome.storage.sync.set({ si_terms_consent: { version: 3, acceptedAt: Date.now() } }),
    );
    await page.close();
  }
});

test('warns before a JSON file reaches the page upload handler', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#upload').setInputFiles({
    name: 'secrets.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ apiKey: 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3' })),
  });
  const warning = page.locator('secureintent-file-check');
  await expect(warning.getByText('SecureIntent found 1 possible secret')).toBeVisible();
  await expect(page.locator('#received')).toBeEmpty();
  await expect(page.locator('#received')).not.toHaveAttribute('data-input-seen', 'secrets.json');
  await warning.getByRole('button', { name: 'Upload anyway' }).click();
  await expect(page.locator('#received')).toHaveText('secrets.json');
  await expect(page.locator('#received')).toHaveAttribute('data-input-seen', 'secrets.json');
  await page.close();
});

test('team policy blocks the JSON file before the page receives it', async ({ context }) => {
  const bundle = {
    ...DEFAULT_BUNDLE,
    policy: { blockInsteadOfWarn: true, requireSessionLock: false, blockedSites: [] },
  };
  await context.serviceWorkers()[0].evaluate((b) => chrome.storage.local.set({ si_config: b }), bundle);
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#upload').setInputFiles({
    name: 'secrets.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ apiKey: 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3' })),
  });
  const warning = page.locator('secureintent-file-check');
  await expect(warning.getByText('Your team blocks uploads containing sensitive information')).toBeVisible();
  await expect(warning.getByRole('button', { name: 'Upload anyway' })).toHaveCount(0);
  await expect(page.locator('#received')).toBeEmpty();
  await page.close();
});

test('file warning traps keyboard focus and Escape cancels the upload', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#upload').setInputFiles({
    name: 'secrets.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ apiKey: 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3' }),
    ),
  });
  const warning = page.locator('secureintent-file-check');
  await expect(
    warning.getByRole('alertdialog', { name: 'SecureIntent file check' }),
  ).toBeVisible();
  const cancel = warning.getByRole('button', { name: 'Cancel upload' });
  const allow = warning.getByRole('button', { name: 'Upload anyway' });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(allow).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(warning).toHaveCount(0);
  await expect(page.locator('#received')).toBeEmpty();
  await page.close();
});

test('a clean text file reaches the page only after local scanning', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#upload').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('ordinary meeting notes'),
  });
  await expect(page.locator('#received')).toHaveText('notes.txt');
  await expect(page.locator('secureintent-file-check')).toHaveCount(0);
  await page.close();
});

test('a JSON file dropped onto a page is checked before replay', async ({ context }) => {
  const page = await context.newPage();
  await page.route(SITE, (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto(SITE);
  await page.locator('#drop').evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify({ apiKey: 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3' })], 'secrets.json', { type: 'application/json' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  const warning = page.locator('secureintent-file-check');
  await expect(warning.getByText('SecureIntent found 1 possible secret')).toBeVisible();
  await expect(page.locator('#received')).toBeEmpty();
  await warning.getByRole('button', { name: 'Upload anyway' }).click();
  await expect(page.locator('#received')).toHaveText('secrets.json');
  await page.close();
});
