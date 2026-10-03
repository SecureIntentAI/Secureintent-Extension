import { browser } from '#imports';
import { API_BASE } from '@/lib/api/client';
import { withDeadline } from '@/lib/async';
import { isConsentAccepted } from '@/lib/consent';
import { entitlementItem } from '@/lib/entitlement';
import { verifyBundle } from '@/lib/config/verify';
import { getClerkToken } from './entitlementBackground';

const KEY = 'si_telemetry_queue_v1';
const GUEST_KEY = 'si_guest_telemetry_queue_v1';
const MAX_EVENTS = 512;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
type Event = { eventId: string; site: string; policyVersion: number; action: string;
  browser: string; detections: Array<{ fingerprint: string; type: string; label: string }> };
type Entry = { createdAt: number; event: Event };
type State = { owner: string | null; queue: Entry[]; dropped: number };
const empty = (): State => ({ owner: null, queue: [], dropped: 0 });

let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}
async function load(key: string): Promise<State> {
  const value = (await browser.storage.local.get(key))[key] as Partial<State> | undefined;
  return value && Array.isArray(value.queue)
    ? { owner: typeof value.owner === 'string' ? value.owner : null,
        queue: value.queue, dropped: Number(value.dropped) || 0 }
    : empty();
}
const save = (key: string, state: State) => browser.storage.local.set({ [key]: state });

async function currentOwner(): Promise<string | null> {
  const stored = await entitlementItem.getValue();
  if (!stored) return null;
  const payload = stored.payload ?? JSON.stringify(stored.blob);
  if (!(await verifyBundle(payload, stored.signature))) return null;
  try {
    const signed = JSON.parse(payload) as { clerkUserId?: unknown; org?: { id?: unknown } | null };
    if (typeof signed.clerkUserId !== 'string' || !signed.clerkUserId) return null;
    // Keep the signed owner stable when its entitlement expires during an
    // outage. The server still checks fresh Clerk membership on delivery.
    const orgId = typeof signed.org?.id === 'string' ? signed.org.id : null;
    return JSON.stringify([signed.clerkUserId, orgId]);
  } catch { return null; }
}

function cleanEvent(message: unknown, senderUrl?: string): Event | null {
  const source = (message as { event?: Record<string, unknown> })?.event;
  if (!source || typeof source !== 'object') return null;
  let site: string;
  try { site = new URL(senderUrl ?? '').hostname.toLowerCase(); } catch { return null; }
  if (!site || site.length > 253 || !/^[a-z0-9.-]+$/.test(site)) return null;
  if (typeof source.eventId !== 'string' || !/^[0-9a-f-]{36}$/.test(source.eventId) ||
      !Number.isSafeInteger(source.policyVersion) || Number(source.policyVersion) < 0 ||
      !['cancelled', 'paste_anyway', 'paste_anonymously'].includes(String(source.action)) ||
      !Array.isArray(source.detections) || source.detections.length < 1 || source.detections.length > 100) return null;
  const detections: Event['detections'] = [];
  for (const item of source.detections) {
    if (!item || typeof item !== 'object' ||
        typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
        typeof item.type !== 'string' || !['known-key', 'private-key', 'env-credential', 'pii', 'high-entropy'].includes(item.type) ||
        typeof item.label !== 'string' || item.label.length < 1 || item.label.length > 100) return null;
    detections.push({ fingerprint: item.fingerprint, type: item.type, label: item.type });
  }
  return { eventId: source.eventId, site, policyVersion: Number(source.policyVersion),
    action: String(source.action), browser: String(source.browser ?? '').slice(0, 20), detections };
}

/** Persist privacy-limited metadata before attempting the network request. */
export async function sendAuthenticatedTelemetry(message: unknown, senderUrl?: string) {
  if (!(await isConsentAccepted())) return null;
  const event = cleanEvent(message, senderUrl);
  if (!event) return null;
  const guest = (message as { event?: { signedIn?: unknown } })?.event?.signedIn === false;
  const key = guest ? GUEST_KEY : KEY;
  const queued = await serial(async () => {
    const owner = guest ? 'guest' : await currentOwner();
    if (!owner) return false;
    const current = await load(key);
    const state = current.owner === owner ? current : { ...empty(), owner };
    const now = Date.now();
    const valid = state.queue.filter((item) => item.createdAt > now - MAX_AGE_MS);
    const expired = state.queue.length - valid.length;
    if (!valid.some((item) => item.event.eventId === event.eventId)) valid.push({ createdAt: now, event });
    const overflow = Math.max(0, valid.length - MAX_EVENTS);
    await save(key, { owner, queue: valid.slice(overflow),
      dropped: state.dropped + expired + overflow });
    return true;
  });
  if (queued) void flushAuthenticatedTelemetry().catch(() => {});
  return queued ? { queued: true } : null;
}

let flushing: Promise<void> | undefined;
export function flushAuthenticatedTelemetry(): Promise<void> {
  if (!flushing) flushing = serial(async () => {
    await flush(GUEST_KEY, true);
    await flush(KEY, false);
  }).finally(() => { flushing = undefined; });
  return flushing;
}

async function flush(key: string, guest: boolean): Promise<void> {
  if (!(await isConsentAccepted())) { await save(key, empty()); return; }
  const owner = guest ? 'guest' : await currentOwner();
  const state = await load(key);
  if (!owner || state.owner !== owner) { await save(key, empty()); return; }
  const token = guest ? null : await getClerkToken();
  if (!guest) {
    if (!token) return;
    try {
      const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (claims.sub !== JSON.parse(owner)[0]) return;
    } catch { return; }
  }
  const expectedOrgId = JSON.parse(owner)[1] as string | null;
  for (let sent = 0; sent < 10; sent++) {
    const current = await load(key);
    if (current.owner !== owner || (!guest && (await currentOwner()) !== owner)) return;
    const next = current.queue[0];
    if (!next) return;
    if (next.createdAt <= Date.now() - MAX_AGE_MS) {
      await save(key, { ...current, queue: current.queue.slice(1), dropped: current.dropped + 1 });
      continue;
    }
    let response: Response;
    try {
      response = await withDeadline((signal) => fetch(`${API_BASE}/v1/telemetry`, {
        method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        // An old event must never be silently attributed to a new team.
        body: JSON.stringify({ ...next.event, ...(expectedOrgId ? { orgId: expectedOrgId } : {}) }),
        cache: 'no-store', redirect: 'error', signal,
      }), new AbortController(), 25_000);
    } catch { return; }
    if (response.status === 202) {
      const ack = await response.json().catch(() => null) as { accepted?: number } | null;
      if (ack?.accepted !== next.event.detections.length) return;
    } else if (response.status !== 400) return;
    const latest = await load(key);
    if (latest.owner !== owner) return;
    await save(key, { ...latest, queue: latest.queue.filter((item) => item.event.eventId !== next.event.eventId),
      dropped: latest.dropped + (response.status === 400 ? 1 : 0) });
  }
}
