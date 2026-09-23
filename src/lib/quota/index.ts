import { browser } from '#imports';
import type { EntitlementSnapshot } from '@/lib/entitlement';
import { OFFLINE_LIMIT, offlineUsed } from './offline';

export { formatQuotaReset, quotaResetAt } from './reset';

export interface QuotaStatus {
  used: number;
  remaining: number; // -1 when unlimited
  limit: number;
  unlimited: boolean;
}

const FREE_LIMIT = OFFLINE_LIMIT;

function unlimited(): QuotaStatus {
  return { used: 0, remaining: -1, limit: FREE_LIMIT, unlimited: true };
}

async function offlineStatus(): Promise<QuotaStatus> {
  const used = await offlineUsed();
  return { used, remaining: Math.max(0, FREE_LIMIT - used), limit: FREE_LIMIT, unlimited: false };
}

/**
 * Current Anonymise & Paste allowance, routed by state:
 * Pro → unlimited; signed-in → backend (per-account); else → obfuscated on-device.
 * Falls back to the on-device count if the backend is unreachable.
 */
export async function getAnonymizeStatus(snap: EntitlementSnapshot): Promise<QuotaStatus> {
  if (snap.pro) return unlimited();
  if (snap.signedIn) {
    const r = (await browser.runtime
      .sendMessage({ type: 'si-quota-status' })
      .catch(() => null)) as QuotaStatus | null;
    if (r && typeof r.remaining === 'number') return r;
  }
  return offlineStatus();
}

/** Whether an anonymize is allowed right now (pre-check before offering the action). */
export async function canAnonymize(snap: EntitlementSnapshot): Promise<boolean> {
  if (snap.pro) return true;
  const s = await getAnonymizeStatus(snap);
  return s.unlimited || s.remaining > 0;
}

/** Consume one anonymize. Returns whether it was allowed (Pro is always allowed). */
export async function consumeAnonymize(snap: EntitlementSnapshot): Promise<boolean> {
  if (snap.pro) return true;
  {
    const r = (await browser.runtime
      .sendMessage({ type: 'si-quota-consume' })
      .catch(() => null)) as { allowed?: boolean } | null;
    if (r && typeof r.allowed === 'boolean') return r.allowed;
    // The background is the sole writer of the offline allowance across tabs.
  }
  return false;
}
