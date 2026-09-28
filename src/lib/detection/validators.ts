// Post-match validators confirm a regex candidate, so broad regexes don't
// produce false positives.

export type ValidatorName = 'card' | 'credential' | 'entropy';

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

const VALIDATORS: Record<ValidatorName, (raw: string) => boolean> = {
  card,
  credential,
  entropy,
};

// Unknown names pass through (fail open, never block a paste).
export function validateMatch(name: string | undefined, raw: string): boolean {
  if (!name) return true;
  const fn = VALIDATORS[name as ValidatorName];
  return fn ? fn(raw) : true;
}

export { card, entropy, luhn, shannon };
