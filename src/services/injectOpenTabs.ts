import { browser } from '#imports';
import { scriptsForUrl } from '@/lib/inject/openTabs';

/** Attach the paste guard to tabs that were already open when the extension loaded. */
export async function injectOpenTabs(): Promise<void> {
  if (!browser.scripting?.executeScript) return;
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null || !tab.url) return;
      const files = scriptsForUrl(tab.url);
      if (!files) return;
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: files as NonNullable<
            Parameters<typeof browser.scripting.executeScript>[0]['files']
          >,
        });
      } catch {
        // The tab cannot run scripts: a store page, a discarded tab, or a PDF.
      }
    }),
  );
}
