import { expect, test } from 'vitest';
import { contentHash } from '../bridge/hash';
import { detectSecrets, GHOST_EXTRA_PATTERNS } from '../detection';
import { PATTERNS } from '../detection/patterns';
import { sanitize } from '../detection/sanitize';
import type { TokenizeResult } from '../detection/tokenize';
import { createPasteComputation } from './process';
import { MAX_PASTE_CHARS, MAX_PREVIEW_FINDINGS, type ScanResult } from './protocol';

const patterns = [...PATTERNS, ...GHOST_EXTRA_PATTERNS].map(({ regex, ...pattern }) => ({
  ...pattern,
  source: regex.source,
  flags: regex.flags,
}));
const SECRET = `sk-${'a'.repeat(30)}`;

test('worker computation preserves complete scan, hash and sanitization results', () => {
  const text = `hello ${SECRET} 10.0.0.1`;
  const compute = createPasteComputation();
  const scan = compute({
    id: 1,
    operation: 'scan',
    input: { text, patterns, summary: false },
  }) as ScanResult;
  const expected = detectSecrets(text, [...PATTERNS, ...GHOST_EXTRA_PATTERNS]);
  expect(scan.detections).toEqual(expected);
  expect(scan.total).toBe(expected.length);
  expect(scan.handledHash).toBe(contentHash(text).toString());
  expect(compute({ id: 2, operation: 'sanitize', input: null })).toBe(sanitize(text, expected));
});

test('preview limits never limit the findings transformed', () => {
  const text = `${SECRET}\n`.repeat(MAX_PREVIEW_FINDINGS + 20);
  const compute = createPasteComputation();
  const scan = compute({
    id: 1,
    operation: 'scan',
    input: { text, patterns, summary: false },
  }) as ScanResult;
  expect(scan.total).toBe(MAX_PREVIEW_FINDINGS + 20);
  expect(scan.detections).toHaveLength(MAX_PREVIEW_FINDINGS);
  const tokenized = compute({ id: 2, operation: 'tokenize', input: null }) as TokenizeResult;
  expect(tokenized.text).not.toContain(SECRET);
  expect(tokenized.text.match(/⟦SI:/g)).toHaveLength(MAX_PREVIEW_FINDINGS + 20);
});

test('large log response stays compact while all findings are sanitized', () => {
  const text = `${SECRET}\n`.repeat(20_000);
  const compute = createPasteComputation();
  const scan = compute({
    id: 1,
    operation: 'scan',
    input: { text, patterns, summary: true, sample: true },
  }) as ScanResult;
  expect(scan.detections).toEqual([]);
  expect(scan.summary?.total).toBe(20_000);
  // Telemetry gets a bounded sample to fingerprint; nothing else grows with the paste.
  expect(scan.sample).toHaveLength(100);
  const { sample: _sample, ...rest } = scan;
  expect(JSON.stringify(rest).length).toBeLessThan(1000);
  expect(JSON.stringify(scan).length).toBeLessThan(20_000);
  expect(compute({ id: 2, operation: 'sanitize', input: null })).not.toContain(SECRET);
});

test('a summary scan without a sample request (file checks) returns no raw findings', () => {
  const scan = createPasteComputation()({
    id: 1,
    operation: 'scan',
    input: { text: `${SECRET}\n`.repeat(50), patterns, summary: true },
  }) as ScanResult;
  expect(scan.sample).toBeUndefined();
  expect(scan.detections).toEqual([]);
});

test('restoration operates on the original token text without cascading', () => {
  const compute = createPasteComputation();
  const token = '⟦SI:abcdef01⟧';
  compute({ id: 1, operation: 'scan', input: { text: token, patterns, summary: false } });
  expect(compute({ id: 2, operation: 'rehydrate', input: [[token, '$& ⟦SI:abcdef02⟧']] })).toEqual({
    text: '$& ⟦SI:abcdef02⟧',
    tokenCount: 1,
  });
});

test('rejects oversized input, output, and excessive findings without a partial result', () => {
  expect(() =>
    createPasteComputation()({
      id: 1,
      operation: 'scan',
      input: {
        text: 'x'.repeat(MAX_PASTE_CHARS + 1),
        patterns: [],
        summary: false,
      },
    }),
  ).toThrow();
  const compute = createPasteComputation();
  compute({
    id: 1,
    operation: 'scan',
    input: { text: '⟦SI:abcdef01⟧', patterns: [], summary: false },
  });
  expect(() =>
    compute({
      id: 2,
      operation: 'rehydrate',
      input: [['⟦SI:abcdef01⟧', 'x'.repeat(MAX_PASTE_CHARS + 1)]],
    }),
  ).toThrow();
  expect(() =>
    createPasteComputation()({
      id: 1,
      operation: 'scan',
      input: {
        text: 'x'.repeat(100_001),
        summary: true,
        patterns: [{ type: 'known-key', label: 'Every character', source: 'x', flags: 'g' }],
      },
    }),
  ).toThrow();
});

test('does not transform before scanning or allow a second scan in the same session', () => {
  const compute = createPasteComputation();
  expect(() => compute({ id: 1, operation: 'sanitize', input: null })).toThrow();
  const command = {
    id: 2,
    operation: 'scan' as const,
    input: { text: '', patterns, summary: false },
  };
  compute(command);
  expect(() => compute(command)).toThrow();
});
