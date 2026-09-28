import { defineContentScript } from '#imports';
import '@/overlay/overlay.css';
import { createPasteGuard } from '@/content/createPasteGuard';
import { installFileGuard } from '@/content/fileGuard';

// Catch-all guard for every site that has no dedicated entrypoint. Runs on all
// http(s) pages but no-ops where a dedicated guard is present (it marks a shared
// window flag the fallback checks at paste time), so the 19 supported sites are
// never double-guarded. Its local file guard also checks supported file-input and
// drag/drop text files before page handlers receive them. Uses the bundle's
// `fallback` selector — any common text-entry element — and, like every guard,
// only surfaces the paste overlay when text matches a secret pattern.
export default defineContentScript({
  matches: ['*://*/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_start',
  async main(ctx) {
    installFileGuard(ctx);
    await createPasteGuard(ctx, { name: location.hostname, siteKey: 'fallback' });
  },
});
