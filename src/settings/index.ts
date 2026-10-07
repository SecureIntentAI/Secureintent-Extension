import { storage } from '#imports';
import { getActiveBundle, getPolicy } from '@/lib/config';

export const enabledItem = storage.defineItem<boolean>('local:si_enabled', {
  fallback: true,
});

export const blockedCountItem = storage.defineItem<number>('local:si_blocked_count', {
  fallback: 0,
});

export const isEnabled = () => enabledItem.getValue();
export const setEnabled = (value: boolean) => enabledItem.setValue(value);
export const getBlockedCount = () => blockedCountItem.getValue();

// --- Session Lock (cloud consoles) ---
export const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export const sessionLockEnabledItem = storage.defineItem<boolean>('local:si_lock_enabled', {
  fallback: false,
});
/** Salted SHA-256 of the PIN; null until the user sets one. Never plaintext. */
export const sessionLockPinHashItem = storage.defineItem<string | null>('local:si_lock_pin', {
  fallback: null,
});
export const sessionLockTimeoutItem = storage.defineItem<number>('local:si_lock_timeout_ms', {
  fallback: DEFAULT_LOCK_TIMEOUT_MS,
});

export interface SessionLockConfig {
  enabled: boolean;
  pinHash: string | null;
  timeoutMs: number;
}

/**
 * Team Policy `requireSessionLock`: the admin has pinned Session Lock on for
 * every member. The flag rides on the Ed25519-signed config bundle, so only a
 * Worker-signed bundle can turn it on.
 *
 * Reads fall back to "not enforced" — a settings read must never throw, and a
 * missing/unreadable bundle means we simply have no policy to apply.
 */
export async function isSessionLockEnforced(): Promise<boolean> {
  try {
    return getPolicy(await getActiveBundle()).requireSessionLock;
  } catch {
    return false;
  }
}

export async function getSessionLockConfig(): Promise<SessionLockConfig> {
  const [stored, pinHash, timeoutMs, enforced] = await Promise.all([
    sessionLockEnabledItem.getValue(),
    sessionLockPinHashItem.getValue(),
    sessionLockTimeoutItem.getValue(),
    isSessionLockEnforced(),
  ]);
  // Policy wins over the local toggle, so an enforced lock is on for every
  // reader even if a stale `false` is still sitting in storage.
  return { enabled: enforced || stored, pinHash, timeoutMs };
}

/**
 * Turn the lock on or off. Returns false when the change was REFUSED because the
 * team policy pins it on — callers surface that to the member instead of letting
 * a click quietly do nothing.
 */
export async function setSessionLockEnabled(value: boolean): Promise<boolean> {
  if (!value && (await isSessionLockEnforced())) return false;
  await sessionLockEnabledItem.setValue(value);
  return true;
}

/** Save a PIN hash and turn the lock on in one step (no separate enable click). */
export async function setSessionLockPin(pinHash: string): Promise<void> {
  await sessionLockPinHashItem.setValue(pinHash);
  await sessionLockEnabledItem.setValue(true);
}

/**
 * Remove the PIN and disable the lock. Returns false when refused: dropping the
 * PIN would disable an enforced lock through the back door, so the policy has to
 * block this path too, not only the toggle.
 */
export async function clearSessionLockPin(): Promise<boolean> {
  if (await isSessionLockEnforced()) return false;
  await sessionLockPinHashItem.setValue(null);
  await sessionLockEnabledItem.setValue(false);
  return true;
}

export async function recordBlocked(n: number): Promise<void> {
  const current = await blockedCountItem.getValue();
  await blockedCountItem.setValue(current + n);
}

// --- Desktop bridge (SecureIntent desktop agent) ---

/**
 * Whether the SecureIntent desktop app answered the last pairing lookup.
 *
 * There is no switch for the bridge any more: the extension pairs with the
 * desktop app on its own (see `lib/bridge/pairing.ts`), and whether the two
 * coordinate is decided in the desktop app, which is what holds the token. This
 * records only that a desktop app is there, so content scripts can skip
 * reporting the tab where there is nothing to report it to. It is not the token.
 */
export const bridgeAvailableItem = storage.defineItem<boolean>('local:si_bridge_available', {
  fallback: false,
});

/**
 * Storage the manual pairing flow used to write: an on/off switch and a pasted
 * token, both on disk. Removed on update, so a token pasted into an older
 * version does not stay behind.
 */
export async function forgetManualPairing(): Promise<void> {
  await storage.removeItems(['local:si_bridge_enabled', 'local:si_bridge_token']);
}
