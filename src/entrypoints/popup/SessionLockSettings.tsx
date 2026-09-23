import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browser, storage } from '#imports';
import { PinBoxes } from '@/components/PinBoxes';
import { ACCOUNT_URL } from '@/lib/clerkConfig';
import { hasFeature } from '@/lib/entitlement';
import { getOrCreateSalt, type KeyValueStore } from '@/lib/fingerprint';
import { hashPin, verifyPin } from '@/lib/lock';
import {
  clearSessionLockPin,
  isSessionLockEnforced,
  sessionLockEnabledItem,
  sessionLockPinHashItem,
  sessionLockTimeoutItem,
  setSessionLockEnabled,
  setSessionLockPin,
} from '@/settings';

const store: KeyValueStore = {
  get: async (k) => (await storage.getItem<string>(`local:${k}`)) ?? undefined,
  set: (k, v) => storage.setItem(`local:${k}`, v),
};
const MIN = 60_000;
const PIN_LEN = 4;

/** A protected action that requires the current PIN before it runs. */
type GatedAction = 'disable' | 'remove' | 'change';

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="15" height="15">
      <rect
        x="4.5"
        y="10.5"
        width="15"
        height="10"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M8 10.5V7.5a4 4 0 0 1 8 0v3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SessionLockSettings() {
  const [enabled, setEnabled] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [timeoutMin, setTimeoutMin] = useState(5);

  const [changing, setChanging] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Current-PIN verification gate for the protected actions.
  const [gate, setGate] = useState<GatedAction | null>(null);
  const [gatePin, setGatePin] = useState('');
  const [gateAttempt, setGateAttempt] = useState(0); // bump to reset + refocus the boxes

  const [loaded, setLoaded] = useState(false); // storage values resolved
  const [animate, setAnimate] = useState(false); // enable collapse transition (after settle)
  // Team Policy `requireSessionLock`: pinned on by the workspace admin. The
  // member keeps a working toggle (so the click gets an answer) but the answer
  // is an explanation, never a silent no-op.
  const [enforced, setEnforced] = useState(false);
  const [refused, setRefused] = useState(false); // they just tried to switch it off
  // Session Lock is a Pro feature. Gate the whole config UI on the entitlement so
  // a free/signed-out user can't set a PIN or enable it (the content script also
  // refuses to activate without this feature — this keeps the UI honest too).
  const [entitled, setEntitled] = useState(false);

  useEffect(() => {
    // Load all values at once so the body opens/collapses in a single paint
    // (no tall-then-short flash on popup open).
    Promise.all([
      sessionLockEnabledItem.getValue(),
      sessionLockPinHashItem.getValue(),
      sessionLockTimeoutItem.getValue(),
      hasFeature('session_lock'),
      isSessionLockEnforced(),
    ]).then(([e, h, ms, ent, enf]) => {
      setEnabled(e || enf); // an enforced lock reads as on, whatever storage says
      setHasPin(Boolean(h));
      setTimeoutMin(Math.round(ms / MIN));
      setEntitled(ent || enf);
      setEnforced(enf);
      setLoaded(true);
      // Turn the open/close animation on a couple of frames later, so the
      // initial state lands instantly without animating.
      requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)));
    });
  }, []);

  const showForm = !hasPin || changing;
  // Collapse the body when the lock is dormant (a PIN exists but it's switched
  // off). Setup, the verify gate, and the enabled state all keep it open.
  // Stay collapsed until loaded so we never flash the expanded setup form.
  const open = loaded && (enabled || !hasPin || changing || gate !== null);
  // Under enforcement, keep the enforced note in the re-measure deps so the body
  // grows to fit it (see the max-height effect below).

  // Animate via measured max-height (reliable in both directions, unlike the
  // grid 0fr→1fr trick which can stall on expand). Re-measured on every content
  // change so growth (errors, form swaps) stays smooth.
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on any content change
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.style.maxHeight = open ? `${el.scrollHeight}px` : '0px';
  }, [open, gate, showForm, hasPin, enabled, error, changing, timeoutMin, enforced, refused]);

  const resetForm = () => {
    setPin('');
    setConfirm('');
    setError(null);
  };
  const closeGate = () => {
    setGate(null);
    setGatePin('');
    setError(null);
  };

  // Verify the entered PIN, then run the pending protected action.
  const confirmGate = async (entered: string) => {
    const hash = await sessionLockPinHashItem.getValue();
    const salt = await getOrCreateSalt(store);
    if (!hash || !(await verifyPin(entered, salt, hash))) {
      setError('Incorrect PIN');
      setGatePin('');
      setGateAttempt((n) => n + 1); // reset + refocus the boxes
      return;
    }
    const action = gate;
    closeGate();
    // Both writes go through the settings layer, which refuses under an enforced
    // policy — the UI hides these paths anyway, but the guarantee lives there.
    if (action === 'disable') {
      if (!(await setSessionLockEnabled(false))) {
        setRefused(true);
        return;
      }
      setEnabled(false);
      toggleRef.current?.focus(); // body collapses (inert) — return focus to the toggle
    } else if (action === 'remove') {
      if (!(await clearSessionLockPin())) {
        setRefused(true);
        return;
      }
      setHasPin(false);
      setEnabled(false);
      resetForm();
    } else if (action === 'change') {
      setChanging(true); // open the set-new-PIN form
    }
  };

  // Enabling is free; turning OFF must be authorized with the PIN.
  const toggle = async () => {
    if (enforced) {
      // Answer the click. Silently ignoring it reads as a broken toggle; the
      // member needs to know their team pinned this, not that the popup is buggy.
      setRefused(true);
      return;
    }
    if (enabled) {
      setGate('disable');
      return;
    }
    setEnabled(true);
    await setSessionLockEnabled(true);
  };

  const save = async () => {
    if (pin.length !== PIN_LEN) {
      setError('Enter a 4-digit PIN');
      return;
    }
    if (pin !== confirm) {
      setError("PINs don't match");
      return;
    }
    const salt = await getOrCreateSalt(store);
    await setSessionLockPin(await hashPin(pin, salt)); // also auto-enables
    setHasPin(true);
    setEnabled(true);
    setChanging(false);
    resetForm();
  };

  const changeTimeout = async (min: number) => {
    setTimeoutMin(min);
    await sessionLockTimeoutItem.setValue(min * MIN);
  };

  const openAccount = () => {
    browser.tabs.create({ url: ACCOUNT_URL }).catch(() => {});
  };

  // Not on a plan that includes Session Lock → show a locked, upgrade-only card.
  // No toggle, no PIN form: a free user can neither enable nor configure it.
  // An enforced policy overrides this: the team requires the lock, so the member
  // must be able to set their PIN even if the cached entitlement lags behind.
  if (loaded && !entitled && !enforced) {
    return (
      <section className="si-lockcfg">
        <div className="si-lockcfg-head">
          <span className="si-lockcfg-title">
            <LockIcon />
            Session Lock
          </span>
          <span className="si-plan-tag is-pro">Pro</span>
        </div>
        <div className={`si-lockcfg-body ${animate ? 'is-anim' : ''} is-open`}>
          <div className="si-lockcfg-body-inner">
            <p className="si-lockcfg-hint">
              PIN-locks cloud consoles after inactivity. Available on Pro.
            </p>
            <div className="si-lockcfg-row">
              <button type="button" className="si-lockcfg-save" onClick={openAccount}>
                Upgrade to unlock
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="si-lockcfg">
      <div className="si-lockcfg-head">
        <span className="si-lockcfg-title">
          <LockIcon />
          Session Lock
        </span>
        {enforced && <span className="si-plan-tag">Team policy</span>}
        <button
          ref={toggleRef}
          type="button"
          role="switch"
          aria-checked={enabled}
          // Stays clickable under enforcement on purpose: `toggle` answers with
          // an explanation. A `disabled` switch would just look broken.
          className={`si-toggle ${enabled ? 'is-on' : ''}`}
          onClick={toggle}
          disabled={!hasPin || gate !== null}
          title={
            enforced
              ? 'Required by your team policy'
              : hasPin
                ? 'Enable / disable'
                : 'Set a PIN first'
          }
        >
          <span className="si-toggle-dot" />
        </button>
      </div>

      <div
        ref={bodyRef}
        className={`si-lockcfg-body ${animate ? 'is-anim' : ''} ${open ? 'is-open' : ''}`}
      >
        <div className="si-lockcfg-body-inner" inert={!open}>
          {!gate && <p className="si-lockcfg-hint">Locks cloud consoles after inactivity.</p>}

          {enforced && (
            <p className={`si-lockcfg-note is-enforced${refused ? ' is-error' : ''}`} role="status">
              {refused
                ? "Your team requires Session Lock — it can't be turned off."
                : 'Required by your team policy.'}
            </p>
          )}

          {gate ? (
            <>
              <div className="si-lockcfg-row">
                <PinBoxes
                  key={gateAttempt}
                  value={gatePin}
                  onChange={(p) => {
                    setGatePin(p);
                    setError(null);
                  }}
                  onComplete={confirmGate}
                  error={Boolean(error)}
                  autoFocus
                  ariaLabel="Current PIN digit"
                />
                <button type="button" className="si-lockcfg-link" onClick={closeGate}>
                  Cancel
                </button>
              </div>
              {error && (
                <p className="si-lockcfg-note is-error">{error} · forgot it? Reinstall to reset.</p>
              )}
            </>
          ) : showForm ? (
            <>
              <div className="si-lockcfg-field">
                <span className="si-lockcfg-fieldlabel">New PIN</span>
                <PinBoxes
                  value={pin}
                  onChange={(p) => {
                    setPin(p);
                    setError(null);
                  }}
                  autoFocus
                  ariaLabel="New PIN digit"
                />
              </div>
              <div className="si-lockcfg-field">
                <span className="si-lockcfg-fieldlabel">Confirm</span>
                <PinBoxes
                  value={confirm}
                  onChange={(p) => {
                    setConfirm(p);
                    setError(null);
                  }}
                  ariaLabel="Confirm PIN digit"
                />
              </div>
              <div className="si-lockcfg-row">
                <button
                  type="button"
                  className="si-lockcfg-save"
                  onClick={save}
                  disabled={pin.length !== PIN_LEN || confirm.length !== PIN_LEN}
                >
                  Save PIN
                </button>
                {changing && (
                  <button
                    type="button"
                    className="si-lockcfg-btn"
                    onClick={() => {
                      setChanging(false);
                      resetForm();
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {error && <p className="si-lockcfg-note is-error">{error}</p>}
            </>
          ) : (
            <>
              <p className="si-lockcfg-note is-set">
                ● Protected · locks after {timeoutMin} min idle
              </p>
              <div className="si-lockcfg-row">
                <button type="button" className="si-lockcfg-btn" onClick={() => setGate('change')}>
                  Change PIN
                </button>
                {/* Removing the PIN disables the lock, so it's not offered while
                    the team enforces it. Changing it stays available. */}
                {!enforced && (
                  <button
                    type="button"
                    className="si-lockcfg-btn is-danger"
                    onClick={() => setGate('remove')}
                  >
                    Remove PIN
                  </button>
                )}
              </div>
            </>
          )}

          <div className="si-lockcfg-row">
            <span className="si-lockcfg-rowlabel">Lock after</span>
            <fieldset className="si-seg" aria-label="Lock after">
              {[1, 5, 15].map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`si-seg-btn ${timeoutMin === m ? 'is-on' : ''}`}
                  aria-pressed={timeoutMin === m}
                  onClick={() => changeTimeout(m)}
                >
                  {m}m
                </button>
              ))}
            </fieldset>
          </div>
        </div>
      </div>
    </section>
  );
}
