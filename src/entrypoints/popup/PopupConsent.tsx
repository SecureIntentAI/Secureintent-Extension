import { useState } from 'react';
import { browser } from '#imports';
import { Logo } from '@/components/Logo';
import { acceptTerms, openPolicyPage, PRIVACY_URL, TOS_URL } from '@/lib/consent';

function HeroShield() {
  return (
    <svg viewBox="0 0 48 48" width="34" height="34" fill="none" aria-hidden="true">
      <path
        d="M24 5l14 6v11c0 8.7-5.9 14.9-14 17.6C15.9 36.9 10 30.7 10 22V11l14-6z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M17.5 24l4.5 4.5 9-9.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Blocking consent screen shown in the popup until the user accepts the current
 * Terms & Privacy. Replaces the normal popup UI. Mirrors the welcome page.
 */
export function PopupConsent({ onAccept }: { onAccept: () => void }) {
  const appVersion = browser.runtime.getManifest().version;
  const [checked, setChecked] = useState(false);

  const agree = async () => {
    await acceptTerms();
    onAccept();
  };

  return (
    <div className="si-pop">
      <header className="si-pop-header">
        <div className="si-brand">
          <Logo size={22} />
          <span className="si-wordmark">
            SecureIntent<span className="si-accent">.ai</span>
          </span>
        </div>
        <span className="si-version">v{appVersion}</span>
      </header>

      <section className="si-consent-gate">
        <div className="si-consent-hero">
          <HeroShield />
        </div>
        <h2 className="si-consent-gate-title">Catch secrets before you paste</h2>
        <p className="si-consent-gate-text">
          On-device protection — pasted text and secret values stay in your browser.
        </p>
        <p className="si-consent-gate-text si-consent-gate-text--shadow">
          Signed-in Business organisation users also share limited Shadow AI security metadata with
          their organisation: recognised AI-service hostname, paste size, detection category, and
          warning outcome. Never prompts, pasted text, secrets, full URLs, or URL paths.
        </p>

        <label className="si-consent-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span className="si-consent-box" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true">
              <path
                d="M5 12.5l4.5 4.5L19 7.5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="si-consent-check-text">
            I agree to the{' '}
            <a href={TOS_URL} onClick={openPolicyPage(TOS_URL)}>
              Terms
            </a>{' '}
            and{' '}
            <a href={PRIVACY_URL} onClick={openPolicyPage(PRIVACY_URL)}>
              Privacy Policy
            </a>
          </span>
        </label>

        <button type="button" className="si-consent-gate-btn" onClick={agree} disabled={!checked}>
          Activate protection
        </button>
      </section>
    </div>
  );
}
