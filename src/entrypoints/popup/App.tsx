import { useEffect, useState } from 'react';
import { browser } from '#imports';
import { Logo } from '@/components/Logo';
import { getActiveBundle } from '@/lib/config';
import { isConsentAccepted } from '@/lib/consent';
import { blockedCountItem, isEnabled } from '@/settings';
import './App.css';
import { AccountSection } from './AccountSection';
import { BridgeSettings } from './BridgeSettings';
import { PlanCard } from './PlanCard';
import { PopupConsent } from './PopupConsent';
import { type ProtectionStatus, protectionStatus } from './protection';
import { SessionLockSettings } from './SessionLockSettings';
import { useCountUp } from './useCountUp';

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 17L17 7M9 7h8v8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShieldIcon({ checked, size = 20 }: { checked: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width={size} height={size}>
      <path
        d="M12 3l7 3v5.5c0 4.3-2.9 7.4-7 8.8-4.1-1.4-7-4.5-7-8.8V6l7-3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {checked && (
        <path
          d="M8.7 12l2.1 2.1 4-4.2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function LocalShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="13" height="13">
      <path
        d="M12 3l7 3v5.5c0 4.3-2.9 7.4-7 8.8-4.1-1.4-7-4.5-7-8.8V6l7-3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <rect
        x="9.25"
        y="11"
        width="5.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M10.5 11v-1a1.5 1.5 0 0 1 3 0v1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36M21 4v4h-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function App() {
  const [count, setCount] = useState(0);
  const displayCount = useCountUp(count);
  const [patternVersion, setPatternVersion] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<ProtectionStatus>({ kind: 'inactive' });
  const [needsConsent, setNeedsConsent] = useState<boolean | null>(null);
  const appVersion = browser.runtime.getManifest().version;

  useEffect(() => {
    isConsentAccepted().then((ok) => setNeedsConsent(!ok));
    blockedCountItem.getValue().then(setCount);
    getActiveBundle().then((b) => setPatternVersion(b.version));
    const stop = blockedCountItem.watch((v) => setCount(v ?? 0));

    // Resolve protection status for the current tab.
    Promise.all([browser.tabs.query({ active: true, currentWindow: true }), isEnabled()]).then(
      async ([tabs, enabled]) => {
        const candidate = protectionStatus(tabs[0]?.url, enabled);
        if (candidate.kind !== 'active' || tabs[0]?.id == null) {
          setStatus(candidate);
          return;
        }
        const response = await browser.tabs
          .sendMessage(tabs[0].id, { type: 'si-protection-status' })
          .catch(() => null);
        setStatus(response?.ready && response.active ? candidate : { kind: 'inactive' });
      },
    );

    return () => stop();
  }, []);

  const refresh = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await browser.runtime.sendMessage({ type: 'si-refresh-config' });
      const b = await getActiveBundle();
      setPatternVersion(b.version);
    } finally {
      setTimeout(() => setSyncing(false), 600);
    }
  };

  if (needsConsent === null) return null; // brief load — avoids flashing the UI
  if (needsConsent) {
    return (
      <PopupConsent
        onAccept={() => {
          setNeedsConsent(false);
          browser.runtime.sendMessage({ type: 'si-consent-accepted' }).catch(() => {});
        }}
      />
    );
  }

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

      <AccountSection />

      <section className={`si-hero si-hero--${status.kind}`}>
        <div className="si-hero-ring">
          <ShieldIcon checked={status.kind === 'active'} size={30} />
        </div>
        <h2 className="si-hero-title">
          {status.kind === 'active'
            ? 'Protected'
            : status.kind === 'paused'
              ? 'Protection paused'
              : 'Not active here'}
        </h2>
        {status.kind === 'active' && (
          <span className="si-hero-host" title={status.host}>
            {status.host}
          </span>
        )}
        <div className="si-hero-metric">
          <b>{displayCount.toLocaleString()}</b> secret{count === 1 ? '' : 's'} intercepted so far
        </div>
      </section>

      <PlanCard />

      <SessionLockSettings />
      <BridgeSettings />

      <div className="si-config">
        <span className="si-config-label">
          Detection patterns <span className="si-config-ver">v{patternVersion ?? '—'}</span>
        </span>
        <button
          type="button"
          className={`si-refresh ${syncing ? 'is-syncing' : ''}`}
          onClick={refresh}
          disabled={syncing}
          title="Check for the latest detection patterns"
        >
          <RefreshIcon />
          {syncing ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      <footer className="si-pop-footer">
        <span
          className="si-privacy-badge"
          title="Your text is analyzed on-device and never leaves the browser"
        >
          <LocalShieldIcon />
          Local text processing
        </span>
        <a
          className="si-link"
          href="https://github.com/Secureintent-Admin/Secureintent-Extension"
          target="_blank"
          rel="noreferrer"
        >
          Auditable code <ArrowIcon />
        </a>
      </footer>
    </div>
  );
}

export default App;
