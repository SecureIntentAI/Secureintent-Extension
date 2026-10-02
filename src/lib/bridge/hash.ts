// The desktop bridge's dedup key: a keyed MAC of one copy, never the copy.
//
// Two steps, split across two contexts on purpose:
//
//   1. The content script that saw the paste computes `contentDigest(text)`, a
//      SHA-256. The pasted text never leaves that frame; only the digest does.
//   2. The background, which holds the pairing token, turns the digest into
//      `dedupMac(token, digest)` and sends that over the socket.
//
// This replaces an unsalted FNV-1a of the text. That was cheap to test guesses
// against, so for a low-entropy value (a card number, a short password) the hash
// on the wire was as good as the value. Keyed with the pairing token, the MAC is
// useless to anyone who does not already hold it. The desktop computes the same
// thing (`dedup_mac` in engine/src/bridge.rs), domain-separated like the
// handshake proofs; both sides pin one shared vector in their tests, so a change
// to either construction fails on both.

const enc = new TextEncoder();

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 64 lowercase hex characters: the shape of both the digest and the MAC. */
export function isHex256(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`, as the desktop hashes `s.as_bytes()`. */
export async function contentDigest(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function keyedMac(token: string, domain: string, digestHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode(`secureintent-bridge-v2/${domain}/${digestHex}`),
    ),
  );
}

/**
 * HMAC-SHA256 keyed with the pairing token, over
 * `secureintent-bridge-v2/handled/<digest>`, as lowercase hex.
 */
export function dedupMac(token: string, digestHex: string): Promise<string> {
  return keyedMac(token, 'handled', digestHex);
}

/**
 * The same construction in its own domain, `secureintent-bridge-v2/allowed/<digest>`:
 * what we send to ask the desktop whether the person already restored this exact
 * text there with Undo (`allowed_mac` in engine/src/bridge.rs). A separate domain,
 * so a `handled` MAC can never be replayed as this question.
 */
export function allowedMac(token: string, digestHex: string): Promise<string> {
  return keyedMac(token, 'allowed', digestHex);
}

/** The `handled` frame. The MAC is hex we produced, so plain JSON is safe. */
export function handledFrame(mac: string, ttlMs: number): string {
  return JSON.stringify({ type: 'handled', mac, ttl_ms: Math.floor(ttlMs) });
}

/** The `query_allowed` frame. The desktop answers `{type:"allowed", ok}`. */
export function queryAllowedFrame(mac: string): string {
  return JSON.stringify({ type: 'query_allowed', mac });
}
