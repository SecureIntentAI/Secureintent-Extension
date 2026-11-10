import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { signatureMap, trustedKeys, verifySigned } from './verify';

// A key pair generated for this run only. Its public half is installed as the
// trusted key for both purposes through the build-time override, so no signing
// key is ever stored in the repository.
let privateKey: CryptoKey;
let otherKey: CryptoKey;

async function rawPublic(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return btoa(String.fromCharCode(...raw));
}
async function sign(key: CryptoKey, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  otherKey = other.privateKey;
  vi.stubEnv('WXT_POLICY_PUBLIC_KEY', await rawPublic(pair.publicKey));
});
afterAll(() => vi.unstubAllEnvs());

describe('trustedKeys', () => {
  test('each purpose trusts its own labelled key', () => {
    expect(Object.keys(trustedKeys('config'))).toEqual(['config-2026-11']);
    expect(Object.keys(trustedKeys('entitlement'))).toEqual(['entitlement-2026-11']);
  });
});

describe('verifySigned', () => {
  test('accepts a valid signature under the trusted id', async () => {
    const payload = JSON.stringify({ version: 5 });
    const signatures = { 'config-2026-11': await sign(privateKey, payload) };
    expect(await verifySigned('config', payload, signatures)).toBe(true);
    expect(
      await verifySigned('entitlement', payload, {
        'entitlement-2026-11': await sign(privateKey, payload),
      }),
    ).toBe(true);
  });
  test('rejects a signature over different content', async () => {
    const signatures = {
      'config-2026-11': await sign(privateKey, JSON.stringify({ version: 5 })),
    };
    expect(await verifySigned('config', JSON.stringify({ version: 6 }), signatures)).toBe(false);
  });
  test('rejects a valid signature made by another key', async () => {
    const payload = '{}';
    expect(
      await verifySigned('config', payload, { 'config-2026-11': await sign(otherKey, payload) }),
    ).toBe(false);
  });
  test('ignores signatures under ids it does not trust, including the other purpose', async () => {
    const payload = '{}';
    const sig = await sign(privateKey, payload);
    expect(await verifySigned('config', payload, { 'entitlement-2026-11': sig })).toBe(false);
    expect(await verifySigned('config', payload, { 'config-2025-01': sig })).toBe(false);
    expect(await verifySigned('config', payload, { signature: sig })).toBe(false);
  });
  test('rejects a missing, null or garbage map', async () => {
    expect(await verifySigned('config', '{}', null)).toBe(false);
    expect(await verifySigned('config', '{}', undefined)).toBe(false);
    expect(await verifySigned('config', '{}', 'not-a-map')).toBe(false);
    expect(await verifySigned('config', '{}', { 'config-2026-11': 'not-base64-sig' })).toBe(false);
    expect(await verifySigned('config', '{}', { 'config-2026-11': '' })).toBe(false);
  });
});

describe('signatureMap', () => {
  test('keeps only string signatures', () => {
    expect(signatureMap({ a: 'x', b: 1, c: '' })).toEqual({ a: 'x' });
    expect(signatureMap([])).toBeNull();
    expect(signatureMap(null)).toBeNull();
  });
});
