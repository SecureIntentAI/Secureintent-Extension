import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

// Mock the Ed25519 verifier so tests don't need the private signing key.
vi.mock('@/lib/config/verify', () => ({
  verifySigned: vi.fn(
    async (_purpose: string, _payload: string, signatures: unknown) =>
      (signatures as Record<string, string> | null)?.['entitlement-2026-11'] === 'valid',
  ),
  signatureMap: (value: unknown) =>
    value && typeof value === 'object' ? (value as Record<string, string>) : null,
}));

import { clockFloorItem, resetClockFloorMemory } from './clock';
import {
  canManageTeam,
  evaluateBlob,
  evaluateStored,
  FREE_ENTITLEMENT,
  getActiveEntitlement,
  getEntitlementSnapshot,
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
  resetClockFloorMemory();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('evaluateBlob', () => {
  test('valid + unexpired → unlocked', () => {
    expect(evaluateBlob(proBlob(), 1500, true)).toEqual({
      plan: 'developer_pro',
      tier: 'browser_pro',
      trial: { state: 'none', endsAt: null },
      pro: true,
      features: ['rehydrate', 'ghost', 'session_lock'],
      source: 'paddle',
      businessDomain: null,
      email: null,
      org: null,
    });
  });
  test('reads the package and trial from a newer blob', () => {
    const e = evaluateBlob(
      proBlob({
        tier: 'desktop_pro',
        trial: { state: 'active', endsAt: 1_800_000_000 },
        source: 'trial',
      }),
      1500,
      true,
    );
    expect(e).toMatchObject({
      tier: 'desktop_pro',
      trial: { state: 'active', endsAt: 1_800_000_000 },
    });
  });
  test('an older blob (plan only) maps to its package, with no trial', () => {
    expect(evaluateBlob(proBlob({ plan: 'business_pro' }), 1500, true)).toMatchObject({
      tier: 'business',
      trial: { state: 'none', endsAt: null },
    });
  });
  test('an unknown tier or malformed trial falls back safely', () => {
    const e = evaluateBlob(
      proBlob({ tier: 'platinum' as never, trial: { state: 'forever' } as never }),
      1500,
      true,
    );
    expect(e).toMatchObject({ tier: 'browser_pro', trial: { state: 'none', endsAt: null } });
  });
  test('carries the account email through for display', () => {
    expect(evaluateBlob(proBlob({ email: 'dev@acme.com' }), 1500, true).email).toBe('dev@acme.com');
  });
  test('invalid signature → free', () => {
    expect(evaluateBlob(proBlob(), 1500, false)).toEqual({
      plan: 'developer',
      tier: 'free',
      trial: { state: 'none', endsAt: null },
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
      tier: 'free',
      trial: { state: 'none', endsAt: null },
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
      {
        blob: proBlob(),
        payload: JSON.stringify(signed),
        signatures: { 'entitlement-2026-11': 'valid' },
      },
      1500,
    );
    expect(out.pro).toBe(false);
    expect(out.features).toEqual([]);
  });
  test('rejects malformed signed payloads', async () => {
    for (const payload of ['null', '{}', 'invalid']) {
      expect(
        await evaluateStored(
          { blob: proBlob(), payload, signatures: { 'entitlement-2026-11': 'valid' } },
          1500,
        ),
      ).toEqual(FREE_ENTITLEMENT);
    }
  });
  test('null → free', async () => {
    expect(await evaluateStored(null, 1500)).toEqual({
      plan: 'developer',
      tier: 'free',
      trial: { state: 'none', endsAt: null },
      pro: false,
      features: [],
      source: 'none',
      businessDomain: null,
      email: null,
      org: null,
    });
  });
  test('valid signature unlocks', async () => {
    const out = await evaluateStored(
      { blob: proBlob(), signatures: { 'entitlement-2026-11': 'valid' } },
      1500,
    );
    expect(out.pro).toBe(true);
  });
  test('bad signature → free', async () => {
    const out = await evaluateStored(
      { blob: proBlob(), signatures: { 'entitlement-2026-11': 'nope' } },
      1500,
    );
    expect(out.pro).toBe(false);
  });
});

describe('cache', () => {
  test('telemetry ownership comes from verified payload and clears on invalid signatures', async () => {
    const blob = proBlob({ exp: 9_999_999_999 });
    await entitlementItem.setValue({
      blob: { ...blob, clerkUserId: 'unsigned-edit' },
      payload: JSON.stringify(blob),
      signatures: { 'entitlement-2026-11': 'valid' },
    });
    const stop = await initEntitlementCache();
    try {
      expect(getEntitlementSnapshot().userId).toBe('user_1');
      await entitlementItem.setValue({ blob, signatures: { 'entitlement-2026-11': 'nope' } });
      await vi.waitFor(() => expect(getEntitlementSnapshot().userId).toBeNull());
    } finally {
      stop();
    }
  });

  test('initEntitlementCache primes hasFeatureCached and updates on change', async () => {
    await entitlementItem.setValue({
      blob: proBlob({ exp: 9_999_999_999 }),
      signatures: { 'entitlement-2026-11': 'valid' },
    });
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
    await entitlementItem.setValue({
      blob: proBlob({ exp: 9_999_999_999 }),
      signatures: { 'entitlement-2026-11': 'valid' },
    });
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

// The clock floor (24 Nov 2026): expiry is checked against the highest time seen.
// proBlob() is issued at 1000 s, expires at 2000 s.
describe('clock floor', () => {
  const store = () =>
    entitlementItem.setValue({ blob: proBlob(), signatures: { 'entitlement-2026-11': 'valid' } });

  test('a valid plan still works normally', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1500 * 1000);
    await store();
    expect((await getActiveEntitlement()).pro).toBe(true);
    const stop = await initEntitlementCache();
    expect(hasFeatureCached('rehydrate')).toBe(true);
    stop();
  });

  test('an expired plan stays expired after the clock is moved back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await store();
    vi.setSystemTime(3000 * 1000);
    expect((await getActiveEntitlement()).pro).toBe(false);

    vi.setSystemTime(1500 * 1000);
    expect((await getActiveEntitlement()).pro).toBe(false);
    const stop = await initEntitlementCache();
    expect(hasFeatureCached('rehydrate')).toBe(false);
    expect(getEntitlementSnapshot().pro).toBe(false);
    stop();
  });

  test('the floor survives a restart (it is in storage, not only memory)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await store();
    vi.setSystemTime(3000 * 1000);
    await getActiveEntitlement();
    expect(await clockFloorItem.getValue()).toBe(3000 * 1000);

    resetClockFloorMemory(); // a new service worker / content script
    vi.setSystemTime(1500 * 1000);
    expect((await getActiveEntitlement()).pro).toBe(false);
  });
});
