import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { verifyBundle } from '@/lib/config/verify';
import { acceptTerms, consentItem } from '@/lib/consent';
import { entitlementItem } from '@/lib/entitlement';
import { getClerkToken } from './entitlementBackground';
import {
  flushAuthenticatedTelemetry,
  invalidateTelemetryDelivery,
  sendAuthenticatedTelemetry,
  TELEMETRY_MAX_AGE_MS,
  TELEMETRY_MAX_ATTEMPTS,
  TELEMETRY_MAX_BYTES,
  TELEMETRY_MAX_EVENTS,
  TELEMETRY_MAX_PENDING_BYTES,
  TELEMETRY_MAX_PENDING_EVENTS,
  TELEMETRY_QUEUE_KEY,
  TELEMETRY_RETRY_ALARM,
} from './telemetryBackground';

vi.mock('@/lib/config/verify', () => ({ verifyBundle: vi.fn(async () => true) }));
vi.mock('./entitlementBackground', () => ({ getClerkToken: vi.fn() }));
const sender = 'https://chatgpt.com/private/conversation?private=discarded';
let now: number;
let fetchMock: ReturnType<typeof vi.fn>;
const owner = { userId: 'user_a', orgId: 'org_a' };
const jwt = (userId = owner.userId, orgId: string | null = owner.orgId) =>
  `e30.${btoa(JSON.stringify({ sub: userId, ...(orgId ? { org_id: orgId } : {}) }))}.signature`;
const event = (count = 1) => ({
  eventId: crypto.randomUUID(),
  site: 'Ignored site',
  policyVersion: 1,
  browser: 'chrome',
  detections: Array.from({ length: count }, () => ({
    fingerprint: 'a'.repeat(64),
    type: 'known-key',
    label: 'Unsafe label should not persist',
  })),
  action: 'cancelled',
  plan: 'business_pro',
  source: 'org_seat',
  signedIn: true,
  orgId: owner.orgId,
  actorId: 'a'.repeat(32),
  businessDomain: 'private.example',
});
async function account(userId = owner.userId, orgId: string | null = owner.orgId) {
  const blob = {
    clerkUserId: userId,
    plan: 'business_pro' as const,
    source: 'org_seat' as const,
    org: orgId ? { id: orgId, name: null, role: null } : null,
    pro: true,
    features: [],
    status: 'active',
    businessDomain: null,
    issuedAt: 0,
    exp: 9_999_999_999,
  };
  await entitlementItem.setValue({ blob, payload: JSON.stringify(blob), signature: 'valid' });
  vi.mocked(getClerkToken).mockResolvedValue(jwt(userId, orgId));
}
const state = async () =>
  (await fakeBrowser.storage.local.get(TELEMETRY_QUEUE_KEY))[TELEMETRY_QUEUE_KEY];
type InputEvent = Omit<ReturnType<typeof event>, 'orgId'> & { orgId: string | null };
async function enqueue(value: InputEvent = event(), identity: typeof owner | null = owner) {
  const result = await sendAuthenticatedTelemetry({ event: value, owner: identity }, sender);
  await flushAuthenticatedTelemetry();
  return result;
}
async function seed(values: ReturnType<typeof event>[], overrides = {}) {
  await fakeBrowser.storage.local.set({
    [TELEMETRY_QUEUE_KEY]: {
      queue: values.map((value) => ({
        event: { ...value, site: 'chatgpt.com' },
        owner,
        createdAt: now,
        attempts: 0,
      })),
      dropped: 0,
      failures: 0,
      retryAt: 0,
      ...overrides,
    },
  });
}
beforeEach(async () => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(verifyBundle).mockResolvedValue(true);
  await acceptTerms();
  await account();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  invalidateTelemetryDelivery();
  await flushAuthenticatedTelemetry();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('persists only bounded metadata, uses browser hostname, omits owner identity from HTTP', async () => {
  const value = { ...event(), rawText: 'raw secret payload', nested: { raw: 'must disappear' } };
  expect(await enqueue(value)).toEqual({ queued: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = fetchMock.mock.calls[0][1];
  const body = JSON.parse(request.body);
  expect(body.site).toBe('chatgpt.com');
  expect(body.detections[0].label).toBe('Credential');
  expect(request.headers.Authorization).toBe(`Bearer ${jwt()}`);
  expect(request.body).not.toMatch(/raw secret|private|Unsafe|user_a|rawText|nested/);
  expect((await state()).queue).toEqual([]);
  expect(await fakeBrowser.alarms.get(TELEMETRY_RETRY_ALARM)).toBeUndefined();
});

test.each([
  'network',
  'server',
  'missing-token',
])('retries %s failure with the same event ID after backoff', async (failure) => {
  if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
  if (failure === 'server') fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
  if (failure === 'missing-token') vi.mocked(getClerkToken).mockResolvedValueOnce(null);
  const value = event();
  await enqueue(value);
  const pending = await state();
  expect(pending.queue.map((entry: { event: { eventId: string } }) => entry.event.eventId)).toEqual(
    [value.eventId],
  );
  expect(pending.retryAt).toBeGreaterThan(now);
  expect(pending.retryAt).toBeLessThanOrEqual(now + 30_000);
  expect(await fakeBrowser.alarms.get(TELEMETRY_RETRY_ALARM)).toBeDefined();
  const attempts = fetchMock.mock.calls.length;
  await flushAuthenticatedTelemetry();
  expect(fetchMock).toHaveBeenCalledTimes(attempts);
  now = pending.retryAt + 1;
  await flushAuthenticatedTelemetry();
  expect((await state()).queue).toEqual([]);
  expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).eventId).toBe(value.eventId);
});

test.each([
  { status: 202, body: { accepted: 0 } },
  { status: 200, body: { accepted: 1 } },
])('requires exact durable acknowledgement: $status $body', async (result) => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(result.body), { status: result.status }));
  await enqueue();
  expect((await state()).queue).toHaveLength(1);
});

