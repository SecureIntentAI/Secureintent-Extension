/**
 * The package (KAU-25): Browser Free, Browser Pro, Desktop Pro (Browser Pro plus
 * the desktop app) and Business. Older blobs carry only `plan`.
 */
export type Tier = 'free' | 'browser_pro' | 'desktop_pro' | 'business';

/** The account's one 30-day Desktop Pro trial. `endsAt` is Unix seconds. */
export interface TrialInfo {
  state: 'none' | 'available' | 'active' | 'used';
  endsAt: number | null;
}

/** Mirrors the Worker's signed entitlement blob (backend lib/entitlementSign.ts). */
export interface SignedEntitlement {
  clerkUserId: string;
  // Optional for backward-compat with blobs cached before the Worker added it.
  email?: string | null;
  plan: 'developer' | 'developer_pro' | 'business_pro';
  /** Optional: blobs from before the Worker added packages carry only `plan`. */
  tier?: Tier;
  trial?: TrialInfo;
  source: 'manual' | 'lifetime' | 'org_seat' | 'paddle' | 'trial' | 'business_email' | 'none';
  /** The team this seat belongs to, when the plan came from an org subscription. */
  org?: { id: string; name: string | null; role: string | null; seats?: number } | null;
  pro: boolean;
  features: string[];
  status: string | null;
  businessDomain: string | null;
  issuedAt: number;
  exp: number;
}

/** What we persist: the blob, its detached Ed25519 signature, and the exact JSON
 *  string the signature was computed over. We verify against `payload` (not a
 *  re-`JSON.stringify` of `blob`), because a storage round-trip can change the
 *  serialized byte order and break the signature check. `payload` is optional
 *  for backward-compat with values cached before this field existed. */
export interface StoredEntitlement {
  blob: SignedEntitlement;
  signature: string;
  payload?: string;
}

/** The on-device view used by gating: which features are unlocked right now. */
export interface ActiveEntitlement {
  plan: SignedEntitlement['plan'];
  tier: Tier;
  trial: TrialInfo;
  pro: boolean;
  features: string[];
  source: SignedEntitlement['source'];
  businessDomain: string | null;
  email: string | null;
  org: { id: string; name: string | null; role: string | null; seats?: number } | null;
}

export const NO_TRIAL: TrialInfo = { state: 'none', endsAt: null };

export const FREE_ENTITLEMENT: ActiveEntitlement = {
  plan: 'developer',
  tier: 'free',
  trial: NO_TRIAL,
  pro: false,
  features: [],
  source: 'none',
  businessDomain: null,
  email: null,
  org: null,
};

/** Pro feature keys — must match the Worker's PRO_FEATURES. */
export type FeatureKey = 'rehydrate' | 'ghost' | 'session_lock';
