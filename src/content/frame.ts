import type { ContentScriptContext } from '#imports';

/** True in the tab's top-level document, false in any embedded frame. */
export const isTopFrame = (): boolean => window.top === window;

/**
 * The host a frame's content belongs to. about:blank, about:srcdoc and blob:
 * frames have no hostname of their own but run with their creator's origin,
 * so site rules (a team's blocked sites, our own pages) apply to them as they
 * do to that creator. An opaque frame falls back to the frame that embeds it.
 */
export function frameHostname(
  loc: Pick<Location, 'hostname'> & { ancestorOrigins?: DOMStringList } = location,
  origin: string = globalThis.origin,
): string {
  if (loc.hostname) return loc.hostname;
  for (const candidate of [origin, loc.ancestorOrigins?.[0]]) {
    if (!candidate || candidate === 'null') continue;
    try {
      const { hostname } = new URL(candidate);
      if (hostname) return hostname;
    } catch {
      // not a URL; try the next one
    }
  }
  return '';
}

/**
 * Run `attach` now and again whenever the document is rebuilt in place.
 * document.open() (used by pages that fill a frame with document.write) clears
 * every listener on the document and its window, ours included. `attach` must
 * add the same listener functions each time; the browser ignores a listener
 * that is already registered, so repeating it is harmless.
 */
export function keepListening(ctx: ContentScriptContext, attach: () => void): void {
  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document, { childList: true });
  ctx.onInvalidated?.(() => observer.disconnect());
}

const USE_EVENTS = ['focusin', 'pointerdown', 'keydown', 'paste', 'beforeinput', 'dragenter'];

/**
 * Resolves once the person starts using this frame: focus, a click, a key, a
 * paste or a drag. Pages can embed many frames that are never typed into (ads,
 * trackers, widgets); waiting for use keeps their cost to a few listeners.
 */
export function whenFrameUsed(ctx: ContentScriptContext): Promise<void> {
  return new Promise((resolve) => {
    if (document.hasFocus()) {
      resolve();
      return;
    }
    const used = () => resolve();
    keepListening(ctx, () => {
      for (const type of USE_EVENTS) {
        ctx.addEventListener(window, type as keyof WindowEventMap, used, {
          capture: true,
          passive: true,
        });
      }
    });
  });
}
