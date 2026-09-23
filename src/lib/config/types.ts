// keep in sync with backend/src/lib/configBundle.ts
import type { PatternOrigin, SecretType } from '../detection';

export interface BundlePattern {
  type: SecretType;
  label: string;
  regex: string;
  flags?: string;
  validate?: string; // optional post-match validator name (e.g. 'card')
  /**
   * Who authored this pattern. The Worker writes `'team'` — and ONLY `'team'`,
   * only on a team's own patterns; the default catalogue ships with no `origin`
   * key at all, so absent means default and the test is always `=== 'team'`.
   * `validPattern` deliberately ignores it: an install that predates this field
   * already accepts these bundles, and a bundle must never be rejected (and its
   * kill switch lost) over a cosmetic marker.
   */
  origin?: PatternOrigin; // 'default' | 'team'
}
export interface BundleSite {
  inputSelector: string;
}
/**
 * Team Policy Sync (Business tier): rules a team admin pushes to every member.
 * It rides on the same Ed25519-signed bundle as the patterns, so it can only
 * arrive from the Worker after signature verification — that is the trust
 * anchor. The Worker resolves the caller's org from the Clerk token on
 * `/v1/config`; anonymous and non-team installs get a bundle with no `policy`.
 */
export interface BundlePolicy {
  /** Clerk organisation these rules belong to. Absent on bundles saved before it was sent. */
  orgId?: string;
  /** Drop "Paste anyway" from the warning: the warning becomes a block. */
  blockInsteadOfWarn: boolean;
  /** Force Session Lock on; the member cannot switch it off. */
  requireSessionLock: boolean;
  /**
   * Team-authored detection patterns. Already merged into `patterns`
   * server-side — kept here so the client can tell team rules from ours.
   */
  /** Optional: the Worker merges these into `patterns` and omits them here. */
  extraPatterns?: BundlePattern[];
  /** Hostnames this team must not paste into at all (subdomains included). */
  blockedSites: string[];
  /**
   * Per-tool Shadow AI rules for this organisation. Absent on bundles from a
   * Worker that has not published any, which means every recognised tool stays
   * visible and pasteable.
   */
  aiServices?: AiServiceRule[];
}

export interface AiServiceRule {
  serviceId: string;
  classification: 'sanctioned' | 'recognized' | 'review';
  pasteBlocked: boolean;
}
export interface ConfigBundle {
  version: number;
  patterns: BundlePattern[];
  sites: Record<string, BundleSite>;
  killSwitch: boolean;
  // Team Policy: absent for anonymous / non-team installs and for every bundle
  // published before Team Policy Sync — both stay perfectly valid.
  policy?: BundlePolicy;
  policyVersion?: number;
  // pilot mode: run entropy patterns (catches more, noisier). Off = standard tuning.
  aggressive?: boolean;
  // Ghost Sanitizer tuning. minChars: pastes at least this large take the
  // aggressive expanded-detection path. Omitted → built-in GHOST_MIN_CHARS.
  ghost?: { minChars?: number };
}
