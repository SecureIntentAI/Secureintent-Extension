import { browser } from '#imports';
import { API_BASE } from '@/lib/api/client';
import { abortable, withDeadline } from '@/lib/async';
import { verifyBundle } from '@/lib/config/verify';
import { isConsentAccepted } from '@/lib/consent';
import { entitlementItem } from '@/lib/entitlement';
import type { TelemetryDetection, TelemetryEvent } from '@/lib/telemetry/types';
import { getClerkToken } from './entitlementBackground';
import type { TelemetryOwner } from './telemetryService';

export const TELEMETRY_RETRY_ALARM = 'si-telemetry-retry';
export const TELEMETRY_QUEUE_KEY = 'si_telemetry_queue_v2';
export const TELEMETRY_MAX_EVENTS = 512;
export const TELEMETRY_MAX_BYTES = 512 * 1024;
export const TELEMETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TELEMETRY_MAX_ATTEMPTS = 16;
export const TELEMETRY_MAX_PENDING_EVENTS = 64;
export const TELEMETRY_MAX_PENDING_BYTES = 128 * 1024;
const MAX_PER_FLUSH = 8;
const ORG_ID = /^(?:org_[A-Za-z0-9]{1,60}|org_si_[a-f0-9]{32})$/;
const LABELS = {
  'known-key': 'Credential',
  'private-key': 'Private key',
  'env-credential': 'Environment credential',
  pii: 'Personal information',
  'high-entropy': 'High-entropy secret',
} as const;
type Entry = {
  owner: TelemetryOwner | null;
  event: TelemetryEvent;
  createdAt: number;
  attempts: number;
};
type State = { queue: Entry[]; dropped: number; failures: number; retryAt: number };
const empty = (): State => ({ queue: [], dropped: 0, failures: 0, retryAt: 0 });
let revision = 0;
let controller: AbortController | undefined;
let tail: Promise<unknown> = Promise.resolve();
let flushing: Promise<void> | undefined;
let pendingAdmissions = 0;
let pendingAdmissionBytes = 0;

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function ownerValue(value: unknown): TelemetryOwner | null {
  const owner = record(value);
  return owner &&
    typeof owner.userId === 'string' &&
    /^user_[A-Za-z0-9_-]{1,128}$/.test(owner.userId) &&
    (owner.orgId === null || (typeof owner.orgId === 'string' && ORG_ID.test(owner.orgId)))
    ? { userId: owner.userId, orgId: owner.orgId as string | null }
    : null;
}
function sameOwner(a: TelemetryOwner | null, b: TelemetryOwner | null): boolean {
  return a?.userId === b?.userId && a?.orgId === b?.orgId;
}

/** Preserve the signed owner through expiry during an outage, but never trust duplicate blob fields. */
async function currentOwner(): Promise<TelemetryOwner | null> {
  const stored = await entitlementItem.getValue();
  if (!stored) return null;
  try {
    const payload = stored.payload ?? JSON.stringify(stored.blob);
    if (!(await verifyBundle(payload, stored.signature))) return null;
    const signed = JSON.parse(payload);
    return ownerValue({ userId: signed.clerkUserId, orgId: signed.org?.id ?? null });
  } catch {
    return null;
  }
}

