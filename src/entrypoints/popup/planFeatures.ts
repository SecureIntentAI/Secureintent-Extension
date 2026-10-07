import { formatQuotaReset, type QuotaStatus } from '@/lib/quota';

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

export interface PlanView {
  planLabel: string;
  isPro: boolean;
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

const PLAN_LABEL: Record<'developer' | 'developer_pro' | 'business_pro', string> = {
  developer: 'Free',
  developer_pro: 'Developer Pro',
  business_pro: 'Business Pro',
};

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
  plan: 'developer' | 'developer_pro' | 'business_pro';
  pro: boolean;
  quota: QuotaStatus;
  /** The entitlement's org, when this plan is a seat someone else pays for. */
  org?: { name: string | null; role: string | null } | null;
  /** Team-authored patterns in the active bundle; omitted/0 means none. */
  teamRules?: number;
  /** Injectable clock — the quota reset date is derived from it. */
  nowMs?: number;
}): PlanView {
  const { plan, pro, quota, org = null, teamRules = 0, nowMs = Date.now() } = input;

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
    // "Business", not "Pro": a Developer Pro user already is Pro, so telling them
    // to upgrade to Pro for these would be a dead end.
    ...BUSINESS_TOOLKIT.map((f) =>
      plan === 'business_pro'
        ? { ...f, state: 'active' as const, detail: 'Active' }
        : { ...f, state: 'locked' as const, detail: 'Business' },
    ),
    ...COMING_SOON.map((f) => ({ ...f, state: 'soon' as const, detail: 'Coming soon' })),
  ];

  return {
    planLabel:
      plan === 'business_pro' && org?.role === 'org:member' ? 'Developer Pro' : PLAN_LABEL[plan],
    isPro: pro,
    org: org ? { name: org.name ?? 'your team', isAdmin: org.role === 'org:admin' } : null,
    // Clamped: a negative or fractional count could only come from a bug, and
    // the card renders this number to the user.
    teamRules: Number.isFinite(teamRules) && teamRules > 0 ? Math.floor(teamRules) : 0,
    rows,
  };
}
