import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { DEFAULT_BUNDLE } from '../src/lib/config/default';
import { expect, test } from './fixtures';
import { seedPro } from './signing';

declare const chrome: {
  storage: {
    local: {
      remove(keys: string[]): Promise<void>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

const SITE = 'https://example.com/';
const fixture = new URL('./fixtures/draft-js/', import.meta.url);
const ASSETS: Record<string, string> = {
  'Draft.css': 'draft-js/dist/Draft.css',
  'Draft.min.js': 'draft-js/dist/Draft.min.js',
  'immutable.min.js': 'immutable/dist/immutable.min.js',
  'react.production.min.js': 'react/umd/react.production.min.js',
  'react-dom.production.min.js': 'react-dom/umd/react-dom.production.min.js',
};
const POST =
  'Looking for a Junior Engineer who’s excited about:\n\n' +
  '🔐 Cybersecurity & secret detection\n🧠 AI / LLM security\n' +
  '🖥 Desktop applications\n⚙️ Rust & Java\n' +
  '🌐 Browser extensions & developer tools\n🛡 DLP & data protection';
const SECRET = `sk-${'a'.repeat(30)}`;
const pageErrors = new WeakMap<Page, string[]>();

async function openEditor(page: Page) {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${SITE}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const dependency = ASSETS[name];
    const file = dependency
      ? new URL(`node_modules/${dependency}`, fixture)
      : new URL('index.html', fixture);
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      throw new Error(
        `Missing Draft.js fixture ${fileURLToPath(file)}. Run npm ci --prefix e2e/fixtures/draft-js --ignore-scripts first.`,
      );
    }
    await route.fulfill({
      contentType: dependency
        ? name.endsWith('.css')
          ? 'text/css'
          : 'text/javascript'
        : 'text/html',
      body,
    });
  });
  await page.goto(SITE);
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
  return page.locator('[contenteditable="true"]');
}

async function paste(page: Page, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press('ControlOrMeta+V');
}

async function expectModel(page: Page, text: string) {
  try {
    await expect.poll(() => page.locator('#model').textContent()).toBe(text);
    // Let asynchronous insertion validation settle too: correct model text
    // accompanied by a delayed false error is still a regression.
    await page.waitForTimeout(350);
    await expect(page.locator('secureintent-paste-status')).toHaveCount(0);
    expect(pageErrors.get(page)).toEqual([]);
  } catch (error) {
    const state = await page.evaluate(() => ({
      model: document.querySelector('#model')?.textContent,
      editor: document.querySelector('[contenteditable="true"]')?.innerHTML,
      status: document.querySelector('secureintent-paste-status')?.shadowRoot?.textContent,
      overlay: document.querySelector('secureintent-overlay')?.shadowRoot?.textContent,
    }));
    await test.info().attach('draft-editor-state', {
      body: Buffer.from(JSON.stringify({ ...state, errors: pageErrors.get(page) }, null, 2)),
      contentType: 'application/json',
    });
    await page.screenshot({ path: test.info().outputPath('draft-model-failure.png') });
    throw error;
  }
}

test.beforeEach(async ({ context }) => {
  await context.serviceWorkers()[0].evaluate(async () => {
    await chrome.storage.local.remove(['si_config', 'si_config_synced']);
  });
});

test.afterEach(async ({ context }) => {
  // The extension context is shared with other specs. Do not leave this
  // fixture's destination block or signed test entitlement active for them.
  await context.serviceWorkers()[0].evaluate(async () => {
    await chrome.storage.local.remove(['si_config', 'si_config_synced', 'si_entitlement']);
  });
});

test('Draft.js multiline emoji paste survives save/reopen, editing and select-all deletion', async ({
  context,
}) => {
  const page = await context.newPage();
  const editor = await openEditor(page);
  await editor.click();
  await paste(page, POST);
  // Checking only innerText misses the reported bug: all lines can be visible
  // while Draft.js stores only the last line in ContentState.
  await expectModel(page, POST);
  await page.locator('#save').click();
  await expect(page.locator('#saved')).toHaveText(POST);
  await page.locator('#reopen').click();
  await expectModel(page, POST);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('!');
  await expectModel(page, `${POST}!`);
  await page.keyboard.press('Backspace');
  await expectModel(page, POST);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expectModel(page, '');
  await expect(editor).toHaveText('');
  await page.close();
});

