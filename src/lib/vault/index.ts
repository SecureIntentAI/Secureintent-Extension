import type { VaultEntry } from '@/lib/detection';

/**
 * RAM-only store of `token → secret` mappings used to rehydrate anonymized
 * pastes. Backed by `storage.session` in the extension (never written to disk,
 * cleared when the browser closes). The store is injected so the logic stays
 * pure and testable, mirroring the salt module.
 */
export interface VaultStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** Entries older than this are treated as gone, bounding residency in a long session. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/** The subset of `chrome.storage.session` we need to open up to content scripts. */
type AccessLevel = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
interface SessionAccess {
  setAccessLevel?: (opts: { accessLevel: AccessLevel }) => Promise<void> | void;
}

/**
 * MV3 `storage.session` defaults to `TRUSTED_CONTEXTS` only, so content scripts
 * cannot read or write the vault until the background opts in. Call this once at
 * background startup. No-op (and error-swallowing) on engines without
 * `setAccessLevel` (e.g. Firefox), where content scripts already have access.
 */
export async function allowVaultInContentScripts(session: SessionAccess): Promise<void> {
  try {
    await session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch {
    // older / cross-browser engines — safe to ignore.
  }
}

interface StoredEntry {
  secret: string;
  ts: number;
}
type OriginMap = Record<string, StoredEntry>;

function keyFor(origin: string): string {
  return `si_vault:${origin}`;
}

async function readMap(store: VaultStore, origin: string): Promise<OriginMap> {
  const raw = await store.get(keyFor(origin));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as OriginMap) : {};
  } catch {
    return {};
  }
}

/** Store `token → secret` entries for an origin, stamped with `now`. */
export async function vaultPut(
  store: VaultStore,
  origin: string,
  entries: VaultEntry[],
  now: number,
): Promise<void> {
  if (entries.length === 0) return;
  const map = await readMap(store, origin);
  for (const { token, secret } of entries) {
    map[token] = { secret, ts: now };
  }
  await store.set(keyFor(origin), JSON.stringify(map));
}

/** Resolve a token to its secret, or `undefined` if unknown or older than the TTL. */
export async function vaultResolve(
  store: VaultStore,
  origin: string,
  token: string,
  now: number,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<string | undefined> {
  const entry = (await readMap(store, origin))[token];
  if (!entry) return undefined;
  if (now - entry.ts > ttlMs) return undefined;
  return entry.secret;
}

/**
 * All live `token → secret` pairs for an origin (expired entries omitted).
 * Read by the background on each restoration request; no long-lived page cache.
 */
export async function vaultSnapshot(
  store: VaultStore,
  origin: string,
  now: number,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<Record<string, string>> {
  const map = await readMap(store, origin);
  const out: Record<string, string> = {};
  for (const [token, entry] of Object.entries(map)) {
    if (now - entry.ts <= ttlMs) out[token] = entry.secret;
  }
  return out;
}

/** Drop entries older than the TTL for an origin. */
export async function vaultSweep(
  store: VaultStore,
  origin: string,
  now: number,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  const map = await readMap(store, origin);
  let changed = false;
  for (const [token, entry] of Object.entries(map)) {
    if (now - entry.ts > ttlMs) {
      delete map[token];
      changed = true;
    }
  }
  if (changed) await store.set(keyFor(origin), JSON.stringify(map));
}
