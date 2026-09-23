import type { SecretLocation } from '../detection/locate';
import type { Pattern } from '../detection/patterns';
import type { GhostSummary } from '../detection/sanitize';
import type { TokenizeResult } from '../detection/tokenize';
import type { Detection, SecretType } from '../detection/types';

export const PASTE_PORT = 'si-paste-worker';
export const PASTE_READY = 'si-paste-worker-ready';
export const MAX_PASTE_CHARS = 2_000_000;
export const MAX_PREVIEW_FINDINGS = 100;
export const WORK_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 120_000;
export const MAX_PASTE_WORKERS = 4;
export const MAX_PASTE_SESSIONS = 1000;
export const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
export const QUEUE_TIMEOUT_MS = 30_000;
export const PASTE_REQUEST_TIMEOUT_MS = QUEUE_TIMEOUT_MS + WORK_TIMEOUT_MS + 5_000;

export type WirePattern = Omit<Pattern, 'regex'> & { source: string; flags: string };
export interface ScanResult {
  detections: Detection[];
  locations: SecretLocation[];
  total: number;
  summary?: GhostSummary;
  types: SecretType[];
  labels: string[];
  handledHash: string;
}
export interface PasteOperations {
  scan: {
    input: { text: string; patterns: WirePattern[]; summary: boolean };
    output: ScanResult;
  };
  sanitize: { input: null; output: string };
  tokenize: { input: null; output: TokenizeResult };
  rehydrate: { input: [string, string][]; output: { text: string; tokenCount: number } };
}
export type Operation = keyof PasteOperations;
export type PasteCommand = {
  [K in Operation]: { id: number; operation: K; input: PasteOperations[K]['input'] };
}[Operation];
export type PasteReply =
  | { id: number; ok: true; result: unknown }
  | {
      id: number;
      ok: false;
      error: string;
    };

export interface PasteProcessor {
  request<K extends Operation>(
    operation: K,
    input: PasteOperations[K]['input'],
  ): Promise<PasteOperations[K]['output']>;
}
