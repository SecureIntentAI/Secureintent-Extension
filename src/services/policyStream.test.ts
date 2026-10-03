import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { REQUEST_TIMEOUT_MS } from '@/lib/async';
import { ensurePolicyStream, stopPolicyStream } from './policyStream';

const mocks = vi.hoisted(() => ({
  consent: true,
  org: 'org_acme' as string | null,
  token: vi.fn(),
  refresh: vi.fn(),
  sync: vi.fn(),
  report: vi.fn(),
}));
vi.mock('@/lib/consent', () => ({ isConsentAccepted: async () => mocks.consent }));
vi.mock('@/lib/entitlement', () => ({
  getActiveEntitlement: async () => ({ org: mocks.org ? { id: mocks.org } : null }),
}));
vi.mock('./entitlementBackground', () => ({
  getClerkToken: mocks.token,
  refreshEntitlementBg: mocks.refresh,
}));
vi.mock('./configService', () => ({ syncConfig: mocks.sync }));
vi.mock('./businessConnection', () => ({ reportBusinessConnection: mocks.report }));

class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    TestSocket.instances.push(this);
  }
  open() {
    this.readyState = TestSocket.OPEN;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

beforeEach(() => {
  stopPolicyStream();
  fakeBrowser.reset();
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.consent = true;
  mocks.org = 'org_acme';
  mocks.token.mockReset().mockResolvedValue('synthetic-session');
  mocks.refresh.mockReset().mockResolvedValue({ status: 'updated' });
  mocks.sync.mockReset().mockResolvedValue({ status: 'updated' });
  mocks.report.mockReset().mockResolvedValue(undefined);
  TestSocket.instances = [];
  vi.stubGlobal('WebSocket', TestSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ orgId: mocks.org, ticket: 'synthetic-ticket' })),
  );
});
afterEach(() => {
  stopPolicyStream();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('only consented team accounts request a stream ticket', async () => {
  mocks.consent = false;
  await ensurePolicyStream();
  mocks.consent = true;
  mocks.org = null;
  await ensurePolicyStream();
  expect(fetch).not.toHaveBeenCalled();
  expect(TestSocket.instances).toHaveLength(0);
});

test('policy bursts reconcile again after an in-flight fetch without parallel requests', async () => {
  let finish!: (value: { status: string }) => void;
  mocks.sync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await ensurePolicyStream();
  const ws = TestSocket.instances[0];
  expect(ws.url).toContain('/v1/business/policy-stream/org_acme');
  expect(ws.protocol).toBe('si-policy.synthetic-ticket');
  ws.open();
  ws.message({ type: 'policy.changed' });
  ws.message({ type: 'policy.changed' });
  ws.message({ type: 'policy.changed' });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  finish({ status: 'updated' });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  expect(mocks.report).toHaveBeenCalledTimes(2);
});

test('a stuck token mint times out and does not prevent the next connection attempt', async () => {
  mocks.token.mockImplementationOnce(() => new Promise(() => {}));
  const first = ensurePolicyStream();
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  await first;
  await ensurePolicyStream();
  expect(mocks.token).toHaveBeenCalledTimes(2);
  expect(TestSocket.instances).toHaveLength(1);
});

test('a cancelled connection cannot install its old account socket after a new attempt', async () => {
  let finish!: (value: string) => void;
  mocks.token.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = ensurePolicyStream();
  await vi.advanceTimersByTimeAsync(0);
  stopPolicyStream();
  mocks.org = 'org_new';
  await ensurePolicyStream();
  finish('old-session');
  await old;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(TestSocket.instances).toHaveLength(1);
  expect(TestSocket.instances[0].url).toContain('/org_new');
});

test('a stop during retry membership refresh cannot reopen the stream', async () => {
  let finish!: (value: { status: string }) => void;
  mocks.refresh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await ensurePolicyStream();
  TestSocket.instances[0].open();
  TestSocket.instances[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  stopPolicyStream();
  finish({ status: 'updated' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(TestSocket.instances).toHaveLength(1);
  expect(mocks.token).toHaveBeenCalledTimes(1);
});

test('a ticket for the wrong organization is rejected and retried', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ orgId: 'org_other', ticket: 'synthetic-ticket' }),
  );
  await ensurePolicyStream();
  expect(TestSocket.instances).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(TestSocket.instances).toHaveLength(1);
});

test('a stopped socket cannot cancel its replacement heartbeat or schedule another retry', async () => {
  await ensurePolicyStream();
  const old = TestSocket.instances[0];
  old.open();
  const lateClose = old.onclose;
  stopPolicyStream();
  await ensurePolicyStream();
  const current = TestSocket.instances[1];
  current.open();
  lateClose?.();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(current.send).toHaveBeenCalledExactlyOnceWith('ping');
  expect(old.send).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});
