import type { Pattern } from './patterns';
import { PATTERNS, TYPE_RANK } from './patterns';
import type { Detection, SecretType } from './types';
import { validateMatch } from './validators';

export { compilePatterns, type RawPattern } from './compile';
export { GHOST_EXTRA_PATTERNS, GHOST_MIN_CHARS } from './ghost';
export { locateInText, type SecretLocation } from './locate';
export { redact } from './redact';
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
 * Overlapping matches retain their complete combined range. Specificity chooses
 * the display label, never which sensitive characters may survive redaction.
 * Returns non-overlapping detections sorted by start.
 */
export function detectSecrets(text: string, patterns: Pattern[] = PATTERNS): Detection[] {
  const raw: Detection[] = [];

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++; // guard against zero-width loops
        continue;
      }
      if (validateMatch(pattern.validate, m[0])) {
        // Generic entropy hits inside a URL are link ids (Loom/Drive/…), not secrets.
        if (pattern.validate === 'entropy' && inUrl(text, m.index, m.index + m[0].length)) {
          continue;
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
        raw.push(det);
      }
    }
  }

  // Rank the original matches before merging: the group's expanded length must
  // not influence which original finding supplies its label/type/provenance.
  //
  // A type this build doesn't know ranks lowest rather than producing NaN. The
  // bundle validator accepts unfamiliar types so a new one never invalidates a
  // whole bundle, which only works if the ranking survives seeing one.
  const rankOf = (t: string) => TYPE_RANK[t as SecretType] ?? 0;
  raw.sort((a, b) => {
    const rank = rankOf(b.type) - rankOf(a.type);
    if (rank !== 0) return rank;
    return b.end - b.start - (a.end - a.start);
  });

  const priority = new Map(raw.map((d, i) => [d, i]));
  raw.sort((a, b) => a.start - b.start);

  // A broad credential assignment can cover a known key AND another password.
  // Discarding it just because the key ranks higher leaves that password exposed.
  // Merge the union of each overlapping group, including transitive overlaps.
  // Sorting + a single sweep stays O(n log n), including large log dumps.
  const kept: Detection[] = [];
  let group: { start: number; end: number; primary: Detection } | undefined;
  const flush = () => {
    if (!group) return;
    kept.push({
      ...group.primary,
      start: group.start,
      end: group.end,
      match: text.slice(group.start, group.end),
    });
  };
  for (const det of raw) {
    if (!group || det.start >= group.end) {
      flush();
      group = { start: det.start, end: det.end, primary: det };
    } else {
      group.end = Math.max(group.end, det.end);
      if ((priority.get(det) ?? 0) < (priority.get(group.primary) ?? 0)) group.primary = det;
    }
  }
  flush();
  return kept;
}
