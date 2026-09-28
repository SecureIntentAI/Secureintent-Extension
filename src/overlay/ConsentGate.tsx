import { useEffect } from 'react';
import { Logo } from '@/components/Logo';
import { openPolicyPage, PRIVACY_URL, TOS_URL } from '@/lib/consent';

export interface ConsentGateProps {
  /** Accept the current Terms & Privacy. */
  onAgree: () => void;
  /** Dismiss without accepting; the pending paste or file action is discarded. */
  onCancel: () => void;
  /** Which pending action is discarded when consent is dismissed. */
  contentKind?: 'paste' | 'file';
}

/**
 * Blocking consent gate shown before the first protected paste or file scan.
 * Same closed-shadow overlay chrome as
 * the paste warning — including the same three ways out (Escape, the ×, a click
 * on the scrim), because a dialog the user can't dismiss is a trap, and this one
 * appears on top of their own work.
 *
 * Dismissing discards the already-intercepted paste or selected file. That is
 * stated in the copy — silently swallowing the user's action made this gate feel
 * broken.
 */
export function ConsentGate({ onAgree, onCancel, contentKind = 'paste' }: ConsentGateProps) {
  const isFile = contentKind === 'file';
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
        aria-label={
          isFile
            ? 'Accept the Terms and Privacy Policy to enable SecureIntent file checks'
            : 'Accept the Terms and Privacy Policy to enable SecureIntent paste protection'
        }
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
            aria-label={
              isFile ? 'Dismiss — file upload is cancelled' : 'Dismiss — paste is discarded'
            }
            onClick={onCancel}
          >
            &times;
          </button>
        </div>

        <div className="si-rule" />

        <div className="si-consent-body">
          <h1 className="si-consent-title">
            {isFile
              ? 'One quick step before we check this file'
              : 'One quick step before we protect your pastes'}
          </h1>
          <p className="si-consent-text">
            SecureIntent checks pasted text <strong>on your device</strong> and does not send it or
            secret values to its servers. If you allow a paste, the destination site receives the
            text.
          </p>
          <p className="si-consent-text si-consent-text--shadow">
            For signed-in Business organisation users, Shadow AI sends limited security metadata to
            their organisation: recognised AI-service hostname, paste size, detection category, and
            warning outcome. It never sends prompts, pasted text, secret values, full URLs, or URL
            paths.
          </p>
          <p className="si-consent-text">
            Supported text files are scanned locally before the page receives them. SecureIntent
            does not send file contents or file-scan results to its servers. A clean check passes
            the file to the site; you can cancel a warned upload or continue unless team policy
            blocks it. Binary files and other upload paths are not checked.
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
          {isFile
            ? 'Closing this cancels the selected file; the page will not receive it.'
            : "Closing this discards the paste you just made — nothing is inserted. Copy it again once you've agreed."}
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
