import { browser } from '#imports';
import { scriptsForUrl } from '@/lib/inject/openTabs';

/** Attach the paste guard to tabs that were already open when the extension loaded. */
export async function injectOpenTabs(): Promise<void> {
  const modernInjection = typeof browser.scripting?.executeScript === 'function';
  if (!modernInjection && typeof browser.tabs.executeScript !== 'function') return;
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null || !tab.url) return;
      const files = scriptsForUrl(tab.url);
      if (!files) return;
      try {
        if (modernInjection) {
          await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: files as NonNullable<
              Parameters<typeof browser.scripting.executeScript>[0]['files']
            >,
          });
        } else {
          // Firefox MV2 accepts one file per call. Await each so a dedicated
          // guard claims its page before the fallback guard checks ownership.
          for (const file of files) await browser.tabs.executeScript(tab.id, { file: `/${file}` });
        }
      } catch {
        // The tab cannot run scripts: a store page, a discarded tab, or a PDF.
      }
    }),
  );
}
