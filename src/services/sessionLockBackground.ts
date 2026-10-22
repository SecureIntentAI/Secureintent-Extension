import { browser, storage } from '#imports';
import { getOrCreateSalt, type KeyValueStore } from '@/lib/fingerprint';
import { verifyPin } from '@/lib/lock';
import {
  type AttemptState,
  LOCK_UNLOCK_MESSAGE,
  parseAttemptState,
  recordFailure,
  type UnlockResult,
} from '@/lib/lock/attempts';
import { sessionLockPinHashItem } from '@/settings';

const ATTEMPTS_KEY = 'si_lock_attempts';
const MAX_PIN_CHARS = 64;

const saltStore: KeyValueStore = {
  get: async (key) => (await storage.getItem<string>(`local:${key}`)) ?? undefined,
  set: (key, value) => storage.setItem(`local:${key}`, value),
};

async function readAttempts(now: number): Promise<AttemptState> {
  const stored = (await browser.storage.local.get(ATTEMPTS_KEY))[ATTEMPTS_KEY];
  return parseAttemptState(stored, now);
}

export function resetUnlockAttempts(): Promise<void> {
  return browser.storage.local.remove(ATTEMPTS_KEY);
}

// One check at a time, so tabs unlocking in parallel share one count.
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}

/** Check a PIN against the stored hash, counting misses across every tab. */
export function tryUnlock(pin: unknown): Promise<UnlockResult> {
  return serial(async () => {
    const now = Date.now();
    const state = await readAttempts(now);
    if (now < state.retryAfter) return { ok: false, retryAfter: state.retryAfter };
    const pinHash = await sessionLockPinHashItem.getValue();
    if (!pinHash) return { ok: false, retryAfter: 0 };
    const valid =
      typeof pin === 'string' &&
      pin.length > 0 &&
      pin.length <= MAX_PIN_CHARS &&
      (await verifyPin(pin, await getOrCreateSalt(saltStore), pinHash));
    if (valid) {
      await resetUnlockAttempts();
      return { ok: true, retryAfter: 0 };
    }
    const next = recordFailure(state, Date.now());
    await browser.storage.local.set({ [ATTEMPTS_KEY]: next });
    return { ok: false, retryAfter: next.retryAfter };
  });
}

export function installSessionLockBackground(): void {
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    if ((message as { type?: string })?.type !== LOCK_UNLOCK_MESSAGE) return false;
    // Our own pages (the lock overlay, the settings popup) only.
    if (sender.id !== browser.runtime.id) {
      respond({ ok: false, retryAfter: 0 });
      return false;
    }
    void tryUnlock((message as { pin?: unknown }).pin).then(respond, () =>
      respond({ ok: false, retryAfter: 0 }),
    );
    return true;
  });
  // A new PIN starts with a clean count.
  sessionLockPinHashItem.watch(() => {
    void serial(resetUnlockAttempts).catch(() => {});
  });
}
