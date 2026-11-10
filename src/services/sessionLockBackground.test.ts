import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { Salt } from '@/lib/fingerprint';
import { hashPin } from '@/lib/lock';
import { BASE_LOCKOUT_MS } from '@/lib/lock/attempts';
import { sessionLockPinHashItem } from '@/settings';
import { tryUnlock } from './sessionLockBackground';

let now = 1_000_000;
beforeEach(async () => {
  fakeBrowser.reset();
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await fakeBrowser.storage.local.set({ si_fingerprint_salt: 'test-salt' });
  await sessionLockPinHashItem.setValue(await hashPin('1234', 'test-salt' as Salt));
});
afterEach(() => vi.restoreAllMocks());

test('the right PIN unlocks and clears the count', async () => {
  for (let i = 0; i < 4; i++) expect((await tryUnlock('0000')).ok).toBe(false);
  expect(await tryUnlock('1234')).toEqual({ ok: true, retryAfter: 0 });
  expect(await fakeBrowser.storage.local.get('si_lock_attempts')).toEqual({});
});

test('misses made in parallel all count towards one wait', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => tryUnlock('0000')));
  expect(results.at(-1)).toEqual({ ok: false, retryAfter: now + BASE_LOCKOUT_MS });
  expect((await tryUnlock('1234')).ok).toBe(false);
});

test('without a stored PIN nothing unlocks and nothing is counted', async () => {
  await sessionLockPinHashItem.setValue(null);
  expect(await tryUnlock('1234')).toEqual({ ok: false, retryAfter: 0 });
  expect(await fakeBrowser.storage.local.get('si_lock_attempts')).toEqual({});
});

test('non-string PINs are misses', async () => {
  expect((await tryUnlock(1234)).ok).toBe(false);
  expect(await fakeBrowser.storage.local.get('si_lock_attempts')).toEqual({
    si_lock_attempts: { failures: 1, retryAfter: 0 },
  });
});
