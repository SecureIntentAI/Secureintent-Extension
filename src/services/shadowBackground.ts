import { browser } from '#imports';
import { isConsentAccepted } from '@/lib/consent';
import { entitlementItem, evaluateStored } from '@/lib/entitlement';
import { ShadowApiError, sendShadowEvents } from '@/lib/shadow/api';
import {
  canDiscover,
  type DiscoverySeat,
  type DlpEvent,
  emptyVisitState,
  enqueueEvent,
  makeDlpEvent,
  makePasteVolume,
  makeVisit,
  type ShadowEvent,
  VISIT_TTL,
  type VisitState,
} from '@/lib/shadow/visits';
import { getClerkToken } from './entitlementBackground';

export const SHADOW_STATE_KEY = 'si_shadow_state_v1';
export const SHADOW_ALARM = 'si-shadow-sync';

type Sender = { url?: string; frameId?: number; incognito?: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Turn one content-script message into the next queue, or leave it unchanged. */
export function reduceShadowMessage(
  state: VisitState,
  seat: DiscoverySeat | null,
  consented: boolean,
  sender: Sender,
  message: unknown,
  now: number,
): VisitState {
  if (!canDiscover(seat)) {
    if (state.queue.length === 0 && state.seen.length === 0) return state;
    return { ...emptyVisitState(), dropped: state.dropped + state.queue.length };
  }
  if (!consented) return { ...emptyVisitState(), dropped: state.dropped + state.queue.length };
  const body = asRecord(message);
  const type = body?.type;
  let event: ShadowEvent | null = null;
  if (type === 'si-shadow-visit' && typeof body?.eventId === 'string') {
    event = makeVisit(sender, body.eventId, now);
  } else if (
    type === 'si-shadow-paste-volume' &&
    typeof body?.eventId === 'string' &&
    typeof body.byteSize === 'number'
  ) {
    event = makePasteVolume(sender, body.eventId, body.byteSize, now);
  } else if (type === 'si-shadow-dlp' && body) {
    event = makeDlpEvent(
      sender,
      {
        eventId: String(body.eventId ?? ''),
        pasteEventId: String(body.pasteEventId ?? ''),
        detectionType: body.detectionType as DlpEvent['detectionType'],
        reason: String(body.reason ?? ''),
        action: body.action as DlpEvent['action'],
        findingCount: typeof body.findingCount === 'number' ? body.findingCount : 0,
      },
      now,
    );
  }
  if (!event) return state;
  return enqueueEvent(state, event, now, seat);
}

type OwnedState = VisitState & { owner: string | null };
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}

async function load(): Promise<OwnedState> {
  const stored = (await browser.storage.local.get(SHADOW_STATE_KEY))[SHADOW_STATE_KEY] as
    | Partial<OwnedState>
    | undefined;
  const empty = emptyVisitState();
  return stored
    ? {
        ...empty,
        queue: Array.isArray(stored.queue) ? stored.queue : [],
        seen: Array.isArray(stored.seen) ? stored.seen : [],
        dropped: typeof stored.dropped === 'number' ? stored.dropped : 0,
        lastSync: stored.lastSync ?? null,
        error: stored.error ?? null,
        owner: typeof stored.owner === 'string' ? stored.owner : null,
      }
    : { ...empty, owner: null };
}

const save = (state: OwnedState) => browser.storage.local.set({ [SHADOW_STATE_KEY]: state });

async function seat(): Promise<DiscoverySeat & { owner: string | null }> {
  const stored = await entitlementItem.getValue();
  const ent = await evaluateStored(stored, Math.floor(Date.now() / 1000));
  let user: unknown;
  try {
    user = JSON.parse(stored?.payload ?? JSON.stringify(stored?.blob ?? null))?.clerkUserId;
  } catch {}
  return {
    plan: ent.plan,
    orgId: ent.org?.id ?? null,
    owner: typeof user === 'string' && ent.org ? JSON.stringify([user, ent.org.id]) : null,
  };
}

/** Queue one observation. The pasted text is never part of the message. */
export function recordShadow(message: unknown, sender: Sender): Promise<void> {
  const atArrival = seat();
  return serial(async () => {
    const [current, who, arrived, consented] = await Promise.all([
      load(),
      seat(),
      atArrival,
      isConsentAccepted(),
    ]);
    const same = current.owner !== null && current.owner === who.owner;
    const base = same
      ? current
      : { ...emptyVisitState(), dropped: current.dropped + current.queue.length };
    const next = reduceShadowMessage(
      base,
      who,
      consented,
      sender,
      arrived.owner === who.owner ? message : null,
      Date.now(),
    );
    await save({ ...next, owner: consented && canDiscover(who) ? who.owner : null });
  });
}

/** Send the oldest batch. A failure leaves the events queued for the next alarm. */
async function flush(): Promise<void> {
  const who = await seat();
  let state = await load();
  if (
    !canDiscover(who) ||
    !who.owner ||
    state.owner !== who.owner ||
    !(await isConsentAccepted())
  ) {
    await save({ ...emptyVisitState(), owner: null, dropped: state.dropped + state.queue.length });
    return;
  }
  const now = Date.now();
  const queue = state.queue.filter((event) => event.timestamp >= now - VISIT_TTL);
  state = { ...state, queue, dropped: state.dropped + (state.queue.length - queue.length) };
  await save(state);
  if (!queue.length) return;
  const token = await getClerkToken();
  if (!token) {
    await save({ ...state, error: 'Signed out; Shadow AI metadata stays queued.' });
    return;
  }
  // A freshly minted credential must identify the queue's original owner.
  // Never replay observations using another account or organisation's token.
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(part));
    const org = claims.org_id ?? claims.o?.id;
    if (typeof claims.sub !== 'string' || typeof org !== 'string') {
      await save({ ...state, error: 'Shadow upload requires an organisation-bound session.' });
      return;
    }
    if (
      JSON.stringify([claims.sub, org]) !== who.owner ||
      !(await isConsentAccepted()) ||
      (await seat()).owner !== who.owner
    ) {
      await save({ ...emptyVisitState(), owner: null, dropped: state.dropped + queue.length });
      return;
    }
  } catch {
    await save({ ...state, error: 'Shadow upload requires an organisation-bound session.' });
    return;
  }
  const batch = queue.slice(0, 25);
  try {
    const ids = await sendShadowEvents(token, batch);
    await save({
      ...state,
      queue: queue.filter((event) => !ids.includes(event.eventId)),
      lastSync: Date.now(),
      error: null,
    });
  } catch (error) {
    if (error instanceof ShadowApiError && error.status === 400) {
      await save({
        ...state,
        queue: queue.slice(batch.length),
        dropped: state.dropped + batch.length,
        error: 'Rejected Shadow AI batch discarded.',
      });
      return;
    }
    await save({ ...state, error: 'Shadow AI report queued for retry.' });
  }
}

let flushing: Promise<void> | undefined;
export function flushShadow(): Promise<void> {
  if (!flushing)
    flushing = serial(flush).finally(() => {
      flushing = undefined;
    });
  return flushing;
}

export function installShadowBackground(): void {
  browser.alarms.create(SHADOW_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SHADOW_ALARM) return;
    void flushShadow().catch(() => {});
  });
}
