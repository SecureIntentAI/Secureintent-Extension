import { describe, expect, test } from 'vitest';
import { detectorCorpusV1_2_0 } from './corpus/v1_2_0';
import { detectSecrets } from './index';
import { PATTERNS } from './patterns';

function scan(text: string, aggressive = true) {
  const patterns = aggressive
    ? PATTERNS
    : PATTERNS.filter((pattern) => pattern.validate !== 'entropy');
  return detectSecrets(text, patterns).map(({ label, match }) => ({ label, match }));
}

describe(`detector regression corpus v${detectorCorpusV1_2_0.version}`, () => {
  test.each(detectorCorpusV1_2_0.positives)('detects positive case: $id', (sample) => {
    expect(scan(sample.text)).toEqual(sample.expected);
  });

  test.each(detectorCorpusV1_2_0.negatives)('does not flag negative case: $id', (sample) => {
    expect(scan(sample.text, sample.aggressive)).toEqual(sample.expected);
  });

  test('tracks a useful balanced synthetic corpus', () => {
    expect(detectorCorpusV1_2_0.positives.length).toBeGreaterThanOrEqual(10);
    expect(detectorCorpusV1_2_0.negatives.length).toBeGreaterThanOrEqual(10);
  });
});
