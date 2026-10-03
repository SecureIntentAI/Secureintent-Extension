import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { browser } from '#imports';
import { REQUEST_TIMEOUT_MS } from '@/lib/async';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { configItem } from '@/lib/config/store';
import { reportBusinessConnection } from './businessConnection';

const state = vi.hoisted(() => ({
  consent: true,
  org: 'org_acme' as string | null,
  userId: 'user_test_a',
  token: '',
  receipts: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('@/lib/consent', () => ({ isConsentAccepted: async () => state.consent }));
vi.mock('@/lib/entitlement', () => ({
  getActiveEntitlement: async (expectedUserId?: string | null) => ({
    org:
      state.org && (expectedUserId === undefined || expectedUserId === state.userId)
        ? { id: state.org }
        : null,
  }),
}));
vi.mock('./entitlementBackground', () => ({ getClerkToken: async () => state.token }));
vi.mock('./policyReceipts', () => ({ collectPolicyReceipts: state.receipts }));
vi.mock('./configService', () => ({ syncConfig: state.sync }));

const teamConfig = (version: number, orgId = 'org_acme') => ({
  ...DEFAULT_BUNDLE,
  policy: { orgId, blockInsteadOfWarn: false, requireSessionLock: false, blockedSites: [] },
  policyVersion: version,
});
const acknowledgement = (policyVersion = 4) =>
  Response.json({ connected: true, orgId: 'org_acme', policyVersion });
const status = async () =>
  (await browser.storage.local.get('si_business_connection_status')).si_business_connection_status;

beforeEach(() => {
  fakeBrowser.reset();
  state.consent = true;
  state.org = 'org_acme';
  state.userId = 'user_test_a';
  state.token = `test.${btoa(JSON.stringify({ sub: state.userId }))}.synthetic`;
  state.receipts
    .mockReset()
    .mockResolvedValue({ policyState: 'downloaded', confirmedGuards: 0, expectedPages: 0 });
  state.sync.mockReset().mockResolvedValue({ status: 'unchanged' });
  vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'SecureIntent',
    version: '1.2.0',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => acknowledgement()),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('reports identity-bound metadata and accepts the actual server acknowledgement', async () => {
  await configItem.setValue(teamConfig(4));
  await reportBusinessConnection();
  await reportBusinessConnection();
  const calls = vi.mocked(fetch).mock.calls;
  const first = JSON.parse(String(calls[0][1]?.body));
  const second = JSON.parse(String(calls[1][1]?.body));
  expect(first).toMatchObject({
    expectedOrgId: 'org_acme',
    extensionVersion: '1.2.0',
    appliedPolicyVersion: 4,
  });
  expect(first.installationId).toBe(second.installationId);
  expect(first).not.toHaveProperty('email');
  expect(first).not.toHaveProperty('userId');
  expect(calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${state.token}` });
  expect(await status()).toMatchObject({ status: 'reported' });
});

test('does not report unconsented or individual accounts', async () => {
  state.consent = false;
  await reportBusinessConnection();
  state.consent = true;
  state.org = null;
  await reportBusinessConnection();
  expect(fetch).not.toHaveBeenCalled();
});

test("cannot acknowledge another organization's cached policy", async () => {
  await configItem.setValue(teamConfig(99, 'org_other'));
  await reportBusinessConnection();
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({
    appliedPolicyVersion: 0,
    policyState: 'pending',
  });
});

test.each([
  'consent',
  'organization',
])('rechecks %s after collecting page receipts', async (change) => {
  state.receipts.mockImplementationOnce(async () => {
    if (change === 'consent') state.consent = false;
    else state.org = 'org_other';
    return { policyState: 'downloaded', confirmedGuards: 0, expectedPages: 0 };
  });
  await reportBusinessConnection();
  expect(fetch).not.toHaveBeenCalled();
});

test('does not report with the previous user token after a same-organization account switch', async () => {
  await configItem.setValue(teamConfig(4));
  state.receipts.mockImplementationOnce(async () => {
    state.userId = 'user_test_b';
    return { policyState: 'downloaded', confirmedGuards: 0, expectedPages: 0 };
  });
  await reportBusinessConnection();
  expect(fetch).not.toHaveBeenCalled();

  state.token = `test.${btoa(JSON.stringify({ sub: state.userId }))}.synthetic`;
  await reportBusinessConnection();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
    Authorization: `Bearer ${state.token}`,
  });
});

test('concurrent callers share one connection report', async () => {
  await configItem.setValue(teamConfig(4));
  const first = reportBusinessConnection();
  expect(reportBusinessConnection()).toBe(first);
  await first;
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('reports the new revision immediately after the server requests a policy refresh', async () => {
  await configItem.setValue(teamConfig(4));
  vi.mocked(fetch).mockImplementation(async () => acknowledgement(5));
  state.sync.mockImplementationOnce(async () => {
    await configItem.setValue(teamConfig(5));
    return { status: 'updated' };
  });
  await reportBusinessConnection();
  expect(state.sync).toHaveBeenCalledTimes(1);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(String(call[1]?.body)).appliedPolicyVersion),
  ).toEqual([4, 5]);
  expect(await status()).toMatchObject({ status: 'reported' });
});

test.each([
  { connected: true, orgId: 'org_other', policyVersion: 4 },
  { connected: true, orgId: 'org_acme', policyVersion: -1 },
  { connected: true },
])('rejects an invalid server acknowledgement: %j', async (reply) => {
  await configItem.setValue(teamConfig(4));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(reply));
  await reportBusinessConnection();
  expect(await status()).toMatchObject({ status: 'retry_pending' });
  await reportBusinessConnection();
  expect(await status()).toMatchObject({ status: 'reported' });
});

test('a stalled report times out and releases the next reporting cycle', async () => {
  await configItem.setValue(teamConfig(4));
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
  const first = reportBusinessConnection();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  await first;
  expect(await status()).toMatchObject({ status: 'retry_pending' });
  await reportBusinessConnection();
  expect(await status()).toMatchObject({ status: 'reported' });
});