test('deduplicates a repeated queued event', async () => {
  fetchMock.mockRejectedValue(new Error('offline'));
  const value = event();
  await enqueue(value);
  await enqueue(value);
  expect((await state()).queue).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('parallel flushes share a request and an event arriving during upload survives', async () => {
  let release!: () => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ accepted: 1 }), { status: 202 }));
      }),
  );
  const first = event(),
    second = event();
  await sendAuthenticatedTelemetry({ event: first, owner }, sender);
  const flush = flushAuthenticatedTelemetry();
  expect(flushAuthenticatedTelemetry()).toBe(flush);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const arrival = sendAuthenticatedTelemetry({ event: second, owner }, sender);
  release();
  await Promise.all([flush, arrival]);
  await flushAuthenticatedTelemetry();
  expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).eventId)).toEqual([
    first.eventId,
    second.eventId,
  ]);
  expect((await state()).queue).toEqual([]);
});

test('consent withdrawn while credentials are pending prevents delivery and drops queue', async () => {
  let release!: (token: string) => void;
  vi.mocked(getClerkToken).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await sendAuthenticatedTelemetry({ event: event(), owner }, sender);
  const flush = flushAuthenticatedTelemetry();
  await vi.waitFor(() => expect(getClerkToken).toHaveBeenCalled());
  await consentItem.setValue(null);
  release(jwt());
  await flush;
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await state()).queue).toEqual([]);
});

test.each([
  1, 100,
])('bounds pending admissions with %i detections during a slow upload, then releases capacity', async (detections) => {
  let release!: () => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(new Response('', { status: 503 }));
      }),
  );
  await sendAuthenticatedTelemetry({ event: event(), owner }, sender);
  const flush = flushAuthenticatedTelemetry();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const arrivals = Array.from({ length: TELEMETRY_MAX_PENDING_EVENTS + 2 }, () =>
    sendAuthenticatedTelemetry(
      { event: { ...event(detections), rawText: 'must not be retained' }, owner },
      sender,
    ),
  );
  // Overflow resolves while the admitted records are still waiting behind the upload.
  expect(await Promise.all(arrivals.slice(TELEMETRY_MAX_PENDING_EVENTS))).toEqual([null, null]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  release();
  await flush;
  const results = await Promise.all(arrivals);
  await flushAuthenticatedTelemetry();
  const accepted = results.filter((result) => result?.queued).length;
  if (detections === 1) expect(accepted).toBe(TELEMETRY_MAX_PENDING_EVENTS);
  else {
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(TELEMETRY_MAX_PENDING_EVENTS);
  }
  const persisted = (await state()).queue.slice(1);
  expect(persisted).toHaveLength(accepted);
  expect(
    persisted.reduce(
      (total: number, entry: { event: unknown; owner: unknown }) =>
        total + JSON.stringify({ event: entry.event, owner: entry.owner }).length,
      0,
    ),
  ).toBeLessThanOrEqual(TELEMETRY_MAX_PENDING_BYTES);
  expect(JSON.stringify(await state())).not.toContain('must not be retained');
  expect(await sendAuthenticatedTelemetry({ event: event(), owner }, sender)).toEqual({
    queued: true,
  });
  await flushAuthenticatedTelemetry();
});

test('session invalidation aborts pending token acquisition without waiting for its completion', async () => {
  vi.mocked(getClerkToken).mockImplementationOnce(() => new Promise(() => {}));
  await sendAuthenticatedTelemetry({ event: event(), owner }, sender);
  const flush = flushAuthenticatedTelemetry();
  await vi.waitFor(() => expect(getClerkToken).toHaveBeenCalled());
  invalidateTelemetryDelivery();
  await account('user_b');
  await flush;
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await state()).queue).toEqual([]);
});

