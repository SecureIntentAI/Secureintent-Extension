import { beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { configItem } from '@/lib/config/store';
import type { EntitlementSnapshot } from '@/lib/entitlement';
import { anonymiseNeedsSignIn, getAnonymizeStatus } from './index';
import { OFFLINE_LIMIT, offlineConsume } from './offline';

const snap = (over: Partial<EntitlementSnapshot>) =>
  ({ pro: false, signedIn: false, ...over }) as EntitlementSnapshot;
const launched = () =>
  configItem.setValue({
    ...DEFAULT_BUNDLE,
    version: DEFAULT_BUNDLE.version + 1,
    plansEnforced: true,
  });

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

test('before launch, signed out keeps the on-device allowance', async () => {
  expect(await anonymiseNeedsSignIn()).toBe(false);
  await offlineConsume();
  expect(await getAnonymizeStatus(snap({}))).toEqual({
    used: 1,
    remaining: OFFLINE_LIMIT - 1,
    limit: OFFLINE_LIMIT,
    unlimited: false,
  });
});

test('from launch, signed out needs sign-in, whatever the on-device count says', async () => {
  await launched();
  expect(await anonymiseNeedsSignIn()).toBe(true);
  expect(await getAnonymizeStatus(snap({}))).toMatchObject({
    remaining: 0,
    unlimited: false,
    signInRequired: true,
  });
});

test('from launch, signed in asks the account allowance, and Pro stays unlimited', async () => {
  await launched();
  const account = { used: 3, remaining: 7, limit: 10, unlimited: false };
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(account);
  expect(await getAnonymizeStatus(snap({ signedIn: true }))).toEqual(account);
  expect((await getAnonymizeStatus(snap({ pro: true }))).unlimited).toBe(true);
});
