import { storage } from '#imports';

/**
 * A random id for this browser install, sent as X-SI-Install on every
 * GET /v1/entitlement so the Worker can count browsers per account and enforce
 * the 5-browser limit. It is not derived from anything about the machine. It
 * lives in local storage, so it survives restarts; a reinstall makes a new one,
 * which the account page can remove (24 Nov 2026).
 */
export const installIdItem = storage.defineItem<string | null>('local:si_install_id', {
  fallback: null,
});

/** What the Worker accepts; anything else in storage is replaced. */
const INSTALL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

let pendingId: Promise<string> | undefined;

/**
 * The install id, made on first use. Concurrent first calls share one promise
 * so two parallel refreshes can't each mint and store a different id.
 */
export function getInstallId(): Promise<string> {
  pendingId ??= (async () => {
    const existing = await installIdItem.getValue();
    if (typeof existing === 'string' && INSTALL_ID_RE.test(existing)) return existing;
    const id = crypto.randomUUID();
    await installIdItem.setValue(id);
    return id;
  })().finally(() => {
    pendingId = undefined;
  });
  return pendingId;
}

/**
 * Why the Worker gave this browser the free plan although the account has a
 * paid one: "limit" means the account is already used in `limit` browsers,
 * "removed" means this browser was removed on the account page.
 */
export interface DeviceLimit {
  kind: 'browser';
  reason: 'limit' | 'removed';
  limit: number;
}

/**
 * The last deviceLimit the Worker sent next to the signed entitlement, or null.
 * It is unsigned and only used to explain the plan in the popup; the plan
 * itself still comes from the signed blob (24 Nov 2026).
 */
export const deviceLimitItem = storage.defineItem<DeviceLimit | null>('local:si_device_limit', {
  fallback: null,
});

/** The response's deviceLimit if it has the shape we know, otherwise null. */
export function parseDeviceLimit(value: unknown): DeviceLimit | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, reason, limit } = value as Record<string, unknown>;
  if (kind !== 'browser' || (reason !== 'limit' && reason !== 'removed')) return null;
  return {
    kind,
    reason,
    limit: typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 5,
  };
}