test('credential rotation cancellation preserves attempts and waits before retrying the same owner', async () => {
  vi.mocked(getClerkToken).mockImplementationOnce(() => new Promise(() => {}));
  await sendAuthenticatedTelemetry({ event: event(), owner }, sender);
  const flush = flushAuthenticatedTelemetry();
  await vi.waitFor(() => expect(getClerkToken).toHaveBeenCalled());
  invalidateTelemetryDelivery();
  await flush;
  const pending = await state();
  expect(pending.queue[0].attempts).toBe(0);
  expect(pending.failures).toBe(0);
  expect(pending.retryAt).toBeGreaterThan(now);
  await flushAuthenticatedTelemetry();
  expect(getClerkToken).toHaveBeenCalledTimes(1);
  now = pending.retryAt + 1;
  await flushAuthenticatedTelemetry();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await state()).queue).toEqual([]);
});

test.each([
  ['user_b', 'org_a'],
  ['user_a', 'org_b'],
])('rejects pending owner after switch to %s/%s', async (userId, orgId) => {
  let release!: (token: string) => void;
  vi.mocked(getClerkToken).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await sendAuthenticatedTelemetry({ event: event(), owner }, sender);
  const flush = flushAuthenticatedTelemetry();
  await vi.waitFor(() => expect(getClerkToken).toHaveBeenCalled());
  await account(userId, orgId);
  release(jwt(userId, orgId));
  await flush;
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await state()).queue).toEqual([]);
});

test('fresh token for another user cannot attribute an event from an old cached entitlement', async () => {
  vi.mocked(getClerkToken).mockResolvedValue(jwt('user_b'));
  await enqueue();
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await state()).queue).toEqual([]);
});

test('accepts absent JWT org claim for the same verified managed organization owner', async () => {
  const orgId = `org_si_${'a'.repeat(32)}`;
  await account('user_a', orgId);
  vi.mocked(getClerkToken).mockResolvedValue(jwt('user_a', null));
  await enqueue({ ...event(), orgId }, { userId: 'user_a', orgId });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).orgId).toBe(orgId);
});

test('anonymous events remain unauthenticated through sign-in and still require consent', async () => {
  const anonymous = { ...event(), signedIn: false, orgId: null, source: 'none', plan: 'developer' };
  await enqueue(anonymous, null);
  expect(getClerkToken).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  await consentItem.setValue(null);
  await enqueue({ ...anonymous, eventId: crypto.randomUUID() }, null);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('rejects missing/forged original owners and invalid signatures without anonymous downgrade', async () => {
  expect(await sendAuthenticatedTelemetry({ event: event() }, sender)).toBeNull();
  expect(
    await sendAuthenticatedTelemetry(
      { event: event(), owner: { userId: 'user_b', orgId: 'org_a' } },
      sender,
    ),
  ).toBeNull();
  vi.mocked(verifyBundle).mockResolvedValue(false);
  expect(await sendAuthenticatedTelemetry({ event: event(), owner }, sender)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('signed payload is authoritative over duplicate raw blob fields', async () => {
  const stored = (await entitlementItem.getValue())!;
  await entitlementItem.setValue({ ...stored, blob: { ...stored.blob, clerkUserId: 'user_b' } });
  await enqueue();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a persisted signed-in event with missing owner is discarded, never sent anonymously', async () => {
  await seed([event()]);
  const pending = await state();
  pending.queue[0].owner = null;
  await fakeBrowser.storage.local.set({ [TELEMETRY_QUEUE_KEY]: pending });
  await flushAuthenticatedTelemetry();
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await state()).queue).toEqual([]);
});

test('drops expired and exhausted entries and clears retry alarms', async () => {
  const values = [event(), event()];
  await seed(values);
  const pending = await state();
  pending.queue[0].createdAt = now - TELEMETRY_MAX_AGE_MS;
  pending.queue[1].attempts = TELEMETRY_MAX_ATTEMPTS;
  await fakeBrowser.storage.local.set({ [TELEMETRY_QUEUE_KEY]: pending });
  await flushAuthenticatedTelemetry();
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await state()).queue).toEqual([]);
  expect((await state()).dropped).toBe(2);
  expect(await fakeBrowser.alarms.get(TELEMETRY_RETRY_ALARM)).toBeUndefined();
});

test('enforces count and serialized byte caps while retaining newest bounded events', async () => {
  await seed(
    Array.from({ length: TELEMETRY_MAX_EVENTS }, () => event()),
    { retryAt: now + 60_000 },
  );
  const newest = event();
  await enqueue(newest);
  expect((await state()).queue).toHaveLength(TELEMETRY_MAX_EVENTS);
  expect((await state()).queue.at(-1).event.eventId).toBe(newest.eventId);
  await seed(
    Array.from({ length: 60 }, () => event(100)),
    { retryAt: now + 60_000 },
  );
  await flushAuthenticatedTelemetry();
  expect(JSON.stringify(await state()).length).toBeLessThanOrEqual(TELEMETRY_MAX_BYTES);
  expect((await state()).dropped).toBeGreaterThan(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a permanently invalid event does not prevent the next queued event from delivery', async () => {
  fetchMock.mockResolvedValueOnce(new Response('', { status: 400 }));
  await seed([event(), event()]);
  await flushAuthenticatedTelemetry();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect((await state()).queue).toEqual([]);
  expect((await state()).dropped).toBe(1);
});
