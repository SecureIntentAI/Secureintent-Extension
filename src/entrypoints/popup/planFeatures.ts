import type { Tier, TrialInfo } from '@/lib/entitlement/types';
import { formatQuotaReset, type QuotaStatus } from '@/lib/quota';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Visual state of a feature row in the "Your plan" checklist. */
export type FeatureState = 'active' | 'usage' | 'locked' | 'soon';

export interface FeatureRow {
  key: string;
  label: string;
  state: FeatureState;
  /** Right-column text: "Active" | "Unlimited" | "9 / 10 left" | "Pro" | "Business" | "Coming soon". */
  detail: string;
  /** One-line explanation shown in the "?" tooltip beside the label. */
  note: string;
}

/** The team a seat belongs to, phrased for the person holding it. */
export interface PlanOrgView {
  name: string;
  isAdmin: boolean;
}

/** A running trial: how long is left, for the card to say. */
export interface PlanTrialView {
  daysLeft: number;
  /** e.g. "3 Dec": the trial's last day, in the user's locale. */
  endsOn: string;
}

export interface PlanView {
  planLabel: string;
  isPro: boolean;
  /** Set while the 30-day Desktop Pro trial is running. */
  trial: PlanTrialView | null;
  /** The account can still start its one trial: show Start trial. */
  canStartTrial: boolean;
  /** Set when this plan is a team seat, so the card can say who provides it. */
  org: PlanOrgView | null;
  /**
   * How many patterns in the active bundle the team's own admin authored
   * (`origin === 'team'`). 0 for everyone else — a user with no team can never
   * have one, because the Worker only marks a caller's OWN team patterns — and
   * the card then shows nothing at all about teams.
   */
  teamRules: number;
  rows: FeatureRow[];
}

/** The package names (KAU-25), one spelling each, used by every popup surface. */
export const TIER_LABEL: Record<Tier, string> = {
  free: 'Browser Free',
  browser_pro: 'Browser Pro',
  desktop_pro: 'Desktop Pro',
  business: 'Business',
};

/** The trial's days left and last day, or null when it is not running. */
function trialView(trial: TrialInfo, nowMs: number): PlanTrialView | null {
  if (trial.state !== 'active' || trial.endsAt === null) return null;
  const endsMs = trial.endsAt * 1000;
  if (endsMs <= nowMs) return null;
  return {
    daysLeft: Math.ceil((endsMs - nowMs) / DAY_MS),
    endsOn: new Date(endsMs).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
  };
}

/**
 * Feature names are product names: one spelling each, used verbatim in the popup
 * and in the overlay (see `src/overlay/Overlay.tsx`). Change them here, not there.
 */
const TOOLKIT: ReadonlyArray<{ key: string; label: string; note: string }> = [
  {
    key: 'rehydrate',
    label: 'Rehydrate Vault',
    note: 'Restore the original secrets from masked tokens later in the same session.',
  },
  {
    key: 'ghost',
    label: 'Ghost Log Sanitiser',
    note: 'Strip secrets, IPs and emails from large logs before you paste them.',
  },
  {
    key: 'session_lock',
    label: 'Session Lock',
    note: 'PIN-lock high-risk cloud consoles after inactivity or tab-away.',
  },
];

/**
 * Team features. Both ship and run in production today — they are part of the
 * Business Pro plan, not a roadmap — so they read as included there and as a
 * locked upsell on every lower tier. Nothing in this file says "Soon".
 */
const BUSINESS_TOOLKIT: ReadonlyArray<{ key: string; label: string; note: string }> = [
  {
    key: 'team_policy',
    label: 'Team Policy Sync',
    note: 'Push shared detection rules and settings across your whole team.',
  },
];

/**
 * Not available yet on any plan: security alerts arrive with the SecureIntent
 * desktop app. The team console's Alerts page is a preview until then.
 */
const COMING_SOON: ReadonlyArray<{ key: string; label: string; note: string }> = [
  {
    key: 'team_alerts',
    label: 'Security-Team Alerts',
    note: 'Coming with the SecureIntent desktop app: notify your security team when a teammate pastes a secret.',
  },
];

