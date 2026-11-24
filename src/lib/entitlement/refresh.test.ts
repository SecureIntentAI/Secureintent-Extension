import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

vi.mock('@/lib/config/verify', () => ({
  verifySigned: vi.fn(
    async (_purpose: string, _payload: string, signatures: unknown) =>
      (signatures as Record<string, string> | null)?.['entitlement-2026-11'] === 'valid',
  ),
  signatureMap: (value: unknown) =>
    value && typeof value === 'object' ? (value as Record<string, string>) : null,
}));

import { clockFloorItem, resetClockFloorMemory } from './clock';
import { deviceLimitItem, installIdItem } from './device';
import { getActiveEntitlement } from './index';
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

// X-SI-Install and deviceLimit (24 Nov 2026): the Worker counts browsers per
// account by this id and enforces the 5-browser limit.
describe('install id and browser limit', () => {
  const okResponse = (extra: object = {}) =>
    new Response(
      JSON.stringify({
        entitlement: blob,
        signatures: { 'entitlement-2026-11': 'valid' },
        ...extra,
      }),
      { status: 200 },
    );
  const installHeader = (call: unknown[]) =>
    ((call[1] as RequestInit).headers as Record<string, string>)['X-SI-Install'];

  test('sends the same X-SI-Install on every call, and keeps it in local storage', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await refreshEntitlement(async () => 'tok');
    await refreshEntitlement(async () => 'tok');
    const first = installHeader(fetchMock.mock.calls[0]);
    expect(first).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(installHeader(fetchMock.mock.calls[1])).toBe(first);
    expect(await installIdItem.getValue()).toBe(first);
  });

  test('parallel first refreshes still share one id', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([
      refreshEntitlement(async () => 'tok'),
      refreshEntitlement(async () => 'tok'),
    ]);
    expect(installHeader(fetchMock.mock.calls[0])).toBe(installHeader(fetchMock.mock.calls[1]));
  });

  test('a stored id is reused', async () => {
    await installIdItem.setValue('existing-install-0001');
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await refreshEntitlement(async () => 'tok');
    expect(installHeader(fetchMock.mock.calls[0])).toBe('existing-install-0001');
  });

  test('stores deviceLimit when sent, and clears it when not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse({ deviceLimit: { kind: 'browser', reason: 'limit', limit: 5 } }),
      ),
    );
    await refreshEntitlement(async () => 'tok');
    expect(await deviceLimitItem.getValue()).toEqual({
      kind: 'browser',
      reason: 'limit',
      limit: 5,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse()),
    );
    await refreshEntitlement(async () => 'tok');
    expect(await deviceLimitItem.getValue()).toBeNull();
  });

  test('an unknown deviceLimit shape is ignored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ deviceLimit: { kind: 'desktop', reason: 'limit' } })),
    );
    await refreshEntitlement(async () => 'tok');
    expect(await deviceLimitItem.getValue()).toBeNull();
  });

  test('signing out clears deviceLimit', async () => {
    await deviceLimitItem.setValue({ kind: 'browser', reason: 'removed', limit: 5 });
    await refreshEntitlement(async () => null);
    expect(await deviceLimitItem.getValue()).toBeNull();
  });

  test("a verified blob's issuedAt raises the clock floor", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              entitlement: { ...blob, issuedAt: future },
              signatures: { 'entitlement-2026-11': 'valid' },
            }),
            { status: 200 },
          ),
      ),
    );
    await refreshEntitlement(async () => 'tok');
    expect(await clockFloorItem.getValue()).toBe(future * 1000);
  });
});

// A clock once set ahead (24 Nov 2026): only a verified refresh may lower the
// floor, to the server's signed issuedAt.
describe('clock floor reset by a verified refresh', () => {
  const NOW_SEC = 1_800_000_000;
  const respond = (b: SignedEntitlement, sig = 'valid') =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ entitlement: b, signatures: { 'entitlement-2026-11': sig } }),
            {
              status: 200,
            },
          ),
      ),
    );

  beforeEach(() => {
    resetClockFloorMemory();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => vi.useRealTimers());

  test('floor at 2030, verified refresh issued now: the plan is valid again', async () => {
    const in2030 = Date.UTC(2030, 0, 1);
    await clockFloorItem.setValue(in2030);
    const fresh = { ...blob, issuedAt: NOW_SEC, exp: NOW_SEC + 7 * 86_400 };
    await entitlementItem.setValue({
      blob: fresh,
      payload: JSON.stringify(fresh),
      signatures: { 'entitlement-2026-11': 'valid' },
    });
    expect((await getActiveEntitlement()).pro).toBe(false); // locked by the 2030 floor

    respond(fresh);
    expect((await refreshEntitlement(async () => 'tok')).status).toBe('updated');
    expect(await clockFloorItem.getValue()).toBe(NOW_SEC * 1000);
    expect((await getActiveEntitlement()).pro).toBe(true);
  });

  test('after the reset, an earlier local time still reads the plan as expired', async () => {
    await clockFloorItem.setValue(Date.UTC(2030, 0, 1));
    const issued = { ...blob, issuedAt: NOW_SEC, exp: NOW_SEC + 3600 };
    respond(issued);
    await refreshEntitlement(async () => 'tok');

    vi.setSystemTime((NOW_SEC + 7200) * 1000); // past exp
    expect((await getActiveEntitlement()).pro).toBe(false);
    vi.setSystemTime((NOW_SEC - 86_400) * 1000); // below issuedAt
    expect((await getActiveEntitlement()).pro).toBe(false);
  });

  test('an unverified response never lowers the floor', async () => {
    const in2030 = Date.UTC(2030, 0, 1);
    await clockFloorItem.setValue(in2030);
    respond({ ...blob, issuedAt: NOW_SEC }, 'forged');
    expect((await refreshEntitlement(async () => 'tok')).status).toBe('cleared');
    expect(await clockFloorItem.getValue()).toBe(in2030);
  });
});