/** Only bounded metadata is persisted or uploaded; custom labels and extra fields are discarded. */
function cleanEvent(
  value: unknown,
  senderUrl: string,
  owner: TelemetryOwner | null,
): TelemetryEvent | null {
  const event = record(value);
  if (!event) return null;
  let site: string;
  try {
    const url = new URL(senderUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    site = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (
    !site ||
    site.length > 253 ||
    /[/?#@\s]/.test(site) ||
    typeof event.eventId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.eventId) ||
    !Number.isSafeInteger(event.policyVersion) ||
    Number(event.policyVersion) < 0 ||
    Number(event.policyVersion) > 4294967295 ||
    !['cancelled', 'paste_anyway', 'paste_anonymously'].includes(String(event.action)) ||
    !Array.isArray(event.detections) ||
    !event.detections.length ||
    event.detections.length > 100
  )
    return null;
  const detections: TelemetryDetection[] = [];
  for (const value of event.detections) {
    const item = record(value);
    if (
      !item ||
      typeof item.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
      typeof item.type !== 'string' ||
      !Object.hasOwn(LABELS, item.type)
    )
      return null;
    const type = item.type as keyof typeof LABELS;
    detections.push({
      fingerprint: item.fingerprint as TelemetryDetection['fingerprint'],
      type,
      label: LABELS[type],
    });
  }
  return {
    eventId: event.eventId,
    site,
    policyVersion: Number(event.policyVersion),
    detections,
    action: event.action as TelemetryEvent['action'],
    browser: ['chrome', 'firefox', 'edge', 'opera', 'safari'].includes(String(event.browser))
      ? String(event.browser)
      : '',
    plan: ['developer', 'developer_pro', 'business_pro'].includes(String(event.plan))
      ? String(event.plan)
      : 'developer',
    source: ['none', 'lifetime', 'org_seat', 'paddle', 'business_email', 'manual'].includes(
      String(event.source),
    )
      ? String(event.source)
      : 'none',
    signedIn: owner !== null,
    businessDomain: null,
    orgId: owner?.orgId ?? null,
    actorId: null,
  };
}

function bounded(state: State): State {
  const now = Date.now();
  const queue = state.queue.filter(
    (entry) =>
      entry.createdAt > now - TELEMETRY_MAX_AGE_MS &&
      entry.createdAt <= now &&
      entry.attempts < TELEMETRY_MAX_ATTEMPTS,
  );
  let dropped = state.dropped + state.queue.length - queue.length;
  // All retained fields are ASCII. Include JSON framing and fixed state overhead.
  const sizes = queue.map((entry) => JSON.stringify(entry).length + 1);
  let bytes = sizes.reduce((sum, size) => sum + size, 256);
  while (queue.length > TELEMETRY_MAX_EVENTS || bytes > TELEMETRY_MAX_BYTES) {
    queue.shift();
    bytes -= sizes.shift() ?? 0;
    dropped++;
  }
  return { ...state, queue, dropped, ...(queue.length ? {} : { retryAt: 0, failures: 0 }) };
}
async function load(): Promise<State> {
  const value = record((await browser.storage.local.get(TELEMETRY_QUEUE_KEY))[TELEMETRY_QUEUE_KEY]);
  if (!value || !Array.isArray(value.queue)) return empty();
  const raw = value.queue.slice(-TELEMETRY_MAX_EVENTS);
  const queue: Entry[] = [];
  for (const item of raw) {
    const entry = record(item),
      owner = ownerValue(entry?.owner);
    const source = record(entry?.event);
    if (
      !entry ||
      !source ||
      (entry.owner !== null && !owner) ||
      ((source.signedIn || source.orgId) && !owner) ||
      (source.orgId ?? null) !== (owner?.orgId ?? null) ||
      !Number.isSafeInteger(entry.createdAt) ||
      !Number.isSafeInteger(entry.attempts) ||
      Number(entry.attempts) < 0
    )
      continue;
    const event = cleanEvent(source, `https://${String(source.site)}/`, owner);
    if (event)
      queue.push({
        event,
        owner,
        createdAt: Number(entry.createdAt),
        attempts: Number(entry.attempts),
      });
  }
  const integer = (n: unknown) => (Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : 0);
  return bounded({
    queue,
    dropped: integer(value.dropped) + value.queue.length - queue.length,
    failures: Math.min(16, integer(value.failures)),
    retryAt: Math.min(Date.now() + 15 * 60_000, integer(value.retryAt)),
  });
}
async function save(state: State): Promise<void> {
  await browser.storage.local.set({ [TELEMETRY_QUEUE_KEY]: state });
  if (!state.queue.length) {
    await browser.alarms.clear(TELEMETRY_RETRY_ALARM);
    return;
  }
  const expiry = Math.min(...state.queue.map((entry) => entry.createdAt + TELEMETRY_MAX_AGE_MS));
  await browser.alarms.create(TELEMETRY_RETRY_ALARM, {
    when: Math.max(Date.now() + 1000, Math.min(state.retryAt || Date.now(), expiry)),
  });
}
async function pruneIdentity(state: State): Promise<State> {
  if (!(await isConsentAccepted()))
    return { ...empty(), dropped: state.dropped + state.queue.length };
  const owner = await currentOwner();
  const queue = state.queue.filter(
    (entry) => entry.owner === null || sameOwner(entry.owner, owner),
  );
  return bounded({ ...state, queue, dropped: state.dropped + state.queue.length - queue.length });
}

/** Called synchronously on consent/session changes; pending token work cannot send afterward. */
export function invalidateTelemetryDelivery(): void {
  revision++;
  controller?.abort(new DOMException('Telemetry identity or consent changed', 'AbortError'));
}

/** Capture ownership from the original paste, persist, then attempt delivery asynchronously. */
export function sendAuthenticatedTelemetry(message: unknown, senderUrl?: string) {
  const input = record(message),
    source = record(input?.event),
    owner = ownerValue(input?.owner);
  if (
    !source ||
    ((source.signedIn || source.orgId) && !owner) ||
    (input?.owner != null && !owner) ||
    (source.orgId ?? null) !== (owner?.orgId ?? null)
  )
    return Promise.resolve(null);
  const event = cleanEvent(source, senderUrl ?? '', owner);
  if (!event) return Promise.resolve(null);
  // The asynchronous closure receives only normalized metadata, never the raw message.
  return admitTelemetry(event, owner);
}

async function admitTelemetry(event: TelemetryEvent, owner: TelemetryOwner | null) {
  const bytes = JSON.stringify({ event, owner }).length;
  if (
    pendingAdmissions >= TELEMETRY_MAX_PENDING_EVENTS ||
    pendingAdmissionBytes + bytes > TELEMETRY_MAX_PENDING_BYTES
  )
    return null;
  pendingAdmissions++;
  pendingAdmissionBytes += bytes;
  try {
    const arrival = revision;
    const queued = await serial(async () => {
      if (!(await isConsentAccepted()) || arrival !== revision) return false;
      if (owner && !sameOwner(owner, await currentOwner())) return false;
      let state = await pruneIdentity(await load());
      if (arrival !== revision || !(await isConsentAccepted())) return false;
      if (
        !state.queue.some(
          (entry) => entry.event.eventId === event.eventId && sameOwner(entry.owner, owner),
        )
      )
        state.queue.push({ event, owner, createdAt: Date.now(), attempts: 0 });
      state = bounded(state);
      await save(state);
      return true;
    });
    if (queued) void flushAuthenticatedTelemetry().catch(() => {});
    return queued ? { queued: true } : null;
  } finally {
    pendingAdmissions--;
    pendingAdmissionBytes -= bytes;
  }
}

type Result = 'accepted' | 'retry' | 'discard' | 'owner-changed' | 'cancelled';
async function deliver(entry: Entry): Promise<Result> {
  const generation = revision;
  const active = new AbortController();
  controller = active;
  try {
    return await withDeadline(async (signal) => {
      const token = entry.owner ? await abortable(getClerkToken(), signal) : null;
      if (entry.owner) {
        if (!token) return 'retry';
        try {
          const claims = JSON.parse(
            atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
          );
          const orgId = claims.org_id ?? claims.o?.id;
          if (claims.sub !== entry.owner.userId || (orgId != null && orgId !== entry.owner.orgId))
            return 'owner-changed';
        } catch {
          return 'retry';
        }
        if (!sameOwner(entry.owner, await currentOwner())) return 'owner-changed';
      }
      if (!(await isConsentAccepted()) || generation !== revision)
        throw new DOMException('Telemetry scope changed', 'AbortError');
      signal.throwIfAborted();
      const response = await fetch(`${API_BASE}/v1/telemetry`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(entry.event),
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
      if (response.status === 202) {
        const ack = await response.json().catch(() => null);
        return ack?.accepted === entry.event.detections.length ? 'accepted' : 'retry';
      }
      return [400, 403, 413, 422].includes(response.status) ? 'discard' : 'retry';
    }, active);
  } catch {
    return generation !== revision ? 'cancelled' : 'retry';
  } finally {
    if (controller === active) controller = undefined;
  }
}

async function flush(): Promise<void> {
  let state = await pruneIdentity(await load());
  await save(state);
  if (state.retryAt > Date.now()) return;
  for (let count = 0; count < MAX_PER_FLUSH && state.queue.length; count++) {
    const entry = state.queue[0];
    const result = await deliver(entry);
    if (result === 'accepted' || result === 'discard') {
      state.queue.shift();
      if (result === 'discard') state.dropped++;
      state.failures = 0;
      state.retryAt = 0;
    } else if (result === 'owner-changed') {
      const before = state.queue.length;
      state.queue = state.queue.filter((item) => !sameOwner(item.owner, entry.owner));
      state.dropped += before - state.queue.length;
    } else if (result === 'cancelled') {
      // Clerk can rotate its cached credential without changing accounts. A
      // cancelled request must not consume the network retry budget or spin.
      state.retryAt = Date.now() + Math.floor(30_000 * (0.8 + Math.random() * 0.2));
    } else {
      entry.attempts++;
      state.failures++;
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(state.failures - 1, 5));
      state.retryAt = Date.now() + Math.floor(delay * (0.8 + Math.random() * 0.2));
    }
    state = await pruneIdentity(bounded(state));
    await save(state);
    if (result === 'retry' || result === 'cancelled') return;
  }
}

/** One serialized delivery run; arrivals during upload are retained for the next run/alarm. */
export function flushAuthenticatedTelemetry(): Promise<void> {
  if (!flushing)
    flushing = serial(flush).finally(() => {
      flushing = undefined;
    });
  return flushing;
}
