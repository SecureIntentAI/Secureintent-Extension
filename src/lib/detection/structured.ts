import type { Detection } from './types';
import { isPlaceholderCredentialValue, shannon } from './validators';

const KEY_NAME =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/i;
function secretField(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (
    /(?:^|[_-])(?:public[_-]?key|key[_-]?id|client[_-]?id|token[_-]?count|secret[_-]?name|password[_-]?hash)(?:$|[_-])/.test(
      normalized,
    )
  )
    return false;
  return KEY_NAME.test(normalized);
}

function likelyCredential(name: string, value: string): boolean {
  const candidate = value.trim();
  if (candidate.length < 8 || candidate.length > 8192 || isPlaceholderCredentialValue(candidate))
    return false;
  if (/^(?:https?:\/\/|[./]|\d+$)/i.test(candidate)) return false;
  if (new Set(candidate).size < 4) return false;
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (/(?:^|[_-])(?:password|passwd|private[_-]?key|client[_-]?secret)(?:$|[_-])/.test(normalized))
    return true;
  return candidate.length >= 16 && shannon(candidate) >= 3;
}

function quotedEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

/** Find string values attached to credential field names, preserving offsets for redaction. */
export function detectStructuredCredentials(text: string, maxFindings = Infinity): Detection[] {
  const findings: Detection[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"' && text[i] !== "'") continue;
    const keyEnd = quotedEnd(text, i);
    if (keyEnd < 0) break;
    const key = text.slice(i + 1, keyEnd);
    let cursor = keyEnd + 1;
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
    if (text[cursor] !== ':' || !secretField(key)) {
      i = keyEnd;
      continue;
    }
    cursor++;
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
    if (text[cursor] !== '"' && text[cursor] !== "'") {
      i = keyEnd;
      continue;
    }
    const valueEnd = quotedEnd(text, cursor);
    if (valueEnd < 0) break;
    const start = cursor + 1;
    const value = text.slice(start, valueEnd);
    if (likelyCredential(key, value)) {
      if (findings.length >= maxFindings)
        throw new RangeError('Too many findings to process safely');
      findings.push({
        type: 'env-credential',
        label: 'JSON credential',
        match: value,
        start,
        end: valueEnd,
      });
    }
    i = valueEnd;
  }

  // .env and similar assignments; process one line at a time so a value cannot
  // absorb the next field. The matched span contains only the value.
  for (let start = 0; start < text.length; ) {
    const end = text.indexOf('\n', start);
    const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(start, lineEnd);
    const separator = line.indexOf('=');
    if (separator > 0 && separator < 128) {
      const name = line
        .slice(0, separator)
        .trim()
        .replace(/^export\s+/, '');
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) && secretField(name)) {
        const rest = line.slice(separator + 1);
        const leading = rest.length - rest.trimStart().length;
        const first = separator + 1 + leading;
        const raw = line.slice(first).trimEnd();
        const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : '';
        const value = quote && raw.endsWith(quote) ? raw.slice(1, -1) : raw;
        const offset = start + first + (quote ? 1 : 0);
        if (likelyCredential(name, value)) {
          if (findings.length >= maxFindings)
            throw new RangeError('Too many findings to process safely');
          findings.push({
            type: 'env-credential',
            label: 'Structured credential',
            match: value,
            start: offset,
            end: offset + value.length,
          });
        }
      }
    }
    if (end < 0) break;
    start = end + 1;
  }
  return findings;
}

function tokenChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === '_' ||
    ch === '-' ||
    ch === '.'
  );
}

/** Conservative unknown-token candidate pass for unfamiliar dotted or dashed formats. */
export function detectUnknownTokens(text: string, maxFindings = Infinity): Detection[] {
  const findings: Detection[] = [];
  let lineStart = 0;
  for (let i = 0; i < text.length; ) {
    if (!tokenChar(text[i])) {
      if (text[i] === '\n') lineStart = i + 1;
      i++;
      continue;
    }
    const start = i;
    while (tokenChar(text[i])) i++;
    const value = text.slice(start, i);
    // Structured fields are handled with their field names above. Avoid
    // treating a public identifier as secret merely because it looks random.
    if (text[start - 1] === '"' || text[start - 1] === "'" || text[i] === '"' || text[i] === "'")
      continue;
    if (/^[\w-]+\s*=\s*$/.test(text.slice(Math.max(lineStart, start - 128), start))) continue;
    if (value.length < 32 || value.length > 512) continue;
    if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value)) continue;
    if (!/[._-]/.test(value) || shannon(value) < 4) continue;
    let left = start;
    while (left > Math.max(lineStart, start - 128) && !/\s/.test(text[left - 1])) left--;
    let right = i;
    while (right < text.length && right < i + 128 && !/\s/.test(text[right])) right++;
    const surrounding = text.slice(left, right);
    if (surrounding.includes('://') || /[a-z0-9.-]+\.[a-z]{2,}\/\S/i.test(surrounding)) continue;
    if (findings.length >= maxFindings) throw new RangeError('Too many findings to process safely');
    findings.push({
      type: 'high-entropy',
      label: 'Possible unknown token',
      match: value,
      start,
      end: i,
    });
  }
  return findings;
}
