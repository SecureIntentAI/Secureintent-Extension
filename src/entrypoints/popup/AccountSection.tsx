import { SHADOW_DEMO } from '@/lib/shadow/demoConfig';
import { Show, useUser } from '@clerk/chrome-extension';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from '#imports';
import {
  ACCOUNT_URL,
  isAuthEnabled,
  isClerkSdkEnabled,
  SHADOW_DASHBOARD_URL,
  TEAM_URL,
} from '@/lib/clerkConfig';
import {
  type ActiveEntitlement,
  canManageTeam,
  FREE_ENTITLEMENT,
  getActiveEntitlement,
} from '@/lib/entitlement';
import type { RefreshResult } from '@/lib/entitlement/refresh';
import { configItem } from '@/lib/config/store';

const PLAN_LABEL: Record<ActiveEntitlement['plan'], string> = {
  developer: 'Free',
  developer_pro: 'Developer Pro',
  business_pro: 'Business Pro',
};

/**
 * What the plan badge says. A seat says whose it is: an employee should be able
 * to see at a glance that their protection comes from work, not their card.
 * Both browser paths use this, so the two bars can't drift apart again.
 */
function planText(ent: ActiveEntitlement): string {
  const label = ent.plan === 'business_pro' && ent.org?.role === 'org:member'
    ? 'Developer Pro'
    : PLAN_LABEL[ent.plan];
  return ent.org ? `${label} · ${ent.org.name ?? 'Team'}` : label;
}

/** Why the plan on screen might not be the one the user expects. */
const REFRESH_UNAVAILABLE = "Couldn't check your plan just now — showing the last one we saw.";
const REFRESH_CLEARED =
  "We couldn't verify your Pro licence on this device, so it's been reset to Free. Sign in again on the account page, then retry.";

/** Turn a background refresh result into something worth showing a human. */
function describeRefresh(res: RefreshResult | undefined): string | null {
  if (!res) return null; // no answer (auth disabled / nothing to say)
  if (res.status === 'cleared') return REFRESH_CLEARED;
  if (res.status === 'error') return REFRESH_UNAVAILABLE;
  return null;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Opens the web account page where all sign-in / profile / billing lives. Signing
 * in there syncs the Clerk session back into the extension (ClerkProvider syncHost).
 */
function openAccountTab() {
  browser.tabs.create({ url: ACCOUNT_URL }).catch(() => {});
}

function openTeamTab(e: { stopPropagation: () => void }) {
  e.stopPropagation(); // the row itself opens the account page
  browser.tabs.create({ url: TEAM_URL }).catch(() => {});
}

function openShadowDashboard() {
  browser.tabs.create({ url: SHADOW_DASHBOARD_URL }).catch(() => {});
}

/** Team console shortcut. Admins only — a member has nothing to manage there. */
function TeamLink({ ent }: { ent: ActiveEntitlement }) {
  if (!canManageTeam(ent)) return null;
  return (
    <button type="button" className="si-team-link" onClick={openTeamTab}>
      Manage team
      <ChevronIcon />
    </button>
  );
}

/** The organization dashboard contains team activity, so only admins see this link. */
function ShadowDashboardLink({ ent }: { ent: ActiveEntitlement }) {
  if (ent.plan !== 'business_pro' || !canManageTeam(ent)) return null;
  return (
    <button type="button" className="si-team-link" onClick={openShadowDashboard}>
      Shadow AI dashboard
      <ChevronIcon />
    </button>
  );
}

function PolicyUpdateNotice({ ent, identity }: { ent: ActiveEntitlement; identity: string | null }) {
  const [revision, setRevision] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const orgId = ent.source === 'org_seat' ? ent.org?.id : null;
  const key = orgId && identity ? `si_policy_notice:${identity.toLowerCase()}:${orgId}` : null;

  useEffect(() => {
    let active = true;
    const read = async () => {
      if (!key || !orgId) {
        if (active) setRevision(null);
        return;
      }
      const bundle = await configItem.getValue();
      const version = bundle?.policy?.orgId === orgId ? bundle.policyVersion ?? 0 : 0;
      const saved = (await browser.storage.local.get(key))[key];
      if (active) {
        setRevision(version > 0 ? version : null);
        setDismissed(saved === version);
      }
    };
    void read().catch(() => { if (active) setRevision(null); });
    const onChange = () => { void read().catch(() => {}); };
    browser.storage.onChanged.addListener(onChange);
    return () => { active = false; browser.storage.onChanged.removeListener(onChange); };
  }, [key, orgId]);

  if (!revision || dismissed || !key) return null;
  return (
    <div className="si-policy-notice" role="status">
      <strong>Team policy revision {revision} downloaded</strong>
      <span>Open your account to see the current rules and whether your devices confirmed them.</span>
      <div className="si-policy-notice-actions">
        <button type="button" onClick={openAccountTab}>View policy</button>
        <button type="button" onClick={() => {
          setDismissed(true);
          void browser.storage.local.set({ [key]: revision });
        }}>Got it</button>
      </div>
    </div>
  );
}

/**
 * A visible, retryable failure. Silently swallowing this is what left users
 * staring at "Free" (or a shimmer) with no idea why.
 */
function AccountError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="si-account-error" role="alert">
      <span className="si-account-error-text">{message}</span>
      <button type="button" className="si-account-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Reads + keeps the active entitlement fresh (refreshing from the Worker on
 * sign-in). `loading` stays true until the first read resolves, so the UI can
 * show a neutral placeholder instead of flashing "Free" before Pro loads.
 * `error` explains a failed or cleared refresh; `retry` runs the whole thing
 * again.
 */
