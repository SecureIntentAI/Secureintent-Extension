import { browser } from '#imports';
import type { TelemetryAction, TelemetryDetection, TelemetryEvent } from '@/lib/telemetry/types';

/** Local message envelope only; never part of the telemetry HTTP body. */
export interface TelemetryOwner {
  userId: string;
  orgId: string | null;
}
const owners = new WeakMap<TelemetryEvent, TelemetryOwner | null>();

export function buildEvent(
  input: {
    site: string;
    policyVersion: number;
    detections: TelemetryDetection[];
    action: TelemetryAction;
    plan: string;
    source: string;
    signedIn: boolean;
    businessDomain: string | null;
    orgId?: string | null;
    actorId?: string | null;
  },
  owner: TelemetryOwner | null = null,
): TelemetryEvent {
  // Build-time browser flag from WXT (chrome | firefox | edge | opera | safari).
  const event = { eventId: crypto.randomUUID(), browser: import.meta.env.BROWSER, ...input };
  owners.set(event, owner ? { ...owner } : null);
  return event;
}

export function sendTelemetry(event: TelemetryEvent): void {
  const owner = owners.get(event) ?? null;
  // Missing attribution must never bind an old event to whoever signs in next.
  if ((event.signedIn || event.orgId) && !owner) return;
  void browser.runtime.sendMessage({ type: 'si-telemetry', event, owner }).catch(() => {});
}
