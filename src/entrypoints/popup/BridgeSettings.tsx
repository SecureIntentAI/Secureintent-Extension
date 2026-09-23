import { useEffect, useState } from 'react';
import { bridgeEnabledItem, bridgeTokenItem, setBridgeEnabled, setBridgeToken } from '@/settings';

/**
 * Pairing with the desktop app.
 *
 * Both products watch the clipboard, so without this they each warn about the
 * same copy. Paired, the browser tells the app which site the focused tab is on
 * and says when it has already handled something, and the app stays quiet.
 *
 * The token is typed in because there is nothing to fetch it from — the desktop
 * shows it on its dashboard next to the endpoint, and its local API neither
 * offers a handout nor sends the CORS headers a browser would need to read one.
 * Copying it is the shortest honest path, and it doubles as the consent moment:
 * nothing is shared until someone deliberately pairs the two.
 */
export function BridgeSettings() {
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([bridgeEnabledItem.getValue(), bridgeTokenItem.getValue()])
      .then(([on, t]) => {
        if (!alive) return;
        setEnabled(on);
        setToken(t ?? '');
        setBusy(false);
      })
      // An unreadable setting leaves this off, which is how an opt-in should fail.
      .catch(() => alive && setBusy(false));
    const unwatch = bridgeEnabledItem.watch((v) => alive && setEnabled(v));
    return () => {
      alive = false;
      unwatch();
    };
  }, []);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next); // answer the click immediately
    try {
      await setBridgeEnabled(next);
    } catch {
      setEnabled(!next); // put it back rather than lying about the state
    }
  };

  const save = async () => {
    try {
      await setBridgeToken(token);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch {
      setSaved(false);
    }
  };

  const paired = token.trim().length > 0;

  return (
    <section className="si-lockcfg">
      <div className="si-lockcfg-head">
        <span className="si-lockcfg-title">Desktop app</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Pair with the SecureIntent desktop app"
          className={`si-toggle ${enabled ? 'is-on' : ''}`}
          onClick={toggle}
          disabled={busy}
          title={enabled ? 'Disable' : 'Enable'}
        >
          <span className="si-toggle-dot" />
        </button>
      </div>

      {enabled && (
        <div className="si-lockcfg-body-inner">
          <p className="si-lockcfg-hint">
            Requires a desktop app supporting secure pairing v2. Older versions cannot pair.
          </p>
          <label className="si-lockcfg-hint" htmlFor="si-bridge-token">
            Pairing token — copy it from the desktop app’s dashboard
          </label>
          <div className="si-lockcfg-row">
            <input
              id="si-bridge-token"
              type="password"
              spellCheck={false}
              autoComplete="off"
              placeholder="Paste the token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
            <button type="button" className="si-lockcfg-btn" onClick={save} disabled={busy}>
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <p className={`si-lockcfg-note ${enabled && paired ? 'is-set' : ''}`}>
        {!enabled
          ? 'If you also run the SecureIntent desktop app, pair them so one copy isn’t flagged twice.'
          : paired
            ? 'Paired. Shares the site you’re on — never the page — with the app on this machine.'
            : 'Add the token from the desktop app to finish pairing. Nothing is shared until you do.'}
      </p>
    </section>
  );
}