test('Draft.js anonymous paste replaces the original selection after warning focus changes', async ({
  context,
}) => {
  await seedPro(context);
  const page = await context.newPage();
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type('before OLD after');
  await page.keyboard.press('Home');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await paste(page, `🔐 ${SECRET}\n🛡 checked`);
  const overlay = page.locator('secureintent-overlay');
  await expect(overlay).toBeAttached();
  await expectModel(page, 'before OLD after');
  await overlay.getByText('Paste anonymously', { exact: true }).click();
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('#model')).toHaveText(/^before 🔐 ⟦SI:[0-9a-f]{8}⟧\n🛡 checked after$/);
  const masked = await page.locator('#model').textContent();
  expect(masked).not.toContain(SECRET);
  await expectModel(page, masked ?? '');
  const received = await page.evaluate(() =>
    JSON.parse(document.body.dataset.receivedPastes ?? '[]'),
  );
  expect(received).toHaveLength(1);
  expect(received[0]).toEqual({
    text: masked?.replace(/^before /, '').replace(/ after$/, ''),
    html: '',
    trusted: false,
  });
  await page.locator('#save').click();
  expect(await page.locator('#saved').textContent()).toBe(masked);
  await page.locator('#reopen').click();
  await expectModel(page, masked ?? '');
  await page.close();
});

test('Draft.js preserves leading, trailing and empty lines from a CRLF paste', async ({
  context,
}) => {
  const page = await context.newPage();
  const editor = await openEditor(page);
  await editor.click();
  const text = '\r\n🔐 first\r\n\r\n🛡 last\r\n';
  const expected = text.replace(/\r\n/g, '\n');
  await paste(page, text);
  await expectModel(page, expected);
  await page.locator('#save').click();
  expect(await page.locator('#saved').textContent()).toBe(expected);
  await page.locator('#reopen').click();
  await expectModel(page, expected);
  await page.close();
});

test('Draft.js preserves a soft newline before a multiline paste', async ({ context }) => {
  const page = await context.newPage();
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type('prefix');
  await page.keyboard.press('Shift+Enter');
  await expectModel(page, 'prefix\n');
  await paste(page, '🧠 first\n\n🛡 last');
  const expected = 'prefix\n🧠 first\n\n🛡 last';
  await expectModel(page, expected);
  await page.locator('#save').click();
  expect(await page.locator('#saved').textContent()).toBe(expected);
  // A delayed insertion-verification error must not appear after a valid model
  // update. Typing/deleting above already tests the subsequent edit path.
  await page.waitForTimeout(400);
  await expect(page.locator('secureintent-paste-status')).toHaveCount(0);
  await page.close();
});

test('Draft.js replaces a cross-block selection after a warning moves focus', async ({
  context,
}) => {
  const page = await context.newPage();
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type('before OLD');
  await page.keyboard.press('Enter');
  await page.keyboard.type('middle');
  await page.keyboard.press('Enter');
  await page.keyboard.type('OLD after');
  await expectModel(page, 'before OLD\nmiddle\nOLD after');
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 14; i++) await page.keyboard.press('Shift+ArrowRight');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('OLD\nmiddle\nOLD');
  await paste(page, `🔐 ${SECRET}\n🛡 replacement`);
  const overlay = page.locator('secureintent-overlay');
  await expect(overlay).toBeAttached();
  await expectModel(page, 'before OLD\nmiddle\nOLD after');
  await overlay.getByRole('button', { name: 'Paste anyway', exact: true }).click();
  const expected = `before 🔐 ${SECRET}\n🛡 replacement after`;
  await expectModel(page, expected);
  await page.locator('#save').click();
  expect(await page.locator('#saved').textContent()).toBe(expected);
  await page.close();
});

test('a blocked Draft.js destination never receives sensitive content', async ({ context }) => {
  await context.serviceWorkers()[0].evaluate(
    (bundle) =>
      chrome.storage.local.set({
        si_config: { ...bundle, policy: { blockedSites: ['example.com'] } },
      }),
    DEFAULT_BUNDLE,
  );
  const page = await context.newPage();
  const editor = await openEditor(page);
  await editor.click();
  await paste(page, `🔐 ${SECRET}\n🛡 do not send`);
  const overlay = page.locator('secureintent-overlay');
  await expect(overlay).toBeAttached();
  await expect(overlay.getByText('Paste anonymously', { exact: true })).toHaveCount(0);
  await expect(overlay.getByText('Paste anyway', { exact: true })).toHaveCount(0);
  await expectModel(page, '');
  await expect(editor).toHaveText('');
  expect(
    await page.evaluate(() => JSON.parse(document.body.dataset.receivedPastes ?? '[]')),
  ).toEqual([]);
  await page.close();
});
