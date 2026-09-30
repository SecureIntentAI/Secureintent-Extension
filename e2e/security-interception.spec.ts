import { clickOverlayButton, expect, openEditor, paste, test } from './security-fixture';

const SECRET = `sk-${'a'.repeat(30)}`;
const pagePastes = (page: import('@playwright/test').Page) => page.evaluate(
  () => (window as unknown as { pagePastes: string[] }).pagePastes,
);

test('window capture blocks the page inline listener and repeated trusted pastes', async ({ page }) => {
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true });
  await paste(page, SECRET);
  await expect(page.locator('secureintent-overlay')).toBeAttached();
  await expect(editor).toHaveValue('');
  expect(await pagePastes(page)).toEqual([]);
  await page.keyboard.press('ControlOrMeta+V');
  await expect(editor).toHaveValue('');
  expect(await pagePastes(page)).toEqual([]);
  // Even if the page returns focus to the underlying editor, the listener
  // itself must block repetition. The fix cannot depend on modal focus alone.
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(editor).toHaveValue('');
  expect(await pagePastes(page)).toEqual([]);
  await clickOverlayButton(page, 'Cancel');
  await expect(page.locator('secureintent-overlay')).toHaveCount(0);
  await editor.click();
  await paste(page, 'ordinary text');
  await expect(editor).toHaveValue('ordinary text');
  expect(await pagePastes(page)).toEqual(['ordinary text']);
});

test('an approved paste preserves selection replacement and undo', async ({ page }) => {
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true });
  await editor.fill('before replace after');
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 14));
  await paste(page, SECRET);
  await clickOverlayButton(page, 'Paste anyway');
  await expect(editor).toHaveValue(`before ${SECRET} after`);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(editor).toHaveValue('before replace after');
  expect(await pagePastes(page)).toEqual([]);
});

test('anonymization works in a contenteditable after dialog focus moves', async ({ page }) => {
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Rich editor' });
  await editor.fill('before replace after');
  await editor.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild!, 7);
    range.setEnd(el.firstChild!, 14);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await paste(page, SECRET);
  await clickOverlayButton(page, 'Paste anonymously');
  await expect(editor).toHaveText(/^before ⟦SI:[0-9a-f]{8}⟧ after$/);
  expect(await pagePastes(page)).toEqual([]);
});

test('consent gate also blocks repeated pastes and restores focus after Escape', async ({ page, worker }) => {
  await worker.evaluate('chrome.storage.sync.set({ si_terms_consent: null })');
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true });
  await paste(page, SECRET);
  await expect(page.locator('secureintent-consent')).toBeAttached();
  await expect.poll(() => page.evaluate(() => document.activeElement?.localName)).toBe('secureintent-consent');
  await page.keyboard.press('ControlOrMeta+V');
  await expect(editor).toHaveValue('');
  expect(await pagePastes(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('secureintent-consent')).toHaveCount(0);
  await expect(editor).toBeFocused();
  await paste(page, 'ordinary text');
  await expect(editor).toHaveValue('ordinary text');
});

test('dedicated and fallback guards intercept once before the page window listener', async ({ page }) => {
  const url = 'https://chatgpt.com/';
  await page.route(url, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><script>
      window.pagePastes=[];
      window.addEventListener('paste', e => window.pagePastes.push(e.clipboardData.getData('text/plain')), true);
    </script><textarea id="prompt-textarea" aria-label="Editor"></textarea>`,
  }));
  const ready = page.waitForEvent('console', { predicate: (message) => message.text().includes('ChatGPT · guard active') });
  await page.goto(url);
  await ready;
  await page.getByRole('textbox', { name: 'Editor' }).click();
  await paste(page, SECRET);
  await expect(page.locator('secureintent-overlay')).toHaveCount(1);
  expect(await pagePastes(page)).toEqual([]);
  await clickOverlayButton(page, 'Cancel');
  await expect(page.locator('secureintent-overlay')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Editor' })).toHaveValue('');
});
