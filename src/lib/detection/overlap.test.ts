import { describe, expect, test } from 'vitest';
import { DEFAULT_BUNDLE } from '../config/default';
import { compilePatterns, detectSecrets, sanitize, tokenizeSecrets } from './index';
import { PATTERNS, type Pattern } from './patterns';

describe('overlapping findings retain all sensitive coverage', () => {
  test.each([
    ['catalogue', PATTERNS],
    ['offline bundle', compilePatterns(DEFAULT_BUNDLE.patterns)],
  ] as const)('%s removes an adjacent password and preserves the full reversible region', (_, patterns) => {
    const key = `sk-${'a'.repeat(25)}`;
    const region = `API_KEY=${key};PASSWORD=second-secret`;
    const text = `before ${region} after`;
    const detections = detectSecrets(text, patterns);
    const tokenized = tokenizeSecrets(text, detections);
    for (const output of [tokenized.text, sanitize(text, detections)]) {
      expect(output).not.toContain(key);
      expect(output).not.toContain('second-secret');
      expect(output).toMatch(/^before .+ after$/);
    }
    let restored = tokenized.text;
    for (const entry of tokenized.entries) restored = restored.replace(entry.token, entry.secret);
    expect(restored).toBe(text);
  });

  test('retains nested and transitively overlapping ranges, but separates adjacent ranges', () => {
    const text = 'abcdefghij KL';
    const patterns: Pattern[] = [
      { type: 'known-key', label: 'Specific', regex: /cde/g },
      { type: 'env-credential', label: 'Broad', regex: /abcde/g },
      { type: 'env-credential', label: 'Extending', regex: /efghi/g },
      { type: 'env-credential', label: 'Adjacent', regex: /j/g },
      { type: 'known-key', label: 'Separate', regex: /KL/g },
    ];
    const detections = detectSecrets(text, patterns);
    expect(detections.map(({ start, end, match }) => ({ start, end, match }))).toEqual([
      { start: 0, end: 9, match: 'abcdefghi' },
      { start: 9, end: 10, match: 'j' },
      { start: 11, end: 13, match: 'KL' },
    ]);
    expect(detections[0].label).toBe('Specific');
    expect(sanitize(text, detections)).not.toMatch(/[a-j]/);
  });

  test('retains the highest-ranked label and uses original match length for ties', () => {
    const patterns: Pattern[] = [
      { type: 'env-credential', label: 'Broad', regex: /abcdefghij/g },
      { type: 'known-key', label: 'Short', regex: /bc/g },
      { type: 'known-key', label: 'Long', regex: /defg/g, origin: 'team' },
    ];
    expect(detectSecrets('abcdefghij', patterns)).toEqual([
      { type: 'known-key', label: 'Long', start: 0, end: 10, match: 'abcdefghij', origin: 'team' },
    ]);
  });
});
