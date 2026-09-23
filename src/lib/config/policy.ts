import type { AiServiceRule, BundlePolicy, ConfigBundle } from './types';

/**
 * The policy every non-team install runs under: nothing enforced. Returned as a
 * fresh object (never a shared constant) so a caller can't mutate one install's
 * "no policy" into an active one for every other reader.
 */
function emptyPolicy(): BundlePolicy {
  return {
    blockInsteadOfWarn: false,
    requireSessionLock: false,
    extraPatterns: [],
    blockedSites: [],
    aiServices: [],
  };
}

const CLASSIFICATIONS = new Set(['sanctioned', 'recognized', 'review']);

function normalizeAiServices(value: unknown): AiServiceRule[] {
  if (!Array.isArray(value)) return [];
  const rules: AiServiceRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rule = item as Record<string, unknown>;
    if (
      typeof rule.serviceId !== 'string' ||
      rule.serviceId.length === 0 ||
      rule.serviceId.length > 40
    )
      continue;
    if (!CLASSIFICATIONS.has(String(rule.classification))) continue;
    if (typeof rule.pasteBlocked !== 'boolean') continue;
    rules.push({
      serviceId: rule.serviceId,
      classification: rule.classification as AiServiceRule['classification'],
      pasteBlocked: rule.pasteBlocked,
    });
    if (rules.length >= 18) break;
  }
  return rules;
}

/**
 * Normalise a host for comparison. Admins type hostnames by hand, so accept the
 * shapes they actually produce (a pasted URL, a leading dot, a port, mixed case)
 * rather than silently failing to enforce the rule they thought they wrote.
 */
function normalizeHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // "https://example.com/x" → "example.com/x"
    .replace(/[/?#].*$/, '') // drop any path/query/fragment
    .replace(/:\d+$/, '') // drop a port
    .replace(/^\.+/, '') // ".corp.com" → "corp.com"
    .replace(/\.+$/, '');
}

/**
 * Read the team policy off an active bundle, defaulting every field.
 *
 * The bundle reaching here has already passed `validateBundle` + Ed25519
 * verification in `syncConfig` (an unverified bundle is never persisted), so
 * this is normalisation, not a trust check. It still coerces defensively: a
 * bundle cached by an older build, or any field we can't read, must degrade to
 * "not enforced" rather than to a half-applied policy.
 */
export function getPolicy(bundle: Pick<ConfigBundle, 'policy'> | null | undefined): BundlePolicy {
  const p = bundle?.policy;
  if (!p || typeof p !== 'object') return emptyPolicy();
  return {
    blockInsteadOfWarn: p.blockInsteadOfWarn === true,
    requireSessionLock: p.requireSessionLock === true,
    extraPatterns: Array.isArray(p.extraPatterns) ? p.extraPatterns : [],
    blockedSites: Array.isArray(p.blockedSites)
      ? p.blockedSites
          .filter((s): s is string => typeof s === 'string')
          .map(normalizeHost)
          .filter((s) => s.length > 0)
      : [],
    aiServices: normalizeAiServices(p.aiServices),
  };
}

/** Organisation policy forbids pasting into this recognised AI tool. */
export function aiPasteBlocked(policy: BundlePolicy, serviceId: string | undefined): boolean {
  if (!serviceId) return false;
  return (
    policy.aiServices?.some((rule) => rule.serviceId === serviceId && rule.pasteBlocked) === true
  );
}

/**
 * Whether this hostname is on the team's blocked list. Subdomains inherit the
 * block: an admin blocking "example.com" means the site, not just the apex.
 */
export function isBlockedHost(hostname: string, blockedSites: readonly string[]): boolean {
  if (blockedSites.length === 0) return false;
  const host = normalizeHost(hostname);
  if (!host) return false;
  return blockedSites.some((site) => host === site || host.endsWith(`.${site}`));
}
