import { defineContentScript } from '#imports';
import { bridgeEnabledItem } from '@/settings';

// Tells the background worker which host the focused tab is on, so it can pass
// it to the desktop agent and the two products stop warning about the same copy
// twice.
//
// A content script rather than a `tabs` listener on purpose. A script already
// runs on every page for the fallback paste guard, and it can read its own
// address without any permission at all — whereas watching tabs from the
// background would mean the `tabs` permission, and a Chrome listing that
// declares it reads your browsing history. Same information, none of the
// disclosure.
//
// Only host and port are ever read. The path, query and fragment are not
// touched, because the agent only needs to know whether this is a local dev
// server and a URL's query string routinely carries session tokens.

/** Enough to cover a fast tab switch without reporting every one on the way. */
const DEBOUNCE_MS = 250;

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_idle',
  main() {
    const page = window as unknown as Record<string, boolean>;
    if (page.__secureintentBridge) return;
    page.__secureintentBridge = true;
    let enabled = false;
    // Only report a real move. An in-page route change in a single-page app
    // never alters host or port, so debouncing alone would still send a burst of
    // identical frames on a client-side router.
    let lastSent = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const report = () => {
      if (!enabled || !document.hasFocus()) return;
      const host = location.hostname;
      if (!host) return; // about:blank and similar have nothing to report
      const port = location.port ? Number(location.port) : null;
      // Scheme matters: the desktop parses what we send as a URL, and a dev
      // server on https behaves differently from one on http.
      const scheme = location.protocol === 'https:' ? 'https' : 'http';
      const key = `${scheme}://${host}:${port ?? ''}`;
      if (key === lastSent) return;
      lastSent = key;
      // Fire and forget. No agent, worker asleep, bridge off — all the same
      // answer here, and none of them are this page's problem.
      browser.runtime.sendMessage({ type: 'si-bridge-url', host, port, scheme }).catch(() => {});
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(report, DEBOUNCE_MS);
    };

    bridgeEnabledItem
      .getValue()
      .then((v) => {
        enabled = v;
        if (enabled) schedule();
      })
      .catch(() => {
        // Unreadable settings mean the feature stays off, which is the safe way
        // for an opt-in to fail.
      });

    bridgeEnabledItem.watch((v) => {
      enabled = v;
      if (enabled) schedule();
    });

    // Focus is what makes a tab the one the user is looking at; the agent has no
    // use for a background tab's address.
    window.addEventListener('focus', schedule, { passive: true });
    document.addEventListener('visibilitychange', schedule, { passive: true });
  },
});
