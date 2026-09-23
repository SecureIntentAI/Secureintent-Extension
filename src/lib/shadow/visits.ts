import { AI_CATALOG, normalizeHostname, recognizeAiPage } from './catalog';

export const QUEUE_LIMIT = 5000;
export const VISIT_TTL = 86_400_000;
export type VisitEvent = {
  schemaVersion: 1;
  eventId: string;
  type: 'ai_page_visit';
  timestamp: number;
  hostname: string;
  serviceId: string;
  catalogVersion: number;
};
export type PasteVolumeEvent = {
  schemaVersion: 1;
  eventId: string;
  type: 'ai_paste_volume';
  timestamp: number;
  hostname: string;
  serviceId: string;
  catalogVersion: number;
  byteSize: number;
};
export type DlpAction = 'blocked' | 'cancelled' | 'sanitised' | 'warning_bypassed';
export type DlpEvent = {
  schemaVersion: 1;
  eventId: string;
  pasteEventId: string;
  type: 'ai_sensitive_paste';
  timestamp: number;
  hostname: string;
  serviceId: string;
  catalogVersion: number;
  detectionType: 'known-key' | 'private-key' | 'env-credential' | 'pii' | 'high-entropy';
  reason: string;
  action: DlpAction;
  findingCount: number;
};
export type ShadowEvent = VisitEvent | PasteVolumeEvent | DlpEvent;
export type ShadowPolicy = {
  version: number;
  refreshAfterSeconds: number;
  services: {
    serviceId: string;
    classification: 'sanctioned' | 'recognized' | 'review';
    pasteBlocked: boolean;
  }[];
};
/** A real Clerk organisation seat. Discovery does not run for any other plan. */
export type DiscoverySeat = {
  plan: string;
  orgId: string | null;
};
export type VisitState = {
  queue: ShadowEvent[];
  seen: { eventId: string; timestamp: number }[];
  dropped: number;
  lastSync: number | null;
  error: string | null;
};
export const emptyVisitState = (): VisitState => ({
  queue: [],
  seen: [],
  dropped: 0,
  lastSync: null,
  error: null,
});

const ORG_ID = /^org_[A-Za-z0-9]{1,60}$/;

export function canDiscover(seat: DiscoverySeat | null): boolean {
  return !!seat && seat.plan === 'business_pro' && !!seat.orgId && ORG_ID.test(seat.orgId);
}

/** Browser-supplied URL is transient input; only a catalog hostname survives. */
export function makeVisit(
  sender: { url?: string; frameId?: number; incognito?: boolean },
  eventId: string,
  now: number,
): VisitEvent | null {
  if (
    sender.frameId !== 0 ||
    sender.incognito ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId)
  )
    return null;
  try {
    const url = new URL(sender.url ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const hostname = normalizeHostname(url.hostname);
    const service = hostname && recognizeAiPage(hostname, url.pathname);
    if (!hostname || !service) return null;
    return {
      schemaVersion: 1,
      eventId,
      type: 'ai_page_visit',
      timestamp: now,
      hostname,
      serviceId: service.id,
      catalogVersion: AI_CATALOG.version,
    };
  } catch {
    return null;
  }
}

function destination(sender: {
  url?: string;
  frameId?: number;
  incognito?: boolean;
}): { hostname: string; serviceId: string } | null {
  if (sender.frameId !== 0 || sender.incognito) return null;
  try {
    const url = new URL(sender.url ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const hostname = normalizeHostname(url.hostname);
    const service = hostname && recognizeAiPage(hostname, url.pathname);
    return hostname && service ? { hostname, serviceId: service.id } : null;
  } catch {
    return null;
  }
}

const validUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function makePasteVolume(
  sender: { url?: string; frameId?: number; incognito?: boolean },
  eventId: string,
  byteSize: number,
  now: number,
): PasteVolumeEvent | null {
  const target = destination(sender);
  if (
    !target ||
    !validUuid(eventId) ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    byteSize > 8_000_000
  )
    return null;
  return {
    schemaVersion: 1,
    eventId,
    type: 'ai_paste_volume',
    timestamp: now,
    ...target,
    catalogVersion: AI_CATALOG.version,
    byteSize,
  };
}

export function makeDlpEvent(
  sender: { url?: string; frameId?: number; incognito?: boolean },
  input: {
    eventId: string;
    pasteEventId: string;
    detectionType: DlpEvent['detectionType'];
    reason: string;
    action: DlpAction;
    findingCount: number;
  },
  now: number,
): DlpEvent | null {
  const target = destination(sender);
  if (
    !target ||
    !validUuid(input.eventId) ||
    !validUuid(input.pasteEventId) ||
    !['known-key', 'private-key', 'env-credential', 'pii', 'high-entropy'].includes(
      input.detectionType,
    ) ||
    typeof input.reason !== 'string' ||
    input.reason.length < 1 ||
    input.reason.length > 100 ||
    !['blocked', 'cancelled', 'sanitised', 'warning_bypassed'].includes(input.action) ||
    !Number.isSafeInteger(input.findingCount) ||
    input.findingCount < 1 ||
    input.findingCount > 100_000
  )
    return null;
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    pasteEventId: input.pasteEventId,
    type: 'ai_sensitive_paste',
    timestamp: now,
    ...target,
    catalogVersion: AI_CATALOG.version,
    detectionType: input.detectionType,
    reason: input.reason,
    action: input.action,
    findingCount: input.findingCount,
  };
}

export function enqueueEvent(
  state: VisitState,
  event: ShadowEvent,
  now: number,
  seat: DiscoverySeat | null,
): VisitState {
  // A seat that is not a Business organisation must not keep metadata that could
  // be uploaded later under a different account.
  if (!canDiscover(seat)) {
    if (state.queue.length === 0 && state.seen.length === 0) return state;
    return { ...emptyVisitState(), dropped: state.dropped + state.queue.length };
  }
  const queue = state.queue.filter((item) => item.timestamp >= now - VISIT_TTL);
  const seen = state.seen.filter((item) => item.timestamp >= now - VISIT_TTL);
  if (seen.some((item) => item.eventId === event.eventId)) return { ...state, queue, seen };
  const overflow = queue.length >= QUEUE_LIMIT ? 1 : 0;
  return {
    ...state,
    queue: [...queue.slice(overflow), event],
    seen: [...seen, { eventId: event.eventId, timestamp: event.timestamp }].slice(-2 * QUEUE_LIMIT),
    dropped: state.dropped + (state.queue.length - queue.length) + overflow,
  };
}

export const enqueueVisit = enqueueEvent;
