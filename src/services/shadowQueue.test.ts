import { beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { acceptTerms, consentItem } from '@/lib/consent';
import { entitlementItem } from '@/lib/entitlement';
import { sendShadowEvents } from '@/lib/shadow/api';
import { getClerkToken } from './entitlementBackground';
import { flushShadow, recordShadow, SHADOW_STATE_KEY } from './shadowBackground';

vi.mock('@/lib/config/verify', () => ({ verifyBundle: vi.fn(async () => true) }));
vi.mock('./entitlementBackground', () => ({ getClerkToken: vi.fn() }));
vi.mock('@/lib/shadow/api', () => ({
  sendShadowEvents: vi.fn(),
  ShadowApiError: class extends Error {
    constructor(public status: number) {
      super();
    }
  },
}));
const sender = { url: 'https://chatgpt.com/', frameId: 0 };
const visit = () => ({ type: 'si-shadow-visit', eventId: crypto.randomUUID() });
async function account(user = 'user_a', org = 'org_a') {
  const blob = {
    clerkUserId: user,
    plan: 'business_pro' as const,
    pro: true,
    features: [],
    org: { id: org, name: null, role: null },
    source: 'org_seat' as const,
    status: 'active',
    businessDomain: null,
    issuedAt: 0,
    exp: 9_999_999_999,
  };
  await entitlementItem.setValue({ blob, signature: 'valid', payload: JSON.stringify(blob) });
  vi.mocked(getClerkToken).mockResolvedValue(
    `e30.${btoa(JSON.stringify({ sub: user, org_id: org }))}.signature`,
  );
}
const state = async () => (await fakeBrowser.storage.local.get(SHADOW_STATE_KEY))[SHADOW_STATE_KEY];
beforeEach(async () => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  await acceptTerms();
  await account();
  vi.mocked(sendShadowEvents).mockImplementation(async (_token, events) =>
    events.map((e) => e.eventId),
  );
});
test('1,000 simultaneous observations survive serialized storage updates', async () => {
  const observations = Array.from({ length: 1000 }, visit);
  await Promise.all(observations.map((v) => recordShadow(v, sender)));
  expect((await state()).queue).toHaveLength(1000);
  expect(new Set((await state()).queue.map((e: { eventId: string }) => e.eventId)).size).toBe(1000);
});
test('a record arriving during upload is not overwritten by its acknowledgement', async () => {
  await recordShadow(visit(), sender);
  let release!: (ids: string[]) => void;
  vi.mocked(sendShadowEvents).mockImplementationOnce(
    (_t, events) =>
      new Promise((resolve) => {
        release = () => resolve(events.map((e) => e.eventId));
      }),
  );
  const sending = flushShadow();
  await vi.waitFor(() => expect(sendShadowEvents).toHaveBeenCalled());
  const next = visit();
  const recording = recordShadow(next, sender);
  release([]);
  await Promise.all([sending, recording]);
  expect((await state()).queue.map((e: { eventId: string }) => e.eventId)).toEqual([next.eventId]);
});
test('revoked consent discards queued data without uploading', async () => {
  await recordShadow(visit(), sender);
  await consentItem.setValue(null);
  await flushShadow();
  expect(sendShadowEvents).not.toHaveBeenCalled();
  expect((await state()).queue).toEqual([]);
});
test('account and organisation switches never upload previous observations', async () => {
  for (const [user, org] of [
    ['user_b', 'org_a'],
    ['user_a', 'org_b'],
  ]) {
    await account();
    await recordShadow(visit(), sender);
    await account(user, org);
    await flushShadow();
    expect((await state()).queue).toEqual([]);
  }
  expect(sendShadowEvents).not.toHaveBeenCalled();
});
test('a mismatched minted token cannot upload a valid old entitlement queue', async () => {
  await recordShadow(visit(), sender);
  vi.mocked(getClerkToken).mockResolvedValue(
    `e30.${btoa(JSON.stringify({ sub: 'user_b', org_id: 'org_b' }))}.sig`,
  );
  await flushShadow();
  expect(sendShadowEvents).not.toHaveBeenCalled();
});
