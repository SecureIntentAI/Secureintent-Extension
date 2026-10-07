import type { Fingerprint } from '@/lib/fingerprint';
import type { SecretType } from '../detection';

// `sanitised`: a large (Ghost) paste had every finding replaced before inserting.
// `blocked`: team policy refused the paste, whatever the person chose.
export type TelemetryAction =
  | 'paste_anonymously'
  | 'paste_anyway'
  | 'cancelled'
  | 'sanitised'
  | 'blocked';

export interface TelemetryDetection {
  fingerprint: Fingerprint;
  type: SecretType;
  label: string;
}

export interface TelemetryEvent {
  eventId: string;
  site: string;
  policyVersion: number;
  detections: TelemetryDetection[];
  action: TelemetryAction;
  // Which browser this extension build runs in (chrome | firefox | edge | opera).
  browser: string;
  // User context — for segmenting telemetry by tier / business. No PII: only the
  // plan, how it was granted, whether signed in, and (business tier) the domain.
  plan: string;
  source: string;
  signedIn: boolean;
  businessDomain: string | null;
  // Team context. `orgId` groups a company's events for their own dashboard;
  // `actorId` is a per-team pseudonym (SHA-256 of the Clerk user id + org id),
  // so a team can be told how many distinct people are involved without us
  // sending anyone's identity. Both null outside a team.
  orgId?: string | null;
  actorId?: string | null;
}
