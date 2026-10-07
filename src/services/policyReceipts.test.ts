import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { Browser } from '#imports';
import { collectPolicyReceipts, PROBE_WAIT_MS } from './policyReceipts';

type Tabs = Awaited<ReturnType<typeof fakeBrowser.tabs.query>>;
const tab = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://site${id}.example/`,
  status: 'complete',
  discarded: false,
  incognito: false,
  ...extra,
});

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every probed tab answers like a running guard holding `version`. */
function answerProbes(version: number) {
  vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (tabId, message) => {
    const { nonce } = message as { nonce: string };
    await fakeBrowser.runtime.onMessage.trigger(
      { type: 'si-policy-receipt', nonce, orgId: 'org_acme', version, active: true },
      { tab: { id: tabId } as Browser.tabs.Tab, frameId: 0 },
    );
  });
}

test('sleeping and loading tabs are not expected to answer, so the receipt is confirmed', async () => {
  vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
    tab(1),
    tab(2, { discarded: true }),
    tab(3, { status: 'loading' }),
    tab(4, { url: 'chrome://extensions/' }),
    tab(5, { incognito: true }),
    tab(6, { url: 'https://chromewebstore.google.com/detail/x' }),
    tab(7, { url: 'https://addons.mozilla.org/en-US/firefox/' }),
    tab(8, { frozen: true }),
    tab(9, { url: 'https://support.mozilla.org/en-US/kb/' }),
    tab(10, { url: 'https://accounts.firefox.com/settings' }),
    tab(11, { url: 'https://example.com/report.PDF' }),
  ] as unknown as Tabs);
  answerProbes(7);
  const receipt = collectPolicyReceipts('org_acme', 7);
  await vi.advanceTimersByTimeAsync(PROBE_WAIT_MS);
  expect(await receipt).toEqual({
    policyState: 'guards_confirmed',
    confirmedGuards: 1,
    expectedPages: 1,
  });
  expect(fakeBrowser.tabs.sendMessage).toHaveBeenCalledTimes(1);
});

test('a running tab on an older revision still keeps the receipt pending', async () => {
  vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([tab(1)] as unknown as Tabs);
  answerProbes(6);
  const receipt = collectPolicyReceipts('org_acme', 7);
  await vi.advanceTimersByTimeAsync(PROBE_WAIT_MS);
  expect(await receipt).toMatchObject({ policyState: 'pending' });
});

test('no probeable tab means the revision is downloaded', async () => {
  vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
    tab(1, { discarded: true }),
  ] as unknown as Tabs);
  const receipt = collectPolicyReceipts('org_acme', 7);
  await vi.advanceTimersByTimeAsync(PROBE_WAIT_MS);
  expect(await receipt).toEqual({
    policyState: 'downloaded',
    confirmedGuards: 0,
    expectedPages: 0,
  });
});
