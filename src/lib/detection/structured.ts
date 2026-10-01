import type { Detection } from './types';
import { hasFingerprintContext, isPlaceholderCredentialValue, shannon } from './validators';

const KEY_NAME =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/i;
function publicField(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[.\s:]+/g, '_').toLowerCase();
  return /(?:^|[_-])(?:public[_-]?key|key[_-]?id|client[_-]?id|token[_-]?count|secret[_-]?name|password[_-]?hash)(?:$|[_-])/.test(normalized);
}

function secretField(name: string): boolean {
  const normalized = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[.\s:]+/g, '_')
    .toLowerCase();
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
  const normalized = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[.\s:]+/g, '_')
    .toLowerCase();

  // Keep the decision explainable: field context, length, and randomness each
  // contribute evidence. Password/private-key fields have stronger context;
  // generic "token" or "secret" fields need a value that also looks generated.
  let confidence = /(?:^|[_-])(?:password|passwd|private[_-]?key|client[_-]?secret)(?:$|[_-])/.test(
    normalized,
  )
    ? 4
    : 2;
  if (candidate.length >= 16) confidence++;
  if (shannon(candidate) >= 3) confidence++;
  return confidence >= 4;
}

function pushCredential(
  findings: Detection[],
  maxFindings: number,
  text: string,
  name: string,
  start: number,
  end: number,
  label: string,
  strongContext = false,
): void {
  const value = text.slice(start, end);
  const accepted = strongContext
    ? value.length >= 12 && !/^(?:https?:\/\/|\d+$)/i.test(value) &&
      !isPlaceholderCredentialValue(value) && new Set(value).size >= 4
    : likelyCredential(name, value);
  if (!accepted) return;
  if (findings.length >= maxFindings) throw new RangeError('Too many findings to process safely');
  findings.push({ type: 'env-credential', label, match: value, start, end });
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

function stripYamlComment(value: string): string {
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (ch === "'" && quote === "'" && value[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(value[i - 1])) {
      return value.slice(0, i);
    }
  }
  return value;
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
    pushCredential(findings, maxFindings, text, key, start, valueEnd, 'JSON credential');
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
        pushCredential(
          findings,
          maxFindings,
          text,
          name,
          offset,
          offset + value.length,
          'Structured credential',
        );
      }
    }

    // YAML-style key/value fields. Only inspect field-shaped lines, and keep
    // the finding span on the scalar so anonymisation leaves the document valid.
    const yaml = /^\s*([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*:\s*(.*?)\s*$/.exec(line);
    const isAuthorizationHeader = /^\s*(?:proxy-)?authorization\s*:\s*(?:Bearer|Basic)\s+/i.test(
      line,
    );
    if (yaml && secretField(yaml[1]) && !isAuthorizationHeader) {
      const rawValue = stripYamlComment(yaml[2]).trimEnd();
      const leading = rawValue.length - rawValue.trimStart().length;
      const scalar = rawValue.trim();
      const quote = scalar[0] === '"' || scalar[0] === "'" ? scalar[0] : '';
      const value = quote && scalar.endsWith(quote) ? scalar.slice(1, -1) : scalar;
      const offset = start + line.indexOf(yaml[2]) + leading + (quote ? 1 : 0);
      pushCredential(
        findings,
        maxFindings,
        text,
        yaml[1],
        offset,
        offset + value.length,
        'Structured credential',
      );
    }

    // HTTP authorization headers carry explicit credential context. Match only
    // the credential portion after a recognized scheme, never the whole header.
    const authorization = /^\s*(?:proxy-)?authorization\s*:\s*(Bearer|Basic)\s+(\S+)\s*$/i.exec(
      line,
    );
    if (authorization) {
      const token = authorization[2].replace(/["',;]+$/, '');
      const tokenOffset = start + line.lastIndexOf(authorization[2]);
      pushCredential(
        findings,
        maxFindings,
        text,
        'authorization',
        tokenOffset,
        tokenOffset + token.length,
        'Structured credential',
        true,
      );
    }
    if (end < 0) break;
    start = end + 1;
  }

  // XML leaves field names adjacent to values rather than using key/value
  // separators. Restrict this pass to simple text elements with known secret
  // field names; attributes, nested markup, and arbitrary element names are out.
  const xmlField = /<([A-Za-z_][\w:.-]*)\b[^>]*>([^<]+)<\/\1\s*>/gi;
  for (let match = xmlField.exec(text); match; match = xmlField.exec(text)) {
    const value = match[2];
    const leading = value.length - value.trimStart().length;
    const trailing = value.trimEnd().length;
    if (trailing <= leading || !secretField(match[1])) continue;
    const start = match.index + match[0].indexOf(value) + leading;
    pushCredential(
      findings,
      maxFindings,
      text,
      match[1],
      start,
      match.index + match[0].indexOf(value) + trailing,
      'Structured credential',
    );
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
export function detectUnknownTokens(
  text: string,
  maxFindings = Infinity,
  rejectedStructuredCandidates?: Uint8Array,
): Detection[] {
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
    if (rejectedStructuredCandidates) {
      let fullyRejected = true;
      for (let offset = start; offset < i; offset++) {
        if (!rejectedStructuredCandidates[offset]) {
          fullyRejected = false;
          break;
        }
      }
      if (fullyRejected) continue;
    }
    if (hasFingerprintContext(text, start)) continue;
    // Structured fields are handled with their field names above. Avoid
    // treating a public identifier as secret merely because it looks random.
    if (text[start - 1] === '"' || text[start - 1] === "'" || text[i] === '"' || text[i] === "'")
      continue;
    const fieldPrefix = text.slice(Math.max(lineStart, start - 128), start);
    if (/^[\w-]+\s*=\s*$/.test(fieldPrefix)) continue;
    const yamlField = /^\s*([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*:\s*$/.exec(fieldPrefix);
    if (yamlField && publicField(yamlField[1])) continue;
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
