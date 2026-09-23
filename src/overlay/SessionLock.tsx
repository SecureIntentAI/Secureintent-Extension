import { useEffect, useRef, useState } from 'react';
import { Logo } from '@/components/Logo';

export const PIN_LENGTH = 4;

export interface SessionLockProps {
  setupRequired?: boolean;
  onSetup?: () => void;
  /** Verify the entered PIN. Return true to unlock (caller unmounts the overlay). */
  onUnlock: (pin: string) => boolean | Promise<boolean>;
}

function LockGlyph() {
  return (
    <svg className="si-lock-glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

/**
 * Full-screen lock for high-risk consoles — a segmented 4-digit PIN gate.
 * Walk-away deterrent: the host page stays in the DOM behind the closed shadow
 * overlay; this gates casual viewing, not a determined attacker with devtools.
 */
export function SessionLock({ onUnlock, setupRequired, onSetup }: SessionLockProps) {
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(''));
  const [error, setError] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  // Focus the first box on mount.
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  // Auto-submit the moment all four digits are present.
  useEffect(() => {
    if (!digits.every(Boolean)) return;
    let cancelled = false;
    (async () => {
      const ok = await onUnlock(digits.join(''));
      if (cancelled || ok) return;
      setError(true);
      setDigits(Array(PIN_LENGTH).fill(''));
      refs.current[0]?.focus();
    })();
    return () => {
      cancelled = true;
    };
  }, [digits, onUnlock]);

  const setAt = (i: number, value: string) => {
    setError(false);
    const d = value.replace(/\D/g, '').slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = d;
      return next;
    });
    if (d && i < PIN_LENGTH - 1) refs.current[i + 1]?.focus();
  };

  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, PIN_LENGTH);
    if (!text) return;
    e.preventDefault();
    setError(false);
    setDigits(Array.from({ length: PIN_LENGTH }, (_, k) => text[k] ?? ''));
    refs.current[Math.min(text.length, PIN_LENGTH - 1)]?.focus();
  };

  return (
    <div className="si-scrim si-lock-scrim">
      <div className="si-hud si-lock-card" role="dialog" aria-label="Console locked">
        <div className="si-lock-badge">
          <LockGlyph />
        </div>

        <p className="si-lock-title">Console locked</p>
        <p className="si-lock-sub">
          {setupRequired
            ? 'Your team requires Session Lock. Set a PIN in the extension to continue.'
            : 'Enter your PIN to continue.'}
        </p>
        {setupRequired ? (
          <button type="button" className="si-btn si-btn-mint" onClick={onSetup}>
            Set up Session Lock
          </button>
        ) : (
          <>
            <div className={`si-pin ${error ? 'is-error' : ''}`}>
              {digits.map((d, i) => (
                <input
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional inputs
                  key={i}
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  className="si-pin-box"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={1}
                  aria-label={`PIN digit ${i + 1}`}
                  value={d}
                  onChange={(e) => setAt(i, e.target.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  onPaste={onPaste}
                />
              ))}
            </div>

            <p className="si-lock-error" role="alert">
              {error
                ? 'Incorrect PIN or too many attempts. After five attempts, wait 30 seconds.'
                : ''}
            </p>
          </>
        )}

        <div className="si-lock-foot">
          <Logo size={14} />
          <span>
            SecureIntent<span className="si-ai">.ai</span>
          </span>
        </div>
      </div>
    </div>
  );
}
