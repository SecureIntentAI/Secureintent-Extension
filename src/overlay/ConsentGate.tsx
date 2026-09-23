import { useEffect } from 'react';
import { Logo } from '@/components/Logo';
import { openPolicyPage, PRIVACY_URL, TOS_URL } from '@/lib/consent';

export interface ConsentGateProps {
  /** Accept the current Terms & Privacy. */
  onAgree: () => void;
  /** Dismiss without accepting — this paste is discarded, nothing is inserted. */
  onCancel: () => void;
}

/**
 * Blocking consent gate shown on the first paste that would trigger a warning,
 * before the extension protects anything. Same closed-shadow overlay chrome as
 * the paste warning — including the same three ways out (Escape, the ×, a click
 * on the scrim), because a dialog the user can't dismiss is a trap, and this one
 * appears on top of their own work.
 *
 * Dismissing maps to the same outcome as the warning dialog's Cancel: the paste
 * was already `preventDefault`-ed, so it is dropped. That is stated in the copy —
 * a silently swallowed paste is what made this gate feel broken.
 */
export function ConsentGate({ onAgree, onCancel }: ConsentGateProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="si-scrim" onClick={onCancel}>
      <div
        className="si-hud si-consent"
        role="alertdialog"
        aria-modal="true"
        aria-label="Accept the Terms of Service and Privacy Policy to enable SecureIntent"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="si-top">
          <span className="si-brand">
            <Logo size={22} />
            <span className="si-wordmark">
              SecureIntent<span className="si-ai">.ai</span>
            </span>
          </span>
          <button
            type="button"
            className="si-x"
            aria-label="Dismiss — this paste is discarded"
            onClick={onCancel}
          >
            &times;
          </button>
        </div>

        <div className="si-rule" />

        <div className="si-consent-body">
          <h1 className="si-consent-title">One quick step before we protect your pastes</h1>
          <p className="si-consent-text">
            SecureIntent analyzes pasted text <strong>on your device</strong> — your text never
            leaves the browser. To enable protection, please agree to our terms.
          </p>
          <p className="si-consent-links">
            <a href={TOS_URL} onClick={openPolicyPage(TOS_URL)}>
              Terms of Service
            </a>
            <span aria-hidden="true"> · </span>
            <a href={PRIVACY_URL} onClick={openPolicyPage(PRIVACY_URL)}>
              Privacy Policy
            </a>
          </p>
        </div>

        <p className="si-consent-note">
          Closing this discards the paste you just made — nothing is inserted and nothing is sent
          anywhere. Copy it again once you've agreed.
        </p>

        <div className="si-actions">
          <button type="button" className="si-btn si-btn-ghost" onClick={onCancel}>
            Not now
          </button>
          <button type="button" className="si-btn si-btn-mint" onClick={onAgree}>
            I Agree &amp; Enable Protection
          </button>
        </div>
      </div>
    </div>
  );
}
