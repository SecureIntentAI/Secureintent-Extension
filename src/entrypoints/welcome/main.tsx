import { type ReactNode, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Logo } from '@/components/Logo';
import {
  acceptTerms,
  isConsentAccepted,
  openPolicyPage,
  PRIVACY_URL,
  TOS_URL,
} from '@/lib/consent';
import './style.css';

function HeroShield() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" fill="none" aria-hidden="true">
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

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path
        d="M5 12h13M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// AWS's own documented example key. It matches the AKIA pattern, so the guard
// really fires on it, and it authenticates nothing — safe to ship and to paste.
const SAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';

/** Where step 2 sends them to try it. Kept first in the marks row below, too. */
const TRY_URL = 'https://chatgpt.com/';

function PuzzleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
      <path
        d="M10 4a2 2 0 114 0v1h3a1 1 0 011 1v3h1a2 2 0 110 4h-1v3a1 1 0 01-1 1h-3v-1a2 2 0 10-4 0v1H6a1 1 0 01-1-1v-3H4a2 2 0 110-4h1V6a1 1 0 011-1h4V4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true">
      <path
        d="M9 3h6l-1 5 3 3v2h-4v6l-1 2-1-2v-6H7v-2l3-3-1-5z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Step 1 — the toolbar, drawn the way the user is about to see it. */
function PinScene() {
  return (
    <div className="w-scene w-scene--pin" aria-hidden="true">
      <div className="w-toolbar">
        <span className="w-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="w-omni" />
        <span className="w-puzzle">
          <PuzzleIcon />
        </span>
      </div>
      <div className="w-menu">
        <div className="w-menu-row">
          <span className="w-menu-mark">
            <Logo size={11} />
          </span>
          <span className="w-menu-name">SecureIntent</span>
          <span className="w-menu-pin">
            <PinIcon />
          </span>
        </div>
        <div className="w-menu-row w-menu-row--ghost">
          <span className="w-menu-mark" />
          <span className="w-menu-bar" />
        </div>
      </div>
    </div>
  );
}

/** Step 2 — the interception itself: the key typed, the guard stopping it. */
function CatchScene() {
  return (
    <div className="w-scene w-scene--catch" aria-hidden="true">
      <div className="w-composer">
        <span className="w-composer-key">{SAMPLE_KEY}</span>
      </div>
      <div className="w-warn">
        <span className="w-warn-icon">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
            <path
              d="M12 3l8 3.4v6.2c0 4.9-3.3 8.4-8 9.9-4.7-1.5-8-5-8-9.9V6.4L12 3z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <b className="w-warn-title">AWS access key</b>
      </div>
    </div>
  );
}

/**
 * Simplified marks for the tools we guard, drawn inline because the extension's
 * CSP blocks remote images. Silhouettes at 16px, not exact reproductions — they
 * identify the destination, they don't claim any endorsement.
 */