function useEntitlement(signedIn: boolean): {
  ent: ActiveEntitlement;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [ent, setEnt] = useState<ActiveEntitlement>(FREE_ENTITLEMENT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every run (and on unmount) so a superseded attempt can't paint.
  const runId = useRef(0);

  const load = useCallback(async () => {
    const id = ++runId.current;
    const live = () => runId.current === id;
    setLoading(true);
    setError(null);

    let refreshError: string | null = null;
    if (signedIn) {
      try {
        const res = (await browser.runtime.sendMessage({ type: 'si-refresh-entitlement' })) as
          | RefreshResult
          | undefined;
        refreshError = describeRefresh(res);
      } catch {
        refreshError = REFRESH_UNAVAILABLE; // background unreachable
      }
    }
    try {
      const e = await getActiveEntitlement();
      if (!live()) return;
      setEnt(e);
      setError(refreshError);
    } catch {
      if (!live()) return;
      setEnt(FREE_ENTITLEMENT);
      setError(REFRESH_UNAVAILABLE);
    }
    if (live()) setLoading(false);
  }, [signedIn]);

  useEffect(() => {
    void load();
    return () => {
      runId.current++; // supersede an in-flight run
    };
  }, [load]);

  return { ent, loading, error, retry: load };
}

function SignedInBar() {
  const { user } = useUser();
  const { ent, loading, error, retry } = useEntitlement(true);
  const isFree = ent.plan === 'developer';

  const email = user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? 'Signed in';
  const initial = (email[0] ?? '?').toUpperCase();

  return (
    <>
      <button
        type="button"
        className="si-profile"
        onClick={openAccountTab}
        title="Manage your account"
      >
        {user?.imageUrl ? (
          <img className="si-profile-avatar" src={user.imageUrl} alt={email} />
        ) : (
          <span className="si-profile-avatar si-profile-avatar--fallback">{initial}</span>
        )}
        <span className="si-profile-lines">
          <span className="si-profile-email" title={email}>
            {email}
          </span>
          {loading ? (
            <span className="si-profile-plan si-profile-plan--loading" aria-hidden="true" />
          ) : (
            <span className={`si-profile-plan${isFree ? '' : ' is-pro'}`}>{planText(ent)}</span>
          )}
        </span>
        <span className="si-profile-go" aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      <TeamLink ent={ent} />
      <ShadowDashboardLink ent={ent} />
      <PolicyUpdateNotice ent={ent} identity={user?.id ?? null} />
      {error && <AccountError message={error} onRetry={retry} />}
    </>
  );
}

function SignedOutBar() {
  return (
    <button
      type="button"
      className="si-profile si-profile--out"
      onClick={openAccountTab}
      title="Sign in"
    >
      <span className="si-profile-avatar si-profile-avatar--empty" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M5 19.5a7 7 0 0 1 14 0"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="si-profile-lines">
        <span className="si-profile-email">Not signed in</span>
        <span className="si-profile-plan">Sign in to unlock Pro</span>
      </span>
      <span className="si-profile-go" aria-hidden="true">
        <ChevronIcon />
      </span>
    </button>
  );
}

/**
 * Firefox bar. There's no ClerkProvider here (the chrome-extension SDK can't run
 * on Firefox — see clerkConfig), so we can't use `useUser`/`Show`. Instead we ask
 * the background to refresh the entitlement (which reads the session cookie) and
 * drive the UI off the result: `status: 'signed-out'` + a free plan means no
 * session; anything else means signed in. Sign-in / management happens on the web
 * account page, which syncs the cookie the background then reads.
 *
 * Everything the Chrome bar shows about a team — the org on the plan badge and
 * the admin's console link — has to show here too: a Firefox team admin has no
 * other route to their console.
 */
function FirefoxAccountBar() {
  const [ent, setEnt] = useState<ActiveEntitlement>(FREE_ENTITLEMENT);
  const [state, setState] = useState<'loading' | 'signed-in' | 'signed-out'>('loading');
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  const load = useCallback(async () => {
    const id = ++runId.current;
    const live = () => runId.current === id;
    setState('loading');
    setError(null);

    let signedOut = false;
    let refreshError: string | null = null;
    try {
      const res = (await browser.runtime.sendMessage({ type: 'si-refresh-entitlement' })) as
        | RefreshResult
        | undefined;
      signedOut = res?.status === 'signed-out';
      refreshError = describeRefresh(res);
    } catch {
      // Background unreachable — fall back to the cached entitlement below,
      // and say so rather than presenting a stale plan as the current truth.
      refreshError = REFRESH_UNAVAILABLE;
    }
    try {
      const e = await getActiveEntitlement();
      if (!live()) return;
      setEnt(e);
      setState(signedOut && e.plan === 'developer' ? 'signed-out' : 'signed-in');
      setError(refreshError);
    } catch {
      if (!live()) return;
      setEnt(FREE_ENTITLEMENT);
      setState('signed-in'); // can't prove they're signed out; don't claim it
      setError(REFRESH_UNAVAILABLE);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      runId.current++; // supersede an in-flight run
    };
  }, [load]);

  const retry = load;

  if (state === 'signed-out') {
    return (
      <>
        <SignedOutBar />
        {error && <AccountError message={error} onRetry={retry} />}
      </>
    );
  }

  const isFree = ent.plan === 'developer';
  const loading = state === 'loading';
  const email = ent.email ?? 'Signed in';
  const initial = (ent.email?.[0] ?? '?').toUpperCase();
  return (
    <>
      <button
        type="button"
        className="si-profile"
        onClick={openAccountTab}
        title="Manage your account"
      >
        {ent.email ? (
          <span className="si-profile-avatar si-profile-avatar--fallback">{initial}</span>
        ) : (
          <span className="si-profile-avatar si-profile-avatar--empty" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M5 19.5a7 7 0 0 1 14 0"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </span>
        )}
        <span className="si-profile-lines">
          <span className="si-profile-email" title={email}>
            {email}
          </span>
          {loading ? (
            <span className="si-profile-plan si-profile-plan--loading" aria-hidden="true" />
          ) : (
            <span className={`si-profile-plan${isFree ? '' : ' is-pro'}`}>{planText(ent)}</span>
          )}
        </span>
        <span className="si-profile-go" aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      <TeamLink ent={ent} />
      <ShadowDashboardLink ent={ent} />
      <PolicyUpdateNotice ent={ent} identity={ent.email} />
      {error && <AccountError message={error} onRetry={retry} />}
    </>
  );
}

export function AccountSection() {
  if (SHADOW_DEMO) return (
    <div className="si-profile-wrap">
      <button type="button" className="si-team-link" onClick={() => {
        browser.tabs.create({ url: new URL('shadow.html', browser.runtime.getURL('/popup.html')).href }).catch(() => {});
      }}>
        Live Shadow AI · local demo <ChevronIcon />
      </button>
    </div>
  );
  if (isClerkSdkEnabled()) {
    // Chrome: full Clerk SDK with signed-in/out components.
    return (
      <div className="si-profile-wrap">
        <Show when="signed-in">
          <SignedInBar />
        </Show>
        <Show when="signed-out">
          <SignedOutBar />
        </Show>
      </div>
    );
  }
  if (isAuthEnabled()) {
    // Firefox: cookie-based auth, no Clerk provider.
    return (
      <div className="si-profile-wrap">
        <FirefoxAccountBar />
      </div>
    );
  }
  return null; // auth not set up (no publishable key)
}
