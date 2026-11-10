import { API_BASE } from '@/lib/api/client';
import { abortable } from '@/lib/async';
import { signatureMap, verifySigned } from '@/lib/config/verify';
import { siDebug, siError } from '@/lib/debug';
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
    return { status: 'signed-out' };
  }

  try {
    const res = await fetch(`${API_BASE}/v1/entitlement`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };

    const { entitlement, signatures } = (await res.json()) as {
      entitlement: SignedEntitlement;
      signatures?: unknown;
    };

    // Verify against — and later persist — this exact string, so the read-time
    // check uses identical bytes (a storage round-trip can reorder a re-stringify).
    const payload = JSON.stringify(entitlement);
    const valid = await verifySigned('entitlement', payload, signatures);
    signal?.throwIfAborted(); // a late result must not overwrite a newer session
    if (!valid) {
      siError('entitlement', 'signature verification failed; clearing', null);
      await entitlementItem.setValue(null);
      return { status: 'cleared', error: 'bad signature' };
    }

    // Bind to the caller: the blob must belong to the same user whose token we
    // used. Guards against persisting an entitlement issued for a different user.
    const sub = jwtSub(token);
    if (sub && entitlement.clerkUserId !== sub) {
      siError('entitlement', 'user mismatch; clearing', null);
      await entitlementItem.setValue(null);
      return { status: 'cleared', error: 'user mismatch' };
    }

    await entitlementItem.setValue({
      blob: entitlement,
      signatures: signatureMap(signatures) ?? {},
      payload,
    });
    siDebug('entitlement', 'refreshed', { plan: entitlement.plan, pro: entitlement.pro });
    return { status: 'updated', plan: entitlement.plan };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
