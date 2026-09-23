import { storage } from '#imports';

// Anonymise & Paste allowance for logged-out users, tracked on-device.
// Deliberately obfuscated: stored under an innocuous key as an opaque token
// (month + count XOR-folded under a code word, base64url) rather than a plain
// counter, so it doesn't read as "3/10" to someone poking at extension storage.
// This is a UX gate, not a security boundary — clearing storage still resets it.

export const OFFLINE_LIMIT = 10;

const CODE_WORD = 'cadence-2f9-securimeter';
const item = storage.defineItem<{ pulse: string } | null>('local:si_rhythm', { fallback: null });

function fold(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const key = new TextEncoder().encode(CODE_WORD);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] ?? 0) ^ (key[i % key.length] ?? 0);
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unfold(token: string): string {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const key = new TextEncoder().encode(CODE_WORD);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) ^ (key[i % key.length] ?? 0);
  return new TextDecoder().decode(out);
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function readCount(): Promise<number> {
  const v = await item.getValue();
  if (!v?.pulse) return 0;
  try {
    const [m, c] = unfold(v.pulse).split('#');
    if (m !== monthKey()) return 0; // a new month → fresh allowance
    const n = Number(c);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // tampered/garbage → treat as a fresh cycle
  }
}

async function writeCount(count: number): Promise<void> {
  await item.setValue({ pulse: fold(`${monthKey()}#${count}`) });
}

export async function offlineUsed(): Promise<number> {
  return readCount();
}

/** Consume one unit if under the limit. Returns the post-consume state. */
let consumeTail: Promise<unknown> = Promise.resolve();
export function offlineConsume(): Promise<{ used: number; allowed: boolean }> {
  const work = async () => {
    const used = await readCount();
    if (used >= OFFLINE_LIMIT) return { used, allowed: false };
    await writeCount(used + 1);
    return { used: used + 1, allowed: true };
  };
  const next = consumeTail.then(work, work);
  consumeTail = next.catch(() => undefined);
  return next;
}
