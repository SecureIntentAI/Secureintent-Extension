import { createClerkClient } from '@clerk/chrome-extension/client';
import { API_BASE } from '@/lib/api/client';
import { abortable, withDeadline } from '@/lib/async';
import {
  CLERK_JWT_TEMPLATE,
  CLERK_PUBLISHABLE_KEY,
  CLERK_SYNC_HOST,
  IS_FIREFOX,
  isAuthEnabled,
} from '@/lib/clerkConfig';
import { configItem } from '@/lib/config/store';
import { siDebug } from '@/lib/debug';
import { entitlementItem, getActiveEntitlement } from '@/lib/entitlement';
import { type RefreshResult, refreshEntitlement } from '@/lib/entitlement/refresh';
import { offlineUsed } from '@/lib/quota/offline';
import { getClerkTokenFromCookie, getClerkUserIdFromCookie } from './cookieToken';

/**
 * Mint a fresh Clerk session token from the background service worker (no DOM).
 * Returns null when Clerk is unconfigured or the user is signed out.
 */
export async function getClerkToken(): Promise<string | null> {
  if (!isAuthEnabled()) return null;
  // Config, connection reports and stream leases also call this outside the
  // entitlement refresh deadline. A stuck SDK must not pin those loops forever.
  return withDeadline(async (signal) => {
    // Firefox uses the web-app session cookie; missing claims are hydrated by the API.
    if (IS_FIREFOX) return abortable(getClerkTokenFromCookie(), signal);
    const clerk = await abortable(
      createClerkClient({
        publishableKey: CLERK_PUBLISHABLE_KEY,
        syncHost: CLERK_SYNC_HOST,
        background: true,
      }),
      signal,
    );
    if (!clerk.session) return null;
    return abortable(clerk.session.getToken({ template: CLERK_JWT_TEMPLATE }), signal);
  });
}

let pendingRefresh: { controller: AbortController; promise: Promise<RefreshResult> } | undefined;
const SUPERSEDED = 'superseded';
const SUPERSEDED_RETRY_MS = 700;

/** A session change must not reuse, or be overwritten by, an older refresh. */
export function invalidateEntitlementRefresh(): void {
  const previous = pendingRefresh;
  pendingRefresh = undefined;
  previous?.controller.abort(SUPERSEDED);
}

/**
 * Share concurrent popup/startup refreshes; release the request on failure/timeout.
 * A refresh cancelled by a session change answers with a fresh check for the
 * new session (once), so a waiting popup never reports that as a failure.
 */
export function refreshEntitlementBg(supersededRetries = 2): Promise<RefreshResult> {
  if (pendingRefresh) return pendingRefresh.promise;
  const controller = new AbortController();
  const promise = withDeadline(async (signal) => {
    const result = await refreshEntitlement(getClerkToken, signal);
    // Even when the API is offline, reject a cached plan belonging to a
    // different known session. Keep this check inside the shared pipeline.
    const identityChanged = await enforceEntitlementBinding(signal);
    // A policy belongs to a seat, not an installation. Never leave the old
    // team's rules/custom patterns attached after a confirmed identity change.
    if (
      identityChanged ||
      result.status === 'signed-out' ||
      result.status === 'updated' ||
      result.status === 'cleared'
    ) {
      const [bundle, ent] = await Promise.all([configItem.getValue(), getActiveEntitlement()]);
      signal.throwIfAborted();
      if (
        bundle?.policy &&
        (!ent.org || (bundle.policy.orgId && bundle.policy.orgId !== ent.org.id))
      ) {
        await configItem.setValue(null);
      }
    }
    return result;
  }, controller)
    .catch((error): RefreshResult | Promise<RefreshResult> => {
      // A sign-in changes the session more than once in quick succession, so
      // wait out the burst (the background debounces it by 500 ms) first.
      if (supersededRetries > 0 && controller.signal.reason === SUPERSEDED)
        return new Promise<void>((resolve) => setTimeout(resolve, SUPERSEDED_RETRY_MS)).then(() =>
          refreshEntitlementBg(supersededRetries - 1),
        );
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .then((result) => {
      siDebug('entitlement', 'bg refresh', { status: result.status, plan: result.plan ?? null });
      return result;
    })
    .finally(() => {
      if (pendingRefresh?.controller === controller) pendingRefresh = undefined;
    });
  pendingRefresh = { controller, promise };
  return promise;
}

/** The currently signed-in Clerk user id from the background session, or null. */
export async function getClerkUserId(): Promise<string | null> {
  if (!isAuthEnabled()) return null;
  if (IS_FIREFOX) return getClerkUserIdFromCookie();
  try {
    const clerk = await withDeadline((signal) =>
      abortable(
        createClerkClient({
          publishableKey: CLERK_PUBLISHABLE_KEY,
          syncHost: CLERK_SYNC_HOST,
          background: true,
        }),
        signal,
      ),
    );
    return clerk.session?.user?.id ?? clerk.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Clear the cached entitlement if it was issued for a different user than the
 * one currently signed in — a signed blob is otherwise portable between installs
 * until it expires. Null-safe: only clears on a DEFINITE mismatch (a known,
 * different user id), never when the session id can't be read, so a legitimate
 * user is never wrongly downgraded to free.
 */
export async function enforceEntitlementBinding(signal?: AbortSignal): Promise<boolean> {
  const stored = await entitlementItem.getValue();
  if (!stored) return false;
  const userId = await (signal ? abortable(getClerkUserId(), signal) : getClerkUserId());
  signal?.throwIfAborted();
  if (userId && stored.blob.clerkUserId !== userId) {
    const latest = await entitlementItem.getValue();
    signal?.throwIfAborted();
    if (
      latest?.signature !== stored.signature ||
      latest?.blob.clerkUserId !== stored.blob.clerkUserId
    )
      return false;
    siDebug('entitlement', 'binding mismatch — clearing', { current: userId });
    await entitlementItem.setValue(null);
    return true;
  }
  return false;
}

/** GET the signed-in user's Anonymise & Paste allowance from the Worker. */
export async function getUsageStatus(): Promise<unknown | null> {
  try {
    return await withDeadline(async (signal) => {
      const token = await abortable(getClerkToken(), signal);
      if (!token) return null;
      // Carry the on-device (offline) count into the account so signing in doesn't
      // reset the allowance to a fresh 10/10 — the backend reconciles to the max.
      const offline = await offlineUsed().catch(() => 0);
      const res = await fetch(`${API_BASE}/v1/usage`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-SI-Offline-Used': String(offline),
        },
        cache: 'no-store',
        signal,
      });
      return res.ok ? await res.json() : null;
    });
  } catch {
    return null;
  }
}

/** Consume one Anonymise & Paste for the signed-in user. */
export async function consumeUsage(): Promise<unknown | null> {
  try {
    return await withDeadline(async (signal) => {
      const token = await abortable(getClerkToken(), signal);
      if (!token) return null;
      const res = await fetch(`${API_BASE}/v1/usage/anonymize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      return res.ok ? await res.json() : null;
    });
  } catch {
    return null;
  }
}

// Note: there is deliberately no in-extension checkout starter here. Buying a
// plan happens on the account page (ACCOUNT_URL), which already runs the Paddle
// flow against the signed-in web session — a second, extension-initiated path
// would be a second destination for the one "upgrade" intent.
