import type { Pattern } from './patterns';

/**
 * Supplemental personal-data rules used by both regular and Ghost paste scans.
 * Ghost still has a separate large-paste presentation threshold; it no longer
 * controls whether these email and IP detectors run.
 */
export const GHOST_EXTRA_PATTERNS: Pattern[] = [
  {
    type: 'pii',
    label: 'IP address',
    supplemental: true,
    // Any valid IPv4 (each octet 0–255), public or private. Boundaries use
    // digit/dot lookarounds rather than \b, so IPs glued to following text in
    // flattened logs (e.g. "10.0.0.1Installed", "10.20.2.231VDOM") are caught.
    regex:
      /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
  },
  {
    type: 'pii',
    label: 'IPv6 address',
    supplemental: true,
    // Broad candidate extraction followed by the strict `ipv6` validator.
    // The end assertion backs off sentence-final dots without including them
    // in the redacted span. Colons and dots allow compressed and mapped forms.
    regex:
      /(?<![A-Za-z0-9])[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[A-Za-z0-9_.-]+)?(?<!\.)(?![A-Za-z0-9])/g,
    validate: 'ipv6',
  },
  {
    type: 'pii',
    label: 'Email address',
    supplemental: true,
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

/** Pastes at least this many characters take the Ghost (aggressive) path. */
export const GHOST_MIN_CHARS = 2000;
