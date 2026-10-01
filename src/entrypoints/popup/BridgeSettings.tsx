import { useEffect, useState } from 'react';
import { bridgeAvailableItem } from '@/settings';

/**
 * Whether the extension is working together with the desktop app.
 *
 * Both products watch the clipboard, so without coordination they each warn
 * about the same copy. Paired, the browser tells the app which site the focused
 * tab is on and says when it has already handled something, and the app stays
 * quiet.
 *
 * There is nothing to switch or paste here: the extension pairs on its own with
 * a SecureIntent desktop app on the same machine (see `lib/bridge/pairing.ts`),
 * and whether the two coordinate is a setting in the desktop app. This only says
 * which of the two states it is in.
 */
export function BridgeSettings() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    bridgeAvailableItem
      .getValue()
      .then((v) => alive && setAvailable(v))
      .catch(() => {});
    const unwatch = bridgeAvailableItem.watch((v) => alive && setAvailable(v));
    return () => {
      alive = false;
      unwatch();
    };
  }, []);

  return (
    <section className="si-lockcfg" aria-label="Desktop app">
      <div className="si-lockcfg-head">
        <span className="si-lockcfg-title">Desktop app</span>
      </div>
      <p className={`si-lockcfg-note ${available ? 'is-set' : ''}`}>
        {available
          ? 'Connected automatically. Shares the site you’re on — never the page — with the SecureIntent app on this computer, so one copy isn’t flagged twice.'
          : 'Not detected. With the SecureIntent desktop app installed, the two connect on their own so one copy isn’t flagged twice.'}
      </p>
    </section>
  );
}
