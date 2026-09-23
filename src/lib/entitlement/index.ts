import { verifyBundle } from '@/lib/config/verify';
import { entitlementItem } from './store';
import {
  type ActiveEntitlement,
  type FeatureKey,
  FREE_ENTITLEMENT,
  type SignedEntitlement,
  type StoredEntitlement,
} from './types';

export type { ActiveEntitlement, FeatureKey, SignedEntitlement, StoredEntitlement };
export { entitlementItem, FREE_ENTITLEMENT };

/**
 * Pure evaluation: given a (possibly signature-valid) blob and the current time,
 * decide what is unlocked. An invalid signature or an expired blob → free.
 * Crypto verification is done by the caller and passed in as `signatureValid`.
 *
 * `expectedUserId` binds the blob to a Clerk user: a valid signature only proves
 * the Worker issued the blob, not that it belongs to *this* install. When an id
 * is supplied (a string, or null when signed out) and it doesn't match
 * `blob.clerkUserId`, the entitlement is rejected — this stops a signed pro blob
 * from being copied into another install. Omit it (undefined) to skip the check
 * in contexts without access to the live session (e.g. content scripts, which
 * instead rely on the background enforcer clearing a mismatch).
 */
export function evaluateBlob(
  blob: SignedEntitlement,
  nowSec: number,
  signatureValid: boolean,
  expectedUserId?: string | null,
): ActiveEntitlement {
  if (
    !signatureValid ||
    !blob ||
    !Number.isFinite(blob.exp) ||
    blob.exp <= nowSec ||
    typeof blob.clerkUserId !== 'string' ||
    typeof blob.pro !== 'boolean' ||
    !['developer', 'developer_pro', 'business_pro'].includes(blob.plan) ||
    !Array.isArray(blob.features) ||
    !blob.features.every((key) => typeof key === 'string')
  )
    return FREE_ENTITLEMENT;
  if (expectedUserId !== undefined && blob.clerkUserId !== expectedUserId) return FREE_ENTITLEMENT;
  return {
    plan: blob.plan,
    pro: blob.pro,
    features: blob.features,
    source: blob.source,
    businessDomain: blob.businessDomain ?? null,
    email: blob.email ?? null,
    org: blob.org ?? null,
  };
}

/** Verify the stored blob's signature, then evaluate it. Defaults to free. */
export async function evaluateStored(
  stored: StoredEntitlement | null,
  nowSec: number,
  expectedUserId?: string | null,
): Promise<ActiveEntitlement> {
  if (!stored) return FREE_ENTITLEMENT;
  // Verify against the exact signed payload when present; fall back to a
  // re-stringify only for values cached before `payload` was stored.
  try {
    const payload = stored.payload ?? JSON.stringify(stored.blob);
    const valid = await verifyBundle(payload, stored.signature);
    // Only interpret bytes authenticated by the signature, never the duplicate blob.
    return evaluateBlob(JSON.parse(payload), nowSec, valid, expectedUserId);
  } catch {
    return FREE_ENTITLEMENT;
  }
}

/**
 * Read + verify + evaluate the persisted entitlement. Pass `expectedUserId` to
 * bind it to the currently signed-in user (background/popup); omit it in
 * content scripts.
 */
export async function getActiveEntitlement(
  expectedUserId?: string | null,
): Promise<ActiveEntitlement> {
  const stored = await entitlementItem.getValue();
  return evaluateStored(stored, Math.floor(Date.now() / 1000), expectedUserId);
}

// --- Synchronous cache for content-script hot paths (mirrors the `enabled` flag) ---

/** User-context snapshot read synchronously by the telemetry hot path. */
export interface EntitlementSnapshot {
  plan: ActiveEntitlement['plan'];
  source: ActiveEntitlement['source'];
  pro: boolean;
  signedIn: boolean;
  businessDomain: string | null;
  /** The team this seat belongs to, so events can be grouped by company. */
  orgId: string | null;
  orgName: string | null;
  /**
   * Stable pseudonym for this person inside their team: SHA-256 of the Clerk
   * user id and the org id. Lets a team's own dashboard count distinct people
   * without us shipping their identity — an admin's view is aggregate today,
   * and this is the key that could join to a name later if they ever turn that
   * on. Null outside a team: individual telemetry stays fully anonymous.
   */
  actorId: string | null;
}

const FREE_SNAPSHOT: EntitlementSnapshot = {
  plan: 'developer',
  source: 'none',
  pro: false,
  signedIn: false,
  businessDomain: null,
  orgId: null,
  orgName: null,
  actorId: null,
};

/** SHA-256(userId:orgId), hex, truncated — a per-team pseudonym, not an id. */
async function computeActorId(userId: string, orgId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${userId}:${orgId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

let cachedFeatures = new Set<string>();
let cachedSnapshot: EntitlementSnapshot = FREE_SNAPSHOT;
let cachedExpiry = 0;
let cacheRevision = 0;

async function computeCache(): Promise<{
  features: Set<string>;
  snapshot: EntitlementSnapshot;
  expiry: number;
}> {
  const stored = await entitlementItem.getValue();
  const ent = await evaluateStored(stored, Math.floor(Date.now() / 1000));
  let signed: SignedEntitlement | null = null;
  try {
    signed = JSON.parse(stored?.payload ?? JSON.stringify(stored?.blob ?? null));
  } catch {}
  return {
    expiry: signed?.exp ?? 0,
    features: new Set(ent.features),
    // signedIn: any stored blob means the user authenticated (even on the free tier).
    snapshot: {
      plan: ent.plan,
      source: ent.source,
      pro: ent.pro,
      signedIn: stored !== null,
      businessDomain: ent.businessDomain,
      orgId: ent.org?.id ?? null,
      orgName: ent.org?.name ?? null,
      actorId:
        ent.org && signed?.clerkUserId
          ? await computeActorId(signed.clerkUserId, ent.org.id)
          : null,
    },
  };
}

/**
 * Prime the in-memory caches and keep them fresh as the entitlement changes.
 * Call once at content-script boot. Returns a stop() to remove the watcher.
 */
export async function initEntitlementCache(): Promise<() => void> {
  const update = async () => {
    const revision = ++cacheRevision;
    const next = await computeCache();
    if (revision !== cacheRevision) return;
    cachedFeatures = next.features;
    cachedSnapshot = next.snapshot;
    cachedExpiry = next.expiry;
  };
  const stop = entitlementItem.watch(() => {
    void update();
  });
  await update();
  return stop;
}

/** Synchronous gate for the paste/lock hot paths. Reads the primed cache. */
export function hasFeatureCached(key: FeatureKey): boolean {
  return cachedExpiry > Date.now() / 1000 && cachedFeatures.has(key);
}

/** Synchronous user-context snapshot for telemetry. Reads the primed cache. */
export function getEntitlementSnapshot(): EntitlementSnapshot {
  return cachedExpiry > Date.now() / 1000 ? cachedSnapshot : FREE_SNAPSHOT;
}

/**
 * Whether this person administers a team. Drives the console link: a member has
 * nothing to manage, so offering them the console is a dead end.
 */
export function canManageTeam(ent: ActiveEntitlement): boolean {
  return ent.org?.role === 'org:admin';
}

/** Async one-shot gate (popup / non-hot paths). */
export async function hasFeature(key: FeatureKey): Promise<boolean> {
  return (await getActiveEntitlement()).features.includes(key);
}
