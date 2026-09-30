import type { Page, Worker } from '@playwright/test';
import { DEFAULT_BUNDLE } from '../src/lib/config/default';
import type { ConfigBundle } from '../src/lib/config/types';
import { clickOverlayButton, expect, openEditor, paste, SITE, test } from './security-fixture';

declare const chrome: {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
};

async function update(page: Page, worker: Worker, bundle: ConfigBundle, valid = true) {
  const applied = page.waitForEvent('console', {
    predicate: (message) => message.text().includes(valid
      ? 'guard configuration updated' : 'keeping previous guard configuration'),
    timeout: 5_000,
  });
  // Inject at the persisted-config boundary. This verifies live enforcement;
  // signature verification and transport remain covered by configService tests.
  await worker.evaluate((value) => chrome.storage.local.set({ si_config: value }), bundle);
  await applied;
}

const blockedBundle: ConfigBundle = {
  ...DEFAULT_BUNDLE,
  version: DEFAULT_BUNDLE.version + 1,
  policy: {
    blockInsteadOfWarn: true,
    requireSessionLock: false,
    blockedSites: [new URL(SITE).hostname],
  },
};

test('an existing tab applies and removes a site block without reloading', async ({ page, worker, context }) => {
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true });
  await update(page, worker, blockedBundle);
  await paste(page, 'ordinary text');
  await expect(page.locator('secureintent-overlay')).toBeAttached();
  await expect(editor).toHaveValue('');
  await clickOverlayButton(page, 'Dismiss');

  const newPage = await context.newPage();
  await openEditor(newPage);
  await paste(newPage, 'ordinary text');
  await expect(newPage.locator('secureintent-overlay')).toBeAttached();
  await expect(newPage.getByRole('textbox', { name: 'Editor', exact: true })).toHaveValue('');
  await newPage.close();

  await update(page, worker, { ...DEFAULT_BUNDLE, version: blockedBundle.version + 1 });
  await editor.click();
  await paste(page, 'ordinary text');
  await expect(editor).toHaveValue('ordinary text');
  await expect(page.locator('secureintent-overlay')).toHaveCount(0);
});

test('a tightened policy invalidates a pending warning before any insertion', async ({ page, worker }) => {
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true });
  await paste(page, `sk-${'a'.repeat(30)}`);
  await expect(page.locator('secureintent-overlay')).toBeAttached();
  await update(page, worker, blockedBundle);
  await expect(page.locator('secureintent-overlay')).toHaveCount(0);
  await expect(editor).toHaveValue('');
  await editor.click();
  await paste(page, 'ordinary text');
  await clickOverlayButton(page, 'Dismiss');
  await expect(editor).toHaveValue('');
});

test('an invalid selector update retains the previous working block', async ({ page, worker }) => {
  await openEditor(page);
  await update(page, worker, blockedBundle);
  await update(page, worker, {
    ...DEFAULT_BUNDLE,
    version: blockedBundle.version + 1,
    sites: { fallback: { inputSelector: '[' } },
  }, false);
  await paste(page, 'ordinary text');
  await expect(page.locator('secureintent-overlay')).toBeAttached();
  await expect(page.getByRole('textbox', { name: 'Editor', exact: true })).toHaveValue('');
  await clickOverlayButton(page, 'Dismiss');
});

test('custom rules and the kill switch update on the existing page', async ({ page, worker }) => {
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true });
  const custom: ConfigBundle = {
    ...DEFAULT_BUNDLE,
    patterns: [{ type: 'known-key', label: 'Team token', regex: 'TEAM-SENSITIVE', origin: 'team' }],
  };
  await update(page, worker, custom);
  await paste(page, 'TEAM-SENSITIVE');
  await expect(editor).toHaveValue('');
  await clickOverlayButton(page, 'Cancel');
  await update(page, worker, { ...custom, killSwitch: true });
  await editor.click();
  await paste(page, 'TEAM-SENSITIVE');
  await expect(editor).toHaveValue('TEAM-SENSITIVE');
  await editor.fill('');
  await update(page, worker, { ...custom, killSwitch: false });
  await paste(page, 'TEAM-SENSITIVE');
  await expect(page.locator('secureintent-overlay')).toBeAttached();
  await expect(editor).toHaveValue('');
});