const MARKS: Array<{ name: string; url: string; path: ReactNode }> = [
  {
    name: 'ChatGPT',
    url: TRY_URL,
    // Six-fold rosette: the silhouette of OpenAI's interlocking knot, which is
    // what reads at this size. Not their official path.
    path: (
      <g stroke="currentColor" strokeWidth="1.25">
        <ellipse cx="12" cy="12" rx="3.9" ry="8.4" />
        <ellipse cx="12" cy="12" rx="3.9" ry="8.4" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="3.9" ry="8.4" transform="rotate(120 12 12)" />
      </g>
    ),
  },
  {
    name: 'Claude',
    url: 'https://claude.ai/new',
    path: (
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M12 4.5v15M5.5 8.2l13 7.6M18.5 8.2l-13 7.6" />
      </g>
    ),
  },
  {
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    path: (
      <path
        d="M12 3.5c0 4.7 3.8 8.5 8.5 8.5-4.7 0-8.5 3.8-8.5 8.5 0-4.7-3.8-8.5-8.5-8.5 4.7 0 8.5-3.8 8.5-8.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    ),
  },
  {
    name: 'Copilot',
    url: 'https://github.com/copilot',
    path: (
      <g stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M4 13c0-3.3 3.6-5.5 8-5.5s8 2.2 8 5.5c0 3.6-3.2 5.5-8 5.5S4 16.6 4 13z" />
        <path d="M12 7.5C11.4 5.2 10 4 8 4M12 7.5C12.6 5.2 14 4 16 4" strokeLinecap="round" />
        <path d="M9.3 12.4v1.6M14.7 12.4v1.6" strokeLinecap="round" />
      </g>
    ),
  },
  {
    name: 'Perplexity',
    url: 'https://www.perplexity.ai/',
    path: (
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 4.5v15" />
        <path d="M12 9.2L6.5 5.4v6.3H4.6v6.9L12 13.4l7.4 5.2v-6.9h-1.9V5.4L12 9.2z" />
      </g>
    ),
  },
  {
    name: 'Grok',
    url: 'https://grok.com/',
    path: (
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M6 19L18 5M11.5 13.5L18 19M6 5l4 4.6" />
      </g>
    ),
  },
];

/** Step 3 — the destinations we watch. Each one opens, so trying it is one click. */
function CoverScene() {
  return (
    <div className="w-scene w-scene--cover">
      <div className="w-marks">
        {MARKS.map((m) => (
          <a className="w-mark" key={m.name} href={m.url} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
              {m.path}
            </svg>
            <span className="w-sr">Open {m.name}</span>
          </a>
        ))}
        <span className="w-mark w-mark--rest" aria-hidden="true">
          +13
        </span>
      </div>
      <span className="w-sweep" aria-hidden="true" />
    </div>
  );
}

function Steps() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SAMPLE_KEY);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // clipboard blocked — the key stays selectable by hand
    }
  };

  return (
    <ol className="w-steps">
      <li className="w-step">
        <PinScene />
        <div className="w-step-b">
          <span className="w-step-n">Step 1</span>
          <h2 className="w-step-t">Pin it to your toolbar</h2>
          <p className="w-step-d">Puzzle icon, then the pin. The badge counts what it stops.</p>
        </div>
      </li>

      <li className="w-step">
        <CatchScene />
        <div className="w-step-b">
          <span className="w-step-n">Step 2</span>
          <h2 className="w-step-t">Watch it catch one</h2>
          <p className="w-step-d">Take this dead sample key and paste it into any AI chat.</p>
          <div className="w-key">
            <code>{SAMPLE_KEY}</code>
            <button type="button" className="w-copy" onClick={copy}>
              {copied ? 'Copied' : 'Copy key'}
            </button>
          </div>
        </div>
      </li>

      <li className="w-step">
        <CoverScene />
        <div className="w-step-b">
          <span className="w-step-n">Step 3</span>
          <h2 className="w-step-t">It's already watching</h2>
          <p className="w-step-d">
            Nineteen AI tools by name. Everywhere else by default. Nothing to configure.
          </p>
        </div>
      </li>
    </ol>
  );
}

function Welcome() {
  const [accepted, setAccepted] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    isConsentAccepted().then(setAccepted);
  }, []);

  const agree = async () => {
    await acceptTerms();
    setAccepted(true);
  };

  return (
    <main className="w-shell">
      <div className="w-ambient" aria-hidden="true" />
      <header className="w-brand">
        <Logo size={26} />
        <span className="w-word">
          SecureIntent<span className="w-accent">.ai</span>
        </span>
      </header>

      {accepted ? (
        <section className="w-card w-card--guide w-enter">
          <div className="w-hero w-hero--ok">
            <HeroShield />
          </div>
          <h1 className="w-title">You're protected</h1>
          <p className="w-sub">Paste as usual — we step in only when a secret is detected.</p>
          <Steps />
          <button type="button" className="w-cta w-cta--ghost" onClick={() => window.close()}>
            Close tab
          </button>
        </section>
      ) : (
        <section className="w-card w-enter">
          <div className="w-hero">
            <HeroShield />
          </div>

          <h1 className="w-title">Catch secrets before you paste</h1>
          <p className="w-sub">On-device protection for API keys, tokens, and passwords.</p>
          <p className="w-sub w-shadow-notice">
            If you are signed in to a Business organisation, Shadow AI sends that organisation
            limited security metadata: recognised AI-service hostname, paste size, detection
            category, and warning outcome. Prompts, pasted text, secret values, full URLs, and URL
            paths never leave your browser.
          </p>

          <label className="w-consent">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span className="w-consent-box" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
                <path
                  d="M5 12.5l4.5 4.5L19 7.5"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="w-consent-text">
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

          <button type="button" className="w-cta" onClick={agree} disabled={!checked}>
            Activate protection
            <ArrowIcon />
          </button>

          <div className="w-trust">
            <span>On-device</span>
            <i />
            <span>No raw-text retention</span>
          </div>
        </section>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Welcome />);
