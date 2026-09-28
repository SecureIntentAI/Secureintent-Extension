import { expect, test } from 'vitest';
import { detectSecrets } from './index';
import { PATTERNS } from './patterns';

test('finds unknown keys in nested JSON and removes only the value', () => {
  const value = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
  const text = JSON.stringify({ settings: { apiKey: value, publicKey: value } });
  const findings = detectSecrets(text);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    type: 'env-credential',
    label: 'JSON credential',
    match: value,
  });
  expect(text.slice(findings[0].start, findings[0].end)).toBe(value);
  expect(text.slice(0, findings[0].start)).toContain('apiKey');
});

test('finds unknown secrets in .env assignments and skips placeholders', () => {
  const value = 'new-provider-8Jc5M9qR2vT6xY4z';
  const text = `SERVICE_CREDENTIAL=${value}\nSERVICE_PASSWORD=changeme\nPUBLIC_KEY=${value}`;
  const findings = detectSecrets(text);
  expect(findings.filter((d) => d.label === 'Structured credential')).toEqual([
    expect.objectContaining({ match: value }),
  ]);
});

test('known provider detector still wins when it overlaps a structured value', () => {
  const value = `sk-${'a'.repeat(30)}`;
  const findings = detectSecrets(JSON.stringify({ apiKey: value }));
  expect(findings).toHaveLength(1);
  expect(findings[0].label).toBe('OpenAI API key');
});

test('a team-only replacement catalogue suppresses built-in structured detection', () => {
  const value = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
  const teamRules = [
    {
      type: 'known-key' as const,
      label: 'Team only',
      regex: /ACME-[0-9]+/g,
      origin: 'team' as const,
    },
  ];
  expect(detectSecrets(JSON.stringify({ apiKey: value }), teamRules)).toEqual([]);
  expect(detectSecrets(JSON.stringify({ apiKey: value }), PATTERNS)).toHaveLength(1);
});

test('flags a standalone unfamiliar URL-safe token only in aggressive mode', () => {
  const value = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
  expect(detectSecrets(value).some((d) => d.label === 'Possible unknown token')).toBe(true);
  expect(
    detectSecrets(
      value,
      PATTERNS.filter((p) => p.validate !== 'entropy'),
    ),
  ).toEqual([]);
  expect(
    detectSecrets(`https://example.com/${value}`).some((d) => d.label === 'Possible unknown token'),
  ).toBe(false);
});
