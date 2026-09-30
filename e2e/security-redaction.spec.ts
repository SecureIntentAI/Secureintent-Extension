import { clickOverlayButton, expect, openEditor, paste, test } from './security-fixture';

test('anonymization removes all overlapping credentials from a trusted paste', async ({ page }) => {
  await openEditor(page);
  const key = `sk-${'a'.repeat(25)}`;
  await paste(page, `before API_KEY=${key};PASSWORD=second-secret after`);
  await clickOverlayButton(page, 'Paste anonymously');
  await expect(page.locator('secureintent-overlay')).toHaveCount(0);
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true });
  await expect(editor).toHaveValue(/^before ⟦SI:[0-9a-f]{8}⟧ after$/);
  expect(await editor.inputValue()).not.toContain(key);
  expect(await editor.inputValue()).not.toContain('second-secret');
});
