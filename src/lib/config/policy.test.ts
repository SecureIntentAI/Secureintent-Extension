import { describe, expect, test } from 'vitest';
import { DEFAULT_BUNDLE } from './default';
import { getPolicy, isBlockedHost } from './policy';
import type { BundlePolicy } from './types';
import { validateBundle } from './validate';

const POLICY: BundlePolicy = {
  blockInsteadOfWarn: true,
  requireSessionLock: true,
  extraPatterns: [{ type: 'known-key', label: 'Acme key', regex: 'acme_[a-z0-9]{10}' }],
  blockedSites: ['pastebin.com'],
  aiServices: [],
};

describe('getPolicy', () => {
  test('a bundle with no policy enforces nothing (every non-team install)', () => {
    const p = getPolicy(DEFAULT_BUNDLE);
    expect(p).toEqual({
      blockInsteadOfWarn: false,
      requireSessionLock: false,
      extraPatterns: [],
      blockedSites: [],
      aiServices: [],
    });
  });

  test('null / undefined bundles degrade to no policy', () => {
    expect(getPolicy(null).requireSessionLock).toBe(false);
    expect(getPolicy(undefined).blockInsteadOfWarn).toBe(false);
  });

  test('reads the policy off a bundle that carries one', () => {
    expect(getPolicy({ policy: POLICY })).toEqual(POLICY);
  });

  test('never returns a shared object a caller could mutate into an active policy', () => {
    const first = getPolicy(DEFAULT_BUNDLE);
    first.blockedSites.push('evil.com');
    first.blockInsteadOfWarn = true;
    expect(getPolicy(DEFAULT_BUNDLE).blockedSites).toEqual([]);
    expect(getPolicy(DEFAULT_BUNDLE).blockInsteadOfWarn).toBe(false);
  });

  test('coerces a malformed policy to "not enforced" rather than half-applying it', () => {
    const p = getPolicy({
      policy: {
        blockInsteadOfWarn: 'yes',
        requireSessionLock: 1,
        extraPatterns: 'nope',
        blockedSites: { a: 1 },
      },
    } as never);
    expect(p).toEqual({
      blockInsteadOfWarn: false,
      requireSessionLock: false,
      extraPatterns: [],
      blockedSites: [],
      aiServices: [],
    });
  });

  test('normalises hostnames an admin typed as URLs, with ports, dots or caps', () => {
    const p = getPolicy({
      policy: {
        ...POLICY,
        blockedSites: ['https://Pastebin.com/raw?x=1', '.Corp.Internal.', 'db.corp.com:5432', ''],
      },
    });
    expect(p.blockedSites).toEqual(['pastebin.com', 'corp.internal', 'db.corp.com']);
  });
});

describe('isBlockedHost', () => {
  test('matches the exact host', () => {
    expect(isBlockedHost('pastebin.com', ['pastebin.com'])).toBe(true);
  });
  test('subdomains inherit the block', () => {
    expect(isBlockedHost('raw.pastebin.com', ['pastebin.com'])).toBe(true);
  });
  test('is case-insensitive and ignores a port', () => {
    expect(isBlockedHost('RAW.Pastebin.com:8443', ['pastebin.com'])).toBe(true);
  });
  test('does not match a lookalike suffix', () => {
    expect(isBlockedHost('notpastebin.com', ['pastebin.com'])).toBe(false);
    expect(isBlockedHost('pastebin.com.evil.net', ['pastebin.com'])).toBe(false);
  });
  test('an empty list blocks nothing', () => {
    expect(isBlockedHost('pastebin.com', [])).toBe(false);
  });
});

/**
 * The shape the Worker actually returns for a team, copied from
 * backend/src/routes/config.ts `withPolicy`. If these two ever drift, a member's
 * extension rejects the whole bundle — losing the team's patterns and, worse,
 * the kill switch — so assert the real payload here rather than an idealised one.
 */
describe('the bundle the Worker really sends', () => {
  const WORKER_BUNDLE = {
    version: 3,
    killSwitch: false,
    patterns: [
      { type: 'known-key', label: 'AWS access key', regex: 'AKIA[0-9A-Z]{16}' },
      // the team's own pattern, merged in server-side
      { type: 'known-key', label: 'Acme service token', regex: 'acme_[A-Za-z0-9]{24}' },
    ],
    sites: {},
    policy: {
      orgId: 'org_acme',
      blockInsteadOfWarn: true,
      requireSessionLock: true,
      blockedSites: ['pastebin.com'],
      // note: no extraPatterns — deliberately omitted by the Worker
    },
    policyVersion: 4,
  };

  test('validates, so a team member still receives config', () => {
    expect(validateBundle(WORKER_BUNDLE)).toBe(true);
  });

  test('yields the rules the guard enforces', () => {
    const p = getPolicy(WORKER_BUNDLE as never);
    expect(p.blockInsteadOfWarn).toBe(true);
    expect(p.requireSessionLock).toBe(true);
    expect(isBlockedHost('pastebin.com', p.blockedSites)).toBe(true);
  });
});
