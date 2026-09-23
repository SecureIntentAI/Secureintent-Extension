import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

// Mock the Ed25519 verifier so tests don't need the private signing key.
vi.mock('@/lib/config/verify', () => ({
  verifyBundle: vi.fn(async (_payload: string, sig: string | null) => sig === 'valid'),
}));

import {
  canManageTeam,
  evaluateBlob,
  evaluateStored,
  FREE_ENTITLEMENT,
  getActiveEntitlement,
  hasFeatureCached,
  initEntitlementCache,
} from './index';
import { entitlementItem } from './store';
import type { SignedEntitlement } from './types';

const proBlob = (over: Partial<SignedEntitlement> = {}): SignedEntitlement => ({
  clerkUserId: 'user_1',
  plan: 'developer_pro',
  source: 'paddle',
  pro: true,
  features: ['rehydrate', 'ghost', 'session_lock'],
  status: 'active',
  businessDomain: null,
  issuedAt: 1000,
  exp: 2000,
  ...over,
});

beforeEach(() => {
  fakeBrowser.reset();
});

describe('evaluateBlob', () => {
  test('valid + unexpired → unlocked', () => {
    expect(evaluateBlob(proBlob(), 1500, true)).toEqual({
      plan: 'developer_pro',
      pro: true,
      features: ['rehydrate', 'ghost', 'session_lock'],
      source: 'paddle',
      businessDomain: null,
      email: null,
      org: null,
    });
  });
  test('carries the account email through for display', () => {
    expect(evaluateBlob(proBlob({ email: 'dev@acme.com' }), 1500, true).email).toBe('dev@acme.com');
  });
  test('invalid signature → free', () => {
    expect(evaluateBlob(proBlob(), 1500, false)).toEqual({
      plan: 'developer',
      pro: false,
      features: [],
      source: 'none',
      businessDomain: null,
      email: null,
      org: null,
    });
  });
  test('expired → free even if signature valid', () => {
    expect(evaluateBlob(proBlob({ exp: 1200 }), 1500, true)).toEqual({
      plan: 'developer',
      pro: false,
      features: [],
      source: 'none',
      businessDomain: null,
      email: null,
      org: null,
    });
  });
  test('bound to a different user → free (blob is not portable)', () => {
    expect(evaluateBlob(proBlob(), 1500, true, 'user_2').pro).toBe(false);
  });
  test('bound to the matching user → unlocked', () => {
    expect(evaluateBlob(proBlob(), 1500, true, 'user_1').pro).toBe(true);
  });
  test('signed out (null) with a stored blob → free', () => {
    expect(evaluateBlob(proBlob(), 1500, true, null).pro).toBe(false);
  });
  test('no user id supplied → binding skipped (unlocked)', () => {
    expect(evaluateBlob(proBlob(), 1500, true).pro).toBe(true);
  });
});

describe('evaluateStored', () => {
  test('ignores unsigned edits to the duplicate blob', async () => {
    const signed = proBlob({ pro: false, features: [], plan: 'developer' });
    const out = await evaluateStored(
      { blob: proBlob(), payload: JSON.stringify(signed), signature: 'valid' },
      1500,
    );
    expect(out.pro).toBe(false);
    expect(out.features).toEqual([]);
  });
  test('rejects malformed signed payloads', async () => {
    for (const payload of ['null', '{}', 'invalid']) {
      expect(await evaluateStored({ blob: proBlob(), payload, signature: 'valid' }, 1500)).toEqual(
        FREE_ENTITLEMENT,
      );
    }
  });
  test('null → free', async () => {
    expect(await evaluateStored(null, 1500)).toEqual({
      plan: 'developer',
      pro: false,
      features: [],
      source: 'none',
      businessDomain: null,
      email: null,
      org: null,
    });
  });
  test('valid signature unlocks', async () => {
    const out = await evaluateStored({ blob: proBlob(), signature: 'valid' }, 1500);
    expect(out.pro).toBe(true);
  });
  test('bad signature → free', async () => {
    const out = await evaluateStored({ blob: proBlob(), signature: 'nope' }, 1500);
    expect(out.pro).toBe(false);
  });
});

describe('cache', () => {
  test('initEntitlementCache primes hasFeatureCached and updates on change', async () => {
    await entitlementItem.setValue({ blob: proBlob({ exp: 9_999_999_999 }), signature: 'valid' });
    const stop = await initEntitlementCache();
    expect(hasFeatureCached('rehydrate')).toBe(true);
    expect(hasFeatureCached('session_lock')).toBe(true);

    await entitlementItem.setValue(null);
    await vi.waitFor(() => expect(hasFeatureCached('rehydrate')).toBe(false));
    stop();
  });
});

describe('getActiveEntitlement', () => {
  test('reads from storage', async () => {
    await entitlementItem.setValue({ blob: proBlob({ exp: 9_999_999_999 }), signature: 'valid' });
    expect((await getActiveEntitlement()).pro).toBe(true);
  });
});

describe('canManageTeam', () => {
  const withOrg = (role: string | null) => ({
    ...FREE_ENTITLEMENT,
    org: { id: 'org_1', name: 'Optimizely', role },
  });

  test('is true for an org admin', () => {
    expect(canManageTeam(withOrg('org:admin'))).toBe(true);
  });

  test('is false for a member — they have nothing to manage', () => {
    expect(canManageTeam(withOrg('org:member'))).toBe(false);
  });

  test('is false when the role is unknown or the user has no team', () => {
    expect(canManageTeam(withOrg(null))).toBe(false);
    expect(canManageTeam(FREE_ENTITLEMENT)).toBe(false);
  });
});
