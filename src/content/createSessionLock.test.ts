import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_BUNDLE, saveBundle } from '@/lib/config';
import type { Salt } from '@/lib/fingerprint';
import { hashPin } from '@/lib/lock';
import { sessionLockPinHashItem } from '@/settings';
import { createSessionLock } from './createSessionLock';

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock('@/overlay/mountSessionLock', () => ({ mountSessionLock: mount }));
vi.mock('@/overlay/mountLockWarning', () => ({
  mountLockWarning: vi.fn(async () => ({ remove: vi.fn() })),
}));
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
