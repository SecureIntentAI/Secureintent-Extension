import type { ConfigBundle } from './types';

function validPattern(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.regex !== 'string' || p.regex.length === 0 || p.regex.length > 8192) return false;
  if (typeof p.label !== 'string' || p.label.length > 100) return false;
  if (p.flags !== undefined && typeof p.flags !== 'string') return false;
  try {
    new RegExp(p.regex, typeof p.flags === 'string' ? p.flags : 'g');
  } catch {
    return false;
  }
  // Any non-empty type string is accepted.
  //
  // This used to reject, and rejecting is what makes adding a type expensive:
  // `validateBundle` fails the WHOLE bundle on one bad pattern, so the day we
  // first served `high-entropy` every already-installed copy would have thrown
  // the bundle away and quietly stopped taking pattern updates altogether —
  // permanently, since the fix ships in the bundle it can no longer read.
  // An unrecognised type now costs that one pattern its rank (see TYPE_RANK
  // lookups, which fall back to lowest) and nothing else.
  if (typeof p.type !== 'string' || p.type.length === 0) return false;
  if (p.validate !== undefined && typeof p.validate !== 'string') return false;
  return true;
}

/**
 * Team Policy shape check. Strict on purpose: a policy is an enforcement rule,
 * so a half-readable one must not be applied at all (the caller rejects the
 * whole bundle and keeps the last good one, exactly as for a bad pattern).
 */
function validPolicy(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.blockInsteadOfWarn !== 'boolean') return false;
  if (typeof p.requireSessionLock !== 'boolean') return false;
  // Optional by design. The Worker merges a team's extra patterns straight into
  // `bundle.patterns` so they run through the normal detection path, and then
  // OMITS them here — carrying both would register every org pattern twice.
  // Requiring the field would make us reject the real bundle outright, which
  // costs a team its patterns AND the kill switch.
  if (p.extraPatterns !== undefined) {
    if (!Array.isArray(p.extraPatterns) || !p.extraPatterns.every(validPattern)) return false;
  }
  if (!Array.isArray(p.blockedSites)) return false;
  if (!p.blockedSites.every((s) => typeof s === 'string')) return false;
  if (
    p.orgId !== undefined &&
    (typeof p.orgId !== 'string' || !/^org_[A-Za-z0-9]{1,60}$/.test(p.orgId))
  )
    return false;
  if (p.aiServices !== undefined) {
    if (!Array.isArray(p.aiServices) || p.aiServices.length > 18) return false;
    const ids = new Set<string>();
    for (const rule of p.aiServices) {
      if (
        !rule ||
        typeof rule !== 'object' ||
        typeof rule.serviceId !== 'string' ||
        !rule.serviceId ||
        rule.serviceId.length > 40 ||
        ids.has(rule.serviceId) ||
        !['sanctioned', 'recognized', 'review'].includes(rule.classification) ||
        typeof rule.pasteBlocked !== 'boolean'
      )
        return false;
      ids.add(rule.serviceId);
    }
  }
  return true;
}

export function validateBundle(b: unknown): b is ConfigBundle {
  if (typeof b !== 'object' || b === null) return false;
  const o = b as Record<string, unknown>;
  if (!Number.isSafeInteger(o.version) || (o.version as number) < 0) return false;
  if (typeof o.killSwitch !== 'boolean') return false;
  if (o.aggressive !== undefined && typeof o.aggressive !== 'boolean') return false;
  if (!Array.isArray(o.patterns) || o.patterns.length > 220) return false;
  if (typeof o.sites !== 'object' || o.sites === null) return false;
  for (const p of o.patterns as unknown[]) {
    if (!validPattern(p)) return false;
  }
  for (const s of Object.values(o.sites as Record<string, unknown>)) {
    if (typeof s !== 'object' || s === null) return false;
    if (typeof (s as Record<string, unknown>).inputSelector !== 'string') return false;
  }
  // Team Policy is optional — every anonymous install and every bundle
  // published before Team Policy Sync omits it and must stay just as valid.
  if (o.policy !== undefined && !validPolicy(o.policy)) return false;
  if (o.policyVersion !== undefined && typeof o.policyVersion !== 'number') return false;
  if (
    o.ghost !== undefined &&
    (typeof o.ghost !== 'object' ||
      !o.ghost ||
      ('minChars' in o.ghost &&
        (!Number.isSafeInteger(o.ghost.minChars) || (o.ghost.minChars as number) < 1)))
  )
    return false;
  return true;
}
