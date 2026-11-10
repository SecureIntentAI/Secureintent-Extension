import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

vi.mock('@/lib/config/verify', () => ({
  verifySigned: vi.fn(
    async (_purpose: string, _payload: string, signatures: unknown) =>
      (signatures as Record<string, string> | null)?.['entitlement-2026-11'] === 'valid',
  ),
  signatureMap: (value: unknown) =>
    value && typeof value === 'object' ? (value as Record<string, string>) : null,
}));

import { refreshEntitlement } from './refresh';
import { entitlementItem } from './store';
import type { SignedEntitlement } from './types';

const blob: SignedEntitlement = {
  clerkUserId: 'user_1',
  plan: 'developer_pro',
  source: 'paddle',
  pro: true,
  features: ['rehydrate', 'ghost', 'session_lock'],
  status: 'active',
  businessDomain: null,
  issuedAt: 1000,
  exp: 9_999_999_999,
};

/** Minimal unsigned JWT carrying a `sub` claim (enough for jwtSub to read it). */
function tokenWithSub(sub: string): string {
  const b64u = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64u({ alg: 'RS256' })}.${b64u({ sub })}.sig`;
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('refreshEntitlement', () => {
  test('signed-out clears the cache', async () => {
    await entitlementItem.setValue({ blob, signatures: { 'entitlement-2026-11': 'valid' } });
    const r = await refreshEntitlement(async () => null);
    expect(r.status).toBe('signed-out');
    expect(await entitlementItem.getValue()).toBeNull();
  });

  test('valid response is verified and stored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ entitlement: blob, signatures: { 'entitlement-2026-11': 'valid' } }),
            { status: 200 },
          ),
      ),
    );
    const r = await refreshEntitlement(async () => 'tok');
    expect(r).toMatchObject({ status: 'updated', plan: 'developer_pro' });
    expect((await entitlementItem.getValue())?.blob.pro).toBe(true);
  });

  test('bad signature clears the cache', async () => {
    await entitlementItem.setValue({ blob, signatures: { 'entitlement-2026-11': 'valid' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ entitlement: blob, signatures: { 'entitlement-2026-11': 'forged' } }),
            { status: 200 },
          ),
      ),
    );
    const r = await refreshEntitlement(async () => 'tok');
    expect(r.status).toBe('cleared');
    expect(await entitlementItem.getValue()).toBeNull();
  });

  test('rejects a blob issued for a different user than the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ entitlement: blob, signatures: { 'entitlement-2026-11': 'valid' } }),
            { status: 200 },
          ),
      ),
    );
    // blob.clerkUserId is 'user_1'; the token belongs to 'user_2'.
    const r = await refreshEntitlement(async () => tokenWithSub('user_2'));
    expect(r).toMatchObject({ status: 'cleared', error: 'user mismatch' });
    expect(await entitlementItem.getValue()).toBeNull();
  });

  test('stores a blob when it matches the token user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ entitlement: blob, signatures: { 'entitlement-2026-11': 'valid' } }),
            { status: 200 },
          ),
      ),
    );
    const r = await refreshEntitlement(async () => tokenWithSub('user_1'));
    expect(r.status).toBe('updated');
    expect((await entitlementItem.getValue())?.blob.pro).toBe(true);
  });

  test('HTTP error leaves the cache untouched', async () => {
    await entitlementItem.setValue({ blob, signatures: { 'entitlement-2026-11': 'valid' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const r = await refreshEntitlement(async () => 'tok');
    expect(r.status).toBe('error');
    expect(await entitlementItem.getValue()).not.toBeNull();
  });
});
