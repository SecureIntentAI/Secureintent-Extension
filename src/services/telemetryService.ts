import { browser } from '#imports';
import type { TelemetryAction, TelemetryDetection, TelemetryEvent } from '@/lib/telemetry/types';

export function buildEvent(input: {
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
}): TelemetryEvent {
  // Build-time browser flag from WXT (chrome | firefox | edge | opera | safari).
  return { eventId: crypto.randomUUID(), browser: import.meta.env.BROWSER, ...input };
}

export function sendTelemetry(event: TelemetryEvent): void {
  // The background owns all delivery, including Free telemetry. It takes the
  // destination hostname from the browser sender and retains failed sends for
  // retry; content scripts never hold an account credential.
  void browser.runtime.sendMessage({ type: 'si-telemetry', event }).catch(() => {});
}
