import type { ConfigBundle } from './types';

function revision(bundle: ConfigBundle): number {
  const n = bundle.policyVersion;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function orgId(bundle: ConfigBundle): string | null {
  const id = bundle.policy?.orgId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Decide whether a signature-checked bundle replaces the one already stored.
 *
 * `version` is the global catalogue. Team rules move on `policyVersion` without
 * changing it, and a member who leaves receives the same catalogue with the
 * policy removed. Only a response we fetched with a session token may attach,
 * swap, or remove that policy — an anonymous refresh must not wipe rules the
 * member already has, and must not install a policy by itself.
 */
export function shouldAcceptBundle(
  current: ConfigBundle | null,
  incoming: ConfigBundle,
  authenticated: boolean,
): boolean {
  if (!authenticated && (current?.policy || incoming.policy)) return false;
  if (!current) return true;
  if (incoming.version > current.version) return true;
  if (incoming.version < current.version) return false;
  if (!authenticated) return false;
  if (current.policy && !incoming.policy) return true;
  if (orgId(incoming) !== orgId(current)) return true;
  const next = revision(incoming);
  const prev = revision(current);
  if (next !== prev) return next > prev;
  return orgId(incoming) !== orgId(current);
}
