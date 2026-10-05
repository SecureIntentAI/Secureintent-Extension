import { yieldToBrowser } from '../async';
import type { Pattern } from './patterns';
import { PATTERNS, TYPE_RANK } from './patterns';
import { detectStructuredCredentials, detectUnknownTokens } from './structured';
import type { Detection, SecretType } from './types';
import { hasFingerprintContext, validateMatch } from './validators';

export { compilePatterns, type RawPattern } from './compile';
export { GHOST_EXTRA_PATTERNS, GHOST_MIN_CHARS } from './ghost';
export { locateInText, type SecretLocation } from './locate';
export { redact } from './redact';
export { rehydrateTokens } from './rehydrate';
export { type GhostSummary, sanitize, summarize } from './sanitize';
export { TOKEN_RE, type TokenizeResult, tokenizeSecrets, type VaultEntry } from './tokenize';
export type { Detection, PatternOrigin, SecretType } from './types';

/**
 * True when the match sits inside a URL — its surrounding whitespace-delimited
 * token carries a scheme (`https://…`) or a `domain.tld/path`. High-entropy path
 * segments (Loom share ids, Google Drive file ids, …) are links, not secrets, so
 * entropy hits there are skipped to cut false positives. Specific key patterns
 * (gh*_, AIza…) are unaffected — a real key in a URL is still flagged.
 */
function inUrl(text: string, start: number, end: number): boolean {
  let l = start;
  while (l > 0 && !/\s/.test(text[l - 1])) l--;
  let r = end;
  while (r < text.length && !/\s/.test(text[r])) r++;
  const token = text.slice(l, r);
  return token.includes('://') || /[a-z0-9.-]+\.[a-z]{2,}\/\S/i.test(token);
}

/**
 * Scan text for secrets using the pattern catalog. Pure: no DOM, no async.
 * Overlapping matches are resolved by specificity (private-key > known-key >
 * env-credential, then longer match wins). Returns detections sorted by start.
 */
