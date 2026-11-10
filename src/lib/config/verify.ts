// Ed25519 verification of what the Worker signs: the config bundle and the
// entitlement. Each purpose has its own key, and the Worker labels every
// signature with the id of the key that made it (`signatures: { id: sig }`).
// Only the ids listed here are trusted; a signature under any other id, or the
// older unlabelled `signature` field, is ignored.
//
// Test artifacts are separate builds; never distribute a WXT_E2E build.

export type Purpose = 'config' | 'entitlement';
/** Key id → detached base64 signature over the same payload. */
export type SignatureMap = Record<string, string>;

const CONFIG_KEYS: Readonly<Record<string, string>> = {
  'config-2026-11': 'scuKHzgjhlviyYnB3Nyl5RRrzr9oQxhmby5Qj9AEMco=',
};
const ENTITLEMENT_KEYS: Readonly<Record<string, string>> = {
  'entitlement-2026-11': 'XXErXzAAMi5B20tFEWVt6La+eU+MRqyqEMdtdF4P+Mo=',
};
/** Public half of the deterministic e2e key (see e2e/signing.ts). */
const E2E_KEY = 'iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=';

/**
 * The trusted keys for a purpose. A local Worker build (scripts/e2e) may sign
 * with its own key: `WXT_CONFIG_PUBLIC_KEY` / `WXT_ENTITLEMENT_PUBLIC_KEY`, or
 * `WXT_POLICY_PUBLIC_KEY` for both, stand in for the production keys under the
 * same ids. Read at call time so a test can set them before the first check.
 */
export function trustedKeys(purpose: Purpose): Readonly<Record<string, string>> {
  const env = import.meta.env as Record<string, string | undefined>;
  const keys = purpose === 'config' ? CONFIG_KEYS : ENTITLEMENT_KEYS;
  const override =
    (purpose === 'config' ? env.WXT_CONFIG_PUBLIC_KEY : env.WXT_ENTITLEMENT_PUBLIC_KEY) ||
    env.WXT_POLICY_PUBLIC_KEY ||
    (env.WXT_E2E === '1' ? E2E_KEY : undefined);
  if (!override) return keys;
  return Object.fromEntries(Object.keys(keys).map((id) => [id, override]));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function publicKey(b64: string): Promise<CryptoKey> {
  let key = keyCache.get(b64);
  if (!key) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    key = crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    keyCache.set(b64, key);
  }
  return key;
}

async function verifyOne(keyB64: string, payload: string, signatureB64: string): Promise<boolean> {
  try {
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      await publicKey(keyB64),
      sig,
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

/** The labelled signatures of a response or a cached value, or null when absent. */
export function signatureMap(value: unknown): SignatureMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: SignatureMap = {};
  for (const [id, sig] of Object.entries(value as Record<string, unknown>)) {
    if (typeof sig === 'string' && sig.length > 0 && sig.length <= 512) out[id] = sig;
  }
  return out;
}

/**
 * True when `signatures` carries a valid signature over `payload` under a key
 * id trusted for this purpose. Anything else (no map, unknown ids only, a
 * signature over other bytes) is false.
 */
export async function verifySigned(
  purpose: Purpose,
  payload: string,
  signatures: unknown,
): Promise<boolean> {
  const map = signatureMap(signatures);
  if (!map) return false;
  for (const [id, keyB64] of Object.entries(trustedKeys(purpose))) {
    const sig = map[id];
    if (sig && (await verifyOne(keyB64, payload, sig))) return true;
  }
  return false;
}
