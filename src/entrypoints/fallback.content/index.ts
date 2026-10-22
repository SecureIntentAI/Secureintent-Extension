import { defineContentScript } from '#imports';
import '@/overlay/overlay.css';
import { createPasteGuard } from '@/content/createPasteGuard';
import { installFileGuard } from '@/content/fileGuard';
import { frameHostname } from '@/content/frame';

// Catch-all guard for every site that has no dedicated entrypoint. Runs on all
// http(s) pages but no-ops where a dedicated guard is present (it marks a shared
// window flag the fallback checks at paste time), so the 19 supported sites are
// never double-guarded. Its local file guard also checks supported file-input and
// drag/drop text files before page handlers receive them. Uses the bundle's
// `fallback` selector — any common text-entry element — and, like every guard,
// only surfaces the paste overlay when text matches a secret pattern.
//
// It runs in every frame, so editors embedded in an iframe (including
// about:blank and srcdoc frames, and on Chromium blob:/data: frames) are
// guarded too. Each frame guards its own fields and shows its own warning; a
// paste fires only in the frame that has focus, so it is checked once. Frames
// that are never used load nothing beyond their listeners (see whenFrameUsed).
// Dedicated site guards stay top-frame only; inside their frames this
// fallback is the guard.
export default defineContentScript({
  matches: ['*://*/*'],
  allFrames: true,
  matchAboutBlank: true,
  // Chromium only: also cover frames whose URL has no host of its own.
  matchOriginAsFallback: { chrome: true, edge: true, opera: true },
  cssInjectionMode: 'ui',
  runAt: 'document_start',
  async main(ctx) {
    installFileGuard(ctx);
    await createPasteGuard(ctx, { name: frameHostname(), siteKey: 'fallback' });
  },
});
