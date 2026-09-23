import { getJson } from '@/lib/api/client';
import { shouldAcceptBundle } from '@/lib/config/freshness';
import { configItem, saveBundle } from '@/lib/config/store';
import type { ConfigBundle } from '@/lib/config/types';
import { validateBundle } from '@/lib/config/validate';
import { verifyBundle } from '@/lib/config/verify';
import { siError } from '@/lib/debug';
import { getClerkToken } from './entitlementBackground';

export interface SyncResult {
  status: 'updated' | 'unchanged' | 'error';
  version?: number;
  error?: string;
}

/**
 * Bearer header for `/v1/config`, when a Clerk session exists. The Worker uses
 * it to resolve the caller's org and attach that team's policy to the bundle.
 *
 * Best-effort by design: signed out there is no token, and a mint that fails
 * (offline, Clerk down, cookie missing on Firefox) must not stop config sync —
 * that channel also carries the kill switch and the pattern updates, so it has
 * to keep working anonymously exactly as it did before Team Policy Sync.
 */
async function authHeaders(): Promise<{
  headers?: Record<string, string>;
  authenticated: boolean;
}> {
  try {
    const token = await getClerkToken();
    return token
      ? { headers: { Authorization: `Bearer ${token}` }, authenticated: true }
      : { authenticated: false };
  } catch (err) {
    siError('config', 'token unavailable, syncing anonymously', err);
    return { authenticated: false };
  }
}

export async function syncConfig(): Promise<SyncResult> {
  const request = ++syncRevision;
  try {
    const { headers, authenticated } = await authHeaders();
    const { bundle, signature } = await getJson<{ bundle: unknown; signature: string | null }>(
      '/v1/config',
      headers,
    );
    if (!validateBundle(bundle)) return { status: 'error', error: 'invalid bundle' };

    const incoming = bundle as ConfigBundle;
    // Signature check gates EVERYTHING in the bundle, policy included: an
    // unverified bundle is never persisted, so a forged team policy can never
    // reach the guard. This is the only writer of the active bundle.
    if (!(await verifyBundle(JSON.stringify(incoming), signature))) {
      return { status: 'error', error: 'signature verification failed' };
    }

    const current = await configItem.getValue();
    if (request !== syncRevision) return { status: 'unchanged', version: current?.version };
    if (!shouldAcceptBundle(current, incoming, authenticated)) {
      return { status: 'unchanged', version: current?.version };
    }
    await saveBundle(incoming);
    return { status: 'updated', version: incoming.version };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

let syncRevision = 0;
export function invalidateConfigSync(): void {
  syncRevision++;
}
