import { useEffect, useState } from 'react';
import { browser, storage } from '#imports';
import { ACCOUNT_URL, isAuthEnabled } from '@/lib/clerkConfig';
import { getActiveBundle } from '@/lib/config';
import { entitlementItem, getActiveEntitlement } from '@/lib/entitlement';
import { getAnonymizeStatus } from '@/lib/quota';
import { buildPlanView, type FeatureState, type PlanView } from './planFeatures';

function FeatureStateIcon({ state }: { state: FeatureState }) {
  if (state === 'locked') {
    return (
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
        <rect x="5" y="10.5" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8.4 12.2l2.4 2.4 4.8-5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlanChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`si-plan-chev${open ? ' is-open' : ''}`}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9.6 9.4a2.4 2.4 0 0 1 4.6.9c0 1.6-2.2 1.9-2.2 3.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** Remembers whether the plan checklist is expanded (default: shown). */
const planExpandedItem = storage.defineItem<boolean>('local:si_plan_expanded', { fallback: true });

type LoadState = { kind: 'loading' } | { kind: 'ready'; view: PlanView } | { kind: 'error' };

/**
 * How many patterns in the active bundle the team's own admin wrote. Only a
 * team's own patterns are ever marked, so this is 0 for every install without
 * one and the card stays exactly as it is today. Never throws: a plan card must
 * not fail over a decoration.
 */
async function countTeamRules(): Promise<number> {
  try {
    const bundle = await getActiveBundle();
    return bundle.patterns.filter((p) => p.origin === 'team').length;
  } catch {
    return 0;
  }
}

/** Read the cached entitlement + allowance and turn them into the checklist. */
async function computeView(): Promise<PlanView> {
  const [stored, ent] = await Promise.all([entitlementItem.getValue(), getActiveEntitlement()]);
  const snap = {
    plan: ent.plan,
    source: ent.source,
    pro: ent.pro,
    signedIn: stored !== null,
    userId: null, // this snapshot is used only for quota display
    businessDomain: ent.businessDomain,
    orgId: ent.org?.id ?? null,
    orgName: ent.org?.name ?? null,
    actorId: null, // quota only needs plan + sign-in state
  };
  const [quota, teamRules] = await Promise.all([getAnonymizeStatus(snap), countTeamRules()]);
  return buildPlanView({ plan: ent.plan, pro: ent.pro, quota, org: ent.org, teamRules });
}

/** "Your plan" card: every feature with its per-plan state (Active / usage / Pro). */
export function PlanCard() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [open, setOpen] = useState(true);
  // Bumped on every run (and on unmount) so a superseded attempt can't paint.
  const runId = useRef(0);

  useEffect(() => {
    planExpandedItem.getValue().then(setOpen);
  }, []);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      planExpandedItem.setValue(next).catch(() => {});
      return next;
    });
  };

  const load = useCallback(async () => {
    const id = ++runId.current;
    const live = () => runId.current === id;
    setState({ kind: 'loading' });

    // Paint immediately from the cached entitlement (a local read, instant).
    // A failure here is visible and retryable: the skeleton used to sit there
    // aria-hidden forever, telling the user nothing.
    try {
      const view = await computeView();
      if (!live()) return;
      setState({ kind: 'ready', view });
    } catch {
      if (live()) setState({ kind: 'error' });
      return;
    }

    // ...then reconcile with the LIVE Clerk session in the background — a
    // sign-out otherwise leaves a stale Pro blob showing "Unlimited" — and
    // repaint. This never blocks the first render (that round-trip is slow),
    // and a failure leaves the cached view up: AccountSection owns explaining
    // that the plan couldn't be re-checked.
    try {
      await browser.runtime.sendMessage({ type: 'si-refresh-entitlement' });
      const view = await computeView();
      if (live()) setState({ kind: 'ready', view });
    } catch {
      /* keep the cached view */
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      runId.current++; // supersede an in-flight run
    };
  }, [load, runId]);

  if (state.kind === 'error') {
    return (
      <section className="si-plan si-plan--in">
        <div className="si-plan-head">
          <span className="si-plan-title">Your plan</span>
        </div>
        <p className="si-plan-error" role="alert">
          Couldn't load your plan. Detection and warnings are still running — this only affects what
          this card can show.
        </p>
        <button type="button" className="si-plan-retry" onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  }

  if (state.kind === 'loading') {
    // Instant skeleton so the section never pops in from nothing.
    return (
      <section className="si-plan si-plan--skeleton" aria-hidden="true">
        <div className="si-plan-head">
          <span className="si-plan-title">Your plan</span>
          <span className="si-skel si-skel-tag" />
        </div>
        <ul className="si-plan-list">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="si-feat">
              <span className="si-skel si-skel-ic" />
              <span className="si-skel si-skel-label" />
              <span className="si-skel si-skel-state" />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const { view } = state;
  return (
    <section className="si-plan si-plan--in">
      <div className="si-plan-head">
        <button
          type="button"
          className="si-plan-toggle"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="si-plan-body"
        >
          <PlanChevron open={open} />
          <span className="si-plan-title">Your plan</span>
        </button>
        <span className={`si-plan-tag${view.isPro ? ' is-pro' : ''}`}>{view.planLabel}</span>
        {/* A seat holder shouldn't be sold a plan they already have through work. */}
        {!view.isPro && !view.org && isAuthEnabled() && (
          <button
            type="button"
            className="si-plan-upgrade"
            onClick={() => browser.tabs.create({ url: ACCOUNT_URL }).catch(() => {})}
          >
            Upgrade
          </button>
        )}
      </div>
      {/* Where the plan comes from: an employee should see at a glance that this
        is their company's seat, and who to ask about it. */}
      {view.org && (
        <p className="si-plan-org">
          Team seat from <b>{view.org.name}</b> —{' '}
          {view.org.isAdmin ? 'you administer this team.' : 'managed by your admin.'}
        </p>
      )}
      {/* Quiet reassurance for a member: the rules their admin wrote really are
        running here. Rendered only when the signed bundle actually carries some,
        so an install with no team shows nothing at all. */}
      {view.teamRules > 0 && (
        <p className="si-plan-team-rules">
          <span className="si-plan-team-chip">Team rules</span>
          {view.teamRules === 1
            ? "1 rule from your team's admin is active."
            : `${view.teamRules} rules from your team's admin are active.`}
        </p>
      )}
      <div id="si-plan-body" className={`si-plan-body${open ? ' is-open' : ''}`}>
        <ul className="si-plan-list">
          {view.rows.map((r) => (
            <li key={r.key} className={`si-feat si-feat--${r.state}`}>
              <span className="si-feat-ic">
                <FeatureStateIcon state={r.state} />
              </span>
              <span className="si-feat-label">{r.label}</span>
              <button type="button" className="si-feat-help" aria-label={r.note}>
                <HelpIcon />
                <span className="si-feat-tip" role="tooltip">
                  {r.note}
                </span>
              </button>
              <span className="si-feat-state">{r.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
