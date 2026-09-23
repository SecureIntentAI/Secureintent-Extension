// raw base64 Ed25519 public key; matches the Worker's signing key
// Test artifacts are separate builds; never distribute a WXT_E2E build.
const PUBLIC_KEY_B64 =
  import.meta.env.WXT_E2E === '1'
    ? 'iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w='
    : 'kn2gVKuqNXC+NKdoM7tST6j+jPAKFQrh5Q/S99uCFDY=';

let keyPromise: Promise<CryptoKey> | null = null;
function publicKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const raw = Uint8Array.from(atob(PUBLIC_KEY_B64), (c) => c.charCodeAt(0));
    keyPromise = crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  }
  return keyPromise;
}

export async function verifyBundle(payload: string, signatureB64: string | null): Promise<boolean> {
  if (!signatureB64) return false;
  try {
    const key = await publicKey();
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sig,
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}
