/** Mirrors the Worker's signed entitlement blob (backend lib/entitlementSign.ts). */
export interface SignedEntitlement {
  clerkUserId: string;
  // Optional for backward-compat with blobs cached before the Worker added it.
  email?: string | null;
  plan: 'developer' | 'developer_pro' | 'business_pro';
  source: 'manual' | 'lifetime' | 'org_seat' | 'paddle' | 'business_email' | 'none';
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
  pro: boolean;
  features: string[];
  source: SignedEntitlement['source'];
  businessDomain: string | null;
  email: string | null;
  org: { id: string; name: string | null; role: string | null; seats?: number } | null;
}

export const FREE_ENTITLEMENT: ActiveEntitlement = {
  plan: 'developer',
  pro: false,
  features: [],
  source: 'none',
  businessDomain: null,
  email: null,
  org: null,
};

/** Pro feature keys — must match the Worker's PRO_FEATURES. */
export type FeatureKey = 'rehydrate' | 'ghost' | 'session_lock';
