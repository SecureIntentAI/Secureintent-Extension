import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_BUNDLE, saveBundle } from '@/lib/config';
import { entitlementItem } from '@/lib/entitlement';
import type { Salt } from '@/lib/fingerprint';
import { hashPin } from '@/lib/lock';
import { sessionLockPinHashItem, sessionLockTimeoutItem } from '@/settings';
import { createSessionLock } from './createSessionLock';

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock('@/overlay/mountSessionLock', () => ({ mountSessionLock: mount }));
vi.mock('@/overlay/mountLockWarning', () => ({
  mountLockWarning: vi.fn(async () => ({ remove: vi.fn() })),
}));
// The background owns the PIN check; route the message straight to it.
vi.mock('@/lib/lock/client', async () => {
  const { tryUnlock } = await import('@/services/sessionLockBackground');
  return { requestUnlock: (pin: string) => tryUnlock(pin) };
});
vi.mock('@/lib/entitlement', async (original) => ({
  ...(await original<object>()),
  hasFeature: vi.fn(async () => false),
}));
let stops: (() => void)[];
beforeEach(async () => {
  fakeBrowser.reset();
  sessionStorage.clear();
  stops = [];
  mount.mockReset();
  mount.mockResolvedValue({ remove: vi.fn() });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await fakeBrowser.storage.local.set({ si_fingerprint_salt: 'test-salt' });
});
afterEach(() => {
  for (const stop of stops) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const start = () =>
  createSessionLock({
    addEventListener: vi.fn(),
    onInvalidated: (fn: () => void) => stops.push(fn),
  } as never);
const enforce = () =>
  saveBundle({
    ...DEFAULT_BUNDLE,
    policy: { blockInsteadOfWarn: false, requireSessionLock: true, blockedSites: [] },
  });

test('a newly enforced policy gates an already-open console without a PIN', async () => {
  await start();
  expect(mount).not.toHaveBeenCalled();
  await enforce();
  await vi.waitFor(() => expect(mount).toHaveBeenCalled());
  expect(mount.mock.calls.at(-1)![1].setupRequired).toBe(true);
  expect(await mount.mock.calls.at(-1)![1].onUnlock('1234')).toBe(false);
});
test('setting the required PIN changes the setup gate to an unlock gate live', async () => {
  await enforce();
  await start();
  await sessionLockPinHashItem.setValue(await hashPin('1234', 'test-salt' as Salt));
  await vi.waitFor(() => expect(mount.mock.calls.at(-1)![1].setupRequired).toBe(false));
  const unlock = mount.mock.calls.at(-1)![1].onUnlock;
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (let i = 0; i < 5; i++) expect(await unlock('0000')).toBe(false);
  expect(await unlock('1234')).toBe(false);
  now += 30_001;
  expect(await unlock('1234')).toBe(true);
});

test('the attempt count and wait carry over to a reloaded page', async () => {
  await sessionLockPinHashItem.setValue(await hashPin('1234', 'test-salt' as Salt));
  await enforce();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await start();
  await vi.waitFor(() => expect(mount).toHaveBeenCalled());
  const first = mount.mock.calls.at(-1)![1].onUnlock;
  for (let i = 0; i < 4; i++) expect(await first('0000')).toBe(false);

  // Reload: a new lock instance on the same console.
  for (const stop of stops.splice(0)) stop();
  sessionStorage.clear();
  mount.mockClear();
  await start();
  await vi.waitFor(() => expect(mount).toHaveBeenCalled());
  const second = mount.mock.calls.at(-1)![1].onUnlock;
  expect(await second('0000')).toBe(false); // fifth miss: 30 s wait
  expect(await second('1234')).toBe(false);
  now += 30_001;
  expect(await second('0000')).toBe(false); // sixth miss: the wait doubles
  now += 30_001;
  expect(await second('1234')).toBe(false);
  now += 30_000;
  expect(await second('1234')).toBe(true);
});

const renewEntitlement = () =>
  entitlementItem.setValue({
    blob: {
      clerkUserId: 'test-user',
      plan: 'business_pro',
      pro: true,
      features: ['session_lock'],
      source: 'org_seat',
      status: 'active',
      businessDomain: null,
      org: { id: 'org_test', name: 'Test', role: 'org:member' },
      issuedAt: Date.now() / 1000,
      exp: Date.now() / 1000 + 900,
    },
    signatures: { 'entitlement-2026-11': 'test-renewal' },
  });

test('minute entitlement renewals preserve the idle deadline and existing unlock callback', async () => {
  await sessionLockPinHashItem.setValue(await hashPin('1234', 'test-salt' as Salt));
  await enforce();
  vi.useFakeTimers();
  await start();
  for (let minute = 0; minute < 4; minute++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await renewEntitlement();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(mount).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mount).toHaveBeenCalledTimes(1);
  const unlock = mount.mock.calls[0][1].onUnlock;
  await renewEntitlement();
  await vi.advanceTimersByTimeAsync(0);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(await unlock('1234')).toBe(true);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(mount).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mount).toHaveBeenCalledTimes(2);
});

test('shortening the timeout accounts for time already spent idle', async () => {
  await sessionLockPinHashItem.setValue(await hashPin('1234', 'test-salt' as Salt));
  await enforce();
  vi.useFakeTimers();
  await start();
  await vi.advanceTimersByTimeAsync(120_000);
  await sessionLockTimeoutItem.setValue(60_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(mount).toHaveBeenCalledTimes(1);
});
