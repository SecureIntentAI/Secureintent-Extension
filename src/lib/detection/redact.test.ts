import { describe, expect, test } from 'vitest';
import { detectSecrets } from './index';
import { githubTokenChecksum } from './validators';
import { redact } from './redact';

describe('redact', () => {
  test('removes the raw secret from the output', () => {
    const secret = 'sk-' + 'a'.repeat(30);
    const text = `my key is ${secret} ok`;
    const out = redact(text, detectSecrets(text));

    expect(out).not.toContain(secret);
    expect(out.startsWith('my key is ')).toBe(true);
    expect(out.endsWith(' ok')).toBe(true);
  });

  test('uses a short asterisk mask, bounded for long secrets', () => {
    const long = 'sk-' + 'a'.repeat(120);
    const out = redact(`key ${long}`, detectSecrets(`key ${long}`));

    expect(out).not.toMatch(/redacted/i);
    const run = out.match(/\*+/)?.[0] ?? '';
    expect(run.length).toBeGreaterThanOrEqual(3);
    expect(run.length).toBeLessThanOrEqual(6);
  });

  test('returns text unchanged when there are no detections', () => {
    const text = 'nothing secret here';
    expect(redact(text, [])).toBe(text);
  });

  test('redacts multiple secrets without corrupting offsets', () => {
    const a = 'sk-' + 'a'.repeat(30);
    const payload = 'b'.repeat(30);
    const b = 'gh' + 'p_' + payload + githubTokenChecksum(payload);
    const text = `${a} middle ${b}`;
    const out = redact(text, detectSecrets(text));

    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out).toContain(' middle ');
  });
});
