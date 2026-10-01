import { describe, expect, test } from 'vitest';
import { contentDigest, dedupMac, handledFrame, isHex256 } from './hash';

// Shared with the desktop: engine/src/bridge.rs pins the same values in its
// handled-MAC test. They were computed independently (Python's hashlib/hmac),
// not by either implementation, so a drift on one side fails there.
const VALUE = 'AKIAIOSFODNN7EXAMPLE';
const DIGEST = '1a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3';
const MAC_TOK_A = 'b443437b79538753f8904d9444682968b099201671dabff45dffe644dfe495c1';

describe('contentDigest', () => {
  test('matches the shared vector', async () => {
    expect(await contentDigest(VALUE)).toBe(DIGEST);
  });

  test('hashes UTF-8 bytes, as the desktop hashes s.as_bytes()', async () => {
    // "é" is two bytes in UTF-8. Digesting UTF-16 code units would differ here.
    expect(await contentDigest('é')).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    );
  });
});

describe('dedupMac', () => {
  test('matches the shared vector', async () => {
    expect(await dedupMac('tok-a', DIGEST)).toBe(MAC_TOK_A);
  });

  test('depends on the token, so it is useless without it', async () => {
    expect(await dedupMac('tok-b', DIGEST)).not.toBe(MAC_TOK_A);
  });

  test('neither the value nor its plain digest is on the wire', async () => {
    const frame = handledFrame(await dedupMac('tok-a', await contentDigest(VALUE)), 5000);
    expect(frame).not.toContain(VALUE);
    expect(frame).not.toContain(DIGEST);
    expect(JSON.parse(frame)).toEqual({ type: 'handled', mac: MAC_TOK_A, ttl_ms: 5000 });
  });
});

describe('handledFrame', () => {
  test('never sends the legacy unkeyed hash field', () => {
    expect(JSON.parse(handledFrame(MAC_TOK_A, 5000))).not.toHaveProperty('hash');
  });

  test('the ttl is always an integer', () => {
    expect(handledFrame(MAC_TOK_A, 1500.7)).toContain('"ttl_ms":1500');
  });
});

describe('isHex256', () => {
  test('accepts only 64 lowercase hex characters', () => {
    expect(isHex256(DIGEST)).toBe(true);
    expect(isHex256(DIGEST.toUpperCase())).toBe(false);
    expect(isHex256(DIGEST.slice(1))).toBe(false);
    expect(isHex256(`${DIGEST.slice(1)}g`)).toBe(false);
  });
});
