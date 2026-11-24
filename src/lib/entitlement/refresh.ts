import { API_BASE } from '@/lib/api/client';
import { abortable } from '@/lib/async';
import { signatureMap, verifySigned } from '@/lib/config/verify';
import { siDebug, siError } from '@/lib/debug';
import { setClockFloorFromServer } from './clock';
import { deviceLimitItem, getInstallId, parseDeviceLimit } from './device';
import { entitlementItem } from './store';
import type { SignedEntitlement } from './types';

export interface RefreshResult {
  status: 'updated' | 'cleared' | 'signed-out' | 'error';
  plan?: SignedEntitlement['plan'];
  error?: string;
}

/** Read the `sub` (Clerk user id) out of a session JWT without verifying it. */
function jwtSub(token: string): string | null {
  try {
    const part = token.split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the signed entitlement for the current Clerk session and persist it.
 * `getToken` returns the Clerk session JWT, or null when signed out.
 * On sign-out the cached entitlement is cleared (premium locks immediately).
 * Fails safe: any error leaves the existing cache untouched.
 */
export async function refreshEntitlement(
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  let token: string | null;
  try {
    signal?.throwIfAborted();
    token = await (signal ? abortable(getToken(), signal) : getToken());
    signal?.throwIfAborted();
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  if (!token) {
    await entitlementItem.setValue(null); // signed out → free
    await deviceLimitItem.setValue(null);
    return { status: 'signed-out' };
  }

  try {
    // X-SI-Install lets the Worker count this browser toward the account's
    // 5-browser limit; without it the limit was never enforced (24 Nov 2026).
    // This is the one place the extension calls /v1/entitlement, so every
    // browser and both token paths (Clerk SDK, Firefox cookie) send it.
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    try {
      headers['X-SI-Install'] = await getInstallId();
    } catch {
      // Storage unavailable: still fetch the plan rather than fail the refresh.
    }
    const res = await fetch(`${API_BASE}/v1/entitlement`, {
      headers,
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };

    const { entitlement, signatures, deviceLimit } = (await res.json()) as {
      entitlement: SignedEntitlement;
      signatures?: unknown;
      deviceLimit?: unknown;
    };

    // Verify against — and later persist — this exact string, so the read-time
    // check uses identical bytes (a storage round-trip can reorder a re-stringify).
    const payload = JSON.stringify(entitlement);
    const valid = await verifySigned('entitlement', payload, signatures);
    signal?.throwIfAborted(); // a late result must not overwrite a newer session
    if (!valid) {
      siError('entitlement', 'signature verification failed; clearing', null);
      await entitlementItem.setValue(null);
      await deviceLimitItem.setValue(null);
      return { status: 'cleared', error: 'bad signature' };
    }

    // Bind to the caller: the blob must belong to the same user whose token we
    // used. Guards against persisting an entitlement issued for a different user.
    const sub = jwtSub(token);
    if (sub && entitlement.clerkUserId !== sub) {
      siError('entitlement', 'user mismatch; clearing', null);
      await entitlementItem.setValue(null);
      await deviceLimitItem.setValue(null);
      return { status: 'cleared', error: 'user mismatch' };
    }

    // The verified issuedAt is server time: the clock floor becomes exactly that,
    // even if lower. Set before the blob so watchers that re-evaluate it on the
    // change already see the corrected floor (24 Nov 2026).
    await setClockFloorFromServer(entitlement.issuedAt);
    await entitlementItem.setValue({
      blob: entitlement,
      signatures: signatureMap(signatures) ?? {},
      payload,
    });
    // Over the browser limit the signed blob is the free plan and deviceLimit
    // says why, for the popup to explain. Absent means this browser counts.
    await deviceLimitItem.setValue(parseDeviceLimit(deviceLimit));
    siDebug('entitlement', 'refreshed', { plan: entitlement.plan, pro: entitlement.pro });
    return { status: 'updated', plan: entitlement.plan };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
