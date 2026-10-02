import { useEffect, useState } from 'react';
import { browser } from '#imports';

/**
 * The link to the SecureIntent desktop app, shown only while there is one.
 *
 * Both products watch the clipboard, so without coordination they each warn
 * about the same copy. Connected, the browser tells the app which site the
 * focused tab is on and when it has already handled something, and asks it about
 * text the person restored there with Undo.
 *
 * There is nothing to switch or paste here: the extension pairs on its own (see
 * `lib/bridge/pairing.ts`) and the switch is in the desktop app. So with no
 * desktop app, or with it closed or switched off, the popup says nothing about
 * it at all. The background checks afresh each time the popup opens.
 */
export function BridgeSettings() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    browser.runtime
      .sendMessage({ type: 'si-bridge-check' })
      .then((v) => alive && setConnected(v === true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!connected) return null;
  return (
    <section className="si-lockcfg" aria-label="Desktop app">
      <div className="si-lockcfg-head">
        <span className="si-lockcfg-title">Desktop app</span>
      </div>
      <p className="si-lockcfg-note is-set">
        Connected. Shares the site you’re on — never the page — with the SecureIntent app on this
        computer, so one copy isn’t flagged twice.
      </p>
    </section>
  );
}
