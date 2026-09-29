// Post-match validators confirm a regex candidate, so broad regexes don't
// produce false positives.

export type ValidatorName =
  | 'card'
  | 'credential'
  | 'entropy'
  | 'github-checksum'
  | 'jwt-structure'
  | 'npm-checksum';

const PLACEHOLDER_VALUE =
  /^(?:changeme|replace[_ -]?me|your[_ -]?(?:api[_ -]?)?(?:key|token|secret)|example|sample|placeholder|dummy|test|none|null|undefined|redacted|<[^>]+>|\*+)$/i;

export function isPlaceholderCredentialValue(raw: string): boolean {
  let value = raw.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1).trim();
  }
  return PLACEHOLDER_VALUE.test(value);
}

function credential(raw: string): boolean {
  const separator = raw.search(/[=:]/);
  if (separator < 0) return true;
  return !isPlaceholderCredentialValue(raw.slice(separator + 1));
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48; // '0' = 48
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Network IIN prefix + length + Luhn keeps timestamps and order IDs from matching.
function card(raw: string): boolean {
  const d = raw.replace(/[^0-9]/g, '');
  if (d.length < 13 || d.length > 19) return false;
  if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(d)) return false;
  return luhn(d);
}

function shannon(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// Bits-per-char threshold flags hashes / random secrets but skips repetitive runs.
function entropy(raw: string): boolean {
  return shannon(raw) >= 3;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** GitHub and npm's newer opaque token formats carry CRC32 in their final 6 chars. */
export function githubTokenChecksum(payload: string): string {
  let crc = 0xffffffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i);
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  let encoded = '';
  do {
    encoded = BASE62[crc % 62] + encoded;
    crc = Math.floor(crc / 62);
  } while (crc > 0);
  return encoded.padStart(6, '0');
}

function checkSuffixedChecksum(raw: string, prefix: string): boolean {
  if (!raw.startsWith(prefix)) return false;
  const body = raw.slice(prefix.length);
  // Only the documented 30-character payload + six-character checksum format
  // is verified. Keep matching other lengths for legacy and future formats.
  if (body.length !== 36) return true;
  return githubTokenChecksum(body.slice(0, 30)) === body.slice(30);
}

function githubChecksum(raw: string): boolean {
  const prefix = /^(?:ghp_|gho_|ghu_|ghr_|ghs_)/.exec(raw)?.[0];
  if (!prefix) return false;
  // GitHub's newer stateless ghs_APPID_JWT format is opaque to this detector;
  // it has its own shape rule and must never be run through the CRC32 check.
  if (prefix === 'ghs_' && raw.slice(prefix.length).includes('.')) return true;
  return checkSuffixedChecksum(raw, prefix);
}

function npmChecksum(raw: string): boolean {
  return checkSuffixedChecksum(raw, 'npm_');
}

function decodeBase64Url(segment: string): Uint8Array | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) return null;
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== segment)
      return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeBase64UrlJsonObject(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jwtStructure(raw: string): boolean {
  // Avoid spending unbounded time decoding arbitrary copied text. Keep the
  // shape match as a candidate above this limit rather than dropping a possible
  // credential solely because its claims are unusually large.
  if (raw.length > 65_536) return true;
  const parts = raw.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]*$/.test(parts[2])) return false;
  const header = decodeBase64UrlJsonObject(parts[0]);
  const claims = decodeBase64UrlJsonObject(parts[1]);
  if (!header || !claims || typeof header.alg !== 'string' || header.alg.length === 0) return false;
  // RFC 7515 permits the unsecured "none" algorithm only with an empty
  // signature. Other compact JWS forms require a non-empty signature segment;
  // this checks serialization shape, not cryptographic validity.
  return header.alg.toLowerCase() === 'none'
    ? parts[2] === ''
    : parts[2].length > 0 && decodeBase64Url(parts[2]) !== null;
}

const VALIDATORS: Record<ValidatorName, (raw: string) => boolean> = {
  card,
  credential,
  entropy,
  'github-checksum': githubChecksum,
  'jwt-structure': jwtStructure,
  'npm-checksum': npmChecksum,
};

// Unknown names pass through (fail open, never block a paste).
export function validateMatch(name: string | undefined, raw: string): boolean {
  if (!name) return true;
  const fn = VALIDATORS[name as ValidatorName];
  return fn ? fn(raw) : true;
}

export { card, entropy, luhn, shannon };
