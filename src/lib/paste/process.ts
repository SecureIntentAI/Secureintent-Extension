import { contentDigest } from '../bridge/hash';
import { detectSecrets } from '../detection';
import { locateInText } from '../detection/locate';
import { rehydrateTokens } from '../detection/rehydrate';
import { sanitize, summarize } from '../detection/sanitize';
import { tokenizeSecrets } from '../detection/tokenize';
import type { Detection } from '../detection/types';
import {
  MAX_PASTE_CHARS,
  MAX_PREVIEW_FINDINGS,
  type PasteCommand,
  type ScanResult,
} from './protocol';

/** Runs ONLY in a dedicated, terminable worker in production. No storage/network. */
export function createPasteComputation() {
  let text: string | undefined;
  let detections: Detection[] = [];
  const bounded = (value: string) => {
    if (value.length > MAX_PASTE_CHARS) throw new RangeError('Paste output is too large');
    return value;
  };
  return (command: PasteCommand): unknown => {
    if (command.operation === 'scan') {
      if (text !== undefined) throw new Error('Paste has already been scanned');
      const input = command.input;
      if (
        typeof input.text !== 'string' ||
        !Array.isArray(input.patterns) ||
        input.patterns.length > 256
      ) {
        throw new Error('Invalid paste scan');
      }
      text = bounded(input.text);
      const patterns = input.patterns.map(({ source, flags, ...pattern }) => {
        if (typeof source !== 'string' || source.length > 8192 || typeof flags !== 'string') {
          throw new Error('Invalid detection rule');
        }
        return { ...pattern, regex: new RegExp(source, flags) };
      });
      detections = detectSecrets(text, patterns, 100_000);
      const preview = input.summary ? [] : detections.slice(0, MAX_PREVIEW_FINDINGS);
      const result: Omit<ScanResult, 'handledDigest'> = {
        // Keep all matches here for transformations, but bound page rendering and
        // JSON messaging. Large logs only need counts, never a 40k-row preview.
        detections: preview,
        locations: preview.map((d) => locateInText(text as string, d)),
        total: detections.length,
        summary: input.summary ? summarize(detections) : undefined,
        // Large logs show counts only, but team telemetry still needs findings
        // to fingerprint. Never rendered; bounded like the preview.
        sample:
          input.summary && input.sample === true
            ? detections.slice(0, MAX_PREVIEW_FINDINGS)
            : undefined,
        types: [...new Set(detections.map((d) => d.type))],
        labels: [...new Set(detections.map((d) => d.label))],
      };
      // The desktop bridge's dedup key, and the one async step: WebCrypto. The
      // text is already set above, so an operation that follows does not wait on
      // it. Computed here, in the worker, because a content script on a plain
      // http:// page has no crypto.subtle.
      return contentDigest(text).then((handledDigest) => ({ ...result, handledDigest }));
    }
    if (text === undefined) throw new Error('Paste has not been scanned');
    if (command.operation === 'sanitize') return bounded(sanitize(text, detections));
    if (command.operation === 'tokenize') {
      const result = tokenizeSecrets(text, detections);
      bounded(result.text);
      return result;
    }
    if (command.operation === 'rehydrate') {
      if (!Array.isArray(command.input) || command.input.length > 100_000) {
        throw new Error('Invalid restoration data');
      }
      return rehydrateTokens(text, new Map(command.input), MAX_PASTE_CHARS);
    }
    throw new Error('Unknown paste operation');
  };
}
