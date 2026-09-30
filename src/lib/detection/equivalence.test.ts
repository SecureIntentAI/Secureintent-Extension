// Behaviour pins for transformations, plus coverage invariants for detection.
// Overlap resolution intentionally differs from the historical implementation:
// sensitive coverage may never be discarded in favour of a more specific label.
import { describe, expect, it } from 'vitest';
import { GHOST_EXTRA_PATTERNS } from './ghost';
import { detectSecrets } from './index';
import { PATTERNS } from './patterns';
import { sanitize } from './sanitize';
import { tokenizeSecrets } from './tokenize';
import type { Detection } from './types';

// ---- original implementations (pre-refactor), kept verbatim as the oracle ----

function categoryForOld(label: string): string {
  if (label === 'IP address' || label === 'Internal IP') return 'ip';
  if (label === 'Email address') return 'email';
  return 'secret';
}

function sanitizeOld(text: string, detections: Detection[]): string {
  if (detections.length === 0) return text;
  const counters: Record<string, number> = {};
  const tokenByValue = new Map<string, string>();
  for (const d of [...detections].sort((a, b) => a.start - b.start)) {
    if (tokenByValue.has(d.match)) continue;
    const cat = categoryForOld(d.label);
    counters[cat] = (counters[cat] ?? 0) + 1;
    tokenByValue.set(d.match, `[#${cat.toUpperCase()}_${counters[cat]}#]`);
  }
  let out = text;
  for (const d of [...detections].sort((a, b) => b.start - a.start)) {
    const token = tokenByValue.get(d.match) as string;
    out = out.slice(0, d.start) + token + out.slice(d.end);
  }
  return out;
}

/** Original: splice right-to-left, one token per detection. */
function tokenizeOldShape(
  text: string,
  detections: Detection[],
): { text: string; secrets: string[] } {
  const ordered = [...detections].sort((a, b) => b.start - a.start);
  const secrets: string[] = [];
  let out = text;
  let n = 0;
  for (const d of ordered) {
    const token = `<<${n++}>>`; // deterministic stand-in for the random token id
    out = out.slice(0, d.start) + token + out.slice(d.end);
    secrets.push(d.match);
  }
  return { text: out, secrets };
}

// ---- deterministic pseudo-random corpus (no dependency on Math.random) ----

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Text with repeated IPs/emails/keys so value-dedup and ordering both matter. */
function corpus(seed: number, lines: number): string {
  const rng = makeRng(seed);
  const ips = ['10.0.0.1', '192.168.1.77', '172.16.4.9'];
  const mails = ['a@acme.io', 'ops@acme.io'];
  const keys = ['AKIAIOSFODNN7EXAMPLE', 'ghp_' + 'a'.repeat(36)];
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const parts = ['line' + i];
    if (rng() < 0.7) parts.push(ips[Math.floor(rng() * ips.length)]);
    if (rng() < 0.5) parts.push(mails[Math.floor(rng() * mails.length)]);
    if (rng() < 0.2) parts.push(keys[Math.floor(rng() * keys.length)]);
    out.push(parts.join(' '));
  }
  return out.join('\n');
}

const ghostPatterns = [
  ...PATTERNS.filter((p) => p.validate !== 'entropy'),
  ...GHOST_EXTRA_PATTERNS,
];

describe('sanitize matches the original implementation', () => {
  for (const seed of [1, 7, 42, 99]) {
    it(`identical output on corpus seed ${seed}`, () => {
      const text = corpus(seed, 200);
      const dets = detectSecrets(text, ghostPatterns);
      expect(dets.length).toBeGreaterThan(0);
      expect(sanitize(text, dets)).toBe(sanitizeOld(text, dets));
    });
  }

  it('identical output when detections are empty', () => {
    expect(sanitize('nothing here', [])).toBe(sanitizeOld('nothing here', []));
  });

  it('numbers repeated values with the same placeholder as before', () => {
    const text = 'a 10.0.0.1 b 10.0.0.1 c 192.168.1.1 d';
    const dets = detectSecrets(text, ghostPatterns);
    expect(sanitize(text, dets)).toBe(sanitizeOld(text, dets));
  });
});

describe('tokenizeSecrets matches the original implementation', () => {
  for (const seed of [3, 11, 64]) {
    it(`identical structure on corpus seed ${seed}`, () => {
      const text = corpus(seed, 200);
      const dets = detectSecrets(text, ghostPatterns);
      const oracle = tokenizeOldShape(text, dets);
      const actual = tokenizeSecrets(text, dets);

      // Same secrets, in the same order (descending by start offset).
      expect(actual.entries.map((e) => e.secret)).toEqual(oracle.secrets);

      // Same masked text once the random token ids are normalised away. The
      // oracle numbers its stand-ins in splice order (right-to-left), so map
      // each real token to the oracle's stand-in for the same entry.
      let normalised = actual.text;
      actual.entries.forEach((e, i) => {
        normalised = normalised.split(e.token).join(`<<${i}>>`);
      });
      expect(normalised).toBe(oracle.text);
    });
  }

  it('leaves text untouched when there are no detections', () => {
    expect(tokenizeSecrets('plain', [])).toEqual({ text: 'plain', entries: [] });
  });

  it('every token is unique', () => {
    const text = corpus(5, 300);
    const dets = detectSecrets(text, ghostPatterns);
    const { entries } = tokenizeSecrets(text, dets);
    expect(new Set(entries.map((e) => e.token)).size).toBe(entries.length);
  });
});

describe('overlap resolution preserves the union of independently detected ranges', () => {
  const cases: Array<[string, string, typeof PATTERNS]> = [
    ['log corpus', corpus(21, 300), ghostPatterns],
    [
      'entropy overlaps (aggressive)',
      'token=deadbeefdeadbeefdeadbeefdeadbeef1234 sk-ant-' +
        'x'.repeat(30) +
        ' AKIAIOSFODNN7EXAMPLE',
      PATTERNS,
    ],
    [
      'connection strings and credential assignments overlap',
      'DATABASE_URL=postgres://user:hunter2@db.internal:5432/app password=hunter2secret',
      PATTERNS,
    ],
    [
      'PEM block containing base64 runs',
      '-----BEGIN RSA PRIVATE KEY-----\n' +
        'MIIEpAIBAAKCAQEA'.repeat(20) +
        '\n-----END RSA PRIVATE KEY-----',
      PATTERNS,
    ],
  ];

  for (const [name, text, patterns] of cases) {
    it(`complete sensitive coverage: ${name}`, () => {
      const independent = patterns.flatMap((pattern) => detectSecrets(text, [pattern]));
      const actual = detectSecrets(text, patterns);
      const coverage = (detections: Detection[]) => {
        const offsets = new Set<number>();
        for (const d of detections) {
          expect(d.match).toBe(text.slice(d.start, d.end));
          for (let i = d.start; i < d.end; i++) offsets.add(i);
        }
        return offsets;
      };
      expect(coverage(actual)).toEqual(coverage(independent));
      // Kept detections never overlap each other.
      for (let i = 1; i < actual.length; i++) {
        expect(actual[i].start).toBeGreaterThanOrEqual(actual[i - 1].end);
      }
    });
  }
});