const ANON_LABEL = 'Anonymise & Paste';
const ANON_NOTE = 'Swap detected secrets for masked tokens so you can paste without leaking them.';

/** The Anonymise & Paste row: unlimited on Pro, a countdown on Free, spent at 0. */
function anonymiseRow(quota: QuotaStatus, nowMs: number): FeatureRow {
  if (quota.unlimited) {
    return {
      key: 'anonymise',
      label: ANON_LABEL,
      state: 'active',
      detail: 'Unlimited',
      note: ANON_NOTE,
    };
  }
  if (quota.signInRequired) {
    return {
      key: 'anonymise',
      label: ANON_LABEL,
      state: 'locked',
      detail: 'Sign in',
      note: `Sign in to use it. A free account includes ${quota.limit} anonymised pastes a month.`,
    };
  }
  if (quota.remaining <= 0) {
    // Spent. Say so plainly and say when it comes back — the quota runs on the
    // UTC calendar month (see src/lib/quota/reset.ts).
    const resetsOn = formatQuotaReset(nowMs);
    return {
      key: 'anonymise',
      label: ANON_LABEL,
      state: 'locked',
      detail: `Resets ${resetsOn}`,
      note: `You have used all ${quota.limit} free anonymised pastes this month. The allowance comes back on ${resetsOn} (UTC); Pro is unlimited.`,
    };
  }
  return {
    key: 'anonymise',
    label: ANON_LABEL,
    state: 'usage',
    detail: `${quota.remaining} / ${quota.limit} left`,
    note: ANON_NOTE,
  };
}

/**
 * Derive the plan checklist shown in the popup (and mirrored on the account
 * page): the always-on detection row, the monthly Anonymise & Paste allowance,
 * the Pro toolkit (active or locked), then the Business team features.
 */
export function buildPlanView(input: {
  tier: Tier;
  pro: boolean;
  trial?: TrialInfo;
  quota: QuotaStatus;
  /** The entitlement's org, when this plan is a seat someone else pays for. */
  org?: { name: string | null; role: string | null } | null;
  /** Team-authored patterns in the active bundle; omitted/0 means none. */
  teamRules?: number;
  /** Injectable clock — the quota reset date is derived from it. */
  nowMs?: number;
}): PlanView {
  const {
    tier,
    pro,
    quota,
    trial = { state: 'none', endsAt: null },
    org = null,
    teamRules = 0,
    nowMs = Date.now(),
  } = input;

  const rows: FeatureRow[] = [
    {
      key: 'detection',
      label: 'Detection & warnings',
      state: 'active',
      detail: 'Active',
      note: 'Scans every paste on-device and warns before secrets reach the page.',
    },
    anonymiseRow(quota, nowMs),
    ...TOOLKIT.map((f) =>
      pro
        ? { ...f, state: 'active' as const, detail: 'Active' }
        : { ...f, state: 'locked' as const, detail: 'Pro' },
    ),
    // "Business", not "Pro": a Browser Pro user already is Pro, so telling them
    // to upgrade to Pro for these would be a dead end.
    ...BUSINESS_TOOLKIT.map((f) =>
      tier === 'business'
        ? { ...f, state: 'active' as const, detail: 'Active' }
        : { ...f, state: 'locked' as const, detail: 'Business' },
    ),
    ...COMING_SOON.map((f) => ({ ...f, state: 'soon' as const, detail: 'Coming soon' })),
  ];

  return {
    // Every Business seat is the Business package, admin or member alike.
    planLabel: TIER_LABEL[tier],
    isPro: pro,
    trial: trialView(trial, nowMs),
    canStartTrial: trial.state === 'available' && !org,
    org: org ? { name: org.name ?? 'your team', isAdmin: org.role === 'org:admin' } : null,
    // Clamped: a negative or fractional count could only come from a bug, and
    // the card renders this number to the user.
    teamRules: Number.isFinite(teamRules) && teamRules > 0 ? Math.floor(teamRules) : 0,
    rows,
  };
}