function* scanSecrets(
  text: string,
  patterns: Pattern[],
  maxFindings = Infinity,
): Generator<void, Detection[]> {
  const raw: Detection[] = [];
  let rejectedStructuredCandidates: Uint8Array | undefined;
  let steps = 0;

  for (const pattern of patterns) {
    // A team rule may specify 'i' without 'g'. exec() would otherwise return
    // the same match forever, freezing every paste that matches that rule.
    const flags = pattern.regex.flags;
    const regex = new RegExp(pattern.regex.source, flags.includes('g') ? flags : `${flags}g`);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (++steps % 256 === 0) yield;
      if (m[0].length === 0) {
        // Advance a full code point for Unicode rules; advancing into a
        // surrogate pair lets exec() rewind and repeat the same empty match.
        const unicode = flags.includes('u') || flags.includes('v');
        regex.lastIndex += unicode && (text.codePointAt(regex.lastIndex) ?? 0) > 0xffff ? 2 : 1;
        continue;
      }
      if (!validateMatch(pattern.validate, m[0])) {
        // A checksum/serialization failure is strong evidence that this is a
        // lookalike for a recognized provider format. Prevent the aggressive
        // entropy fallback from immediately re-flagging the same rejected text.
        if (
          pattern.validate === 'github-checksum' ||
          pattern.validate === 'npm-checksum' ||
          pattern.validate === 'iban' ||
          pattern.validate === 'jwt-structure'
        ) {
          rejectedStructuredCandidates ??= new Uint8Array(text.length);
          rejectedStructuredCandidates.fill(1, m.index, m.index + m[0].length);
        }
        continue;
      }
      // Generic entropy hits inside a URL are link ids (Loom/Drive/…), not secrets.
      if (pattern.validate === 'entropy' && inUrl(text, m.index, m.index + m[0].length)) {
        continue;
      }
      const entropyCandidateRule =
        pattern.validate === 'entropy' ||
        pattern.type === 'high-entropy' ||
        /^high-entropy\b/i.test(pattern.label);
      if (entropyCandidateRule && hasFingerprintContext(text, m.index)) {
        continue;
      }
      if (pattern.validate === 'entropy' && rejectedStructuredCandidates) {
        let fullyRejected = true;
        for (let i = m.index; i < m.index + m[0].length; i++) {
          if (!rejectedStructuredCandidates[i]) {
            fullyRejected = false;
            break;
          }
        }
        if (fullyRejected) continue;
      }
      const det: Detection = {
        type: pattern.type,
        label: pattern.label,
        match: m[0],
        start: m.index,
        end: m.index + m[0].length,
      };
      // Carried so the UI can say which findings came from the team's own
      // rules. Attached only when the pattern had it, so a detection from the
      // default catalogue is the same object it has always been.
      if (pattern.origin !== undefined) det.origin = pattern.origin;
      if (raw.length >= maxFindings) throw new RangeError('Too many findings to process safely');
      raw.push(det);
    }
    yield;
  }

  // A team may explicitly replace the built-in catalogue. Respect that choice;
  // otherwise supplement known formats with value-aware JSON/.env detection.
  if (patterns.some((pattern) => pattern.origin !== 'team' && !pattern.supplemental)) {
    raw.push(...detectStructuredCredentials(text, maxFindings - raw.length));
    if (patterns.some((pattern) => pattern.validate === 'entropy')) {
      raw.push(
        ...detectUnknownTokens(text, maxFindings - raw.length, rejectedStructuredCandidates),
      );
    }
  }

  // Personal data inside a credential belongs to that credential: the host IP
  // or user@host of postgres://user:pass@10.0.0.5/db must not outrank the
  // connection string, or masking would cover the host and leave the password.
  const CREDENTIAL: ReadonlySet<string> = new Set(['private-key', 'known-key', 'env-credential']);
  const credentials = raw.filter((d) => CREDENTIAL.has(d.type));
  if (credentials.length) {
    for (let i = raw.length - 1; i >= 0; i--) {
      const d = raw[i];
      if (d.type !== 'pii') continue;
      if (credentials.some((c) => c.start <= d.start && d.end <= c.end)) raw.splice(i, 1);
      if (++steps % 256 === 0) yield;
    }
  }

  // Resolve overlaps: prefer higher rank, then longer match.
  //
  // A type this build doesn't know ranks lowest rather than producing NaN. The
  // bundle validator accepts unfamiliar types so a new one never invalidates a
  // whole bundle, which only works if the ranking survives seeing one.
  const rankOf = (d: Detection) =>
    // Prefer value-only structured findings over the older assignment regex,
    // which includes the field name and separator in the redacted span.
    d.label === 'Structured credential' ? 1.1 : (TYPE_RANK[d.type as SecretType] ?? 0);
  raw.sort((a, b) => {
    const rank = rankOf(b) - rankOf(a);
    if (rank !== 0) return rank;
    // The catalogue's JSON rule spans the field name as well as its value.
    // A structured finding with the same label isolates just the value.
    if (a.label === 'JSON credential' && b.label === a.label) {
      return a.end - a.start - (b.end - b.start);
    }
    return b.end - b.start - (a.end - a.start);
  });

  // Greedy in that priority order, but the "does this overlap anything kept so
  // far?" test is a claimed-offsets bitmap rather than a scan of everything kept.
  // The old `kept.some(overlaps)` was quadratic: on a 2MB log producing 40k
  // findings it accounted for 1447ms of a 1481ms detection pass, blocking the
  // paste handler and freezing the tab before the warning could even render.
  const claimed = new Uint8Array(text.length);
  const kept: Detection[] = [];
  for (const det of raw) {
    if (++steps % 256 === 0) yield;
    let free = true;
    for (let i = det.start; i < det.end; i++) {
      if (claimed[i]) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    for (let i = det.start; i < det.end; i++) claimed[i] = 1;
    kept.push(det);
  }

  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Baked-in detectors always run. A signed bundle can add rules (team patterns
 * and newly shipped names) but cannot drop a key format this build already
 * knows. A bundle that is only team rules replaces the catalogue on purpose.
 */
export function mergeCatalog(remote: Pattern[]): Pattern[] {
  if (remote.length > 0 && remote.every((pattern) => pattern.origin === 'team')) return remote;
  const known = new Set(PATTERNS.map((pattern) => pattern.label));
  const extra = remote.filter((pattern) => pattern.origin === 'team' || !known.has(pattern.label));
  return [...PATTERNS, ...extra];
}

/** Synchronous small-paste API; shares matching/ordering with the cooperative scan. */
export function detectSecrets(
  text: string,
  patterns: Pattern[] = PATTERNS,
  maxFindings = Infinity,
): Detection[] {
  const scan = scanSecrets(text, patterns, maxFindings);
  let result = scan.next();
  while (!result.done) result = scan.next();
  return result.value;
}

/** Scan whole-text rules without splitting matches at arbitrary chunk boundaries. */
export async function detectSecretsAsync(
  text: string,
  patterns: Pattern[],
  signal: AbortSignal,
): Promise<Detection[]> {
  let sliceStart = performance.now();
  const scan = scanSecrets(text, patterns);
  for (;;) {
    signal.throwIfAborted();
    const result = scan.next();
    if (result.done) return result.value;
    if (performance.now() - sliceStart >= 8) {
      await yieldToBrowser(signal);
      sliceStart = performance.now();
    }
  }
}
