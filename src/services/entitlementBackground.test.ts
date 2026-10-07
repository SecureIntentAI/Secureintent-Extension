import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { REQUEST_TIMEOUT_MS } from '@/lib/async';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { configItem } from '@/lib/config/store';
import type { SignedEntitlement } from '@/lib/entitlement';
import { entitlementItem } from '@/lib/entitlement/store';
import {
  getClerkToken,
  invalidateEntitlementRefresh,
  refreshEntitlementBg,
} from './entitlementBackground';

const { clientMock, tokenMock } = vi.hoisted(() => ({ clientMock: vi.fn(), tokenMock: vi.fn() }));
vi.mock('@clerk/chrome-extension/client', () => ({ createClerkClient: clientMock }));
vi.mock('@/lib/clerkConfig', () => ({
  CLERK_JWT_TEMPLATE: 'test',
  CLERK_PUBLISHABLE_KEY: 'test',
  CLERK_SYNC_HOST: 'https://example.com',
  IS_FIREFOX: false,
  isAuthEnabled: () => true,
}));
vi.mock('@/lib/config/verify', () => ({ verifyBundle: vi.fn(async () => true) }));

const blob: SignedEntitlement = {
  clerkUserId: 'user_1',
  plan: 'developer_pro',
  pro: true,
  features: ['ghost'],
  source: 'manual',
  status: 'active',
  businessDomain: null,
  issuedAt: 1,
  exp: 9_999_999_999,
};
const response = () => new Response(JSON.stringify({ entitlement: blob, signature: 'valid' }));

beforeEach(() => {
  invalidateEntitlementRefresh();
  fakeBrowser.reset();
  vi.clearAllMocks();
  tokenMock.mockResolvedValue(`e30.${btoa(JSON.stringify({ sub: 'user_1' }))}.sig`);
  clientMock.mockResolvedValue({ session: { getToken: tokenMock } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response()),
  );
});
afterEach(() => {
  invalidateEntitlementRefresh();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('concurrent popup refreshes share one token and network request', async () => {
  const first = refreshEntitlementBg();
  expect(refreshEntitlementBg()).toBe(first);
  await Promise.all([first, refreshEntitlementBg()]);
  expect(tokenMock).toHaveBeenCalledTimes(1);
  expect(clientMock).toHaveBeenCalledTimes(2); // token + one shared identity check
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await entitlementItem.getValue())?.blob.pro).toBe(true);
  await refreshEntitlementBg();
  expect(fetch).toHaveBeenCalledTimes(2); // manual retry is not a stale cached response
});

test('a response from the previous session cannot restore Pro after sign-out', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const old = refreshEntitlementBg();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  invalidateEntitlementRefresh();
  tokenMock.mockResolvedValue(null);
  expect((await refreshEntitlementBg()).status).toBe('signed-out');
  resolve(response());
  await old;
  await new Promise((r) => setTimeout(r, 0));
  expect(await entitlementItem.getValue()).toBeNull();
});

test('a popup waiting on a check cancelled by a session change gets the new result, not an error', async () => {
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {})); // the old check never answers
  const waiting = refreshEntitlementBg();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  invalidateEntitlementRefresh();
  const result = await waiting;
  expect(result.status).toBe('updated');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await entitlementItem.getValue())?.blob.plan).toBe('developer_pro');
});

test('a stuck Clerk token request times out and a retry can succeed', async () => {
  vi.useFakeTimers();
  tokenMock.mockImplementationOnce(() => new Promise(() => {}));
  const pending = refreshEntitlementBg();
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  expect((await pending).status).toBe('error');
  expect((await refreshEntitlementBg()).status).toBe('updated');
});

test('a failed network request releases the shared request for retry', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  expect((await refreshEntitlementBg()).status).toBe('error');
  expect((await refreshEntitlementBg()).status).toBe('updated');
});

test('an offline refresh still clears a cached plan from a different known user', async () => {
  await refreshEntitlementBg();
  await configItem.setValue({
    ...DEFAULT_BUNDLE,
    policy: {
      orgId: 'org_previous',
      blockInsteadOfWarn: true,
      requireSessionLock: true,
      blockedSites: ['example.com'],
    },
  });
  expect((await entitlementItem.getValue())?.blob.clerkUserId).toBe('user_1');
  clientMock.mockResolvedValue({ session: { getToken: tokenMock, user: { id: 'user_2' } } });
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  expect((await refreshEntitlementBg()).status).toBe('error');
  expect(await entitlementItem.getValue()).toBeNull();
  expect(await configItem.getValue()).toBeNull();
});

test("an outage retains the same user's cached team rules", async () => {
  const teamBlob = { ...blob, org: { id: 'org_current', name: 'Current', role: 'org:member' } };
  await entitlementItem.setValue({ blob: teamBlob, signature: 'valid' });
  const config = {
    ...DEFAULT_BUNDLE,
    policy: {
      orgId: 'org_current',
      blockInsteadOfWarn: true,
      requireSessionLock: true,
      blockedSites: ['example.com'],
    },
  };
  await configItem.setValue(config);
  clientMock.mockResolvedValue({ session: { getToken: tokenMock, user: { id: 'user_1' } } });
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  expect((await refreshEntitlementBg()).status).toBe('error');
  expect((await entitlementItem.getValue())?.blob.clerkUserId).toBe('user_1');
  expect(await configItem.getValue()).toEqual(config);
});

test('direct token callers time out and can retry a stalled SDK', async () => {
  vi.useFakeTimers();
  clientMock.mockImplementationOnce(() => new Promise(() => {}));
  const pending = expect(getClerkToken()).rejects.toThrow('Request timed out');
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  await pending;
  expect(await getClerkToken()).toContain('.');
});
